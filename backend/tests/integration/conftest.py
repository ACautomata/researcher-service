"""联调集成测试共享 fixtures（issue #179）。

编排三节点链路：真浏览器（Playwright）→ Vite dev server proxy → pytest-django 起的
live Django 后端。live server 复用 pytest-django 的 ``live_server`` fixture（随机端口隔离）；
vite dev server 由本 conftest 起 subprocess，经 ``VITE_API_TARGET`` 注入 live server 端口
（dev 行为不变，测试时指向 live server，端口隔离得以保留）。

每 case 独立 browser context（token/cookie/localStorage 全清）—— 是 L1/L2 401→refresh/
logout 分支能从干净态精确触发的前提（#178 user story 10）。

运行前提（CI integration job / 本地）：装 ``requirements/integration.txt`` +
``playwright install chromium`` + frontend ``npm ci``（vite dev server 依赖）。
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# vite 冷启动就绪轮询（首次 ts 转译较慢）
_VITE_READINESS_TIMEOUT = 30.0
_VITE_POLL_INTERVAL = 0.5

BACKEND_DIR = Path(__file__).resolve().parents[2]   # backend/
FRONTEND_DIR = BACKEND_DIR.parent / 'frontend'


# ═══════════════════════════════════════════════════════════════════════════════
# 环境 setup/teardown（issue #257 follow-up）：把「装 Playwright / frontend npm ci」这类
# fixture-bootstrap 依赖的检测+可选自动准备，以及「session 结束清掉残留 fleet 容器/孤儿进程」
# 的 teardown 收进 pytest fixture 生命周期（yield 配对），而非外置脚本——环境没备好给出
# 可操作失败，跑完留残（容器占端口池、vite/daphne 孤儿、test DB 文件）由 teardown 兜底。
#
# 与 case 级 skipif 门控（_docker_daemon_reachable / _pairing_env_ready）分工：
#   - bootstrap 依赖（playwright 客户端 / chromium / vite 的 node_modules）是「只要跑
#     本目录任何 case 就必须有」的 fixture 前提 → 这里 session 级 fail-fast 断言。
#   - docker daemon / LLM_API_KEY / OPENCLAW_TEMPLATE_DIR 是「只有真起容器的 case 才要」
#     的运行期前提 → 仍由各 case 的 skipif 优雅跳过，不在此断言。
# ═══════════════════════════════════════════════════════════════════════════════

def pytest_addoption(parser):
    """注册 ``--integration-setup``：opt-in 让 bootstrap fixture 自动补齐缺失依赖。

    默认只检测、不安装（不替用户环境做写操作）；显式加该 flag 才执行 npm ci /
    playwright install chromium 等准备动作（CI 已显式装过，无需此 flag）。
    """
    parser.addoption(
        '--integration-setup',
        action='store_true',
        default=False,
        help='自动准备联调集成测试缺失的 bootstrap 依赖（frontend npm ci / '
             'playwright install chromium）。默认仅检测并给出可操作提示。',
    )


def _chromium_installed() -> bool:
    """探测 Playwright chromium 浏览器二进制是否已拉取（不启动浏览器）。

    用 sync_playwright 的 executable_path 指向缓存路径判断存在性，避免真 launch。
    任何异常（playwright 未装 / 路径解析失败）一律按「未就绪」处理，交给 bootstrap 报错。
    """
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            return Path(pw.chromium.executable_path).exists()
    except Exception:  # pylint: disable=broad-exception-caught
        return False


def _integration_bootstrap_gaps() -> list[str]:
    """返回缺失的 bootstrap 依赖描述（空 = 全就绪）。仅在跑本目录 case 时被调一次。"""
    gaps = []
    try:
        import playwright  # noqa: F401
    except ImportError:
        gaps.append('playwright Python 客户端未装')
    else:
        if not _chromium_installed():
            gaps.append('playwright chromium 浏览器未拉取')
    if not (FRONTEND_DIR / 'node_modules' / '.bin' / 'vite').exists():
        gaps.append('frontend 依赖未装（vite 不在 node_modules）')
    return gaps


@pytest.fixture(scope='session', autouse=True)
def integration_bootstrap(request):
    """session 级 setup/teardown 门：跑本目录 case 前确保依赖就绪；跑完清残留。

    setup：默认只检测——缺依赖即 ``pytest.UsageError`` 给可操作指引（而非 vite/daphne
    subprocess 起来后才裸 RuntimeError，或 page fixture 内 ImportError）。加
    ``--integration-setup`` 则自动补齐缺失项（幂等：已就绪项跳过；任一步失败即回滚已
    备项，不留半拉子状态）。

    teardown（yield 后）：扫掉 session 期间残留的真容器 + test DB 文件——容器失败/中断会
    残留 ``openclaw-gw-*`` 占端口池（下次端口分配假失败，记忆 portpool-unit-test-...）。
    只删「session 基线之后在端口池内新建」的容器，不碰基线已存在或池外的（可能是开发者
    手动起的 fleet 容器，不属于本 session）。
    """
    gaps = _integration_bootstrap_gaps()
    if gaps:
        if not request.config.getoption('--integration-setup'):
            raise pytest.UsageError(
                '联调集成测试 bootstrap 依赖未就绪：\n  - ' + '\n  - '.join(gaps) + '\n\n'
                '二选一：\n'
                '  1) 让 pytest 自动准备：python -m pytest tests/integration/ --integration-setup ...\n'
                '  2) 手动准备：\n'
                '       pip install -r requirements/integration.txt\n'
                '       python -m playwright install chromium\n'
                '       (cd ../frontend && npm ci)\n'
                '（docker daemon / LLM_API_KEY / OPENCLAW_TEMPLATE_DIR 属 case 级 skipif 门控，'
                '不在此列——daemon-independent case 无需它们。）',
            )
        _prepare_bootstrap()

    # teardown 基线：session 开始时的 fleet 容器（id 集合），用于「只清本 session 新建」。
    baseline_ids = _fleet_container_ids()
    yield
    _teardown_containers(baseline_ids)
    _cleanup_test_db_files()


def _prepare_bootstrap() -> None:
    """自动补齐 bootstrap 缺失项；任一步失败即尽力回滚，不留半拉子状态。"""
    done = []
    try:
        try:
            import playwright  # noqa: F401
        except ImportError:
            _install_python_requirements()
            done.append('playwright')
        if not _chromium_installed():
            _run(['-m', 'playwright', 'install', 'chromium'], cwd=BACKEND_DIR, via_python=True)
            done.append('chromium')
        if not (FRONTEND_DIR / 'node_modules' / '.bin' / 'vite').exists():
            _run(['npm', 'ci'], cwd=FRONTEND_DIR)
            done.append('frontend')
    except Exception as exc:
        raise pytest.UsageError(
            f'--integration-setup 自动准备失败（已备：{done or "无"}）：{exc}\n'
            '请按报错手动补齐后重跑，或不带 --integration-setup 仅检测。',
        ) from exc

    remaining = _integration_bootstrap_gaps()
    if remaining:
        raise pytest.UsageError(
            '--integration-setup 自动准备后仍有缺失：\n  - ' + '\n  - '.join(remaining),
        )


def _install_python_requirements() -> None:
    """装 requirements/integration.txt 进当前 venv。

    本地 worktree 的 .venv 多为 ``uv venv`` 所建、**无 pip 模块**（``python -m pip`` 直接
    ModuleNotFoundError）；故优先用 uv（经 ``VIRTUAL_ENV`` 指当前 venv，幂等），无 uv 时
    回退 ``python -m pip``（CI 的 setup-python venv 自带 pip）。
    """
    req = str(BACKEND_DIR / 'requirements' / 'integration.txt')
    if shutil.which('uv'):
        env = {**os.environ, 'VIRTUAL_ENV': sys.prefix}
        proc = subprocess.run(['uv', 'pip', 'install', '-r', req],
                              cwd=str(BACKEND_DIR), env=env,
                              capture_output=True, text=True, check=False)
        if proc.returncode == 0:
            return
        raise RuntimeError(f'uv pip install 失败（code {proc.returncode}）：\n{proc.stderr}')
    _run(['-m', 'pip', 'install', '-r', req], cwd=BACKEND_DIR, via_python=True)


def _fleet_container_ids() -> set[str]:
    """当前 daemon 上全部 fleet 容器的 id 集合（label app=openclaw-fleet）；daemon 不可达→空集。"""
    try:
        from containers.docker_runtime import DockerRuntime
        return {c.container_id for c in DockerRuntime().list_fleet()}
    except Exception:  # pylint: disable=broad-exception-caught
        return set()


def _teardown_containers(baseline_ids: set[str]) -> None:
    """清掉 session 期间新建的 fleet 容器（基线之外），不碰基线已存在/池外的。

    双保险：既要在基线之后（本 session 新建），又要在端口池内（池外可能是并发/手动起的）。
    每个容器 stop+remove 独立 try，清理自身异常绝不阻断后续、更不上抛掩盖测试结果。
    端口池界取自 settings.OPENCLAW_FLEET（与 Fleet._build_default 同源，不另硬编码）。
    """
    try:
        from django.conf import settings

        from containers.docker_runtime import DockerRuntime
        pool_start = settings.OPENCLAW_FLEET['PORT_POOL_START']
        pool_end = settings.OPENCLAW_FLEET['PORT_POOL_END']
        runtime = DockerRuntime()
        current = runtime.list_fleet()
    except Exception:  # pylint: disable=broad-exception-caught
        return  # daemon 不可达 / settings 未就绪 → 无可清

    for info in current:
        if info.container_id in baseline_ids:
            continue  # 基线已存在，非本 session 新建，跳过
        in_pool = info.port is not None and pool_start <= info.port <= pool_end
        if info.port is not None and not in_pool:
            continue  # 池外端口（手动起的），不碰
        instance = info.instance_name or _strip_prefix(info.name)
        for op in (runtime.stop, runtime.remove):
            try:
                op(instance)
            except Exception:  # pylint: disable=broad-exception-caught
                pass


def _strip_prefix(container_name: str) -> str:
    """``openclaw-gw-<name>`` → ``<name>``（DockerRuntime.stop/remove 内部会再加前缀）。"""
    from containers.constants import CONTAINER_PREFIX
    return container_name.removeprefix(CONTAINER_PREFIX)


def _cleanup_test_db_files() -> None:
    """清掉 daphne 用的文件级 test DB 及 sidecar（与 daphne_server fixture finally 同集）。

    session 级兜底：daphne fixture 自身 finally 已清，但 fixture setup 中途失败（如 migrate
    成功、daphne 启动失败）可能残留；session 结束再清一遍幂等。
    """
    test_db = BACKEND_DIR / 'test_db_file.sqlite3'
    for p in (test_db,
              test_db.with_suffix('.sqlite3-wal'),
              test_db.with_suffix('.sqlite3-shm'),
              test_db.with_suffix('.sqlite3-journal')):
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass


def _run(argv: list[str], *, cwd: Path, via_python: bool = False) -> None:
    """跑准备子进程（失败即 RuntimeError，带 stdout/stderr 便于诊断）。

    ``via_python=True`` 经 ``sys.executable -m ...`` 调用，兼容无 .venv 的 CI（对齐
    既有 ``_run_manage_py`` / daphne 用 sys.executable 的模式）。
    """
    cmd = [sys.executable, *argv] if via_python else argv
    proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f'bootstrap 准备失败（{" ".join(cmd)}，code {proc.returncode}）：\n'
            f'stdout={proc.stdout}\nstderr={proc.stderr}',
        )


def _resolve_port() -> int:
    """返回 vite dev server 端口。

    CI/默认:随机选 free ephemeral 端口,避免遗留 Vite 抢旧端口的时候就绪探针认错服务器
    (codex #185 P2)。设 ``INTEGRATION_VITE_PORT`` env(如 ``5173``)时为固定值
    (本地 debug 时方便 curl/lsof 确认)。
    """
    if 'INTEGRATION_VITE_PORT' in os.environ:
        return int(os.environ['INTEGRATION_VITE_PORT'])
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _port_open(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(_VITE_POLL_INTERVAL)
        return s.connect_ex((host, port)) == 0


@pytest.fixture
def vite_dev_server(live_server):
    """起 vite dev server，proxy target 经 ``VITE_API_TARGET`` 指向 ``live_server.url``。

    dev 行为不变（``VITE_API_TARGET`` 缺省 :8000）；测试时本 fixture 注入 live server 随机
    端口，坐实 浏览器→Vite proxy→live Django 三节点链路（#179 acceptance）。
    """
    env = {**os.environ, 'VITE_API_TARGET': live_server.url}
    port = _resolve_port()
    # --host 127.0.0.1：强制 IPv4 loopback。vite 8 默认 listen [::1]（localhost→IPv6），
    # 与 readiness 探测 / 浏览器 goto 统一到 127.0.0.1，避开 v4/v6 解析歧义（CI/ubuntu 同稳）。
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=str(FRONTEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _VITE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(f'vite dev server exited early (code {proc.returncode}):\n{out}')
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_VITE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'vite dev server not ready on :{port} within {_VITE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """收掉 vite dev server 子进程树（npm→vite）。

    POSIX 上 ``npm run dev`` 把 vite 作子孙进程拉起;teardown 若只对 npm 发信号,
    vite 孤儿会继续监听 5173,下一个 function 级 fixture 因 ``--strictPort`` 绑不上而
    失败,后续 case 叠加泄漏。配合 ``start_new_session=True``(见 fixture)把 npm 树
    隔离进独立进程组(pgid==npm.pid),这里对整组收信号。
    """
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)


# 每次导航自动重装 dev hook 的 init script（test 侧 own，main.ts 不放测试代码，#188）。
# add_init_script 在每页脚本前注入，异步 IIFE poll 等 Vue mount（#app.__vue_app__，app.mount 挂）
# 再装 hook——不延迟 fixture yield（page.url 保持根路径，不破坏 L1 base 计算），且 test 内再
# page.goto 也会重装（导航清空 window）。pinia 经 app.use(pinia)→globalProperties.$pinia（probe
# 实证 gpPinia=True）；前端 api 经动态 import /src/...（vite dev serve 源码，同一模块实例）。
_TEST_HOOKS_INIT_SCRIPT = """
(async () => {
    while (!document.querySelector('#app') || !document.querySelector('#app').__vue_app__) {
        await new Promise(r => setTimeout(r, 50));
    }
    const app = document.querySelector('#app').__vue_app__;
    window.__pinia = app.config.globalProperties.$pinia;
    const [{ apiFetch }, { listInstances }, { getTree }] = await Promise.all([
        import('/src/api/client.ts'),
        import('/src/api/containers.ts'),
        import('/src/api/wiki.ts'),
    ]);
    window.__apiFetch = apiFetch;
    window.__listInstances = listInstances;
    window.__getTree = getTree;
})();
"""


@pytest.fixture
def page(vite_dev_server):
    """每 case 独立 browser context + page：token/cookie/localStorage 全清。

    每 case 新启 browser（彻底隔离；case 少时不计启动成本，后续 L1-L4 case 增多可改为
    session 级 browser 复用 + function 级 new_context）。dev hook（``__pinia`` / ``__apiFetch`` /
    ``__listInstances`` / ``__getTree``）经 ``context.add_init_script`` 在每次导航后异步注入
    （#188，main.ts 不放测试代码）——不延迟 yield、test 内再导航也重装。
    """
    # playwright 仅在 requirements/integration.txt（#179），backend-unit job 不装（只装 dev.txt）。
    # 不能顶部 import——否则 backend-unit 收集本 conftest 即 ImportError 红整个 job；而 pytest
    # importorskip 在 conftest 顶层不受支持（抛 Skipped 被当 collection error，已实测）。故延迟到
    # fixture 内：只有真正跑 integration case 才 import，deselect 的单元回归不受影响。
    # （Python 规则 #4「顶部 import」的 spec 驱动例外：playwright 是 spec #179 明令的可选依赖。）
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context()
            context.add_init_script(_TEST_HOOKS_INIT_SCRIPT)
            pg = context.new_page()
            # 指向 vite dev server origin：相对路径 fetch('/api/health') 经 vite proxy 打后端
            pg.goto(vite_dev_server, wait_until='domcontentloaded')
            yield pg
        finally:
            browser.close()


# ═══════════════════════════════════════════════════════════════════════════════
# L4 WebSocket fixtures（issue #183）：daphne ASGI LiveServer + Vite proxy + Playwright
# ═══════════════════════════════════════════════════════════════════════════════

# daphne ASGI 冷启动就绪轮询（对齐 Vite _VITE_READINESS_TIMEOUT 模式）
_DAPHNE_READINESS_TIMEOUT = 15.0
_DAPHNE_POLL_INTERVAL = 0.5

# daphne 子进程就绪 stdout 哨兵（daphne 的 ASGI/TCP server 启动完成后打印的启动 marker）
_DAPHNE_LISTENING_MARKER = 'Listening on'


def _run_manage_py(argv: list[str], env: dict[str, str]) -> None:
    """调 ``manage.py <argv>`` 在给定 env 下仿 Django CLI（如 migrate）。"""
    proc = subprocess.run(
        [sys.executable, 'manage.py', *argv],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'manage.py {" ".join(argv)} failed (code {proc.returncode}):\n'
            f'stdout={proc.stdout}\nstderr={proc.stderr}',
        )


def _find_free_port() -> int:
    """返回空闲 TCP 端口（bind + release；用于 daphne subprocess）。"""
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@pytest.fixture
def daphne_server(request, django_db_setup, tmp_path_factory):
    """起 daphne 单进程 ASGI LiveServer（fixed port，同一 test DB）。

    本 fixture 负责 test DB 的创建（migrate）与 daphne 进程的启停。pytest-django
    的 ``django_db_setup`` 仅创建空的 test DB 文件（``CREATE DATABASE`` 等价物），
    不建表——需 ``migrate`` 用 integration.py 设置连接 test DB 创建表。

    此后 daphne 子进程启动，其 Django ORM 连接同一文件级 SQLite，读写表结构与数据。
    测试进程通过 ``@django_db(transaction=True)`` TransactionTestCase 连接相同的
    dev.py settings，pytest-django 会根据 dev settings 创建 in-memory DB 用于测试
    ORM——所以 test 进程和 daphne 进程各有独立 DB，不共享数据。

    OPENCLAW_FLEET_ROOT 注入（#184 T7）：daphne 是独立 OS 进程，测试进程的
    ``Fleet.override`` 跨进程不可见（区别于 L0-L3 的 WSGI threaded live_server 同进程）。
    故 daphne 创建容器（经 HTTP ``POST /containers/``）走其自身 ``Fleet._build_default``
    读 ``settings.OPENCLAW_FLEET.ROOT``。默认 root=<repo>/fleet ⊂ OPENCLAW_TEMPLATE_DIR
    （仓库根），``HomeProvisioner.copytree`` 会把含 fleet 自身的模板树递归拷入 home →
    ``[Errno 63] File name too long``（本地 worktree 必现；CI 经 rsync 干净模板免此患）。
    本 fixture 把 ``OPENCLAW_FLEET_ROOT`` 指 ``tmp_path_factory`` 建的隔离目录（模板外），
    让本地+CI 一致避开递归——对齐 ``test_integration_http._override_fleet_with_real_runtime``
    把 root 指 tmp_path 的隔离模式，但作用到 daphne 子进程（经 env 注入而非 Fleet.override）。

    本地 Colima 跑须 ``--basetemp=$HOME/...``（virtiofs 仅共享 $HOME，fleet root 的
    bind-mount 须在 $HOME 内；CI Linux /tmp 无此限），对齐 wire/L2b 既有惯例。

    Teardown：``_terminate_process_group`` 收掉 daphne 进程树（与 vite_dev_server 同模式）；
    同时清理文件级 test DB 及其 WAL/SHM 侧文件，避免工作目录污染和跨测试状态残留（codex #190 P2）。
    """
    port = _find_free_port()

    # OPENCLAW_FLEET_ROOT：daphne 子进程的 Fleet root（模板外，避 HomeProvisioner 递归）。
    # tmp_path_factory（session 级）建隔离目录；本地须 --basetemp=$HOME/... 让其在 $HOME 内。
    fleet_root = tmp_path_factory.mktemp('daphne-fleet')

    # 1. migrate：用 integration.py settings → 文件级 SQLite（test_db_file.sqlite3）
    #    test 进程通过 pytest-django 默认 dev.py → in-memory DB，两者独立。
    #    daphne 进程 migrate 创建表；test 进程通过 HTTP (register/login/etc.)
    #    向 daphne 发请求，daphne ORM 读写的就是这些表。
    env_integration = {
        **os.environ,
        'DJANGO_SETTINGS_MODULE': 'config.settings.integration',
        'OPENCLAW_FLEET_ROOT': str(fleet_root),
    }
    _run_manage_py(['migrate', '--noinput'], env_integration)

    # 2. 启动 daphne（用 sys.executable -m daphne 而非硬编码 .venv/bin/daphne，
    #    兼容 CI 环境（无 .venv，codex #190 P1）和本地开发环境。
    proc = subprocess.Popen(
        [
            sys.executable, '-m', 'daphne',
            '-b', '127.0.0.1',
            '-p', str(port),
            '--verbosity', '0',
            'config.asgi:application',
        ],
        cwd=str(BACKEND_DIR),
        env=env_integration,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _DAPHNE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(
                    f'daphne exited early (code {proc.returncode}):\n{out}',
                )
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_DAPHNE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'daphne not listening on :{port} within {_DAPHNE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)
        # 清理文件级 test DB 及其 sidecar 文件（codex #190 P2）
        _test_db = BACKEND_DIR / 'test_db_file.sqlite3'
        for _p in (_test_db,
                   _test_db.with_suffix('.sqlite3-wal'),
                   _test_db.with_suffix('.sqlite3-shm'),
                   _test_db.with_suffix('.sqlite3-journal')):
            try:
                _p.unlink(missing_ok=True)
            except OSError:
                pass


@pytest.fixture
def vite_dev_server_ws(daphne_server):
    """起 vite dev server，proxy target 经 ``VITE_API_TARGET`` 指向 daphne ASGI server。

    L4 必须 ASGI（WebSocket 走 Channels ASGI 栈）—— ``live_server`` 是 WSGI，
    不服务 WebSocket。本 fixture 用 daphne_server 替代 live_server，其余编排
    与 ``vite_dev_server`` 一致（复用 ``_resolve_port`` + ``_port_open`` +
    ``_terminate_process_group``）。
    """
    env = {**os.environ, 'VITE_API_TARGET': daphne_server}
    port = _resolve_port()
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=str(FRONTEND_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + _VITE_READINESS_TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ''
                raise RuntimeError(f'vite dev server exited early (code {proc.returncode}):\n{out}')
            if _port_open('127.0.0.1', port):
                break
            time.sleep(_VITE_POLL_INTERVAL)
        else:
            raise RuntimeError(
                f'vite dev server not ready on :{port} within {_VITE_READINESS_TIMEOUT}s',
            )
        yield f'http://127.0.0.1:{port}'
    finally:
        _terminate_process_group(proc)


@pytest.fixture
def page_ws(vite_dev_server_ws):
    """L4 用 Playwright page：每 case 独立 browser context + 导航到 Vite（ASGI 后端）。

    与 ``page`` fixture 等价，仅依赖链不同：daphne_server → vite_dev_server_ws → page_ws，
    而非 live_server → vite_dev_server → page。dev hook（``__pinia`` / ``__apiFetch`` 等）
    经 ``context.add_init_script`` 同态注入。
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            context = browser.new_context()
            context.add_init_script(_TEST_HOOKS_INIT_SCRIPT)
            pg = context.new_page()
            pg.goto(vite_dev_server_ws, wait_until='domcontentloaded')
            yield pg
        finally:
            browser.close()

"""回归测试：root ``backend/conftest.py`` 的 ``pytest_configure`` 必须自动备 python 依赖。

契约：任何 pytest 调用（含 ``pytest -m "integration"`` 全量收集）在 **collection 前**
探测 ``requirements/dev.txt`` 的 ``-r`` closure（含 base.txt）中缺失的 pinned
distribution；本地激活 venv 自动安装自愈（如父仓库 .venv 早于 #253 的 redis 创建，
``common/lock/tests`` 顶层 import 会在 collection 期 ImportError——本钩子赶在 collection
前装齐），CI/裸解释器 loud-fail 抛 ``pytest.UsageError``。

三个层面（对齐 workflow 对抗评审的测试建议）：
  1. PARSER 功能性：tmp requirements 树覆盖 ``-r`` 递归 / inline 注释 / 空行 / URL /
     editable / VCS / option 行 / 重复 pin，断言解析出的归一化 dist 名集合。
  2. DECISION 分支：monkeypatch ``importlib.metadata.version`` 抛 ``PackageNotFoundError``
     模拟缺 redis，monkeypatch ``CI`` env / ``sys.prefix`` / install 副作用 → 断言
     all-present=no-op / 本地+venv=install / CI=UsageError / 裸解释器=UsageError。
  3. PLACEMENT 契约：``pytest_configure`` 必须在 root conftest（collection 前），python
     缺口探测**不在** integration conftest 的 session fixture（playwright 等 infra 专属
     deps 才在那）——分工契约，防 redis 探测被挪回 collection 后的 fixture 而失效。
"""
import importlib.util
import inspect
import sys
from pathlib import Path
from unittest import mock

import pytest

# backend/tests/test_root_conftest_bootstrap.py -> backend/tests/ -> backend/
ROOT_CONFTEST = Path(__file__).resolve().parents[1] / 'conftest.py'
INTEGRATION_CONFTEST = Path(__file__).resolve().parent / 'integration' / 'conftest.py'


def _load_module(path, name):
    """按 path 加载 conftest 模块（不执行其 pytest_configure，仅取函数对象）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, f'无法加载 {path}'
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_root():
    return _load_module(ROOT_CONFTEST, 'root_conftest_under_test')


# ═══════════════ 1. PARSER 功能性 ═══════════════

def test_parse_pinned_dist_names_covers_dev_closure(tmp_path):
    """_pinned_dist_names 解析 dev.txt 的 -r closure，覆盖递归/注释/空行/URL/dup。"""
    mod = _load_root()
    base = tmp_path / 'base.txt'
    dev = tmp_path / 'dev.txt'
    base.write_text(
        'Django==6.0.7  # Web 框架\n'
        'redis==8.1.0  # 分布式锁（#253）\n'
        '# 整行注释\n'
        '\n'
        'uvicorn[standard]==0.30.0\n'
        'https://example.com/bare.whl\n'
        '--index-url https://pypi.org/simple\n',
        encoding='utf-8',
    )
    dev.write_text(
        '-r base.txt\n'
        'pytest-django==4.12.0\n'
        'pylint==4.0.6\n'
        'pylint\n'  # 重复 pin（同一 dist 名，取并集）
        'git+https://github.com/x/y.git@main\n'
        '-e ../src/mypkg\n'
        '-c constraints.txt\n',
        encoding='utf-8',
    )
    names = mod._pinned_dist_names(dev)
    assert {'django', 'redis', 'uvicorn', 'pytest-django', 'pylint'} <= names
    assert 'bare' not in names  # 裸 URL 行跳过
    assert 'mypkg' not in names  # editable 行跳过
    assert 'x' not in names and 'y' not in names  # VCS 行跳过
    # PEP 503 归一化：Django → django（大写/连字符归一）
    assert 'django' in names and 'Django' not in names


def test_parse_skips_constraint_recursion(tmp_path):
    """-c constraint 是上限非需求，不得递归为需求（防虚假缺口/多余安装）。"""
    mod = _load_root()
    constraints = tmp_path / 'constraints.txt'
    req = tmp_path / 'req.txt'
    constraints.write_text('redis<5\n', encoding='utf-8')
    req.write_text('-c constraints.txt\npytest==9.1.1\n', encoding='utf-8')
    names = mod._pinned_dist_names(req)
    assert 'redis' not in names, '-c 引用的 constraint 不应被当作需求'
    assert 'pytest' in names


# ═══════════════ 2. DECISION 分支（monkeypatch 缺 redis）═══════════════

class StubConfig:
    """pytest_configure 的轻量 stub config（含 re-exec 需要的 invocation_params）。"""

    def __init__(self, args=None):
        self.invocation_params = mock.Mock(args=args or ['-q'])


def _patch_redis_missing(monkeypatch):
    """让 ``importlib.metadata.version`` 对 ``redis`` 抛 PackageNotFoundError。"""
    real_version = __import__('importlib.metadata').metadata.version
    state = {'redis_installed': False}

    def fake_version(name):
        if name == 'redis' and not state['redis_installed']:
            raise __import__('importlib.metadata').metadata.PackageNotFoundError(name)
        return real_version(name)

    monkeypatch.setattr('importlib.metadata.version', fake_version)
    return state


def test_all_present_is_noop(monkeypatch):
    """全部依赖就绪 → pytest_configure 不安装、不抛错（no-op）。"""
    mod = _load_root()
    monkeypatch.setattr('importlib.metadata.version',
                        __import__('importlib.metadata').metadata.version)
    with mock.patch.object(mod, '_install_dev_requirements') as install:
        mod.pytest_configure(StubConfig())
    assert not install.called, '依赖全就绪时不应触发安装'


def test_local_venv_auto_installs(monkeypatch):
    """本地激活 venv 缺 redis → 自动安装，装后复查通过。"""
    mod = _load_root()
    state = _patch_redis_missing(monkeypatch)
    monkeypatch.delenv('CI', raising=False)
    monkeypatch.setattr('sys.prefix', '/tmp/venv-prefix')
    monkeypatch.setattr('sys.base_prefix', '/usr')  # prefix != base_prefix → venv

    def fake_install():
        state['redis_installed'] = True  # 安装后 redis 就绪

    with mock.patch.object(mod, '_install_dev_requirements',
                           side_effect=fake_install) as install, \
            mock.patch.object(mod.os, 'execv') as execv:
        mod.pytest_configure(StubConfig())  # 不应抛错
    assert install.called, '本地缺 redis 应自动安装'
    assert execv.called, '装完依赖后应 re-exec pytest'


def test_ci_fails_loud_not_install(monkeypatch):
    """CI 环境缺 redis → pytest.UsageError，且不安装（缺口是漂移信号，不静默自愈）。"""
    mod = _load_root()
    _patch_redis_missing(monkeypatch)
    monkeypatch.setenv('CI', 'true')
    with mock.patch.object(mod, '_install_dev_requirements') as install, \
            pytest.raises(pytest.UsageError) as exc_info:
        mod.pytest_configure(StubConfig())
    assert 'redis' in str(exc_info.value)
    assert not install.called, 'CI 环境不得自动安装'


def test_bare_interpreter_fails_loud_not_install(monkeypatch):
    """裸解释器（无激活 venv，prefix==base_prefix）缺 redis → UsageError，不安装。"""
    mod = _load_root()
    _patch_redis_missing(monkeypatch)
    monkeypatch.delenv('CI', raising=False)
    monkeypatch.setattr('sys.prefix', '/usr')
    monkeypatch.setattr('sys.base_prefix', '/usr')  # 相等 → 裸解释器
    with mock.patch.object(mod, '_install_dev_requirements') as install, \
            pytest.raises(pytest.UsageError):
        mod.pytest_configure(StubConfig())
    assert not install.called, '裸解释器不得自动安装（会污染系统 Python）'


def test_install_uses_uv_then_pip(monkeypatch):
    """_install_dev_requirements 优先 uv（VIRTUAL_ENV 指当前 venv），无 uv 回退 pip。"""
    mod = _load_root()
    calls = []
    fake_run = mock.Mock(side_effect=lambda cmd, **kw: calls.append(cmd) or mock.MagicMock(
        returncode=0, stdout='', stderr=''))
    monkeypatch.setattr('shutil.which', lambda name: '/usr/bin/uv' if name == 'uv' else None)
    with mock.patch.object(mod.subprocess, 'run', fake_run):
        mod._install_dev_requirements()
    assert calls and calls[0][:2] == ['uv', 'pip'], '应优先 uv pip install'


# ═══════════════ 3. PLACEMENT 契约 ═══════════════

def test_python_gap_probe_in_root_pytest_configure():
    """python 缺口探测须在 root conftest 的 pytest_configure（collection 前）。

    B 设计者关键发现：integration conftest 的 session fixture 在 collection **后**运行，
    救不了 ``common/lock/tests`` 顶层 import 的 ImportError——探测必须在 root hook。
    本断言锁住该契约：``pytest_configure`` 存在且调用 ``_unsatisfied_pinned_distributions``。
    """
    root = _load_root()
    assert hasattr(root, 'pytest_configure'), 'root conftest 缺少 pytest_configure hook'
    body = inspect.getsource(root.pytest_configure)
    assert '_unsatisfied_pinned_distributions()' in body, (
        'pytest_configure 未调用 python 缺口探测（应自动备 dev.txt closure 依赖）'
    )


def test_integration_fixture_does_not_probe_python_deps():
    """integration conftest 的 bootstrap 不负责 python 缺口探测（分工契约）。

    ``integration_bootstrap`` fixture 只管 integration-infra 专属项（playwright / chromium
    / vite）；python 依赖缺口由 root conftest 处理。防 redis 探测被挪回 collection 后的
    fixture（那样将无法拦截 common/lock/tests 的 collection ImportError）。
    """
    integration = _load_module(INTEGRATION_CONFTEST, 'integration_conftest_placement_under_test')
    src = inspect.getsource(integration)
    assert '_unsatisfied_pinned_distributions' not in src, (
        'integration conftest 不应探测 python pinned 依赖（归 root conftest 管）'
    )
    assert 'importlib.metadata' not in src, (
        'integration conftest 不应 importlib.metadata 探测 python 依赖（归 root conftest）'
    )


def test_install_then_reexec_pytest(monkeypatch):
    """装完依赖后必须 re-exec pytest，激活新装的插件（codex P2 回归）。

    pytest 在启动早期已扫描 ``pytest11`` entry points；``pytest_configure`` 里才装的
    pytest-django / pytest-asyncio 对当前进程不可见（插件未激活），首次运行会
    ImproperlyConfigured（codex P2 实测复现）。修复：装完依赖后 ``os.execv`` 以全新
    进程重跑 pytest（回放 ``config.invocation_params.args``），新进程启动时新插件已在
    entry points、正常激活。本断言锁住该契约。
    """
    mod = _load_root()
    # 依赖缺口存在（redis 缺失）+ 本地 venv → pytest_configure 走 install → re-exec
    state = _patch_redis_missing(monkeypatch)
    monkeypatch.delenv('CI', raising=False)
    monkeypatch.setattr('sys.prefix', '/tmp/venv-prefix')
    monkeypatch.setattr('sys.base_prefix', '/usr')

    def fake_install():
        state['redis_installed'] = True  # 安装后 redis 就绪 → re-exec 后探测为空，不递归

    monkeypatch.setattr(mod, '_install_dev_requirements', fake_install)

    reexec_calls = []
    monkeypatch.setattr(mod.os, 'execv', lambda exe, argv: reexec_calls.append((exe, argv)))

    mod.pytest_configure(StubConfig(args=['-q', 'tests/test_integration_bootstrap_auto.py']))
    assert reexec_calls, '装完依赖后必须 re-exec pytest（激活新装插件）'
    _exe, argv = reexec_calls[0]
    assert argv[:3] == [sys.executable, '-m', 'pytest'], f're-exec 命令错误: {argv}'
    assert argv[3:] == ['-q', 'tests/test_integration_bootstrap_auto.py'], (
        're-exec 必须回放原 pytest 参数'
    )


def test_no_reexec_when_no_install_needed(monkeypatch):
    """依赖全就绪时 pytest_configure 不得 re-exec（no-op，避免无谓重启）。"""
    mod = _load_root()
    monkeypatch.setattr('importlib.metadata.version',
                        __import__('importlib.metadata').metadata.version)
    with mock.patch.object(mod.os, 'execv') as execv:
        mod.pytest_configure(StubConfig())
    assert not execv.called, '依赖全就绪时不应 re-exec pytest'

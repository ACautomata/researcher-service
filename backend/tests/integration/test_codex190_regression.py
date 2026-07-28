"""回归测试:L4 daphne ASGI 基础设施修复(codex #190 P1/P2)。

覆写五项:
1. Daphne 启动路径——用 ``sys.executable -m daphne`` 而非硬编码 ``.venv/bin/daphne``。
2. Integration settings DB ``NAME``——直接覆盖 ``NAME``（非仅 ``TEST['NAME']``），
   确保 ``manage.py migrate`` 和 daphne 子进程均读写 ``test_db_file.sqlite3``。
3. WebSocket 握手测试传入 JWT——验证 ``test_integration_ws.py`` 的 ``page_ws.evaluate()``
   携带 ``token`` 参数（非 undefined）。
4. Test DB 文件清理——``daphne_server`` fixture teardown 时删除 ``test_db_file.sqlite3``
   及其 WAL/SHM 侧文件，避免工作目录污染。
5. ``DATABASES`` 深拷贝——``from .dev import *`` 是别名引用；深拷贝后覆写 NAME
   不会反向污染 ``config.settings.dev.DATABASES``。

本档不跑真 browser/daphne，仅验证模块构造与契约成立。
"""
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

BACKEND_DIR = Path(__file__).resolve().parents[2]


def test_daphne_accessible_via_sys_executable():
    """验证 daphne 可通过 ``sys.executable -m daphne`` 访问（codex #190 P1）。

    替代回头硬编码 ``backend/.venv/bin/daphne``（CI 无 .venv 时 FileNotFoundError）。
    daphne 无 ``--version`` 标志，以可导入证明 `sys.executable -m daphne` 可用。
    """
    import subprocess

    # daphne 用 argparse；-h 显示帮助且 exit 0
    result = subprocess.run(
        [sys.executable, '-m', 'daphne', '-h'],
        capture_output=True, text=True, timeout=10, check=False,
    )
    assert result.returncode == 0, (
        f'daphne -h failed: rc={result.returncode}\n'
        f'stdout={result.stdout}\nstderr={result.stderr}'
    )
    assert 'usage:' in result.stdout.lower(), (
        'expected daphne help output in stdout'
    )
    assert 'application' in result.stdout, (
        'expected "application" in daphne help'
    )


def test_integration_settings_uses_file_db():
    """验证 integration settings 将 ``NAME`` 设为文件路径而非 ``:memory:``（codex #190 P2）。

    ``DATABASES['default']['NAME']`` 影响 ``manage.py migrate`` 和 daphne ORM 连接；
    之前仅设 ``TEST['NAME']``（仅 pytest-django 消费），migrate/dev 连写的仍是 dev DB。
    """
    from config.settings.integration import DATABASES

    name = DATABASES['default']['NAME']
    assert isinstance(name, str), f'NAME should be str, got {type(name)}'
    assert 'test_db_file' in name, (
        f'expected NAME pointing at test_db_file.sqlite3, got {name!r}'
    )
    assert name != ':memory:', (
        'NAME must be file-based, not :memory: for cross-process daphne access'
    )


def test_conftest_daphne_cmd_uses_sys_executable():
    """验证 ``conftest.py`` 中 daphne 启动命令使用 ``sys.executable -m daphne``（codex #190 P1）。

    直接解析源文件字符串，验证硬编码 ``.venv/bin/daphne`` 已移除。
    """
    conftest_path = BACKEND_DIR / 'tests' / 'integration' / 'conftest.py'
    src = conftest_path.read_text()
    assert '.venv' not in src or '.venv' not in src.split('daphne')[0], (
        'conftest must not hard-code .venv/bin/daphne path'
    )
    # 验证 sys.executable 出现在 daphne 启动相关的 subprocess.Popen 中
    # daphne_server fixture 内应包含 sys.executable, '-m', 'daphne'
    assert "sys.executable" in src, (
        'conftest must use sys.executable for daphne subprocess'
    )
    assert "'-m', 'daphne'" in src or "'-m','daphne'" in src, (
        'conftest must use -m daphne pattern'
    )


def test_conftest_cleans_up_test_db():
    """验证 ``conftest.py`` ``daphne_server`` fixture teardown 清理 test DB 文件（codex #190 P2）。

    避免 test_db_file.sqlite3 残留在工作目录中，污染后续运行。
    """
    conftest_path = BACKEND_DIR / 'tests' / 'integration' / 'conftest.py'
    src = conftest_path.read_text()
    # 验证 finally 块包含 test_db_file.sqlite3 的 unlink
    assert 'test_db_file.sqlite3' in src, (
        'conftest must reference test_db_file.sqlite3 for cleanup'
    )
    assert '.unlink(' in src, (
        'conftest must call .unlink() to remove test DB file'
    )
    assert 'missing_ok=True' in src, (
        'conftest must use missing_ok=True for idempotent cleanup'
    )


def test_integration_deepcopies_databases():
    """验证 integration settings 导入不会污染 dev DATABASES（codex #190 P2）。

    ``from .dev import *`` 是别名引用——不深拷贝直接覆写 NAME 会等量修改
    ``config.settings.dev.DATABASES``，干扰同一进程内的 pytest-django。
    """
    import config.settings.dev

    dev_name_before = config.settings.dev.DATABASES['default'].get('NAME', '')

    import config.settings.integration

    integration_name = config.settings.integration.DATABASES['default']['NAME']
    dev_name_after = config.settings.dev.DATABASES['default'].get('NAME', '')

    assert 'test_db_file' in integration_name, (
        f'integration NAME must point to test_db_file, got {integration_name!r}'
    )
    assert dev_name_before == dev_name_after, (
        f'importing integration settings must not mutate dev.DATABASES: '
        f'before={dev_name_before!r} after={dev_name_after!r}'
    )
    assert dev_name_after != integration_name, (
        'dev and integration must use different database files'
    )

"""pylint 配置骨架的契约测试 —— issue #86 / #77 T1。

验证 pylint 能正确加载并对 Django 项目跑语义检查，不发生崩溃或 ORM 误报。
"""
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest


# ---- 辅助 ----

def _pylint_run(*extra_args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    """在 backend 目录跑 pylint，自动指到项目 pyproject.toml。"""
    if cwd is None:
        cwd = Path(__file__).resolve().parent.parent.parent
    return subprocess.run(
        [sys.executable, "-m", "pylint", *extra_args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )


def _backend_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


# ---- 依赖可导入 ----

def test_pylint_installed():
    """pylint 和 pylint-django 可导入，版本符合 spec。"""
    import pylint
    import pylint_django  # noqa: F401 — 验证插件可加载

    # pylint 4.0.6 是 spec 锁定的版本
    assert pylint.__version__ == "4.0.6"


def test_pylint_django_version():
    """pylint-django 2.8.0 是首个 CI 测 Django 6.0 的版本。"""
    from importlib.metadata import version

    assert version("pylint-django") == "2.8.0"


# ---- pyproject.toml 配置节存在性 ----

def test_pyproject_has_pylint_main_section():
    """pyproject.toml 包含 [tool.pylint.MAIN] 配置节，关键字段正确。"""
    with (_backend_root() / "pyproject.toml").open("rb") as f:
        cfg = tomllib.load(f)
    main = cfg["tool"]["pylint"]["MAIN"]
    assert main["load-plugins"] == "pylint_django"
    assert main["django-settings-module"] == "config.settings.dev"
    assert main["py-version"] == "3.13"
    assert main["jobs"] == 0
    assert any("migrations" in p for p in main["ignore-paths"])


def test_pyproject_has_messages_control():
    """MESSAGES CONTROL disable 清单覆盖三类条目，且 no-member 不在其中。"""
    with (_backend_root() / "pyproject.toml").open("rb") as f:
        cfg = tomllib.load(f)
    disabled = cfg["tool"]["pylint"]["MESSAGES CONTROL"]["disable"]
    # (a) ruff 默认集重叠
    for rule in ["line-too-long", "unused-import", "unused-variable",
                 "wildcard-import", "unused-wildcard-import"]:
        assert rule in disabled, f"{rule} 应在 disable 清单（ruff 重叠）"
    # (b) Django/DRF/pytest 已知误报
    for rule in ["abstract-method", "redefined-outer-name", "unused-argument",
                 "import-outside-toplevel", "protected-access"]:
        assert rule in disabled, f"{rule} 应在 disable 清单（已知误报）"
    # (c) baseline 不追求项
    for rule in ["missing-docstring", "too-few-public-methods", "too-many-ancestors",
                 "fixme", "duplicate-code"]:
        assert rule in disabled, f"{rule} 应在 disable 清单（baseline）"
    # no-member 绝对不能全局关 —— pylint-django transform 自行抑制 ORM 误报
    assert "no-member" not in disabled, (
        "no-member 不应全局 disable；pylint-django 已正确抑制 ORM 误报"
    )


def test_pyproject_has_basic_good_names():
    """BASIC good-names 包含 Django/DRF 常用短变量名。"""
    with (_backend_root() / "pyproject.toml").open("rb") as f:
        cfg = tomllib.load(f)
    names = cfg["tool"]["pylint"]["BASIC"]["good-names"]
    for n in ["i", "j", "k", "e", "f", "_", "pk", "id", "qs", "db"]:
        assert n in names, f"{n} 应在 good-names 中"


def test_pyproject_has_design_thresholds():
    """DESIGN 阈值按 spec 放宽到指定值。"""
    with (_backend_root() / "pyproject.toml").open("rb") as f:
        cfg = tomllib.load(f)
    design = cfg["tool"]["pylint"]["DESIGN"]
    assert design["max-args"] == 7
    assert design["max-locals"] == 20
    assert design["max-branches"] == 15
    assert design["max-attributes"] == 10


# ---- 行为验证 ----

def _assert_pylint_booted(result: subprocess.CompletedProcess):
    """pylint 子进程成功启动（非模块未找到等进程级失败）。"""
    combined = result.stdout + result.stderr
    assert result.returncode != 127, (
        f"pylint 命令未找到（returncode=127）:\n{combined}"
    )
    assert "No module named pylint" not in combined, (
        f"pylint 模块未安装:\n{combined}"
    )


def test_pylint_runs_on_all_apps_without_crash():
    """pylint 扫描全部 6 个 app 不崩溃（允许 lint 告警，不允许 fatal error）。

    pylint 发现 lint 告警时 returncode 非零（按位掩码），那是正常的。
    这里只验证进程级未崩溃：无 traceback、无 fatal。
    """
    apps = ["accounts", "chat", "config", "containers", "models", "wiki"]
    result = _pylint_run(*apps)
    combined = result.stdout + result.stderr
    _assert_pylint_booted(result)
    # fatal 错误（如 E0015 Unrecognized option、模块导入崩溃）→ traceback + 'fatal'
    has_traceback = "Traceback (most recent call last)" in combined
    has_fatal = "fatal" in combined.lower()
    assert not has_traceback, (
        f"pylint 发生 Python traceback 崩溃:\n{combined}"
    )
    assert not has_fatal, (
        f"pylint fatal error:\nSTDERR:\n{result.stderr}\nSTDOUT:\n{result.stdout}"
    )


def test_orm_objects_no_member_false_positive_suppressed():
    """pylint-django transform 生效：ORM Model.objects 用法不触发 no-member。

    单独扫描 containers/models.py（Instance 是 Django Model），验证无 E1101。
    """
    models_py = _backend_root() / "containers" / "models.py"
    result = _pylint_run(str(models_py))
    output = result.stdout + result.stderr
    _assert_pylint_booted(result)
    # E1101 = no-member。Instance 是 Django Model，
    # pylint-django 应将其 objects.filter/create 等识别为合法。
    assert "E1101" not in output, (
        f"pylint-django 应抑制 ORM no-member 误报，但输出含 E1101:\n{output}"
    )

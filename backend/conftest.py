"""Root pytest conftest（backend/）：collection 前自动备齐 backend 开发依赖。

``pytest_configure`` 钩子（pytest 在 **collection 之前**执行）探测 ``requirements/dev.txt``
的 ``-r`` closure（含 base.txt）中缺失的 pinned distribution，缺失时：

  - 本地激活的 venv：自动 ``uv pip install -r requirements/dev.txt``（回退 pip）自愈——
    这是「跑测试前自动执行 setup」的核心：父仓库 .venv 常早于 base.txt 新依赖（如 #253
    加 redis）创建，顶层 import（``common/lock/tests`` 等）会在 collection 期 ImportError；
    本钩子赶在 collection 前装齐，把 opaque 的 ModuleNotFoundError 变成自动修复。
  - CI 环境或缺激活 venv 的裸解释器：抛 ``pytest.UsageError`` 给出缺失清单与手动命令
    （CI 的依赖缺口是缓存/锁漂移信号，应 loud-fail 暴露而非静默自愈；裸解释器自动安装
    会污染系统 Python）。

与 ``tests/integration/conftest.py`` 的 session 级 ``integration_bootstrap`` fixture 分工：
本文件管 **python 依赖缺口**（必须 collection 前处理）；那个 fixture 管 integration-infra
专属项（playwright 客户端 / chromium / frontend node_modules，只在真跑 integration case
时准备）。backend-unit job 装 dev.txt（含 base）、integration job 装 integration.txt（dev
超集）→ 两个 job 里本钩子探测的 pinned dist 全在 → 是 ~N 次 stdlib metadata 探测的 no-op。

探测只查「distribution 缺失」（``importlib.metadata.PackageNotFoundError``），不做版本
比较——版本修复交给幂等的 uv/pip install（resolver 正确性优于手写 SpecifierSet 版本数学，
后者在 CI 不可确定性复现）。``-c`` constraint / URL / editable / VCS 行不探测（constraint
是上限非需求，递归会造虚假缺口），docstring 明确探测覆盖 pinned-name requirements 子集。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent
_DEV_REQUIREMENTS = BACKEND_DIR / 'requirements' / 'dev.txt'

# PEP 503 distribution 名归一化：[-_.]+ → '-', 全小写（importlib.metadata.version 接受）
_NORMALIZE_RE = re.compile(r'[-_.]+')


def pytest_configure(config):
    """collection 前：探测缺失的 pinned 依赖，本地自动装 / CI·裸解释器 loud-fail。

    装完依赖后必须 **re-exec pytest**：pytest 在启动早期就已扫描 ``pytest11`` entry
    points 并激活插件；``pytest_configure`` 里才装的 pytest-django / pytest-asyncio 对
    当前进程不可见（插件未激活）——首次运行会 ImproperlyConfigured（codex P2）。故装完
    用 ``os.execv`` 以全新进程重跑，新进程启动时新插件已在 entry points 里、正常激活。
    re-exec 后依赖已就绪，``_unsatisfied_pinned_distributions()`` 为空 → 直接返回，不递归。
    """
    unsatisfied = _unsatisfied_pinned_distributions()
    if not unsatisfied:
        return
    reason = _auto_install_blocked_reason()
    if reason:
        raise pytest.UsageError(
            'backend 开发依赖缺失（未自动安装）：\n  - ' + '\n  - '.join(unsatisfied) + '\n'
            + reason,
        )
    _install_dev_requirements()
    remaining = _unsatisfied_pinned_distributions()
    if remaining:
        raise pytest.UsageError(
            'backend 开发依赖自动安装后仍有缺失：\n  - ' + '\n  - '.join(remaining) + '\n'
            '请手动执行 `uv pip install -r requirements/dev.txt`（或 `pip install -r '
            'requirements/dev.txt`）后重跑。',
        )
    _reexec_pytest(config)


def _reexec_pytest(config) -> None:
    """用全新进程重跑 pytest（回放原调用参数），激活新装的插件（codex P2）。

    ``config.invocation_params.args`` 即原 pytest argv（``pytest <args>`` 的 <args>），
    re-exec 为 ``python -m pytest <args>`` 完整保留用户意图；若用户直接调 ``pytest``
    脚本而非 ``python -m``，``sys.executable -m pytest`` 亦等价。
    """
    os.execv(sys.executable, [sys.executable, '-m', 'pytest', *config.invocation_params.args])


def _pinned_dist_names(root: Path) -> set[str]:
    """解析 requirements 文件的 ``-r`` closure，返回 PEP 503 归一化的 pinned dist 名。

    覆盖 ``name==ver`` / 范围 specifier 行（经 ``packaging.Requirement`` 取 name）；
    跳过 inline/整行注释、空行、option 行（``--index-url`` 等）、URL / editable / VCS
    行，以及 ``-c`` constraint（constraint 是上限非需求，递归会造虚假缺口）。
    """
    from packaging.requirements import InvalidRequirement, Requirement

    names: set[str] = set()
    seen: set[Path] = set()

    def _walk(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        for line in path.read_text(encoding='utf-8').splitlines():
            raw = line.strip()
            if not raw or raw.startswith('#'):
                continue
            # inline comment 需空格前缀（`daphne==4.2.1  # Channels 要求`），不误伤无空格 #
            raw = re.split(r'\s+#', raw, maxsplit=1)[0].rstrip()
            if not raw:
                continue
            if raw.startswith(('-r', '--requirement')):
                ref = raw.split(None, 1)[1].strip()
                _walk(path.parent / ref)
                continue
            if raw.startswith(('-c', '--constraint', '-e', '--editable')):
                continue
            if raw.startswith((
                'git+', 'hg+', 'svn+', 'bzr+',
                'http://', 'https://', 'file://',
            )):
                continue
            if raw.startswith('-'):
                continue  # 其他 option 行
            try:
                name = Requirement(raw).name
            except InvalidRequirement:
                continue  # 无法解析的非 requirement 行，跳过
            names.add(_NORMALIZE_RE.sub('-', name).lower())

    _walk(root)
    return names


def _unsatisfied_pinned_distributions() -> list[str]:
    """``dev.txt`` closure 中缺失（未安装）的 pinned distribution 名（归一化，排序）。"""
    from importlib import metadata

    missing = []
    for name in sorted(_pinned_dist_names(_DEV_REQUIREMENTS)):
        try:
            metadata.version(name)
        except metadata.PackageNotFoundError:
            missing.append(name)
    return missing


def _auto_install_blocked_reason() -> str | None:
    """自动安装被阻断则返回原因（CI / 无激活 venv）；本地 venv 可自愈返回 None。"""
    if os.environ.get('CI'):
        return '（CI 环境不自动安装——依赖缺口是缓存/锁漂移信号，请核对 requirements）'
    if sys.prefix == sys.base_prefix:
        return '（当前是裸解释器、无激活 venv——自动安装会污染系统 Python，请先建 venv）'
    return None


def _install_dev_requirements() -> None:
    """装 ``requirements/dev.txt`` 进当前 venv（uv 优先、回退 pip）。幂等。

    uv venv 无 pip 模块（``python -m pip`` 直接 ModuleNotFoundError），故优先 uv（经
    ``VIRTUAL_ENV`` 指当前 venv）；CI 的 setup-python venv 自带 pip，回退路径兜底。
    """
    req = str(_DEV_REQUIREMENTS)
    if shutil.which('uv'):
        env = {**os.environ, 'VIRTUAL_ENV': sys.prefix}
        proc = subprocess.run(
            ['uv', 'pip', 'install', '-r', req],
            cwd=str(BACKEND_DIR), env=env, capture_output=True, text=True, check=False,
        )
        if proc.returncode == 0:
            return
        raise RuntimeError(f'uv pip install 失败（code {proc.returncode}）：\n{proc.stderr}')
    proc = subprocess.run(
        [sys.executable, '-m', 'pip', 'install', '-r', req],
        cwd=str(BACKEND_DIR), capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'pip install 失败（code {proc.returncode}）：\n'
            f'stdout={proc.stdout}\nstderr={proc.stderr}',
        )

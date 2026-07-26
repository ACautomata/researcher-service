"""CI 工作流契约测试。

被测 seam：``.github/workflows/ci.yml`` —— 解析后的 GitHub Actions 工作流文档。
真值源：issue #91 验收标准（CI skeleton + frontend job）。重构步骤命名等内部细节
不破坏本测试，只要 trigger/jobs/steps 契约成立。
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

# backend/tests/test_ci_workflow.py -> backend/tests/ -> backend/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"

# lockfile 暴露的 Node 约束偶数主版本号（=LTS 系列），用于判定 node-version 对齐 LTS
LTS_NODE_MAJORS = {"20", "22", "24", "26"}


def _load() -> dict:
    if not WORKFLOW.exists():
        pytest.fail(f"工作流不存在：{WORKFLOW}")
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _trigger(workflow: dict):
    # YAML 1.1 把裸键 "on" 解析为布尔 True（PyYAML 已知行为），两种键形态都兼容。
    return workflow["on"] if "on" in workflow else workflow.get(True)


def _frontend_job(workflow: dict) -> dict:
    jobs = workflow["jobs"]
    assert "frontend" in jobs, "缺少 frontend job"
    return jobs["frontend"]


def test_workflow_file_exists_and_parseable() -> None:
    """AC1：ci.yml 存在且为合法 YAML。"""
    _load()  # 缺文件 / 语法错均经 _load() 抛 fail


def test_triggers_only_on_push() -> None:
    """AC2：仅 ``on: push`` 触发，不加 PR/定时/路径过滤。"""
    assert _trigger(_load()) == "push"


def test_has_frontend_job_on_ubuntu_latest() -> None:
    """AC4：frontend job 跑在 ubuntu-latest。"""
    frontend = _frontend_job(_load())
    assert frontend["runs-on"] == "ubuntu-latest"


def test_no_fail_fast_false() -> None:
    """AC5：不设 ``fail-fast: false``（任一 job 红即 fail，无需等其余 job）。"""
    frontend = _frontend_job(_load())
    strategy = frontend.get("strategy") or {}
    assert strategy.get("fail-fast", True) is not False


def _setup_node_step(frontend: dict) -> dict | None:
    for step in frontend.get("steps", []):
        if step.get("uses", "").startswith("actions/setup-node"):
            return step
    return None


def test_frontend_job_runs_setup_node_with_npm_cache() -> None:
    """AC3：``actions/setup-node`` 带 ``cache: npm`` 并指向 frontend lockfile。"""
    step = _setup_node_step(_frontend_job(_load()))
    assert step is not None, "缺少 actions/setup-node 步骤"
    with_ = step.get("with") or {}
    assert with_.get("cache") == "npm"
    assert with_.get("cache-dependency-path") == "frontend/package-lock.json"


def test_frontend_job_uses_lts_node() -> None:
    """AC：Node 版本对齐 ``frontend/package-lock.json`` 的 LTS（lts/* 别名或偶数 LTS 主版本）。"""
    step = _setup_node_step(_frontend_job(_load()))
    assert step is not None, "缺少 actions/setup-node 步骤"
    node_version = (step.get("with") or {}).get("node-version")
    assert node_version is not None, "setup-node 未声明 node-version"
    assert node_version == "lts/*" or str(node_version).split(".", maxsplit=1)[0] in LTS_NODE_MAJORS


def test_frontend_job_working_directory_is_frontend() -> None:
    """AC3：frontend job 全程在 ``frontend/`` 工作目录（job 或顶层 defaults）。"""
    workflow = _load()
    frontend = _frontend_job(workflow)
    top_default = (workflow.get("defaults") or {}).get("run", {}).get("working-directory")
    job_default = (frontend.get("defaults") or {}).get("run", {}).get("working-directory")
    assert job_default == "frontend" or top_default == "frontend"


def test_frontend_job_runs_required_step_sequence() -> None:
    """AC3：步骤序 setup-node → npm ci → npm run test → npm run build。"""
    steps = _frontend_job(_load())["steps"]

    def step_index(predicate, label: str) -> int:
        for i, step in enumerate(steps):
            if predicate(step):
                return i
        return pytest.fail(f"步骤缺失：{label}")

    setup = step_index(lambda s: s.get("uses", "").startswith("actions/setup-node"), "setup-node")
    ci = step_index(lambda s: "npm ci" in (s.get("run") or ""), "npm ci")
    test = step_index(lambda s: "npm run test" in (s.get("run") or ""), "npm run test")
    build = step_index(lambda s: "npm run build" in (s.get("run") or ""), "npm run build")
    assert setup < ci < test < build

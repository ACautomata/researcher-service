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
CD_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "cd.yml"

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


def _backend_unit_job(workflow: dict) -> dict:
    jobs = workflow["jobs"]
    assert "backend-unit" in jobs, "缺少 backend-unit job"
    return jobs["backend-unit"]


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


def test_has_backend_unit_job_on_ubuntu_latest() -> None:
    """AC5：backend-unit job 跑在 ubuntu-latest。"""
    backend_unit = _backend_unit_job(_load())
    assert backend_unit["runs-on"] == "ubuntu-latest"


def test_backend_unit_runs_parallel_with_frontend() -> None:
    """AC1：backend-unit 与 frontend 并行——不 needs frontend。"""
    backend_unit = _backend_unit_job(_load())
    needs = backend_unit.get("needs")
    if needs is None:
        return
    if isinstance(needs, str):
        needs = [needs]
    assert "frontend" not in needs, "backend-unit 不应 needs frontend（须并行）"


def _setup_python_step(backend_unit: dict) -> dict | None:
    for step in backend_unit.get("steps", []):
        if step.get("uses", "").startswith("actions/setup-python"):
            return step
    return None


def test_backend_unit_runs_setup_python_with_pip_cache() -> None:
    """AC2：``actions/setup-python``（3.13，``cache: pip``，指向 backend lockfile）。"""
    step = _setup_python_step(_backend_unit_job(_load()))
    assert step is not None, "缺少 actions/setup-python 步骤"
    with_ = step.get("with") or {}
    assert with_.get("python-version") == "3.13"
    assert with_.get("cache") == "pip"
    assert with_.get("cache-dependency-path") == "backend/requirements/dev.txt"


def test_backend_unit_working_directory_is_backend() -> None:
    """AC3/4：backend-unit 全程在 ``backend/`` 工作目录（job 或顶层 defaults）。"""
    workflow = _load()
    backend_unit = _backend_unit_job(workflow)
    top_default = (workflow.get("defaults") or {}).get("run", {}).get("working-directory")
    job_default = (backend_unit.get("defaults") or {}).get("run", {}).get("working-directory")
    assert job_default == "backend" or top_default == "backend"


def test_backend_unit_runs_pip_install_dev_requirements() -> None:
    """AC3：``pip install -r requirements/dev.txt``（backend 工作目录下）。"""
    steps = _backend_unit_job(_load())["steps"]
    assert any(
        "pip install" in (s.get("run") or "") and "requirements/dev.txt" in (s.get("run") or "")
        for s in steps
    ), "缺少 pip install -r requirements/dev.txt 步骤"


def test_backend_unit_runs_pytest_without_integration_data() -> None:
    """AC4：``python -m pytest`` 步骤存在，且不设集成测试数据 env（OPENCLAW_TEMPLATE_DIR/LLM_API_KEY）。

    真容器用例靠 docker daemon 探测 + 数据 env 缺失双 skip（不再用 RUN_INTEGRATION 门控），
    故 CI backend-unit 即使装了 docker，也会因缺数据 env 在用例内 skip。
    """
    backend_unit = _backend_unit_job(_load())
    steps = backend_unit["steps"]
    assert any("pytest" in (s.get("run") or "") for s in steps), "缺少 python -m pytest 步骤"
    for key in ("OPENCLAW_TEMPLATE_DIR", "LLM_API_KEY"):
        assert key not in (backend_unit.get("env") or {}), (
            f"backend-unit 不应设 {key}（集成测试数据，CI 不跑真容器）"
        )
        for step in steps:
            assert key not in (step.get("env") or {}), (
                f"backend-unit step 不应设 {key}（集成测试数据，CI 不跑真容器）"
            )


def _pylint_step(backend_unit: dict) -> dict | None:
    for step in backend_unit.get("steps", []):
        if "pylint" in (step.get("run") or ""):
            return step
    return None


def test_backend_unit_runs_pylint_after_pytest() -> None:
    """AC1（#93）：backend-unit 在 pytest 之后串行 pylint（同 job，依赖 pip install 后环境）。"""
    steps = _backend_unit_job(_load())["steps"]
    pytest_idx = next(
        (i for i, s in enumerate(steps) if "pytest" in (s.get("run") or "")),
        None,
    )
    assert pytest_idx is not None, "缺少 python -m pytest 步骤"
    pylint_step = _pylint_step({"steps": steps})
    assert pylint_step is not None, "缺少 pylint 步骤"
    assert steps.index(pylint_step) > pytest_idx, "pylint 必须在 pytest 之后串行"


def test_backend_unit_pylint_command_targets_six_apps() -> None:
    """AC2（#93）：``pylint accounts chat config containers models wiki``（working-directory: backend）。"""
    step = _pylint_step(_backend_unit_job(_load()))
    assert step is not None, "缺少 pylint 步骤"
    run = step.get("run") or ""
    assert "pylint" in run, "pylint 步骤未调用 pylint"
    for app in ("accounts", "chat", "config", "containers", "models", "wiki"):
        assert app in run, f"pylint 目标缺少 app：{app}"


def test_backend_unit_pylint_is_quality_gate() -> None:
    """AC3（#93）：pylint 退出码非零即 job 红——步骤不豁免失败（无 ``continue-on-error``）。"""
    step = _pylint_step(_backend_unit_job(_load()))
    assert step is not None, "缺少 pylint 步骤"
    assert step.get("continue-on-error") is not True, "pylint 步骤不应 continue-on-error（须作为质量门）"


def test_backend_unit_pylint_no_django_settings_env_fallback() -> None:
    """AC4（#93）：pylint 读 pyproject.toml 的 django-settings-module（#77），不设 env 兜底。"""
    backend_unit = _backend_unit_job(_load())
    env_sources = [backend_unit.get("env") or {}]
    env_sources.extend(s.get("env") or {} for s in backend_unit["steps"])
    for env in env_sources:
        assert "DJANGO_SETTINGS_MODULE" not in env, (
            "不应为 pylint 设 DJANGO_SETTINGS_MODULE env 兜底（配置已在 pyproject.toml）"
        )


# ---- CD workflow 契约（#266）----


def _cd_load() -> dict:
    if not CD_WORKFLOW.exists():
        pytest.fail(f"工作流不存在：{CD_WORKFLOW}")
    return yaml.safe_load(CD_WORKFLOW.read_text(encoding="utf-8"))


def _cd_deploy_steps(workflow: dict) -> list:
    jobs = workflow["jobs"]
    assert "deploy" in jobs, "CD 缺少 deploy job"
    return jobs["deploy"]["steps"]


def _cd_normalize_run(steps: list) -> str:
    for step in steps:
        if (step.get("name") or "").startswith("Normalize image repo"):
            return step.get("run") or ""
    return pytest.fail("CD 缺少 Normalize image repo 步骤")


def test_cd_workflow_file_exists_and_parseable() -> None:
    """CD：cd.yml 存在且为合法 YAML。"""
    _cd_load()


def test_cd_temporarily_disabled_workflow_dispatch_only() -> None:
    """CD：当前临时禁用——触发降级为仅 workflow_dispatch（后端迁 TS/Express，#331）。

    恢复自动部署 = 在 cd.yml 还原 ``on: workflow_run``（见 cd.yml on 块注释）。临时禁用期
    deploy job 的 if 守卫仍引用 workflow_run 数据 → 手动触发亦安全跳过（等效完全禁用），
    该守卫由 test_cd_deploy_gated_on_ci_success 单独锁定。
    """
    data = _cd_load()
    # YAML 1.1 把裸键 "on" 解析为布尔 True（PyYAML 已知行为），与 _trigger() 同理。
    on = data.get(True) if True in data else data.get("on")
    assert "workflow_run" not in on, "CD 已临时禁用，不应自动 workflow_run 触发"
    assert "workflow_dispatch" in on, "CD 保留 workflow_dispatch 手动触发入口"


def test_cd_deploy_gated_on_ci_success() -> None:
    """CD：deploy job 由 CI conclusion==success 门控。"""
    data = _cd_load()
    job = data["jobs"]["deploy"]
    assert job.get("if") == "${{ github.event.workflow_run.conclusion == 'success' }}"


def test_cd_image_repo_lowercased_not_raw_github_repository() -> None:
    """CD：镜像仓库名必须全小写——owner 混大小写（ACautomata）会触发 buildx
    "repository name must be lowercase" 校验失败（CI 绿但 CD 必败的 #193 bug）。

    真值路径：Normalize step 经 shell ``tr '[:upper:]' '[:lower:]'`` 归一
    ``$GITHUB_REPOSITORY``（github.repository 的运行时等价物），而非在表达式层
    直接用 ``github.repository``（表达式无大小写转换函数，case 是 switch）。
    """
    run = _cd_normalize_run(_cd_deploy_steps(_cd_load()))
    assert "tr '[:upper:]' '[:lower:]'" in run, "必须用 tr 归一小写"
    assert "GITHUB_REPOSITORY" in run, "归一化必须基于 GITHUB_REPOSITORY"
    assert "echo \"IMAGE_REPO=${IMAGE_REPO}\" >> \"$GITHUB_ENV\"" in run, (
        "必须把小写结果写回 $GITHUB_ENV"
    )
    # 镜像名不再直接引用 github.repository（owner 可能含大写）
    data = _cd_load()
    env_sources = [data["jobs"]["deploy"].get("env") or {}]
    env_sources.extend(s.get("env") or {} for s in data["jobs"]["deploy"]["steps"])
    for env in env_sources:
        assert "github.repository" not in str(env), (
            "CD 镜像名不应引用原始 github.repository（owner 可能含大写）"
        )


def _cd_deploy_script(steps: list) -> str:
    for step in steps:
        if (step.get("name") or "").startswith("Deploy over SSH"):
            # appleboy/ssh-action 的远端脚本在 with.script（非顶层 run）
            return (step.get("with") or {}).get("script") or ""
    return pytest.fail("CD 缺少 Deploy over SSH 步骤")


def test_cd_ssh_script_specifies_deploy_compose_file() -> None:
    """CD：SSH 部署脚本的 docker compose 命令必须显式 ``-f docker-compose.deploy.yml``。

    scp 落盘的是 docker-compose.deploy.yml（非默认名 compose.yml/docker-compose.yml），
    缺 -f 会让 pull/up/ps 报 "no configuration file provided: not found"，
    SSH 部署失败（#283 合并后 CD 第 2 层故障）。健康门失败分支的 ps 同样需 -f。
    """
    script = _cd_deploy_script(_cd_deploy_steps(_cd_load()))
    # 每个 docker compose 调用都必须带 -f docker-compose.deploy.yml
    for cmd in (
        "docker compose -f docker-compose.deploy.yml pull",
        "docker compose -f docker-compose.deploy.yml up -d --remove-orphans",
        "docker compose -f docker-compose.deploy.yml ps",
    ):
        assert cmd in script, f"缺少显式 compose 文件参数：{cmd}"
    # 禁止裸 docker compose（无 -f）
    for line in script.splitlines():
        stripped = line.strip()
        if stripped.startswith("docker compose") and "-f" not in stripped:
            pytest.fail(f"docker compose 调用缺 -f 显式指定：{stripped}")

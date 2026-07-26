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


def test_backend_unit_runs_pytest_without_run_integration() -> None:
    """AC4：``python -m pytest`` 步骤存在，且不设 ``RUN_INTEGRATION``（真容器用例维持 skip）。"""
    backend_unit = _backend_unit_job(_load())
    steps = backend_unit["steps"]
    assert any("pytest" in (s.get("run") or "") for s in steps), "缺少 python -m pytest 步骤"
    assert "RUN_INTEGRATION" not in (backend_unit.get("env") or {}), (
        "backend-unit 不应设 RUN_INTEGRATION"
    )
    for step in steps:
        assert "RUN_INTEGRATION" not in (step.get("env") or {}), (
            "backend-unit step 不应设 RUN_INTEGRATION"
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


# ============================ container-smoke job（issue #95）============================
# 被测 seam 同前：.github/workflows/ci.yml。真值源：issue #95 九条验收标准。
# 备注（user 决定的 override）：LLM_API_KEY 引真 ${{ secrets.LLM_API_KEY }}，覆盖 issue 的
# 「不在本票引入 GitHub Secret 真实 LLM key」一条；本组断言只锚「引 secret 变量 + 不在脚本
# 文本回显其值」，不锚密钥字面值（防 CI 日志泄露真实 key 由 GitHub secret 掩码 + 不回显双保）。

# pin 具体 digest（勿用浮动 latest/tag——tag 可变，供应链可被重推恶意镜像；digest immutable）。
# 与 ci.yml 单一真值同步；digest 经 Docker Hub API 核实（2026-07-27，= latest/main-3c68ead，
# 见 docs/research/r6-docker-image-mount.md）。
OPENCLAW_IMAGE = (
    "acautomata/openclaw-docker-cn-im:2026.7.1"
    "@sha256:d66052d90733e2c054b71e32be066ade802f870bedac7a31ebaf13cd61af2624"
)


def _container_smoke_job(workflow: dict) -> dict:
    jobs = workflow["jobs"]
    assert "container-smoke" in jobs, "缺少 container-smoke job"
    return jobs["container-smoke"]


def _steps_text(job: dict) -> str:
    """job 内所有 step 的 run 脚本拼接（供 grep 类断言）。"""
    return "\n".join(s.get("run") or "" for s in job.get("steps", []))


def test_container_smoke_exists_and_parallel() -> None:
    """AC1：container-smoke 与 frontend / backend-unit 并行（无 needs，独立 job）。"""
    job = _container_smoke_job(_load())
    assert job.get("needs") is None, "container-smoke 不应 needs（须与 frontend/backend-unit 并行）"


def test_container_smoke_on_ubuntu_latest() -> None:
    """AC9：container-smoke 跑在 ubuntu-latest（自带 Docker daemon）。"""
    job = _container_smoke_job(_load())
    assert job["runs-on"] == "ubuntu-latest"


def test_container_smoke_timeout_minutes() -> None:
    """AC4：job 设 generous timeout-minutes 20。"""
    job = _container_smoke_job(_load())
    assert job.get("timeout-minutes") == 20


def test_container_smoke_env_contract() -> None:
    """AC2：job env 设 RUN_INTEGRATION=1 / digest-pin 的 OPENCLAW_IMAGE / OPENCLAW_TEMPLATE_DIR。
    （LLM_API_KEY 的注入与收窄由 test_container_smoke_secret_scoped_to_needed_step 锚定。）"""
    env = _container_smoke_job(_load()).get("env") or {}
    assert env.get("RUN_INTEGRATION") == "1"
    image = env.get("OPENCLAW_IMAGE")
    assert image == OPENCLAW_IMAGE, f"OPENCLAW_IMAGE 须 pin digest：{image}"
    assert "@sha256:" in str(image), "须按 immutable digest pin（防 tag 重推供应链投毒）"
    assert not str(image).endswith(":latest"), "勿用浮动 latest"
    assert "OPENCLAW_TEMPLATE_DIR" in env, "env 缺 OPENCLAW_TEMPLATE_DIR"


def test_container_smoke_secret_scoped_to_needed_step() -> None:
    """AC8 强化（安全审查）：LLM_API_KEY 仅注入需它的 pytest 步骤（step 级 env），
    不暴露给 checkout/cache/pull/cleanup 等无关步骤。"""
    job = _container_smoke_job(_load())
    job_env = job.get("env") or {}
    assert "LLM_API_KEY" not in job_env, (
        "LLM_API_KEY 不应放 job 级 env（应 step 级收窄暴露面）"
    )
    holders = [s for s in job["steps"] if "LLM_API_KEY" in (s.get("env") or {})]
    assert len(holders) == 1, f"LLM_API_KEY 应仅注入单一步骤，实际 {len(holders)} 个"
    holder = holders[0]
    assert "pytest" in (holder.get("run") or ""), (
        "LLM_API_KEY 应仅注入跑集成测试的 pytest 步骤"
    )
    assert holder["env"]["LLM_API_KEY"] == "${{ secrets.LLM_API_KEY }}"


def test_container_smoke_caches_docker_image() -> None:
    """AC3：actions/cache 缓存 docker 镜像 tar，key 含 OPENCLAW_IMAGE，命中免首拉。"""
    job = _container_smoke_job(_load())
    cache_steps = [s for s in job["steps"] if s.get("uses", "").startswith("actions/cache")]
    assert cache_steps, "缺少 actions/cache 步骤"
    found = False
    for step in cache_steps:
        with_ = step.get("with") or {}
        key = str(with_.get("key", ""))
        if "OPENCLAW_IMAGE" in key:
            found = True
    assert found, "cache key 应含 OPENCLAW_IMAGE（命中免首拉）"


def test_container_smoke_docker_save_load_uses_image_env() -> None:
    """AC3：docker save/load tar 路径与镜像 ref 均从 $OPENCLAW_IMAGE 取（与 cache key 同源）。"""
    text = _steps_text(_container_smoke_job(_load()))
    assert "docker save" in text, "缺 docker save 步骤"
    assert "docker load" in text, "缺 docker load 步骤"
    assert "$OPENCLAW_IMAGE" in text, "docker save/load 应引用 $OPENCLAW_IMAGE env"


def test_container_smoke_pull_has_bounded_retry() -> None:
    """AC5：镜像拉取步骤带 1–2 次有限重试（bounded retry 循环），非无限。"""
    steps = _container_smoke_job(_load())["steps"]
    pull_steps = [s for s in steps if "docker pull" in (s.get("run") or "")]
    assert pull_steps, "缺少 docker pull 步骤"
    for step in pull_steps:
        run = step.get("run") or ""
        assert "for" in run and "docker pull" in run, "docker pull 应在有限重试循环内"
        assert "break" in run, "重试循环成功须 break（非无条件循环）"


def test_container_smoke_readiness_polling_not_fixed_sleep() -> None:
    """AC6：就绪等待走轮询（integration test 内 GatewayReadinessWaiter），CI 层无固定长 sleep 站岗。"""
    text = _steps_text(_container_smoke_job(_load()))
    # 关键：不能出现「docker run 后裸 sleep 等网关就绪」模式（就绪轮询已在 #94 集成测试内）。
    # pull 重试循环里的 `sleep 5` 是重试退避、非就绪站岗，故只禁长 sleep（≥30s）。
    assert "sleep 30" not in text and "sleep 60" not in text, "禁用固定长 sleep 代替就绪轮询"


def test_container_smoke_cleanup_runs_always() -> None:
    """AC7：清理步骤带 if: always()，无论成败跑，且用 fleet label 精准删除容器。"""
    job = _container_smoke_job(_load())
    cleanup_steps = [
        s for s in job["steps"]
        if "always()" in str(s.get("if", ""))
    ]
    assert cleanup_steps, "缺少 if: always() 清理步骤"
    found = any("docker" in (s.get("run") or "") for s in cleanup_steps)
    assert found, "清理步骤应包含 docker 容器清理"
    text = "\n".join(s.get("run") or "" for s in cleanup_steps)
    assert "app=openclaw-fleet" in text, "清理应按 fleet label 精准删除，不误删非本 job 容器"


def test_container_smoke_no_real_llm_key_in_logs() -> None:
    """AC8：CI 日志不输出真实 LLM key——任何 run 脚本不 echo/print $LLM_API_KEY 字面值。"""
    job = _container_smoke_job(_load())
    for step in job.get("steps", []):
        run = step.get("run") or ""
        assert "echo $LLM_API_KEY" not in run
        assert "echo ${LLM_API_KEY}" not in run
        assert "printenv LLM_API_KEY" not in run
        assert "echo \"$LLM_API_KEY\"" not in run


def test_container_smoke_runs_integration_pytest_once_no_retry() -> None:
    """AC5：断言（集成测试）不重试——pytest 步骤无 retry 循环、无 continue-on-error。"""
    job = _container_smoke_job(_load())
    pytest_steps = [s for s in job["steps"] if "pytest" in (s.get("run") or "")]
    assert pytest_steps, "缺少 python -m pytest 步骤"
    for step in pytest_steps:
        assert "for" not in (step.get("run") or ""), "断言步骤不应包重试循环（避免掩盖真回归）"
        assert step.get("continue-on-error") is not True, "集成测试须作为质量门（非 continue-on-error）"
        assert "RUN_INTEGRATION" in str(step.get("env") or {}) or "RUN_INTEGRATION" in str(job.get("env") or {}), (
            "集成测试步骤须继承 RUN_INTEGRATION=1"
        )

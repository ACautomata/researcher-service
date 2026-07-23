"""issue #16 部署骨架的接缝测试。

唯一可测接缝 = 部署交付物的静态内容（compose / deploy/openclaw.json / env.example / config.py 暴露的配置面）。
Docker 在本开发机不可用，故 `curl /health` 不在此自动化——见 deploy/README.md 的手动验证步骤。

每个测试名对应一条 issue 16 验收标准，预期值取自 issue 正文与 docs/REFACTOR-SPEC.md 阶段 1/5。
配置单一来源是本仓库的 deploy/openclaw.json，compose 挂载覆盖 researcher 的同名文件（researcher 仓库不动）。
"""
import importlib
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)


def _load_config_fresh(monkeypatch, **env):
    """在受控 env 下重新 import config，返回模块（避免与其他测试的 import 缓存串扰）。"""
    for key in ("RESEARCHER_CONFIG_PATH", "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import config

    importlib.reload(config)
    return config


# --- 验收 1：compose 起 openclaw-gateway，researcher 挂到 /home/node/.openclaw ---

def test_service_uses_openclaw_cn_image(gateway_service):
    assert gateway_service["image"].startswith("${OPENCLAW_IMAGE:-acautomata/openclaw-docker-cn-im")


def test_researcher_bind_mounted_to_openclaw_home(gateway_service):
    volumes = gateway_service["volumes"]
    assert any(
        isinstance(v, str) and v.endswith(":/home/node/.openclaw") and "researcher" in v
        for v in volumes
    ), "researcher 仓库根必须 bind-mount 到 /home/node/.openclaw"


def test_researcher_dir_resolves_to_repo_root_not_deploy(gateway_service):
    """P1 回归：compose 相对路径解析自 project directory(=deploy/)，故 researcher 源须指向仓库根。

    README 指示 `git clone ... ./researcher` 于仓库根；若默认 `./researcher` 会解析成
    deploy/researcher（不存在→compose 自建空目录），导致 workspace/wiki/skills 全缺失（验收 #1）。
    """
    volumes = [v for v in gateway_service["volumes"] if isinstance(v, str)]
    researcher_vol = next(
        v for v in volumes
        if v.endswith(":/home/node/.openclaw") and "researcher" in v
    )
    # 挂载串形如 "${RESEARCHER_DIR:-../researcher}:/home/node/.openclaw"；
    # source 含 ${VAR:-...} 的冒号，故按目标锚点切，取 ":/home..." 之前的全部。
    source = researcher_vol[: -len(":/home/node/.openclaw")]
    # 解析基准是 deploy/，故指向仓库根的 researcher 默认值须是 ../researcher（或显式 RESEARCHER_DIR 覆盖）。
    assert "../researcher" in source, (
        f"researcher 挂载源须解析到仓库根（默认应含 ../researcher），实际: {source}"
    )


def test_runtime_state_and_logs_use_anonymous_volumes(gateway_service):
    volumes = [v for v in gateway_service["volumes"] if isinstance(v, str)]
    assert any(v.endswith(":/home/node/.openclaw/state") and not v.startswith(".") for v in volumes)
    assert any(v.endswith(":/home/node/.openclaw/logs") and not v.startswith(".") for v in volumes)


# --- 验收 2：4 个 sync flag 全关；LLM_API_KEY 走 env；GATEWAY_TOKEN 注入；不设 ALLOW_INSECURE_AUTH ---

def test_all_four_sync_flags_disabled(gateway_env):
    assert gateway_env.get("SYNC_OPENCLAW_CONFIG") == "false"
    assert gateway_env.get("SYNC_MODEL_CONFIG") == "false"
    assert gateway_env.get("SYNC_EXTENSIONS_ON_START") == "false"
    assert gateway_env.get("SYNC_EXTENSIONS_MODE") == "none"


def test_llm_api_key_injected_via_env_not_written_to_disk(gateway_env):
    # 凭证经 env 注入，由 researcher openclaw.json 的 SecretRef 运行时读，不写盘。
    assert gateway_env.get("LLM_API_KEY") == "${LLM_API_KEY}"


def test_gateway_token_injected(gateway_env):
    assert gateway_env.get("GATEWAY_TOKEN") == "${GATEWAY_TOKEN}"


def test_no_insecure_auth_flag_anywhere(gateway_env):
    for key in gateway_env:
        assert "INSECURE" not in key.upper(), f"不得设置 {key}（token 认证始终强制）"


def test_plugins_enabled_for_memory_wiki(gateway_env):
    assert gateway_env.get("OPENCLAW_PLUGINS_ENABLED") == "true"


# --- 验收 3：channels 全禁 ---

def test_channels_fully_disabled(gateway_env):
    assert gateway_env.get("DM_POLICY") == "disabled"
    assert gateway_env.get("GROUP_POLICY") == "disabled"
    assert gateway_env.get("ALLOW_FROM") == ""


# --- 验收 4：端口 127.0.0.1:18789:18789 ---

def test_port_bound_to_loopback_18789(gateway_service):
    ports = gateway_service["ports"]
    assert any(
        isinstance(p, str) and p.endswith(":18789:18789") and "127.0.0.1" in p
        for p in ports
    ), "端口必须收敛到宿主 loopback 127.0.0.1:18789:18789"


# --- deploy/.env.example：必填项占位 ---

def test_deploy_env_example_has_required_placeholders(deploy_env_example):
    assert "GATEWAY_TOKEN=" in deploy_env_example
    assert "LLM_API_KEY=" in deploy_env_example


def test_deploy_env_example_documents_researcher_dir(deploy_env_example):
    assert "RESEARCHER_DIR" in deploy_env_example


# --- 验收 5 / issue body：config.py 暴露 RESEARCHER_CONFIG_PATH ---

def test_config_exposes_researcher_config_path_default(monkeypatch):
    config = _load_config_fresh(monkeypatch)
    assert config.RESEARCHER_CONFIG_PATH == "./deploy/openclaw.json"


def test_config_researcher_config_path_env_override(monkeypatch):
    config = _load_config_fresh(monkeypatch, RESEARCHER_CONFIG_PATH="/tmp/custom/openclaw.json")
    assert config.RESEARCHER_CONFIG_PATH == "/tmp/custom/openclaw.json"


def test_root_env_example_documents_researcher_config_path(root_env_example):
    assert "RESEARCHER_CONFIG_PATH" in root_env_example


# --- compose 文件本身可被 compose 解析（结构性 go/no-go；不依赖 docker daemon）---

def test_compose_file_is_valid_yaml_with_single_service(compose):
    assert set(compose["services"].keys()) == {"openclaw-gateway"}


# --- 验收：本仓库 deploy/openclaw.json 是精简版，且 compose 挂载覆盖 researcher 的同名文件 ---
# 精简范围（已拍板）：删 channels、bindings、lossless-claw；
# 保留 browser（顶层+entry）、memory-core、minimax、memory-wiki；contextEngine=legacy。

def test_compose_overrides_openclaw_json_from_deploy(gateway_service):
    """本仓库 deploy/openclaw.json 单独 bind-mount 覆盖 researcher 的同名文件。

    挂载源写成相对 compose 文件（deploy/）的 ./openclaw.json，断言落点（容器路径）而非源路径字面量。
    """
    volumes = [v for v in gateway_service["volumes"] if isinstance(v, str)]
    assert any(
        v.endswith(":/home/node/.openclaw/openclaw.json")
        for v in volumes
    ), "compose 必须把本仓库 deploy/openclaw.json 挂载覆盖到 /home/node/.openclaw/openclaw.json"


def test_openclaw_config_drops_channels_and_bindings(openclaw_config):
    assert "channels" not in openclaw_config
    assert "bindings" not in openclaw_config


def test_openclaw_config_drops_lossless_claw(openclaw_config):
    plugins = openclaw_config["plugins"]
    assert "lossless-claw" not in plugins["entries"]
    assert "lossless-claw" not in plugins.get("installs", {})
    assert plugins["slots"]["contextEngine"] == "legacy"


def test_openclaw_config_keeps_browser_and_memory_core(openclaw_config):
    assert "browser" in openclaw_config, "顶层 browser 保留"
    entries = openclaw_config["plugins"]["entries"]
    assert entries.get("browser", {}).get("enabled") is True, "plugins.entries.browser 保留"
    assert "memory-core" in entries, "plugins.entries.memory-core 保留"


def test_openclaw_config_keeps_minimax_and_memory_wiki(openclaw_config):
    entries = openclaw_config["plugins"]["entries"]
    assert entries["minimax"]["enabled"] is True
    assert entries["memory-wiki"]["enabled"] is True, "memory-wiki 必须 enable（支撑 Wiki 页）"


def test_openclaw_config_token_uses_env_placeholder(openclaw_config):
    assert openclaw_config["gateway"]["auth"]["token"] == "${GATEWAY_TOKEN}"


def test_openclaw_config_gateway_bind_is_lan(openclaw_config):
    """P2 回归：sync 全关后 env 覆盖 gateway.bind 的行为不可依赖，JSON 须直接 bind lan。

    FastAPI 在宿主/邻容器经 18789 访问网关；bind=loopback 时 Docker 端口映射不到容器内
    loopback，`curl /health` 不可达（验收 #4）。R8 §5 把 gateway.bind 改 lan 列为必改。
    """
    assert openclaw_config["gateway"]["bind"] == "lan"


def test_openclaw_config_insecure_auth_disabled(openclaw_config):
    """token 认证始终强制：Control UI 的 insecure-auth 降级路径也须关闭（codex 安全建议）。"""
    assert openclaw_config["gateway"]["controlUi"]["allowInsecureAuth"] is False


def test_openclaw_config_single_main_agent(openclaw_config):
    agents = openclaw_config["agents"]["list"]
    assert [a["id"] for a in agents] == ["main"]

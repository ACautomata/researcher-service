"""issue #22 apply-config 去 Docker 化 + ocstatus 简化的接缝测试。

接缝 = FastAPI 路由 POST /openclaw/apply-config + GET /openclaw/status。
- apply-config 只写 RESEARCHER_CONFIG_PATH 的 models.providers + agents.defaults.model（单 main），
  无子 agent auth-profiles 产物、无 docker cp、不明文写 .env；写完触发重启钩子（注入 spy 断言，不真跑 docker）。
- status 只报 gateway + 容器 + main，无 subagent_count / agent_count / is_subagent 维度。
"""
import json

import pytest


@pytest.mark.asyncio
async def test_apply_config_writes_only_model_config_single_main(openclaw_apply):
    """apply-config 只写 models.providers + agents.defaults.model，无子 agent 产物。"""
    client, cfg_path, restart_hook = openclaw_apply

    r = await client.post("/api/v1/openclaw/apply-config", json={
        "api_base": "https://api.deepseek.com/anthropic",
        "api_key": "sk-test",
        "api_model": "deepseek-v4-pro",
    })
    assert r.status_code == 200, r.text

    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    # 写了 provider（deepseek 推断）
    providers = data["models"]["providers"]
    assert "deepseek" in providers
    assert providers["deepseek"]["baseUrl"] == "https://api.deepseek.com/anthropic"
    # 单 main：agents.defaults.model.primary 指向新 provider
    assert data["agents"]["defaults"]["model"]["primary"] == "deepseek/deepseek-v4-pro"


@pytest.mark.asyncio
async def test_apply_config_uses_researcher_config_path_env(openclaw_apply):
    """配置路径走 RESEARCHER_CONFIG_PATH（fixture 已指向 tmp 路径，写入即证明生效）。"""
    client, cfg_path, _ = openclaw_apply
    r = await client.post("/api/v1/openclaw/apply-config", json={
        "api_base": "https://api.anthropic.com", "api_key": "k",
    })
    assert r.status_code == 200
    assert cfg_path.is_file(), "应写入 RESEARCHER_CONFIG_PATH 指向的 tmp 路径"


@pytest.mark.asyncio
async def test_apply_config_triggers_restart_hook(openclaw_apply):
    """写完触发重启钩子（docker compose restart 生效），测试注入 spy 断言被调用。"""
    client, _, restart_hook = openclaw_apply
    r = await client.post("/api/v1/openclaw/apply-config", json={
        "api_base": "https://api.deepseek.com", "api_key": "k",
    })
    assert r.status_code == 200
    assert restart_hook.called, "应触发重启钩子以生效配置"


@pytest.mark.asyncio
async def test_apply_config_no_subagent_auth_profiles(openclaw_apply, tmp_path):
    """不生成任何子 agent auth-profiles 产物（autoresearch/paper-review/idea-generate）。"""
    client, cfg_path, _ = openclaw_apply
    await client.post("/api/v1/openclaw/apply-config", json={
        "api_base": "https://api.deepseek.com", "api_key": "k",
    })
    # 在 tmp 树下不应出现任何 agents/<sub>/agent/auth-profiles.json
    stray = list(tmp_path.rglob("auth-profiles.json"))
    assert not stray, f"不应生成子 agent auth-profiles: {stray}"
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    # auth.profiles 不含子 agent 条目
    profiles = data.get("auth", {}).get("profiles", {})
    for key in profiles:
        assert "autoresearch" not in key and "paper-review" not in key and "idea-generate" not in key


@pytest.mark.asyncio
async def test_status_reports_gateway_and_main_only(openclaw_status):
    """status 只报 gateway 可达性 + 容器 + main，无 subagent 维度。"""
    client = openclaw_status
    r = await client.get("/api/v1/openclaw/status")
    assert r.status_code == 200, r.text
    s = r.json()
    assert "gateway" in s
    assert "container" in s
    assert "agents" in s
    # 单 main：agent 列表只有 main
    assert [a["id"] for a in s["agents"]] == ["main"]
    # 去 subagent 维度
    assert "subagent_count" not in s
    assert "agent_count" not in s
    for a in s["agents"]:
        assert "is_subagent" not in a

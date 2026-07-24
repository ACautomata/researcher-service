"""seam: openclaw.json 渲染 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.2（Jinja 渲染、配置单一来源、token 经 env 注入 +
${GATEWAY_TOKEN} 占位不落盘、gateway.port 容器内固定 18789、bind=lan、apiKey env id=LLM_API_KEY）。
模板来源 = deploy/openclaw.json（单容器 compose 同一份，DRY）。
"""
import json
from pathlib import Path

import pytest

from containers.config_renderer import ConfigRenderer

# 模板真源：仓库根 deploy/openclaw.json（test 文件在 backend/containers/tests/ 下，parents[3]=repo root）
DEPLOY_TEMPLATE = Path(__file__).resolve().parents[3] / 'deploy' / 'openclaw.json'


@pytest.fixture
def template_text() -> str:
    return DEPLOY_TEMPLATE.read_text()


def test_render_produces_valid_json(template_text):
    # spec §5.2：渲染产物须是合法 JSON（容器 gateway 解析）
    out = ConfigRenderer(template_text).render()
    json.loads(out)  # 不抛即合法


def test_gateway_port_fixed_18789(template_text):
    # spec §5.2：容器内统一 18789（宿主侧才分配映射端口，见 ports.py）
    cfg = json.loads(ConfigRenderer(template_text).render())
    assert cfg['gateway']['port'] == 18789


def test_gateway_bind_is_lan(template_text):
    # r27 §4.2：bind=lan，控制面跨容器/宿主经 HTTP 访问 18789 必需
    cfg = json.loads(ConfigRenderer(template_text).render())
    assert cfg['gateway']['bind'] == 'lan'


def test_token_is_env_placeholder_not_real_secret(template_text):
    # spec §5.2 安全不变量：token 经 env 注入，JSON 内仅 ${GATEWAY_TOKEN} 占位，
    # 真值绝不落盘（DB 存 token 供后端 WS 握手，但 JSON 文件里是占位）。
    cfg = json.loads(ConfigRenderer(template_text).render())
    assert cfg['gateway']['auth']['token'] == '${GATEWAY_TOKEN}'


def test_llm_api_key_env_id(template_text):
    # spec §5.2 [决策]：全面板共享一个 LLM_API_KEY（SecretRef env id）
    cfg = json.loads(ConfigRenderer(template_text).render())
    provider = cfg['models']['providers']['minimax']
    assert provider['apiKey']['id'] == 'LLM_API_KEY'
    assert provider['apiKey']['source'] == 'env'


def test_wiki_path_points_at_home(template_text):
    # spec §5.6：wiki = ~/.openclaw/wiki/main（bind-mount home 内）
    cfg = json.loads(ConfigRenderer(template_text).render())
    assert cfg['plugins']['entries']['memory-wiki']['config']['vault']['path'] == '~/.openclaw/wiki/main'


def test_render_forces_invariants_against_tampered_template():
    # 核心安全价值：即便模板被污染（token 写了真值、port 改了），renderer 强制修正回 spec 不变量。
    # 防止「真 token 意外落盘进 bind-mount 的 openclaw.json」（spec §5.2 token 不落盘）。
    tampered = json.loads(DEPLOY_TEMPLATE.read_text())
    tampered['gateway']['port'] = 9999
    tampered['gateway']['bind'] = 'loopback'
    tampered['gateway']['auth']['token'] = 'real-secret-DO-NOT-LEAK'
    renderer = ConfigRenderer(json.dumps(tampered))
    cfg = json.loads(renderer.render())
    assert cfg['gateway']['port'] == 18789
    assert cfg['gateway']['bind'] == 'lan'
    assert cfg['gateway']['auth']['token'] == '${GATEWAY_TOKEN}'


def test_render_rejects_invalid_template_json():
    # 模板须合法 JSON；损坏模板应在构造期失败（fail-fast，非静默产出坏配置）
    with pytest.raises(json.JSONDecodeError):
        ConfigRenderer('{ not valid json')

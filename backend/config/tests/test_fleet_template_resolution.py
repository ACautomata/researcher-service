"""settings.OPENCLAW_FLEET['TEMPLATE'] 模板路径解析回归测试 —— codex P2 :141。

验证 deploy/.env.example 承诺的 RESEARCHER_DIR 被 fleet 控制面兑现，而非被无视后
copytree 到默认不存在路径（→ 容器卡 creating，本 PR 要修的同类配置错配）。

优先级：OPENCLAW_TEMPLATE_DIR（绝对，CI/生产）> RESEARCHER_DIR（deploy/ 相对或绝对）
> 默认 <repo>/researcher。相对 RESEARCHER_DIR 相对 <repo>/deploy 解析，对齐 .env.example
注释「相对路径基准是 compose 文件所在目录（deploy/）」。
"""
import importlib
import os

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.settings import base
from config.settings._validation import validate_prod_env

_ENV_KEYS = ('OPENCLAW_TEMPLATE_DIR', 'RESEARCHER_DIR',
             'LLM_API_KEY', 'OPENCLAW_FLEET_WS_SCHEME', 'OPENCLAW_FLEET_WS_HOST')


@pytest.fixture(autouse=True)
def _isolate_template_env():
    """每个用例前后清空/还原受测 env 并重载 base，避免污染其它读取 base 模块的测试。"""
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is not None:
            os.environ[k] = v
        else:
            os.environ.pop(k, None)
    importlib.reload(base)  # 还原 base 模块到原始 env 解析状态


def _reload_with_env(**env) -> object:
    for k, v in env.items():
        os.environ[k] = v
    return importlib.reload(base)


def test_researcher_dir_absolute_is_used_verbatim():
    """绝对 RESEARCHER_DIR 直接作为模板路径（host 上 copytree 源）。"""
    mod = _reload_with_env(RESEARCHER_DIR='/opt/custom/researcher')
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == '/opt/custom/researcher'


def test_researcher_dir_relative_resolved_against_deploy_dir():
    """相对 RESEARCHER_DIR 相对 <repo>/deploy 解析，与 .env.example 注释一致。"""
    mod = _reload_with_env(RESEARCHER_DIR='../researcher')
    deploy_dir = mod.BASE_DIR.parent / 'deploy'
    # ../researcher 从 deploy/ → <repo>/researcher，与默认 TEMPLATE_DEFAULT 同位（规范路径）
    assert os.path.normpath(mod.OPENCLAW_FLEET['TEMPLATE']) == os.path.normpath(str(deploy_dir / '..' / 'researcher'))
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == mod.TEMPLATE_DEFAULT


def test_openclaw_template_dir_precedence():
    """OPENCLAW_TEMPLATE_DIR 优先于 RESEARCHER_DIR（CI/生产绝对路径覆盖）。"""
    mod = _reload_with_env(OPENCLAW_TEMPLATE_DIR='/ci/fleet-template',
                           RESEARCHER_DIR='/should/be/ignored')
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == '/ci/fleet-template'


def test_default_when_neither_set():
    """两者皆未设 → 默认 <repo>/researcher（回归默认路径仍工作）。"""
    mod = _reload_with_env()
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == mod.TEMPLATE_DEFAULT


@pytest.mark.parametrize('rel', ['../researcher', './researcher', 'researcher'])
def test_relative_researcher_dir_stays_within_repo_tree(rel):
    """任意相对 RESEARCHER_DIR 都相对 deploy/ 解析（不再落到默认不存在路径）。"""
    mod = _reload_with_env(RESEARCHER_DIR=rel)
    deploy_dir = mod.BASE_DIR.parent / 'deploy'
    assert os.path.normpath(mod.OPENCLAW_FLEET['TEMPLATE']) == os.path.normpath(str(deploy_dir / rel))


def test_default_template_path_is_dev_fallback_with_prod_fail_fast():
    """2902641 决策：base.py 模板默认是 dev fallback ``<repo>/researcher``（与本仓库并排
    克隆的 researcher），生产/Docker 部署必须经 ``OPENCLAW_TEMPLATE_DIR`` 显式注入绝对路径
    （prod.py 启动时 ``validate_prod_env`` fail-fast 校验缺失/相对路径 → ImproperlyConfigured）。

    历史 codex P1 :287325b 期望"默认是 /srv/openclaw/template/researcher"，但 2902641
    选 path 2：保持默认是 dev-friendly 路径 + 强制生产注入（更安全，旧部署漏配即启动拒）。
    该契约需要默认 dev 工作流仍能 ``copytree`` 找到 researcher（dev 默认并排克隆
    ``../researcher``），生产走 validator fail-fast 兜底——两契约并存。
    """
    mod = _reload_with_env()
    # OPENCLAW_TEMPLATE_DIR 未设时，base.py 默认是 <repo>/researcher（dev fallback）。
    # 生产/Docker 部署必须经 OPENCLAW_TEMPLATE_DIR 注入绝对路径（validator 强制）。
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == mod.TEMPLATE_DEFAULT
    assert mod.OPENCLAW_FLEET['TEMPLATE'] == str(mod.BASE_DIR.parent / 'researcher')

    # prod fail-fast 兜底：OPENCLAW_TEMPLATE_DIR 缺失/相对路径仍拒启动。
    # LLM_API_KEY 给齐，确保拒启动落在 TEMPLATE_DIR 分支而非 LLM_API_KEY 分支
    # （issue #258 起 LLM_API_KEY 也是生产必填，缺失会先于 TEMPLATE_DIR 触发）。
    with pytest.raises(ImproperlyConfigured):
        validate_prod_env({
            'DJANGO_ALLOWED_HOSTS': 'example.test',
            'LLM_API_KEY': 'sk-prod-test',
            # OPENCLAW_TEMPLATE_DIR 故意缺失
        })
    with pytest.raises(ImproperlyConfigured):
        validate_prod_env({
            'DJANGO_ALLOWED_HOSTS': 'example.test',
            'LLM_API_KEY': 'sk-prod-test',
            'OPENCLAW_TEMPLATE_DIR': 'researcher',  # 相对路径
        })


# ---- seam 2：ADR 0005 配置边界 settings 声明解析（issue #257）----
# fleet 配置与配对 WS 配置是 base.py 的环境变量声明落点：runtime 一律经 settings 取值，
# 不在 app 里裸读 os.environ。这里测声明解析本身（默认 + 环境覆盖），与模板解析同 seam。


def test_llm_api_key_declared_default_empty():
    """ADR 0005：OPENCLAW_FLEET 增 LLM_API_KEY 键，读环境、默认空串（dev/integration 宽容）。

    生产必填 fail-fast 在 prod.py 的 validate_prod_env（见 test_settings_prod.py）；
    base 这一层保持宽容，缺省给空串——integration CI 靠 env 注入跑真容器，base 不强制非空。
    """
    mod = _reload_with_env()
    assert 'LLM_API_KEY' in mod.OPENCLAW_FLEET
    assert mod.OPENCLAW_FLEET['LLM_API_KEY'] == ''


def test_llm_api_key_env_override_reflected():
    """环境注入 LLM_API_KEY 后，settings.OPENCLAW_FLEET 反映新值（编排经此取，不再裸读 env）。"""
    mod = _reload_with_env(LLM_API_KEY='sk-test-123')
    assert mod.OPENCLAW_FLEET['LLM_API_KEY'] == 'sk-test-123'


def test_fleet_ws_defaults_ws_and_loopback():
    """ADR 0005：新增配对 WS 配置声明，scheme/host 默认 ws/127.0.0.1（本地零配置可用）。"""
    mod = _reload_with_env()
    assert mod.OPENCLAW_FLEET_WS['SCHEME'] == 'ws'
    assert mod.OPENCLAW_FLEET_WS['HOST'] == '127.0.0.1'


def test_fleet_ws_env_override_reflected():
    """环境覆盖 scheme/host 后 settings 反映新值（配对经此取；wss/lan 绑定由部署注入）。"""
    mod = _reload_with_env(OPENCLAW_FLEET_WS_SCHEME='wss',
                           OPENCLAW_FLEET_WS_HOST='0.0.0.0')
    assert mod.OPENCLAW_FLEET_WS['SCHEME'] == 'wss'
    assert mod.OPENCLAW_FLEET_WS['HOST'] == '0.0.0.0'

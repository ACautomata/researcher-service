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

from config.settings import base

_ENV_KEYS = ('OPENCLAW_TEMPLATE_DIR', 'RESEARCHER_DIR')


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

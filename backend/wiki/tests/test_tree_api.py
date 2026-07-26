"""seam: wiki tree REST API —— issue #45 文件树（spec §6）+ issue #83 物理化。

端点：GET /api/v1/containers/<name>/wiki/tree。
wiki 直读宿主 instances/<name>/home/wiki/main（spec §6），不经容器 gateway。
验收映射：wiki 页左侧文件树展示该容器 wiki/main 结构（issue #45 验收 1）；
issue #83：文件树照实平铺磁盘真实结构，对任意目录（含开放 domain 与未知目录）都能分组。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()
pytestmark = pytest.mark.django_db


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


# ---------------------------- 认证拦截（spec §3）----------------------------


def test_tree_requires_auth(api, instance):
    assert api.get('/api/v1/containers/demo/wiki/tree').status_code == 401


# ---------------------------- 物理结构分组（issue #83）----------------------------


def test_tree_groups_mirror_real_subdirs(authed, instance):
    """分组 = wiki/main 根目录真实子目录，不写死五分类；未知目录也成组。"""
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    assert resp.status_code == 200
    kinds = {g['kind'] for g in resp.json()['groups']}
    # fixture 物理存在且有页的子目录：concepts/domains + 未知目录 experiments
    assert {'concepts', 'domains', 'experiments'} <= kinds
    # entities/sources 物理存在但为空目录 → 不成组（照实平铺，无页即无组）
    assert 'entities' not in kinds
    assert 'sources' not in kinds
    # 组名 = 目录名（kind 与 name 同取目录名，不再硬编码 concept/entity/… 五分类键）
    by_kind = {g['kind']: g for g in resp.json()['groups']}
    assert by_kind['experiments']['name'] == 'experiments'


def test_tree_no_longer_assumes_five_categories(authed, instance):
    """五分类之外不出现空占位组：syntheses/reports 物理不存在 → 不成组。"""
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    kinds = {g['kind'] for g in resp.json()['groups']}
    assert 'syntheses' not in kinds
    assert 'reports' not in kinds
    assert 'concept' not in kinds  # 旧五分类单数键已废


def test_tree_lists_pages_with_path(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    concepts = next(g for g in resp.json()['groups'] if g['kind'] == 'concepts')
    paths = {p['path'] for p in concepts['pages']}
    assert 'concepts/attention.md' in paths
    # 每页带标题（frontmatter title）
    page = next(p for p in concepts['pages'] if p['path'] == 'concepts/attention.md')
    assert page['title'] == 'Attention'


def test_tree_skips_plugin_private_and_index(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    all_paths = {p['path'] for g in resp.json()['groups'] for p in g['pages']}
    # .openclaw-wiki 与顶层 index.md 不进树
    assert not any('.openclaw-wiki' in p for p in all_paths)
    assert 'index.md' not in all_paths
    # 插件私有目录本身也不成组
    kinds = {g['kind'] for g in resp.json()['groups']}
    assert '.openclaw-wiki' not in kinds


def test_tree_domain_pages_under_domains(authed, instance):
    """开放 domain 子树：domains/<d>/papers/ 下的页归入 domains 组。"""
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    domains = next(g for g in resp.json()['groups'] if g['kind'] == 'domains')
    paths = {p['path'] for p in domains['pages']}
    assert 'domains/cv/papers/resnet.md' in paths


def test_tree_unknown_dir_pages_grouped(authed, instance):
    """未知目录 experiments 下的页照实进 experiments 组。"""
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    experiments = next(g for g in resp.json()['groups'] if g['kind'] == 'experiments')
    paths = {p['path'] for p in experiments['pages']}
    assert 'experiments/trial-1.md' in paths


def test_tree_unknown_instance_404(authed, db):
    assert authed.get('/api/v1/containers/nope/wiki/tree').status_code == 404


def test_tree_invalid_name_400(authed, db):
    # 大写/非法字符能匹配 <str:name> 路由但通不过 NAME_VALIDATOR → 400
    # （'/' 永远进不了 name 段，会被 URL 解析 404，故不在此测）
    assert authed.get('/api/v1/containers/Bad_Name/wiki/tree').status_code == 400

"""seam: wiki tree REST API —— issue #45 文件树（spec §6）。

端点：GET /api/v1/containers/<name>/wiki/tree。
wiki 直读宿主 instances/<name>/home/wiki/main（spec §6），不经容器 gateway。
验收映射：wiki 页左侧文件树展示该容器 wiki/main 结构（issue #45 验收 1）。
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


# ---------------------------- 文件树结构（验收 1）----------------------------


def test_tree_returns_five_core_kinds(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    assert resp.status_code == 200
    data = resp.json()
    kinds = {g['kind'] for g in data['groups']}
    # 五核心分类 + domains 子树
    assert {'concept', 'entity', 'source', 'synthesis', 'report', 'domain'} <= kinds


def test_tree_lists_pages_with_path(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    concept = next(g for g in resp.json()['groups'] if g['kind'] == 'concept')
    paths = {p['path'] for p in concept['pages']}
    assert 'concepts/attention.md' in paths
    # 每页带标题（frontmatter title）
    page = next(p for p in concept['pages'] if p['path'] == 'concepts/attention.md')
    assert page['title'] == 'Attention'


def test_tree_skips_plugin_private_and_index(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    all_paths = {p['path'] for g in resp.json()['groups'] for p in g['pages']}
    # .openclaw-wiki 与顶层 index.md 不进树
    assert not any('.openclaw-wiki' in p for p in all_paths)
    assert 'index.md' not in all_paths


def test_tree_domain_pages_under_domains(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/tree')
    domain = next(g for g in resp.json()['groups'] if g['kind'] == 'domain')
    paths = {p['path'] for p in domain['pages']}
    assert 'domains/cv/papers/resnet.md' in paths


def test_tree_unknown_instance_404(authed, db):
    assert authed.get('/api/v1/containers/nope/wiki/tree').status_code == 404


def test_tree_invalid_name_400(authed, db):
    # 大写/非法字符能匹配 <str:name> 路由但通不过 NAME_VALIDATOR → 400
    # （'/' 永远进不了 name 段，会被 URL 解析 404，故不在此测）
    assert authed.get('/api/v1/containers/Bad_Name/wiki/tree').status_code == 400

"""seam: wiki graph REST API —— 全库图谱（spec §6，r29 §3.3 方案 B）。

端点：GET /api/v1/containers/<name>/wiki/graph。
节点 = 后端遍历文件树（跳过 .openclaw-wiki/index）；边 = 解析正文 [[wikilink]]
（+可选 frontmatter related_pages/source_pages）。匹配不到已有节点的 wikilink 生成 ghost 节点。
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


def test_graph_requires_auth(api, instance):
    assert api.get('/api/v1/containers/demo/wiki/graph').status_code == 401


def test_graph_nodes_from_tree(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/graph')
    assert resp.status_code == 200
    node_ids = {n['id'] for n in resp.json()['nodes']}
    assert 'concepts/attention.md' in node_ids
    assert 'domains/cv/papers/resnet.md' in node_ids


def test_graph_edges_from_wikilinks(authed, instance):
    # concepts/attention.md 正文含 [[self-attention]]（无对应页 → ghost 节点）
    resp = authed.get('/api/v1/containers/demo/wiki/graph')
    data = resp.json()
    edges = {(e['from'], e['to']) for e in data['edges']}
    assert ('concepts/attention.md', 'self-attention') in edges
    # ghost 节点也出现在 nodes 中（标记 ghost）
    ghost = next(n for n in data['nodes'] if n['id'] == 'self-attention')
    assert ghost.get('ghost') is True


def test_graph_edges_from_frontmatter_related(authed, instance):
    # domains/cv/papers/resnet.md frontmatter related_pages: [attention] → 指向 attention 页
    resp = authed.get('/api/v1/containers/demo/wiki/graph')
    edges = {(e['from'], e['to']) for e in resp.json()['edges']}
    assert ('domains/cv/papers/resnet.md', 'concepts/attention.md') in edges


def test_graph_unknown_instance_404(authed, db):
    assert authed.get('/api/v1/containers/nope/wiki/graph').status_code == 404

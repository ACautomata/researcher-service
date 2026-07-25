"""seam: wiki page 读取 REST API —— issue #45 编辑器内容加载（spec §6）。

端点：GET /api/v1/containers/<name>/wiki/page?path=<相对 wiki/main 的 .md>。
验收映射：点开任意 md 进编辑器实时渲染（验收 2 的读取侧）。
path 注入（目录穿越/绝对路径/反斜杠）一律拒绝（验收 3）。
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


def test_read_requires_auth(api, instance):
    resp = api.get('/api/v1/containers/demo/wiki/page?path=concepts/attention.md')
    assert resp.status_code == 401


def test_read_returns_content(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/page?path=concepts/attention.md')
    assert resp.status_code == 200
    data = resp.json()
    assert data['path'] == 'concepts/attention.md'
    assert data['title'] == 'Attention'
    assert '# Attention' in data['content']


def test_read_domain_page(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/page?path=domains/cv/papers/resnet.md')
    assert resp.status_code == 200
    assert resp.json()['title'] == 'ResNet'


def test_read_missing_page_404(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/page?path=concepts/nope.md')
    assert resp.status_code == 404


# ---------------------------- path 注入拒绝（验收 3）----------------------------


@pytest.mark.parametrize('bad', [
    '../../../etc/passwd.md',       # 目录穿越
    '..%2F..%2Fsecret.md',          # 编码穿越（DRF 解码后含 ..）
    '/etc/passwd.md',               # 绝对路径
    'concepts\\..\\secret.md',      # 反斜杠穿越
    'concepts/attention',           # 非 .md
])
def test_read_rejects_path_injection(authed, instance, bad):
    resp = authed.get(f'/api/v1/containers/demo/wiki/page?path={bad}')
    assert resp.status_code == 400, f'path 注入未被拒: {bad}'


def test_read_rejects_empty_path(authed, instance):
    resp = authed.get('/api/v1/containers/demo/wiki/page?path=')
    assert resp.status_code == 400

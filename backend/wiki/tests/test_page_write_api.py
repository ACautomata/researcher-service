"""seam: wiki page 写入/新建/删除 REST API —— issue #45（spec §6 / r29）。

端点：PUT/POST/DELETE /api/v1/containers/<name>/wiki/page。
验收映射：
- 编辑防抖自动落盘到对应容器（验收 2 写入侧，PUT 覆盖已存在页）
- 新建/删除页面后端落盘并触发 compile（验收 3）
- path 注入被拒（验收 3）
compile 触发经 CompileFleet 注入 fake 断言（不碰真 docker）。
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


# ---------------------------- PUT 覆盖已存在页（验收 2 写入侧）----------------------------


def test_update_requires_auth(api, instance):
    resp = api.put('/api/v1/containers/demo/wiki/page',
                   {'path': 'concepts/attention.md', 'content': 'x'}, format='json')
    assert resp.status_code == 401


def test_update_overwrites_existing(authed, instance, wiki_home):
    resp = authed.put('/api/v1/containers/demo/wiki/page',
                      {'path': 'concepts/attention.md', 'content': '# 已编辑\n'}, format='json')
    assert resp.status_code == 200
    # 落盘到对应容器 home
    saved = (wiki_home / 'wiki' / 'main' / 'concepts' / 'attention.md').read_text(encoding='utf-8')
    assert saved == '# 已编辑\n'


def test_update_missing_page_404(authed, instance):
    resp = authed.put('/api/v1/containers/demo/wiki/page',
                      {'path': 'concepts/nope.md', 'content': 'x'}, format='json')
    assert resp.status_code == 404


def test_update_does_not_trigger_compile(authed, instance, fake_compile):
    # 编辑是低频人工操作，浏览页即时一致，不主动触发 compile（r29 §2.3）
    authed.put('/api/v1/containers/demo/wiki/page',
               {'path': 'concepts/attention.md', 'content': 'x'}, format='json')
    assert fake_compile == []


# ---------------------------- POST 新建（验收 3）----------------------------


def test_create_writes_and_triggers_compile(authed, instance, wiki_home, fake_compile):
    resp = authed.post('/api/v1/containers/demo/wiki/page',
                       {'path': 'concepts/transformer.md',
                        'content': '---\ntitle: Transformer\n---\n# T\n'}, format='json')
    assert resp.status_code == 201
    assert (wiki_home / 'wiki' / 'main' / 'concepts' / 'transformer.md').exists()
    # 新建触发 compile（同步机器视图索引）
    assert fake_compile == ['demo']


def test_create_existing_409(authed, instance):
    resp = authed.post('/api/v1/containers/demo/wiki/page',
                       {'path': 'concepts/attention.md', 'content': 'x'}, format='json')
    assert resp.status_code == 409


def test_create_rejects_path_injection(authed, instance, fake_compile):
    resp = authed.post('/api/v1/containers/demo/wiki/page',
                       {'path': '../../evil.md', 'content': 'x'}, format='json')
    assert resp.status_code == 400
    assert fake_compile == []


# ---------------------------- DELETE 删除（验收 3）----------------------------


def test_delete_removes_and_triggers_compile(authed, instance, wiki_home, fake_compile):
    target = wiki_home / 'wiki' / 'main' / 'concepts' / 'attention.md'
    assert target.exists()
    resp = authed.delete('/api/v1/containers/demo/wiki/page?path=concepts/attention.md')
    assert resp.status_code == 204
    assert not target.exists()
    assert fake_compile == ['demo']


def test_delete_missing_404(authed, instance):
    resp = authed.delete('/api/v1/containers/demo/wiki/page?path=concepts/nope.md')
    assert resp.status_code == 404


def test_delete_rejects_path_injection(authed, instance, fake_compile):
    resp = authed.delete('/api/v1/containers/demo/wiki/page?path=../../secret.md')
    assert resp.status_code == 400
    assert fake_compile == []


# ---------------------------- managed/私有路径拒绝（codex PR #62 意见4, P2）----------------------------


@pytest.mark.parametrize('managed', [
    'index.md',                          # 插件生成索引
    'AGENTS.md',                         # 插件保留文件
    'concepts/index.md',                 # 分类 index（managed 区）
    '.openclaw-wiki/cache/foo.md',       # 插件私有目录
])
def test_write_rejects_managed_paths(authed, instance, wiki_home, managed):
    resp = authed.put('/api/v1/containers/demo/wiki/page',
                      {'path': managed, 'content': 'x'}, format='json')
    assert resp.status_code == 400, f'managed 路径写入未被拒: {managed}'


@pytest.mark.parametrize('managed', ['index.md', '.openclaw-wiki/cache/foo.md'])
def test_delete_rejects_managed_paths(authed, instance, wiki_home, managed):
    resp = authed.delete(f'/api/v1/containers/demo/wiki/page?path={managed}')
    assert resp.status_code == 400, f'managed 路径删除未被拒: {managed}'


def test_create_rejects_managed_path(authed, instance, fake_compile):
    resp = authed.post('/api/v1/containers/demo/wiki/page',
                       {'path': '.openclaw-wiki/evil.md', 'content': 'x'}, format='json')
    assert resp.status_code == 400
    assert fake_compile == []

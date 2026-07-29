"""seam: containers REST API —— issue #39 容器管理控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（全局 IsAuthenticated 拦截）/§4（零信任，经 Serializer）/
§9.3（容器管理页后端契约：列表 status/health/port + 新建 + 删除）。

端点：GET/POST /api/v1/containers/、DELETE /api/v1/containers/<name>。
fleet fixture（conftest）注入 FakeRuntime，故不碰真 daemon。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from containers.orchestrator import (
    InstanceBusy,
    InstanceCleanupError,
    InstanceExists,
    PortAllocationError,
)
from containers.ports import PortPoolExhausted

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    # force_authenticate 跳过 JWT 编码细节；401 拦截由无 token 用例单独覆盖
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


# ---------------------------- 认证拦截（spec §3）----------------------------


@pytest.mark.django_db
def test_list_requires_auth(api):
    assert api.get('/api/v1/containers/').status_code == 401


@pytest.mark.django_db
def test_create_requires_auth(api):
    assert api.post('/api/v1/containers/', {'name': 'demo'}, format='json').status_code == 401


@pytest.mark.django_db
def test_delete_requires_auth(api):
    assert api.delete('/api/v1/containers/demo').status_code == 401


# ---------------------------- 创建（spec §9.3 新建）----------------------------


@pytest.mark.django_db
def test_create_returns_instance(authed, fleet):
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 201
    data = resp.json()
    assert data['name'] == 'demo'
    assert data['port'] == 19000  # 端口池最小空闲
    assert data['status'] == 'running'
    assert data['image'] == 'img:tag'
    # 落盘验收（issue #39：宿主 instances/<name>/ 落盘）
    assert (fleet['config'].root / 'instances' / 'demo' / 'home' / 'workspace' / 'note.md').exists()
    assert (fleet['config'].root / 'instances' / 'demo' / 'openclaw.json').exists()


@pytest.mark.django_db
def test_create_rejects_invalid_name(authed):
    # spec §4 零信任：非法 name → 400 非 500
    resp = authed.post('/api/v1/containers/', {'name': 'Bad/Name'}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_missing_name(authed):
    resp = authed.post('/api/v1/containers/', {}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_duplicate(authed, fleet):
    # 重复 name → 400（UniqueValidator），非 409/500
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 400


# ---------------------------- 列表（spec §9.3 status/health/port）----------------------------


@pytest.mark.django_db
def test_list_empty(authed):
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_list_shows_created_instance(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    items = authed.get('/api/v1/containers/').json()
    assert len(items) == 1
    assert items[0]['name'] == 'demo'
    # Codex P2：列表应批量携带配对状态，前端不再 per-row 轮询
    assert 'pairing' in items[0]
    assert items[0]['pairing']['status'] == 'unpaired'


@pytest.mark.django_db
def test_list_health_turns_healthy_when_reachable(authed, fleet):
    # issue #39 验收：列表 health 随外部 /health 探测变 healthy
    port = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json').json()['port']
    # 默认 running 但 gateway 未探通 → unhealthy
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'unhealthy'
    fleet['health'].set_reachable(port, True)
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'healthy'


# ---------------------------- 删除（spec §5.4 连数据删）----------------------------


@pytest.mark.django_db
def test_delete_removes_instance_and_dir(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 204
    # issue #39 验收：instances/<name>/ 一并清除
    assert not (fleet['config'].root / 'instances' / 'demo').exists()
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_delete_missing_returns_404(authed):
    assert authed.delete('/api/v1/containers/nope').status_code == 404


@pytest.mark.django_db
def test_delete_rejects_invalid_name(authed):
    # 路径参数也校验（spec §4）：防 URL path 注入
    resp = authed.delete('/api/v1/containers/Bad..Name')
    assert resp.status_code == 400


# ---------------------------- codex R1 并发/清理失败转译（:84/:126） ----------------------------


@pytest.mark.django_db
def test_create_returns_409_on_concurrent_duplicate(authed, fleet, monkeypatch):
    # codex R1 :84：orchestrator InstanceExists（并发绕 UniqueValidator）→ 409，非裸 500
    def _raise(name):
        raise InstanceExists(name)

    monkeypatch.setattr(fleet['orch'], 'create', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_delete_returns_409_when_cleanup_fails(authed, fleet, monkeypatch):
    # codex R1 :126：home 清理失败 → 409 + DB 行保留（可重试），非吞错 204
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')

    def _fail(name):
        raise InstanceCleanupError(name, str(fleet['config'].root))

    monkeypatch.setattr(fleet['orch'], 'delete', _fail)
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 409


# ---------------------------- codex R2 端口耗尽转译（:40） ----------------------------


@pytest.mark.django_db
def test_create_returns_503_when_port_pool_exhausted(authed, fleet, monkeypatch):
    # codex R2 :40：端口池耗尽（PortPoolExhausted）→ 503（预期容量条件），非裸 500
    def _raise(name):
        raise PortPoolExhausted('端口池 19000-19999 已耗尽')

    monkeypatch.setattr(fleet['orch'], 'create', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 503


@pytest.mark.django_db
def test_create_returns_503_when_port_allocation_exhausted(authed, fleet, monkeypatch):
    # codex R2 :40：持续分配冲突（PortAllocationError，重试预算用尽）→ 503，非裸 500
    def _raise(name):
        raise PortAllocationError(name)

    monkeypatch.setattr(fleet['orch'], 'create', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 503


@pytest.mark.django_db
def test_delete_returns_409_while_create_in_flight(authed, fleet, monkeypatch):
    # codex R3 :257：删除目标仍在 provisioning（create 在飞，InstanceBusy）→ 409，非裸 500/204
    def _busy(name):
        raise InstanceBusy(name)

    monkeypatch.setattr(fleet['orch'], 'delete', _busy)
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_returns_409_when_rollback_dir_cleanup_fails(authed, fleet, monkeypatch):
    # codex R4 :265：create 回滚时目录清理失败（InstanceCleanupError，行标 ERROR 保留）→ 409，
    # 非裸 OSError→500。与 delete :126 对称（行保留可重试）。
    def _fail(name):
        raise InstanceCleanupError(name, str(fleet['config'].root / 'instances' / name))

    monkeypatch.setattr(fleet['orch'], 'create', _fail)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_returns_201_even_if_post_create_detail_fails(authed, fleet, monkeypatch):
    # codex R4 :60：POST 已 commit 创建并启动容器后，若随后的 detail() 二次 runtime 查询
    # 因 daemon 抖动失败，不应让已成功的创建返回 500（客户端误判失败重试 → 撞 409 重复名）。
    # 须由 create() 返回结果构造 201，容忍 detail 查询失败。
    def _flaky_detail(name):
        raise RuntimeError('daemon flaked during post-create lookup')

    monkeypatch.setattr(fleet['orch'], 'detail', _flaky_detail)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 201
    assert resp.json()['name'] == 'demo'
    assert resp.json()['status'] == 'running'


# ---------------------------- issue #199：实例列表不批量解密凭据 ----------------------------


@pytest.mark.django_db
def test_list_does_not_decrypt_pairing_credentials(authed, fleet, monkeypatch):
    """问题6-4：实例列表改 values() 投影只取 Pairing 状态字段——
    不再整行加载触发 private_key_pem/device_token 的 AES-GCM 解密
    （N 实例 = 2N 次无谓解密且私钥明文进请求内存）。"""
    from chat.models import Pairing
    from containers.models import Instance
    from security.fields import EncryptedTextField

    fleet['orch'].create('demo')
    inst = Instance.objects.get(name='demo')
    Pairing.objects.create(
        instance=inst, status=Pairing.STATUS_PAIRED, device_id='dev-1',
        private_key_pem='priv', device_token='dt-1', scopes_json='["operator.read"]',
    )
    decrypted_fields = []
    monkeypatch.setattr(
        EncryptedTextField, 'decrypt_value',
        lambda self, value: (decrypted_fields.append(self.name), value)[1],
    )
    resp = authed.get('/api/v1/containers/')
    assert resp.status_code == 200
    item = resp.json()[0]
    assert item['pairing']['status'] == 'paired'
    assert item['pairing']['device_id'] == 'dev-1'
    assert item['pairing']['scopes'] == ['operator.read']
    # Pairing 的密文字段未被解密（Instance.token 等其他字段的既有解密不受影响）
    assert 'private_key_pem' not in decrypted_fields
    assert 'device_token' not in decrypted_fields


@pytest.mark.django_db
def test_list_tolerates_plaintext_pairing_row(authed, fleet, caplog):
    """问题4：手工明文行（模拟备份恢复绕过存量加密迁移）→ 列表 200，不再 500。"""
    import logging

    from django.db import connection

    from chat.models import Pairing
    from containers.models import Instance

    fleet['orch'].create('demo')
    inst = Instance.objects.get(name='demo')
    pairing = Pairing.objects.create(
        instance=inst, status=Pairing.STATUS_PAIRED, device_id='dev-1',
        private_key_pem='priv', device_token='dt-1', scopes_json='[]',
    )
    with connection.cursor() as cursor:
        cursor.execute(
            'UPDATE chat_pairing SET private_key_pem = %s, private_key_pem_is_encrypted = %s, '
            'device_token = %s, device_token_is_encrypted = %s WHERE id = %s',
            ['plain-priv', False, 'plain-dt', False, pairing.pk],
        )
    with caplog.at_level(logging.WARNING, logger='security.fields'):
        resp = authed.get('/api/v1/containers/')
    assert resp.status_code == 200
    assert resp.json()[0]['pairing']['status'] == 'paired'

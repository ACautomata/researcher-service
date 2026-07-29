"""seam: chat pairing REST API —— issue #40 设备配对控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（全局 IsAuthenticated）/§4（零信任）/§8.1（配对前提）。
端点：GET/POST /api/v1/containers/<name>/pairing/（chat.urls 挂到 config）。
fleet fixture 注入 FakeRuntime；transport 注入 FakeTransport 替代真网关。

验收映射：
- POST 完成配对 → 后端存 deviceToken + status=paired（验收 1）
- 配对后 scopes 非空含 operator.read/write/approvals（验收 2）
- 未批准 → 清晰错误 + 重试路径（验收 3）
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from chat.models import Pairing
from chat.pairing import PairingFleet, PairingService
from chat.tests.fakes import FakeTransport
from containers.models import Instance

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


@pytest.fixture
def instance(db):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir='/tmp/x', container_id='cid', status=Instance.STATUS_RUNNING,
        image='img:tag',
    )


@pytest.fixture
def override_service():
    """注入可控 PairingService（FakeTransport）到 view 层（PairingFleet locator）。"""
    injected = []

    def _set(transport):
        svc = PairingService(transport=transport)
        PairingFleet.override(svc)
        injected.append(svc)
        return svc

    yield _set
    PairingFleet.reset()


# ---------------------------- 认证拦截（spec §3）----------------------------


def test_pairing_get_requires_auth(api, instance):
    assert api.get('/api/v1/containers/demo/pairing/').status_code == 401


def test_pairing_post_requires_auth(api, instance):
    assert api.post('/api/v1/containers/demo/pairing/', {}, format='json').status_code == 401


def test_pairing_missing_instance_404(authed):
    assert authed.get('/api/v1/containers/nope/pairing/').status_code == 404


def test_pairing_rejects_invalid_name(authed):
    assert authed.get('/api/v1/containers/Bad..Name/pairing/').status_code == 400


# ---------------------------- GET 查询状态 ----------------------------


def test_get_unpaired_status(authed, instance):
    resp = authed.get('/api/v1/containers/demo/pairing/')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'unpaired'


# ---------------------------- POST 触发配对（验收 1 + 2）----------------------------


def test_post_pair_success(authed, instance, override_service):
    override_service(FakeTransport.hello_ok())
    resp = authed.post('/api/v1/containers/demo/pairing/', {}, format='json')
    assert resp.status_code == 200
    data = resp.json()
    assert data['status'] == 'paired'
    # 验收 1：后端存下可用 deviceToken
    pairing = Pairing.objects.get(instance=instance)
    assert pairing.device_token
    # 验收 2：scopes 非空含 operator.read/write/approvals
    scopes = set(data['scopes'])
    assert {'operator.read', 'operator.write', 'operator.approvals'} <= scopes
    # 私钥/token 不应外泄到 API 出参
    assert 'private_key_pem' not in data
    assert 'device_token' not in data


# ---------------------------- POST 强制重配（deviceToken 撤销恢复）----------------------------


def test_post_pair_force_repair_overwrites_revoked_token(authed, instance, override_service):
    """Codex P1：本地已 paired 但网关侧 token 被撤销时，POST 应重新握手恢复。"""
    override_service(FakeTransport.hello_ok(device_token='dt-old'))
    authed.post('/api/v1/containers/demo/pairing/', {}, format='json')
    old = Pairing.objects.get(instance=instance)
    assert old.device_token == 'dt-old'

    override_service(FakeTransport.hello_ok(device_token='dt-new'))
    resp = authed.post('/api/v1/containers/demo/pairing/', {}, format='json')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'paired'
    assert Pairing.objects.get(instance=instance).device_token == 'dt-new'


# ---------------------------- POST 待批准（验收 3）----------------------------


def test_post_pair_pending_returns_request_id_and_retry(authed, instance, override_service):
    override_service(FakeTransport.pairing_required(request_id='req-555'))
    resp = authed.post('/api/v1/containers/demo/pairing/', {}, format='json')
    assert resp.status_code == 202  # 已受理待批准
    data = resp.json()
    assert data['status'] == 'pending'
    assert data['pairing_request_id'] == 'req-555'
    # 验收 3：清晰错误 + 重试路径（提示宿主 approve 命令）
    assert 'req-555' in data['detail']
    assert 'approve' in data['detail'].lower()


def test_post_pair_error_returns_502(authed, instance, override_service):
    override_service(FakeTransport.connect_error('gateway unreachable at 10.0.0.5:19000'))
    resp = authed.post('/api/v1/containers/demo/pairing/', {}, format='json')
    assert resp.status_code == 502
    assert resp.json()['status'] == 'error'
    # codex R security：固定文案，不泄露原始异常（网络地址/协议细节）
    assert '10.0.0.5' not in resp.json()['detail']
    assert 'unreachable' not in resp.json()['detail']


# ---------------------------- issue #199 问题4：明文行降级不 500 ----------------------------


def test_pairing_get_tolerates_plaintext_credential_row(authed, instance, caplog):
    """手工明文行（备份恢复/手工 SQL 绕过存量加密迁移，状态列 False）：
    GET 配对状态 200 + 明文透传 + 告警，不再 InvalidCredentialCiphertext → 500。"""
    import logging

    from django.db import connection

    pairing = Pairing.objects.create(
        instance=instance, status=Pairing.STATUS_PAIRED, device_id='dev-1',
        private_key_pem='priv', device_token='dt-1', scopes_json='["operator.read"]',
    )
    with connection.cursor() as cursor:
        cursor.execute(
            'UPDATE chat_pairing SET private_key_pem = %s, private_key_pem_is_encrypted = %s, '
            'device_token = %s, device_token_is_encrypted = %s WHERE id = %s',
            ['plain-priv', False, 'plain-dt', False, pairing.pk],
        )
    with caplog.at_level(logging.WARNING, logger='security.fields'):
        resp = authed.get('/api/v1/containers/demo/pairing/')
    assert resp.status_code == 200
    assert resp.json()['status'] == 'paired'
    assert any('plaintext' in r.message for r in caplog.records)

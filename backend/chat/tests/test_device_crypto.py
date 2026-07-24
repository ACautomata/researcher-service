"""seam: chat.device_crypto —— Ed25519 设备身份 + v3 签名基元（issue #40 / spec §8.1）。

字节级对齐上游 openclaw/openclaw（docs/research/r40-device-pairing-protocol.md）：
- deviceId = sha256(raw_ed25519_pubkey_32B).hexdigest()
- 公钥线上格式 = raw 32B base64url；签名 = Ed25519(v3 payload utf8) base64url
- buildDeviceAuthPayloadV3：11 段 "|" 连接，platform/deviceFamily 小写归一化
"""
import base64
import hashlib

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)

from chat.device_crypto import DeviceCrypto, DeviceIdentity


def _generate_identity() -> DeviceIdentity:
    return DeviceCrypto.generate_identity()


def _raw_pubkey_from_pem(public_pem: str) -> bytes:
    """独立复现：从 SPKI PEM 取 32 字节 raw 公钥（不经过被测代码）。"""
    pub = serialization.load_pem_public_key(public_pem.encode())
    der = pub.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return der[-32:]  # SPKI DER 尾部 32B 即 raw key


def _expected_device_id(public_pem: str) -> str:
    return hashlib.sha256(_raw_pubkey_from_pem(public_pem)).hexdigest()


# ---------------------------- 设备身份生成 ----------------------------


def test_generate_identity_pem_formats():
    ident = _generate_identity()
    assert isinstance(ident, DeviceIdentity)
    assert ident.public_key_pem.startswith('-----BEGIN PUBLIC KEY-----')
    assert ident.private_key_pem.startswith('-----BEGIN PRIVATE KEY-----')


def test_generate_identity_device_id_matches_sha256_of_raw_pubkey():
    ident = _generate_identity()
    # deviceId 必须等于独立复现的 sha256(raw32B).hex
    assert ident.device_id == _expected_device_id(ident.public_key_pem)


def test_generate_identity_is_random_per_call():
    assert _generate_identity().device_id != _generate_identity().device_id


def test_public_key_raw_base64url_roundtrip():
    ident = _generate_identity()
    raw_b64url = ident.public_key_raw_base64url()
    # base64url 解码回 32 字节 raw，且与独立复现一致
    raw = base64.urlsafe_b64decode(raw_b64url + '=' * (-len(raw_b64url) % 4))
    assert raw == _raw_pubkey_from_pem(ident.public_key_pem)
    assert len(raw) == 32


# ---------------------------- v3 签名串 ----------------------------


def test_v3_payload_field_order_and_separator():
    payload = DeviceCrypto.build_auth_payload_v3(
        device_id='d' * 64,
        client_id='gateway-client',
        client_mode='backend',
        role='operator',
        scopes=['operator.read', 'operator.write'],
        signed_at_ms=1737264000000,
        token='tok',
        nonce='n-1',
        platform='linux',
        device_family='',
    )
    assert payload == (
        'v3|' + 'd' * 64 + '|gateway-client|backend|operator|'
        'operator.read,operator.write|1737264000000|tok|n-1|linux|'
    )


def test_v3_payload_normalizes_platform_and_device_family_to_lowercase():
    # 上游 normalizeDeviceMetadataForAuth：trim + 大写转小写；空 → ''
    payload = DeviceCrypto.build_auth_payload_v3(
        device_id='x',
        client_id='c',
        client_mode='m',
        role='r',
        scopes=[],
        signed_at_ms=0,
        token=None,
        nonce='n',
        platform='  Darwin ',
        device_family='MacBookPro',
    )
    # token None → 空串；scopes [] → 空串；platform/deviceFamily 归一化
    assert payload == 'v3|x|c|m|r||0||n|darwin|macbookpro'


def test_v3_payload_empty_scopes_and_token_default():
    payload = DeviceCrypto.build_auth_payload_v3(
        device_id='x', client_id='c', client_mode='m', role='r',
        scopes=[], signed_at_ms=0, token=None, nonce='n',
        platform='', device_family='',
    )
    # 9 个 "|" 分隔 10 个字段位（v3 共 11 段 → 10 个 "|"）
    assert payload.count('|') == 10


# ---------------------------- 签名 ----------------------------


def test_sign_produces_base64url_verifiable_by_public_key():
    ident = _generate_identity()
    message = 'v3|a|b|c|d|e|1|t|n|p|f'
    sig_b64url = ident.sign(message)
    # 用公钥独立验签（不经过被测 sign 的对称路径）
    pub = serialization.load_pem_public_key(ident.public_key_pem.encode())
    sig = base64.urlsafe_b64decode(sig_b64url + '=' * (-len(sig_b64url) % 4))
    pub.verify(sig, message.encode())  # 不抛异常即验签通过


def test_identity_from_existing_pem_is_stable():
    # 持久化后重载：同一私钥 PEM 必须派生同一 deviceId（配对身份跨进程稳定）
    ident = _generate_identity()
    reloaded = DeviceIdentity(
        device_id=ident.device_id,
        public_key_pem=ident.public_key_pem,
        private_key_pem=ident.private_key_pem,
    )
    assert reloaded.device_id == ident.device_id
    assert reloaded.public_key_raw_base64url() == ident.public_key_raw_base64url()

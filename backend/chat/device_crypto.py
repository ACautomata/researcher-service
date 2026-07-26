"""chat.device_crypto —— Ed25519 设备身份 + v3 签名基元（issue #40 / spec §8.1）。

字节级对齐上游 openclaw/openclaw（docs/research/r40-device-pairing-protocol.md）：
- 密钥：Ed25519；公钥 SPKI/私钥 PKCS8 PEM 存储。
- raw 公钥 = SPKI DER 尾部 32 字节；deviceId = sha256(raw32B).hexdigest()。
- 公钥线上格式 = raw32B 的 base64url（无 padding）。
- 签名 = Ed25519(private, payload.utf8)，输出 base64url。
- buildDeviceAuthPayloadV3：11 段 "|" 连接，platform/deviceFamily 小写归一化。

上游签名串由网关**逐字节比对**，故归一化（trim + 大写转小写）必须在签名前完成。
"""
from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# 上游 ed25519-signature.ts：SPKI DER = 12B 前缀 + 32B raw key。
_SPKI_DER_PREFIX_LEN = 12


@dataclass(frozen=True)
class DeviceIdentity:
    """持久化的 Ed25519 设备身份（device_id + 公私钥 PEM）。"""

    device_id: str
    public_key_pem: str
    private_key_pem: str

    @staticmethod
    def _b64url_encode(raw: bytes) -> str:
        """标准 base64url、去 padding（上游 Buffer.toString('base64url') 无 padding）。"""
        return base64.urlsafe_b64encode(raw).decode().rstrip('=')

    def _private_key(self) -> Ed25519PrivateKey:
        return serialization.load_pem_private_key(
            self.private_key_pem.encode(), password=None,
        )

    def public_key_raw_base64url(self) -> str:
        """公钥线上格式：SPKI DER 尾部 32B raw key 的 base64url。"""
        pub = serialization.load_pem_public_key(self.public_key_pem.encode())
        der = pub.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return self._b64url_encode(der[_SPKI_DER_PREFIX_LEN:])

    def sign(self, payload: str) -> str:
        """对 payload 的 UTF-8 字节做 Ed25519 签名，输出 base64url。"""
        signature = self._private_key().sign(payload.encode('utf-8'))
        return self._b64url_encode(signature)


class DeviceCrypto:
    """设备身份生成 + 签名串构造（业务逻辑封装，非自由函数）。"""

    @staticmethod
    def _normalize_metadata(value: str | None) -> str:
        """对齐上游 normalizeDeviceMetadataForAuth：trim + 大写转小写；空/None → ''。"""
        if not value:
            return ''
        return value.strip().lower()

    @staticmethod
    def generate_identity() -> DeviceIdentity:
        """生成新 Ed25519 身份；deviceId = sha256(raw 公钥).hex。"""
        priv = Ed25519PrivateKey.generate()
        private_pem = priv.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        public_pem = priv.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        raw_pub = priv.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )[_SPKI_DER_PREFIX_LEN:]
        device_id = hashlib.sha256(raw_pub).hexdigest()
        return DeviceIdentity(
            device_id=device_id,
            public_key_pem=public_pem,
            private_key_pem=private_pem,
        )

    @staticmethod
    def build_auth_payload_v3(  # pylint: disable=too-many-arguments
        *,
        device_id: str,
        client_id: str,
        client_mode: str,
        role: str,
        scopes: list[str],
        signed_at_ms: int,
        token: str | None,
        nonce: str,
        platform: str | None,
        device_family: str | None,
    ) -> str:
        """buildDeviceAuthPayloadV3：11 段 "|" 连接（上游逐字节比对，归一化先行）。"""
        return '|'.join([
            'v3',
            device_id,
            client_id,
            client_mode,
            role,
            ','.join(scopes),
            str(signed_at_ms),
            token or '',
            nonce,
            DeviceCrypto._normalize_metadata(platform),
            DeviceCrypto._normalize_metadata(device_family),
        ])

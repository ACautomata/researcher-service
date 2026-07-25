"""持久化凭证的版本化 AES-256-GCM 加密基元。"""
import base64
import binascii
import os
from collections.abc import Mapping, Sequence

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.core.exceptions import ImproperlyConfigured


class CredentialConfigurationError(ImproperlyConfigured):
    """凭证加密的密钥配置缺失或不合法。"""


class InvalidCredentialCiphertext(ValueError):
    """凭证密文格式错误、被篡改，或无法由当前密钥环解密。"""


class CredentialKeySettings:
    """从环境变量解析有序的 AES-256-GCM 密钥环。"""

    ENVIRONMENT_VARIABLE = 'CREDENTIAL_ENCRYPTION_KEYS'
    KEY_BYTES = 32

    def __init__(self, environment: Mapping[str, str]) -> None:
        self._environment = environment

    def load(self) -> tuple[bytes, ...]:
        raw_value = self._environment.get(self.ENVIRONMENT_VARIABLE, '')
        key_texts = [key.strip() for key in raw_value.split(',') if key.strip()]
        if not key_texts:
            raise CredentialConfigurationError(
                f'{self.ENVIRONMENT_VARIABLE} must contain at least one base64url key'
            )
        keys = tuple(self._decode_key(key_text) for key_text in key_texts)
        if len(set(keys)) != len(keys):
            raise CredentialConfigurationError(
                f'{self.ENVIRONMENT_VARIABLE} must not contain duplicate keys'
            )
        return keys

    def _decode_key(self, key_text: str) -> bytes:
        try:
            key = self._decode_base64url(key_text)
        except (binascii.Error, ValueError) as error:
            raise CredentialConfigurationError(
                f'{self.ENVIRONMENT_VARIABLE} contains an invalid base64url key'
            ) from error
        if len(key) != self.KEY_BYTES:
            raise CredentialConfigurationError(
                f'{self.ENVIRONMENT_VARIABLE} keys must decode to {self.KEY_BYTES} bytes'
            )
        return key

    def _decode_base64url(self, value: str) -> bytes:
        padding = '=' * (-len(value) % 4)
        return base64.b64decode(
            (value + padding).encode('ascii'), altchars=b'-_', validate=True
        )


class CredentialCipher:
    """用有序密钥环加密和解密 UTF-8 文本凭证。"""

    PREFIX = 'enc:v1:'
    NONCE_BYTES = 12

    def __init__(self, keys: Sequence[bytes]) -> None:
        if not keys:
            raise CredentialConfigurationError('credential cipher requires at least one key')
        if any(
            not isinstance(key, bytes) or len(key) != CredentialKeySettings.KEY_BYTES
            for key in keys
        ):
            raise CredentialConfigurationError('credential cipher keys must be 32 bytes')
        self._keys = tuple(keys)

    def encrypt(self, plaintext: str) -> str:
        nonce = os.urandom(self.NONCE_BYTES)
        encrypted = AESGCM(self._keys[0]).encrypt(nonce, plaintext.encode('utf-8'), None)
        return self.PREFIX + self._encode_base64url(nonce + encrypted)

    def decrypt(self, ciphertext: str) -> str:
        payload = self._decode_payload(ciphertext)
        nonce = payload[:self.NONCE_BYTES]
        encrypted = payload[self.NONCE_BYTES:]
        for key in self._keys:
            try:
                return AESGCM(key).decrypt(nonce, encrypted, None).decode('utf-8')
            except (InvalidTag, UnicodeDecodeError):
                continue
        raise InvalidCredentialCiphertext('credential ciphertext could not be authenticated')

    def _decode_payload(self, ciphertext: str) -> bytes:
        if not ciphertext.startswith(self.PREFIX):
            raise InvalidCredentialCiphertext('unsupported credential ciphertext version')
        encoded_payload = ciphertext.removeprefix(self.PREFIX)
        try:
            payload = self._decode_base64url(encoded_payload)
        except (binascii.Error, ValueError, UnicodeEncodeError) as error:
            raise InvalidCredentialCiphertext('invalid credential ciphertext encoding') from error
        if len(payload) <= self.NONCE_BYTES:
            raise InvalidCredentialCiphertext('credential ciphertext is too short')
        return payload

    def _encode_base64url(self, value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')

    def _decode_base64url(self, value: str) -> bytes:
        padding = '=' * (-len(value) % 4)
        return base64.b64decode(
            (value + padding).encode('ascii'), altchars=b'-_', validate=True
        )

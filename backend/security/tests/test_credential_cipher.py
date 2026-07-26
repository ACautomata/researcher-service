"""CredentialCipher 的安全和密钥轮换测试。"""
import base64

import pytest

from security.credential_cipher import (
    CredentialCipher,
    CredentialConfigurationError,
    CredentialKeySettings,
    InvalidCredentialCiphertext,
)


class TestCredentialCipher:
    def test_round_trip_uses_versioned_ciphertext_and_unique_nonces(self):
        cipher = CredentialCipher((bytes(range(32)),))
        first = cipher.encrypt('private-key-秘密')
        second = cipher.encrypt('private-key-秘密')
        assert first.startswith('enc:v1:')
        assert first != second
        assert cipher.decrypt(first) == 'private-key-秘密'

    def test_tampered_ciphertext_is_rejected(self):
        cipher = CredentialCipher((bytes(range(32)),))
        ciphertext = cipher.encrypt('device-token')
        # 篡改首个 base64url 字符（对应 nonce 首字节）：末字符只承载最后 1 字节的
        # 低 2 位、其余 4 位是 padding，约 25% 概率改了等于没改而令 GCM 误判通过。
        index = len(CredentialCipher.PREFIX)
        head = ciphertext[index]
        replacement = 'B' if head != 'B' else 'C'
        tampered = ciphertext[:index] + replacement + ciphertext[index + 1:]
        with pytest.raises(InvalidCredentialCiphertext):
            cipher.decrypt(tampered)

    def test_wrong_key_is_rejected(self):
        cipher = CredentialCipher((bytes(range(32)),))
        ciphertext = cipher.encrypt('gateway-token')
        with pytest.raises(InvalidCredentialCiphertext):
            CredentialCipher((bytes(reversed(range(32))),)).decrypt(ciphertext)

    def test_old_key_can_decrypt_after_rotation(self):
        old_key = bytes(range(32))
        new_key = bytes(reversed(range(32)))
        old_cipher = CredentialCipher((old_key,))
        rotated_cipher = CredentialCipher((new_key, old_key))
        old_ciphertext = old_cipher.encrypt('device-token')
        new_ciphertext = rotated_cipher.encrypt('device-token')
        assert rotated_cipher.decrypt(old_ciphertext) == 'device-token'
        assert CredentialCipher((new_key,)).decrypt(new_ciphertext) == 'device-token'


class TestCredentialKeySettings:
    def test_missing_key_ring_is_rejected(self):
        with pytest.raises(CredentialConfigurationError):
            CredentialKeySettings({}).load()

    def test_invalid_key_length_is_rejected(self):
        short_key = base64.urlsafe_b64encode(b'too-short').decode('ascii')
        with pytest.raises(CredentialConfigurationError):
            CredentialKeySettings({'CREDENTIAL_ENCRYPTION_KEYS': short_key}).load()

    def test_duplicate_keys_are_rejected(self):
        key = base64.urlsafe_b64encode(bytes(range(32))).decode('ascii').rstrip('=')
        with pytest.raises(CredentialConfigurationError):
            CredentialKeySettings({'CREDENTIAL_ENCRYPTION_KEYS': f'{key},{key}'}).load()

    def test_valid_ordered_key_ring_is_loaded(self):
        first = base64.urlsafe_b64encode(bytes(range(32))).decode('ascii').rstrip('=')
        second = base64.urlsafe_b64encode(bytes(reversed(range(32)))).decode('ascii').rstrip('=')
        keys = CredentialKeySettings(
            {'CREDENTIAL_ENCRYPTION_KEYS': f'{first},{second}'}
        ).load()
        assert keys == (bytes(range(32)), bytes(reversed(range(32))))

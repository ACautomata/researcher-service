"""Django 模型的应用层凭证加密字段。"""
from django.conf import settings
from django.db import models

from security.credential_cipher import CredentialCipher


class EncryptedTextField(models.TextField):
    """存储密文、向模型调用方暴露明文的 expand 阶段文本字段。"""

    def get_prep_value(self, value):
        prepared = super().get_prep_value(value)
        if prepared is None or prepared.startswith(CredentialCipher.PREFIX):
            return prepared
        return self._cipher().encrypt(prepared)

    def from_db_value(self, value, expression, connection):
        return self._to_plaintext(value)

    def to_python(self, value):
        return self._to_plaintext(super().to_python(value))

    def _cipher(self) -> CredentialCipher:
        return CredentialCipher(settings.CREDENTIAL_ENCRYPTION_KEYS)

    def _to_plaintext(self, value):
        if value is None or not value.startswith(CredentialCipher.PREFIX):
            return value
        return self._cipher().decrypt(value)

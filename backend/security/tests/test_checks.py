"""启动期系统检查测试（issue #199 问题6-1）。"""
import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings

from security.checks import check_credential_encryption_keys


class TestCredentialKeysStartupCheck:
    def test_missing_keys_fail_fast(self):
        # base settings 不内置密钥——未配置即启动期 ImproperlyConfigured（非首读凭据才炸）
        with (
            override_settings(CREDENTIAL_ENCRYPTION_KEYS=None),
            pytest.raises(ImproperlyConfigured),
        ):
            check_credential_encryption_keys(None)

    def test_empty_keys_fail_fast(self):
        with (
            override_settings(CREDENTIAL_ENCRYPTION_KEYS=()),
            pytest.raises(ImproperlyConfigured),
        ):
            check_credential_encryption_keys(None)

    def test_configured_keys_pass(self):
        with override_settings(CREDENTIAL_ENCRYPTION_KEYS=(b'x' * 32,)):
            assert check_credential_encryption_keys(None) == []

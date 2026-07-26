"""Pairing admin 的凭证隔离回归测试。"""
from django.contrib import admin

from chat.admin import PairingAdmin
from chat.models import Pairing


class TestPairingAdmin:
    def test_credential_fields_are_excluded_from_all_admin_views(self):
        pairing_admin = PairingAdmin(Pairing, admin.site)

        assert 'private_key_pem' in pairing_admin.exclude
        assert 'device_token' in pairing_admin.exclude
        assert 'private_key_pem' not in pairing_admin.list_display
        assert 'device_token' not in pairing_admin.list_display

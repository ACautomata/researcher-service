"""凭证密钥轮换管理命令的行为测试。"""
import pytest
from django.core.management import call_command
from django.db import connection
from django.test import override_settings

from chat.models import Pairing
from containers.models import Instance
from security.credential_cipher import CredentialCipher


class TestRotateCredentialKeysCommand:
    @pytest.mark.django_db
    def test_rotation_reencrypts_all_credentials_with_current_key(self):
        old_key = bytes(range(32))
        current_key = bytes(reversed(range(32)))
        old_cipher = CredentialCipher((old_key,))
        instance = Instance.objects.create(
            name='rotation', port=19100, token='placeholder', home_dir='/tmp/rotation',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )
        pairing = Pairing.objects.create(instance=instance)
        with connection.cursor() as cursor:
            cursor.execute(
                'UPDATE containers_instance SET token = %s WHERE id = %s',
                [old_cipher.encrypt('gateway-token'), instance.pk],
            )
            cursor.execute(
                'UPDATE chat_pairing SET private_key_pem = %s, device_token = %s WHERE id = %s',
                [old_cipher.encrypt('private-key'), old_cipher.encrypt('device-token'), pairing.pk],
            )

        with override_settings(CREDENTIAL_ENCRYPTION_KEYS=(current_key, old_key)):
            call_command('rotate_credential_keys')
        with override_settings(CREDENTIAL_ENCRYPTION_KEYS=(current_key,)):
            assert Instance.objects.get(pk=instance.pk).token == 'gateway-token'
            reloaded_pairing = Pairing.objects.get(pk=pairing.pk)
            assert reloaded_pairing.private_key_pem == 'private-key'
            assert reloaded_pairing.device_token == 'device-token'

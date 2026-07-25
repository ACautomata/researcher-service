"""EncryptedTextField 的 expand 阶段 ORM 行为测试。"""
import pytest
from django.db import connection

from chat.models import Pairing
from containers.models import Instance
from security.credential_cipher import CredentialCipher


class TestEncryptedCredentialFields:
    @pytest.mark.django_db
    def test_new_credential_writes_are_encrypted_and_read_as_plaintext(self):
        instance = Instance.objects.create(
            name='demo', port=19000, token='gateway-token', home_dir='/tmp/demo',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )
        pairing = Pairing.objects.create(
            instance=instance, private_key_pem='private-key', device_token='device-token',
        )

        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT token FROM containers_instance WHERE id = %s', [instance.pk]
            )
            stored_instance_token = cursor.fetchone()[0]
            cursor.execute(
                'SELECT private_key_pem, device_token FROM chat_pairing WHERE id = %s',
                [pairing.pk],
            )
            stored_private_key, stored_device_token = cursor.fetchone()

        assert stored_instance_token.startswith(CredentialCipher.PREFIX)
        assert stored_private_key.startswith(CredentialCipher.PREFIX)
        assert stored_device_token.startswith(CredentialCipher.PREFIX)
        assert Instance.objects.get(pk=instance.pk).token == 'gateway-token'
        reloaded_pairing = Pairing.objects.get(pk=pairing.pk)
        assert reloaded_pairing.private_key_pem == 'private-key'
        assert reloaded_pairing.device_token == 'device-token'

    @pytest.mark.django_db
    def test_legacy_plaintext_rows_remain_readable_during_expand(self):
        instance = Instance.objects.create(
            name='legacy', port=19001, token='new-token', home_dir='/tmp/legacy',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )
        pairing = Pairing.objects.create(
            instance=instance, private_key_pem='new-private-key', device_token='new-device-token',
        )

        with connection.cursor() as cursor:
            cursor.execute(
                'UPDATE containers_instance SET token = %s WHERE id = %s',
                ['legacy-token', instance.pk],
            )
            cursor.execute(
                'UPDATE chat_pairing SET private_key_pem = %s, device_token = %s WHERE id = %s',
                ['legacy-private-key', 'legacy-device-token', pairing.pk],
            )

        reloaded_instance = Instance.objects.get(pk=instance.pk)
        reloaded_pairing = Pairing.objects.get(pk=pairing.pk)
        assert reloaded_instance.token == 'legacy-token'
        assert reloaded_pairing.private_key_pem == 'legacy-private-key'
        assert reloaded_pairing.device_token == 'legacy-device-token'

    @pytest.mark.django_db
    def test_queryset_updates_encrypt_new_credential_values(self):
        instance = Instance.objects.create(
            name='updated', port=19002, token='initial-token', home_dir='/tmp/updated',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )
        pairing = Pairing.objects.create(instance=instance)

        Pairing.objects.filter(pk=pairing.pk).update(device_token='rotated-device-token')

        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT device_token FROM chat_pairing WHERE id = %s', [pairing.pk]
            )
            stored_device_token = cursor.fetchone()[0]

        assert stored_device_token.startswith(CredentialCipher.PREFIX)
        assert Pairing.objects.get(pk=pairing.pk).device_token == 'rotated-device-token'

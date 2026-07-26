"""EncryptedTextField 的 expand 阶段 ORM 行为测试。"""
import pytest
from django.conf import settings
from django.db import connection
from django.db.models import Count, F

from chat.models import Pairing
from containers.models import Instance
from security.credential_cipher import CredentialCipher, InvalidCredentialCiphertext


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
                'UPDATE containers_instance SET token = %s, token_is_encrypted = %s WHERE id = %s',
                ['legacy-token', False, instance.pk],
            )
            cursor.execute(
                'UPDATE chat_pairing SET private_key_pem = %s, private_key_pem_is_encrypted = %s, '
                'device_token = %s, device_token_is_encrypted = %s WHERE id = %s',
                ['legacy-private-key', False, 'legacy-device-token', False, pairing.pk],
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

    @pytest.mark.django_db
    def test_prefix_lookalike_values_are_encrypted_and_legacy_values_remain_readable(self):
        prefix_lookalike = 'enc:v1:' + ('A' * 40)
        instance = Instance.objects.create(
            name='prefixed', port=19003, token=prefix_lookalike, home_dir='/tmp/prefixed',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )

        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT token FROM containers_instance WHERE id = %s', [instance.pk]
            )
            stored_token = cursor.fetchone()[0]
            cursor.execute(
                'UPDATE containers_instance SET token = %s, token_is_encrypted = %s WHERE id = %s',
                [prefix_lookalike, False, instance.pk],
            )

        assert stored_token != prefix_lookalike
        assert stored_token.startswith(CredentialCipher.PREFIX)
        assert Instance.objects.get(pk=instance.pk).token == prefix_lookalike

    @pytest.mark.django_db
    def test_authenticated_ciphertext_tampering_is_not_treated_as_legacy_plaintext(self):
        instance = Instance.objects.create(
            name='tampered', port=19004, token='initial-token', home_dir='/tmp/tampered',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )
        ciphertext = CredentialCipher(settings.CREDENTIAL_ENCRYPTION_KEYS).encrypt('gateway-token')
        first_payload_character = 'A' if ciphertext[len(CredentialCipher.PREFIX)] != 'A' else 'B'
        tampered = (
            CredentialCipher.PREFIX
            + first_payload_character
            + ciphertext[len(CredentialCipher.PREFIX) + 1:]
        )

        with connection.cursor() as cursor:
            cursor.execute(
                'UPDATE containers_instance SET token = %s WHERE id = %s',
                [tampered, instance.pk],
            )

        with pytest.raises(InvalidCredentialCiphertext):
            Instance.objects.get(pk=instance.pk)

    @pytest.mark.django_db
    def test_bulk_create_marks_credentials_as_encrypted(self):
        Instance.objects.bulk_create([
            Instance(
                name='bulk-created', port=19005, token='bulk-token', home_dir='/tmp/bulk',
                container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
            ),
        ])

        assert Instance.objects.get(name='bulk-created').token == 'bulk-token'

    @pytest.mark.django_db
    def test_bulk_create_accepts_generators_and_marks_credentials_as_encrypted(self):
        instances = (
            Instance(
                name='generator-created', port=19008, token='generator-token',
                home_dir='/tmp/generator', container_id='cid',
                status=Instance.STATUS_RUNNING, image='image:tag',
            )
            for _ in range(1)
        )

        Instance.objects.bulk_create(instances)

        assert Instance.objects.get(name='generator-created').token == 'generator-token'

    @pytest.mark.django_db(transaction=True)
    @pytest.mark.asyncio
    async def test_async_bulk_create_marks_credentials_as_encrypted(self):
        await Instance.objects.abulk_create([
            Instance(
                name='async-bulk-created', port=19009, token='async-bulk-token',
                home_dir='/tmp/async-bulk', container_id='cid',
                status=Instance.STATUS_RUNNING, image='image:tag',
            ),
        ])

        instance = await Instance.objects.aget(name='async-bulk-created')
        assert instance.token == 'async-bulk-token'

    @pytest.mark.django_db
    def test_expression_and_bulk_updates_of_credentials_are_rejected(self):
        instance = Instance.objects.create(
            name='bulk-updated', port=19006, token='initial-token', home_dir='/tmp/bulk-update',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )

        with pytest.raises(ValueError):
            Instance.objects.filter(pk=instance.pk).update(token=F('home_dir'))
        instance.token = 'next-token'
        with pytest.raises(ValueError):
            Instance.objects.bulk_update([instance], ['token'])

    @pytest.mark.django_db
    def test_values_and_values_list_return_plaintext_credentials(self):
        instance = Instance.objects.create(
            name='projection', port=19007, token='projection-token', home_dir='/tmp/projection',
            container_id='cid', status=Instance.STATUS_RUNNING, image='image:tag',
        )

        assert Instance.objects.values('token').get(pk=instance.pk) == {
            'token': 'projection-token'
        }
        assert Instance.objects.values_list('token', flat=True).get(pk=instance.pk) == 'projection-token'
        assert Instance.objects.values().get(pk=instance.pk)['token'] == 'projection-token'
        token_index = [field.name for field in Instance._meta.concrete_fields].index('token')
        assert Instance.objects.values_list().get(pk=instance.pk)[token_index] == 'projection-token'
        assert Instance.objects.values_list('token', named=True).get(pk=instance.pk).token == 'projection-token'
        assert Instance.objects.filter(pk=instance.pk).values(total=Count('id')).get()['total'] == 1
        assert Instance.objects.only('token').get(pk=instance.pk).token == 'projection-token'
        assert Instance.objects.only('name').get(pk=instance.pk).token == 'projection-token'
        with pytest.raises(ValueError):
            Instance.objects.defer('token_is_encrypted')
        with pytest.raises(ValueError):
            Instance.objects.defer('token')
        with pytest.raises(ValueError):
            Instance.objects.values(alias=F('token'))
        with pytest.raises(ValueError):
            Instance.objects.values(F('token'))
        with pytest.raises(ValueError):
            Instance.objects.values_list(F('token'))

    @pytest.mark.django_db
    def test_credential_projections_reject_invalid_or_unsupported_combinations(self):
        instance = Instance.objects.create(
            name='projection-rules', port=19010, token='projection-token',
            home_dir='/tmp/projection-rules', container_id='cid',
            status=Instance.STATUS_RUNNING, image='image:tag',
        )
        Pairing.objects.create(instance=instance)

        with pytest.raises(TypeError):
            Instance.objects.values_list('name', 'token', flat=True)
        with pytest.raises(TypeError):
            Instance.objects.values_list('token', flat=True, named=True)
        with pytest.raises(ValueError):
            Pairing.objects.values('instance__token')
        with pytest.raises(ValueError):
            Instance.objects.values_list('token', flat=True).distinct()

    @pytest.mark.django_db
    def test_projection_keeps_annotations_added_after_credentials(self):
        instance = Instance.objects.create(
            name='annotated-projection', port=19011, token='projection-token',
            home_dir='/tmp/annotated-projection', container_id='cid',
            status=Instance.STATUS_RUNNING, image='image:tag',
        )

        projection = Instance.objects.filter(pk=instance.pk).values_list('token').annotate(
            total=Count('id')
        ).get()
        assert projection == ('projection-token', 1)

    @pytest.mark.django_db
    def test_refreshing_non_credential_fields_keeps_credentials_deferred(self):
        instance = Instance.objects.create(
            name='deferred-credential', port=19012, token='deferred-token',
            home_dir='/tmp/deferred-credential', container_id='cid',
            status=Instance.STATUS_RUNNING, image='image:tag',
        )

        instance.refresh_from_db(fields=['status'])

        assert instance.token == 'deferred-token'

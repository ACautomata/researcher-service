from django.conf import settings
from django.db import migrations

from security.credential_cipher import CredentialCipher


class CredentialMigration:
    def __init__(self, apps, schema_editor):
        self._apps = apps
        self._connection = schema_editor.connection
        self._cipher = CredentialCipher(settings.CREDENTIAL_ENCRYPTION_KEYS)

    def encrypt_legacy_values(self, model, field_name, state_field):
        rows = model.objects.filter(**{state_field: False}).values_list('pk', field_name)
        quote = self._connection.ops.quote_name
        table = quote(model._meta.db_table)
        with self._connection.cursor() as cursor:
            for primary_key, value in rows.iterator():
                cursor.execute(
                    f'UPDATE {table} SET {quote(field_name)} = %s, {quote(state_field)} = %s '
                    f'WHERE {quote("id")} = %s',
                    [self._cipher.encrypt(value), True, primary_key],
                )
            cursor.execute(f'SELECT {quote(field_name)} FROM {table}')
            if any(not value.startswith(CredentialCipher.PREFIX) for (value,) in cursor.fetchall()):
                raise RuntimeError(f'credential migration left plaintext {field_name} values')

    def encrypt_legacy_credentials(self):
        pairing = self._apps.get_model('chat', 'Pairing')
        self.encrypt_legacy_values(pairing, 'private_key_pem', 'private_key_pem_is_encrypted')
        self.encrypt_legacy_values(pairing, 'device_token', 'device_token_is_encrypted')


def encrypt_legacy_credentials(apps, schema_editor):
    CredentialMigration(apps, schema_editor).encrypt_legacy_credentials()


class Migration(migrations.Migration):
    dependencies = [('chat', '0005_alter_pairing_credentials')]
    operations = [migrations.RunPython(encrypt_legacy_credentials, migrations.RunPython.noop)]

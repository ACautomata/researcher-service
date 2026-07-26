from django.conf import settings
from django.db import migrations

from security.credential_cipher import CredentialCipher


class CredentialMigration:
    def __init__(self, apps, schema_editor):
        self._apps = apps
        self._connection = schema_editor.connection
        self._cipher = CredentialCipher(settings.CREDENTIAL_ENCRYPTION_KEYS)

    def encrypt_legacy_tokens(self):
        instance = self._apps.get_model('containers', 'Instance')
        rows = instance.objects.filter(token_is_encrypted=False).values_list('pk', 'token')
        quote = self._connection.ops.quote_name
        table = quote(instance._meta.db_table)
        with self._connection.cursor() as cursor:
            for primary_key, token in rows.iterator():
                cursor.execute(
                    f'UPDATE {table} SET {quote("token")} = %s, '
                    f'{quote("token_is_encrypted")} = %s WHERE {quote("id")} = %s',
                    [self._cipher.encrypt(token), True, primary_key],
                )
        with self._connection.cursor() as cursor:
            cursor.execute(f'SELECT {quote("token")} FROM {table}')
            if any(not value.startswith(CredentialCipher.PREFIX) for (value,) in cursor.fetchall()):
                raise RuntimeError('credential migration left plaintext instance tokens')


def encrypt_legacy_tokens(apps, schema_editor):
    CredentialMigration(apps, schema_editor).encrypt_legacy_tokens()


class Migration(migrations.Migration):
    dependencies = [('containers', '0004_alter_instance_token')]
    operations = [migrations.RunPython(encrypt_legacy_tokens, migrations.RunPython.noop)]

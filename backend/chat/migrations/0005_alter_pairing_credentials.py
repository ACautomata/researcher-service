# Generated for issue #55.

from django.db import migrations, models

import security.fields


class Migration(migrations.Migration):
    dependencies = [('chat', '0004_delete_session')]

    operations = [
        migrations.AlterField(
            model_name='pairing',
            name='device_token',
            field=security.fields.EncryptedTextField(
                blank=True, default='', state_field='device_token_is_encrypted',
            ),
        ),
        migrations.AddField(
            model_name='pairing',
            name='device_token_is_encrypted',
            field=models.BooleanField(default=False),
        ),
        migrations.AlterField(
            model_name='pairing',
            name='private_key_pem',
            field=security.fields.EncryptedTextField(
                blank=True, default='', state_field='private_key_pem_is_encrypted',
            ),
        ),
        migrations.AddField(
            model_name='pairing',
            name='private_key_pem_is_encrypted',
            field=models.BooleanField(default=False),
        ),
    ]

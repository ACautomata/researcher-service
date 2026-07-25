# Generated for issue #55.

from django.db import migrations

import security.fields


class Migration(migrations.Migration):

    dependencies = [
        ('chat', '0003_session'),
    ]

    operations = [
        migrations.AlterField(
            model_name='pairing',
            name='device_token',
            field=security.fields.EncryptedTextField(blank=True, default=''),
        ),
        migrations.AlterField(
            model_name='pairing',
            name='private_key_pem',
            field=security.fields.EncryptedTextField(blank=True, default=''),
        ),
    ]

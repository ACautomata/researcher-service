# Generated for issue #55.

from django.db import migrations, models

import security.fields


class Migration(migrations.Migration):

    dependencies = [
        ('containers', '0003_instance_lease_expires_at'),
    ]

    operations = [
        migrations.AlterField(
            model_name='instance',
            name='token',
            field=security.fields.EncryptedTextField(state_field='token_is_encrypted'),
        ),
        migrations.AddField(
            model_name='instance',
            name='token_is_encrypted',
            field=models.BooleanField(default=False),
        ),
    ]

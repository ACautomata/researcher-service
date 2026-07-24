"""codex R1 :77：Instance.port 加 unique 约束——并发端口竞争的 DB 最后仲裁。

应用层 PortAllocator + 保存点重试之外，DB 唯一约束保证两并发 create 选同 port 时
恰有一行 commit，另一行 IntegrityError 触发重试（orchestrator._reserve_row）。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('containers', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='instance',
            name='port',
            field=models.IntegerField(unique=True),
        ),
    ]

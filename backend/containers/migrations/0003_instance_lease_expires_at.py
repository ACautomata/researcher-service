"""codex R8 F1：Instance.lease_expires_at——跨进程可续期 lease（替代 R7 的 created_at+60s）。

R7 用 created_at 时间窗口保护跨 worker 的活动 create，但合法长 create（cp -a/run > 60s）
会被误收敛。R8 改用持久化 lease：_reserve_row 设置、create 在 run 前 checkpoint 续约，
_reconcile_creating 据此判定活动 create（lease 未过期即不收敛）。DB 共享态 = 多 worker 可见。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('containers', '0002_instance_port_unique'),
    ]

    operations = [
        migrations.AddField(
            model_name='instance',
            name='lease_expires_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]

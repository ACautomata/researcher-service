"""chat 0004：删 chat.Session 表（issue #81 / spec #76）。

会话切换为 OpenClaw 网关权威，后端零 session 持久化——本地 chat_session 记账表删除，数据可弃。
"""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('chat', '0003_session'),
    ]

    operations = [
        migrations.DeleteModel(name='Session'),
    ]

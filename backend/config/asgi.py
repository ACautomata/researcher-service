"""
ASGI config for config project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.0/howto/deployment/asgi/
"""

import os

from django.core.asgi import get_asgi_application

# 生产入口默认 prod：prod settings 强制 DJANGO_SECRET_KEY（缺失即 fail-fast），
# 避免误用 dev（DEBUG=True / ALLOWED_HOSTS=*）。开发用 manage.py（默认 dev）。
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.prod')

application = get_asgi_application()

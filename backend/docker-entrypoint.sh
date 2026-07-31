#!/bin/sh
# backend 容器入口：先跑迁移（prod settings，幂等），再起 ASGI(daphne)。
# manage.py 默认 dev（setdefault），故显式 --settings 强制 prod——与 asgi.py 的 prod 默认对齐。
set -e

echo "[entrypoint] running database migrations (config.settings.prod)..."
python manage.py migrate --noinput --settings=config.settings.prod

echo "[entrypoint] starting daphne on 0.0.0.0:8000..."
exec daphne -b 0.0.0.0 -p 8000 config.asgi:application

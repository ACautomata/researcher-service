# backend —— Django 多 OpenClaw 容器管理面板 API

P0 骨架（[issue #37](https://github.com/ACautomata/researcher-service/issues/37)）。
完整规格见 `../docs/FULLSTACK-REFACTOR-SPEC.md`。

## 技术栈

Django 6 + DRF + drf-spectacular（OpenAPI）+ djangorestframework-simplejwt + channels。

## 开发

```bash
# Python 3.13 虚拟环境
python3.13 -m venv .venv && . .venv/bin/activate
pip install -r requirements/dev.txt
python manage.py migrate
python manage.py runserver     # http://localhost:8000
```

## 测试

```bash
python -m pytest
```

## 端点（P0 骨架）

| 方法 | 路径 | 说明 | 认证 |
|---|---|---|---|
| GET | `/api/health` | 健康检查 | 公开 |
| GET | `/api/schema?format=json` | OpenAPI schema | 公开 |
| POST | `/api/v1/auth/register` | 本地账号注册 | 公开 |
| POST | `/api/v1/auth/login` | 登录签发 access/refresh | 公开 |
| POST | `/api/v1/auth/token/refresh` | 刷新 access | 公开 |
| POST | `/api/v1/auth/logout` | 登出（失效 refresh cookie） | 需 JWT |
| GET | `/api/v1/auth/me` | 当前用户 | 需 JWT |
| GET | `/api/v1/auth/oauth/<p>/login` | OIDC 登录占位（未配置 501） | 公开 |
| GET | `/api/v1/auth/oauth/<p>/callback` | OIDC 回调占位（未配置 501） | 公开 |

全局 `DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]`，上表公开端点显式 `AllowAny`。
WebSocket 握手经自定义 `accounts.middleware.JwtAuthMiddleware` 验同一 JWT
（`config.asgi` ProtocolTypeRouter 接入）；chat consumer 路由留 P1 chat ticket。
containers（Docker SDK 编排）/ wiki / models / chat app 仅建骨架，留后续 ticket。

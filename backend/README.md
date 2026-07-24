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
| GET | `/api/v1/containers/` | 容器列表（name/status/health/port/image） | 需 JWT |
| POST | `/api/v1/containers/` | 新建容器（body: `{name}`） | 需 JWT |
| DELETE | `/api/v1/containers/<name>` | 删除容器（默认连数据删） | 需 JWT |

全局 `DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]`，上表公开端点显式 `AllowAny`。
WebSocket 握手经自定义 `accounts.middleware.JwtAuthMiddleware` 验同一 JWT
（`config.asgi` ProtocolTypeRouter 接入）；chat consumer 路由留 P1 chat ticket。
containers app（Docker SDK 编排，[issue #39](https://github.com/researcher-service/issues/39) T03）已落地；
wiki / models / chat app 仅建骨架，留后续 ticket。

## 容器编排控制面（spec §5）

经 docker-py 挂 `/var/run/docker.sock` 增删查 OpenClaw 容器（每容器独立 home + openclaw.json + 端口）。
配置走 `settings.OPENCLAW_FLEET`（可用环境变量覆盖）：

| 配置 | env | 默认 | 说明 |
|---|---|---|---|
| `ROOT` | `OPENCLAW_FLEET_ROOT` | `<repo>/fleet` | `instances/<name>/` 落盘根 |
| `TEMPLATE` | `OPENCLAW_TEMPLATE_DIR` | `/srv/openclaw/template/researcher` | 共享只读模板（`cp -a` 预填充源，需 `git clone ACautomata/researcher`） |
| `IMAGE` | `OPENCLAW_IMAGE` | `acautomata/openclaw-docker-cn-im:latest` | 镜像 tag（生产建议 pin digest） |
| `LLM_API_KEY` | `LLM_API_KEY` | — | 全面板共享 LLM key（env 注入容器，不落盘） |

端口池 `19000–19999`（避开单容器 compose 占用的 18789）。容器命名 `openclaw-gw-<name>`，label
`app=openclaw-fleet`。`GATEWAY_TOKEN` 每容器独立生成（`secrets.token_urlsafe`），经 env 注入，
JSON 内仅 `${GATEWAY_TOKEN}` 占位（不落盘）。

> ⚠ **安全**：Django 挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信部署
> 可接受；生产应限制 Django 网络面或改用 rootless / 远程 TLS daemon。

### integration smoke（需真 daemon）

默认 skip。手动验证建/删容器真实链路：

```bash
export RUN_INTEGRATION=1
export OPENCLAW_TEMPLATE_DIR=/path/to/researcher     # git clone ACautomata/researcher
export OPENCLAW_IMAGE=acautomata/openclaw-docker-cn-im:latest
export LLM_API_KEY=sk-...
python -m pytest containers/tests/test_integration.py -v
```

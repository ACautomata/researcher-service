# backend —— Django 多 OpenClaw 容器管理面板 API

P0 骨架（[issue #37](https://github.com/ACautomata/researcher-service/issues/37)）。
完整规格见 `../docs/FULLSTACK-REFACTOR-SPEC.md`。

## 技术栈

Django 6 + DRF + drf-spectacular（OpenAPI）+ djangorestframework-simplejwt + channels。

> **部署前提（issue #201）**：仅支持 **ASGI（Daphne）单进程单 worker**——REST sync 视图经
> `async_to_sync` 驱动共享 WS pool client，依赖「一切跑在一根事件循环上」；WSGI 入口
> （`config/wsgi.py`）已禁用（import 即 fail-fast），多 worker / WSGI 部署不支持。
> 生产启动：`daphne config.asgi:application`。

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

门控同下方 wire 段：`pytestmark = pytest.mark.integration`（env 缺失直接 fail，不跳过）；CI `backend-unit` job 经 `-m "not integration"` 排除，`integration` job env 齐备时真跑。手动验证建/删容器真实链路：

```bash
export OPENCLAW_TEMPLATE_DIR=/path/to/researcher     # git clone ACautomata/researcher
export OPENCLAW_IMAGE=acautomata/openclaw-docker-cn-im:latest
export LLM_API_KEY=sk-...
python -m pytest containers/tests/test_integration.py -v
```

### chat wire schema 集成测试（ghcr 真镜像）

`chat/tests/test_integration_wire.py`（[issue #155](https://github.com/ACautomata/researcher-service/issues/155)）用真实
`ghcr.io/openclaw/openclaw:2026.6.34-browser` 镜像起 OpenClaw 容器 + Ed25519 设备配对，对 chat 模块依赖的
9 个 wire schema 假设逐一断言（事件结构/字段名/方法名），防止 `FakeChatTransport` 掩盖的假设错误再次潜伏。
既是已修 bug（PR #152 / #153 / #154）的回归防护，又是 wire schema 契约的长期基线。覆盖 T1–T5 五个用例：
chat.send 冒烟、事件流 schema、只读 RPC schema、exec 审批路径 schema、工具调用事件 schema。

**env 三件套**（`OPENCLAW_TEMPLATE_DIR`/`LLM_API_KEY` 必需；`OPENCLAW_IMAGE` 可选，缺省用下方 ghcr 官方镜像。门控见下）：

| env | 用途 |
|---|---|
| `OPENCLAW_IMAGE` | **可选**（缺省默认 `ghcr.io/openclaw/openclaw:2026.6.34-browser`，覆盖 #94 fork 默认） |
| `OPENCLAW_TEMPLATE_DIR` | 容器 home 模板源（bind-mount 白名单路径，非 `/tmp`） |
| `LLM_API_KEY` | 全面板共享 LLM key（注入容器，不落盘） |

**门控——integration marker（非 `RUN_INTEGRATION`）**：测试文件 `pytestmark = pytest.mark.integration`，
**无 skip**，env 缺失直接 fail（强制环境就绪，不靠 skip 兜底）。CI 双轨（`.github/workflows/ci.yml`）：
`backend-unit` job 跑 `-m "not integration"` 排除真容器；`integration` job env 齐备时跑 `-m "integration"` 真验证。
上方 `containers/tests/test_integration.py`（#94 smoke）共用同一 `pytestmark = pytest.mark.integration` 门控
（#157 统一重构自旧的 daemon 探测+skip）——两者仅覆盖面（容器生命周期/配对/chat/wiki 全链路 vs. chat
wire schema）与镜像（fork 默认 vs. ghcr 官方）不同，门控一致。

**本地怎么跑**（须 docker daemon + `OPENCLAW_TEMPLATE_DIR`/`LLM_API_KEY`；`OPENCLAW_IMAGE` 可选用默认）：

```bash
export OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.6.34-browser
export OPENCLAW_TEMPLATE_DIR=/path/to/researcher     # git clone ACautomata/researcher
export LLM_API_KEY=sk-...
# Colima virtiofs 只共享 $HOME：pytest 默认 tmp_path（/var/folders/…）bind-mount 退化为空目录
# → 网关报 Missing config。用 --basetemp 覆盖到 $HOME 下：
python -m pytest chat/tests/test_integration_wire.py -v --basetemp=$HOME/.cache/pytest-wire
```

### 前后端联调集成测试（Playwright × Vite proxy × live Django）

`tests/integration/test_integration_http.py`（[issue #178](https://github.com/ACautomata/researcher-service/issues/178) /
[#179](https://github.com/ACautomata/researcher-service/issues/179)）用 Playwright Python 客户端驱动真浏览器，经
Vite dev server (5173) 的 `/api` proxy 打 pytest-django 起的 live Django 后端，断言 HTTP 响应状态码 + JSON 契约
（源真相在后端 serializer）。覆盖前端 mock `fetch` / 后端 `APIClient` 都测不到的「真浏览器 → Vite proxy → live 后端」
三节点链路（jsdom 测不到 httpOnly cookie / 401→refresh 重试）。门控同 wire 段（`pytestmark = integration`）。

**额外依赖**（wire 三件套之外）：`pip install -r requirements/integration.txt`（含 Playwright，dev.txt 超集）+
`python -m playwright install chromium` + frontend `npm ci`（conftest 经 subprocess 起 vite dev server）。

**本地怎么跑**（L0 health case 不需 docker daemon）：

```bash
pip install -r requirements/integration.txt
python -m playwright install chromium
(cd ../frontend && npm ci)
python -m pytest -m integration tests/integration/test_integration_http.py -v
```

> vite dev server 由 conftest 经 `VITE_API_TARGET` 注入 live server 随机端口（dev 行为不变——
> `vite.config.ts` proxy target 缺省 `http://localhost:8000`，`npm run dev` 完全不受影响）。

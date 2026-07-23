# AI Research Pipeline — 单 main-agent OpenClaw 部署

FastAPI 后端 + 单文件 vanilla-JS 前端的「AI Research Pipeline」，桥接一个**单 `main` agent** 的 OpenClaw 部署。配置来源是外部仓库 [ACautomata/researcher](https://github.com/ACautomata/researcher)（已是单 main agent 的 OpenClaw home），本仓库用精简 compose 栈（`deploy/`）承载网关，传输走 **WebSocket**。

## 架构总览

```
浏览器 (前端 JS)
    │ POST /api/v1/openclaw/*        （前端 SSE 契约 text/done/error/raw 不变）
    ▼
FastAPI (localhost:8000)
    │ routes/openclaw.py  →  services/openclaw_service.py  →  services/openclaw_ws.py
    │ WebSocket  ws://127.0.0.1:18789/   （chat.send，agentId=main）
    ▼
OpenClaw 网关 (Docker 容器，researcher 挂载为 ~/.openclaw)
    │ agents.list 仅 main（allowAgents: []）
    ▼
main agent 调用底层模型（models.providers，由 deploy/openclaw.json 托管）
    ▼
WS chat 事件（deltaText/final/error）→ Pipeline 翻译成 SSE → 前端实时渲染
```

**范围约定**：仅一个 `main` agent；**不接任何消息 channel**（feishu/discord 全裁）；Wiki 页与独立的 Claude Agent SDK（`routes/agent.py`）保留不动。

## 部署

### 前置

- Docker + compose plugin
- 本仓库 `.env`：`OPENCLAW_ENABLED=true`、`OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789`、`OPENCLAW_GATEWAY_TOKEN=<同 deploy/.env 的 GATEWAY_TOKEN>`

### 步骤

```bash
# 1. 克隆 researcher 配置仓库（提供 workspace/ + wiki/ + skills/；其 openclaw.json 被本仓库 deploy/openclaw.json 覆盖）
git clone https://github.com/ACautomata/researcher ./researcher

# 2. 配置网关环境（GATEWAY_TOKEN 强随机 + LLM_API_KEY）
cp deploy/.env.example deploy/.env   # 填入 GATEWAY_TOKEN 与 LLM_API_KEY

# 3. 启动 OpenClaw 网关
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
curl http://127.0.0.1:18789/health

# 4. 启动本仓库后端
python main.py    # http://localhost:8000
```

**配置单一来源在本仓库**：`deploy/openclaw.json` 是精简版（删 channels/bindings/lossless-claw、contextEngine=legacy、`gateway.bind=lan`），compose 把它单独 bind-mount 覆盖 researcher 的同名文件；researcher 仓库**不动**。详见 `deploy/README.md`。

## 前端页面

导航栏「OpenClaw」分组下有 3 个页面（子 agent 页面已删除）：

| 页面 ID | 名称 | 说明 |
|---------|------|------|
| oc-main | 颖姗（主Agent） | 主科研助手，多 Session 流式对话 |
| wiki | Wiki 知识库 | 读 researcher `wiki/main`（memory-wiki vault） |
| ocstatus | OpenClaw 状态 | 网关可达性 + 容器状态 + main |

### 页面代码结构

```
public/js/pages/
├── openclaw_shared.js   ← 共享模块（多 Session、SSE 流式、消息渲染、文件上传）
├── openclaw_main.js     ← 颖姗页面（仅 1 行：buildOcAgentPage('main')）
├── wiki.js              ← Wiki 页（按五核心分类 + domains 分组）
└── ocstatus.js          ← 状态面板（gateway + main）
```

## 调用流程

### 流式对话（WS）

```
1. 用户输入 → 前端 ocSend('main')
2. POST /api/v1/openclaw/chat/stream  { agent_id, message, session_key }
3. Pipeline 创建 task_id + asyncio.Queue
4. 后台协程经进程级 WS 单例向网关 chat.send：
     ws://127.0.0.1:18789/  connect.challenge→connect(auth.token)→hello-ok
     chat.send { sessionKey, message, idempotencyKey, agentId: "main" }
5. 网关按 runId 推 chat 事件（delta/final/error）→ Pipeline 映射为 SSE：
     delta→text、final→done、error→error、终态后补 done
6. 前端 EventSource 逐事件渲染（契约 text/done/error/raw 不变）
```

**行为差异（相对旧 HTTP 实现）**：
- **会话记忆**复用 `session_key`（网关按 sessionKey 维护历史，不再逐条传 history）。
- **system_prompt** 拼接到 message 前缀（WS `chat.send` 无 instructions 对等字段）。
- **temperature / max_tokens** 不再由调用方传，由网关 `openclaw.json` 的 agent 配置托管。
- `chat()`（非流式）复用流式路径收集 text 拼接。

### 非流式对话

```
POST /api/v1/openclaw/chat  { agent_id, message, session_key }
→ 复用流式路径收集全部 text → 返回 { text, raw }
```

## 模型配置（apply-config 去 Docker 化）

个人配置页 → OpenClaw Agent 区域，支持 3 个厂商（DeepSeek / Anthropic / 自定义，均 anthropic-messages 协议）。

```
前端点击「应用当前配置到 OpenClaw」
    ↓
POST /api/v1/openclaw/apply-config  { api_base, api_key, api_model }
    ↓
Pipeline:
  1. 按 URL 推断 provider（deepseek/anthropic/custom）
  2. 只写 RESEARCHER_CONFIG_PATH 的 models.providers + agents.defaults.model（单 main）
     apiKey 用 SecretRef（env LLM_API_KEY），不明文写盘
  3. docker compose restart openclaw-gateway（RESEARCHER_COMPOSE_DIR，默认 ./deploy）
     —— sync 全关后 init 不覆盖配置，无需 docker cp/回写
```

> 生效需后端进程有 docker/compose 权限 + 正确 compose 工作目录；失败不阻断（配置已写盘，下次重启容器生效）。

## 文件上传

```
用户选文件 → POST /api/v1/openclaw/upload  (multipart, agent_id=main + file)
    ↓   （仅接受 main；非 main 拒绝）
Pipeline 保存到 RESEARCHER_WORKSPACE_PATH/oc-uploads/  （默认 ./researcher/workspace/oc-uploads/，uuid 前缀防重名）
    ↓   （researcher bind mount → 容器内 /home/node/.openclaw/workspace/oc-uploads/）
前端在消息文本中追加文件路径，agent 用文件系统工具读取
```

图片文件（image/*）改经 WS `chat.send` 的 `attachments[]`（`{mimeType, fileName, content=纯base64}`，剥 data URL 前缀）传递；非图片仅上传到工作空间由 agent 自行读取。

## Wiki 知识库

读 researcher 的 `wiki/main`（memory-wiki 插件 vault，render mode=obsidian）。`GET /openclaw/wiki` 按**五核心分类**（concepts/entities/sources/syntheses/reports）+ `domains/<domain>/papers/` 子树分组列出页面，跳过 `.openclaw-wiki/`（插件私有）、`_attachments/`、`_views/` 与各目录 `index.md` 占位；frontmatter 兼容插件官方（`pageType/id/title`）与 researcher 论文页（`type/domain/paper.*/evidence_level`）双 schema。`PUT` 只覆盖已存在页面，不新建、不动 `index.md` 的 `openclaw:wiki:*` 生成块。

## 后端 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/openclaw/health | 网关连接状态 |
| GET | /api/v1/openclaw/status | 网关可达性 + 容器 + main 状态 |
| POST | /api/v1/openclaw/chat | 非流式对话 |
| POST | /api/v1/openclaw/chat/stream | SSE 流式对话（返回 task_id） |
| GET | /api/v1/openclaw/chat/{tid}/stream | 消费 SSE 事件流 |
| POST | /api/v1/openclaw/upload | 上传文件到 main workspace |
| POST | /api/v1/openclaw/apply-config | 写模型配置到 researcher openclaw.json 并重启生效 |
| GET | /api/v1/openclaw/sessions | 活跃会话列表 |
| GET | /api/v1/openclaw/wiki | Wiki 页面分组列表 |
| GET | /api/v1/openclaw/wiki/{kind}/{name}/{page_id} | 读 Wiki 单页 |
| PUT | /api/v1/openclaw/wiki/{kind}/{name}/{page_id} | 覆盖已有 Wiki 页 |

## 配置项（.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| OPENCLAW_ENABLED | false | 启用 OpenClaw 桥接 |
| OPENCLAW_GATEWAY_URL | http://127.0.0.1:18789 | 网关地址（WS 用 ws:// 同源） |
| OPENCLAW_GATEWAY_TOKEN | — | = deploy/.env 的 GATEWAY_TOKEN |
| RESEARCHER_CONFIG_PATH | ./deploy/openclaw.json | apply-config 写入的精简配置（compose 挂载覆盖源） |
| RESEARCHER_WORKSPACE_PATH | ./researcher/workspace | main workspace 根（上传落 oc-uploads） |
| RESEARCHER_WIKI_ROOT | ./researcher/wiki/main | Wiki 读取根（memory-wiki vault） |
| RESEARCHER_COMPOSE_DIR | ./deploy | apply-config 后 docker compose restart 的工作目录 |

## 相关文件索引

| 文件 | 说明 |
|------|------|
| routes/openclaw.py | OpenClaw API 路由（chat/upload/apply-config/status/wiki） |
| services/openclaw_service.py | 对前端 SSE 契约 + WS 事件翻译 |
| services/openclaw_ws.py | 进程级 WS 客户端单例（握手/重连/runId 路由） |
| services/user_credentials.py | 逐用户凭证解析（含 OpenClaw） |
| deploy/ | 精简 compose 栈 + deploy/openclaw.json（配置单一来源） |
| public/js/pages/openclaw_shared.js | 前端共享模块（Session/SSE/渲染） |

## 测试

```bash
pip install -r requirements.txt
pytest tests/ -q
```

接缝测试（issue #15 Testing Decisions）：用 FastAPI ASGI transport 对各 openclaw 路由做集成测试，在 openclaw_service 与真实网关之间放 fake OpenClaw WS 服务器替身（`tests/fake_openclaw.py`，模拟握手 + 推送 chat 事件帧）挡下游网络，不需真实容器。

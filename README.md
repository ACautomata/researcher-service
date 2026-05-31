# AI Research Pipeline — OpenClaw 对接架构

## 架构总览

```
浏览器 (前端 JS)
    │
    │ POST /api/v1/openclaw/*
    ▼
FastAPI (localhost:9093)
    │
    │ routes/openclaw.py  →  services/openclaw_service.py
    │
    │ POST http://127.0.0.1:18789/v1/responses
    ▼
OpenClaw 网关 (Docker 容器)
    │
    │ 根据 model 参数路由到 Agent
    │ model="openclaw/main" → 颖姗
    │ model="openclaw/autoresearch" → Autoresearch
    │ model="openclaw/paper-review" → Paper Review
    │ model="openclaw/idea-generate" → Idea Generate
    │
    ▼
    Agent 调用底层模型 (DeepSeek / Claude 等)
    │
    ▼
    SSE 流式响应返回 → Pipeline 转发 → 前端实时渲染
```

## 部署拓扑

| 组件 | 位置 | 端口 | 说明 |
|------|------|------|------|
| FastAPI Pipeline | 宿主机 | 9093 | 对外提供服务，桥接前端和 OpenClaw |
| OpenClaw 网关 | Docker 容器 | 18789 | 管理 Agent 路由、模型调用、会话 |
| DeepSeek API | 外部 | api.deepseek.com | 底层 AI 模型（Anthropic 协议） |

## 前端页面

导航栏「OpenClaw」分组下有 5 个页面：

| 页面 ID | 名称 | Agent ID | 说明 |
|---------|------|----------|------|
| oc-main | 颖姗（主Agent） | main | 主科研助手，可委派子Agent |
| oc-autoresearch | Autoresearch | autoresearch | 论文知识库维护 |
| oc-review | Paper Review | paper-review | 5阶段论文深度评审 |
| oc-idea | Idea Generate | idea-generate | 研究想法生成 |
| ocstatus | OpenClaw 状态 | — | 网关/容器/Agent监控 |

### 页面代码结构

```
public/js/pages/
├── openclaw_shared.js      ← 共享模块（所有 Agent 页面的逻辑）
├── openclaw_main.js        ← 颖姗页面（仅 1 行：调用 shared 模块）
├── openclaw_autoresearch.js
├── openclaw_review.js
└── openclaw_idea.js
```

每个 Agent 页面仅一行代码，调用 `buildOcAgentPage(agentId)` 生成 UI。所有交互逻辑（多 Session、SSE 流式、消息渲染、文件上传）在 `openclaw_shared.js` 中。

### 多 Session 机制

- 每个 Agent 页面支持多个独立会话
- 会话保存在 `localStorage`（`oc_sessions_{agentId}`），刷新/切页面不丢失
- 每个会话通过 `session_key` 传给 OpenClaw 网关实现隔离
- 用户可创建/切换/删除会话，也可清空全部

## 调用流程

### 流式对话

```
1. 用户输入消息 → 前端 ocSend(agentId)
2. POST /api/v1/openclaw/chat/stream  { agent_id, message, history }
3. Pipeline 创建 task_id + asyncio.Queue
4. 后台协程调用 OpenClaw 网关：
   POST http://127.0.0.1:18789/v1/responses  { model, input, stream: true }
5. 网关返回 SSE 事件流 → Pipeline 转发给前端
6. 前端 EventSource 逐事件解析 → 实时更新聊天界面
```

### 非流式对话

```
POST /api/v1/openclaw/chat  { agent_id, message }
→ 等待完整响应 → 返回 { text }
```

### 论文评审（已废弃，合并到对话 Session）

原有独立论文评审功能已废弃。现直接在对话中向 Paper Review Agent 发送论文内容即可。

## 模型配置

### 界面配置路径

个人配置页面 → OpenClaw Agent 区域，支持 3 个厂商：

| 厂商 | 协议 | Base URL |
|------|------|----------|
| DeepSeek（Anthropic协议） | anthropic-messages | https://api.deepseek.com/anthropic |
| Anthropic（Claude） | anthropic-messages | https://api.anthropic.com |
| 自定义 | anthropic-messages | 用户手动输入 |

选择厂商 → 填写 API Key → 点击「应用当前配置到 OpenClaw」。

### 应用配置流程

```
前端点击「应用当前配置到 OpenClaw」
    ↓
POST /api/v1/openclaw/apply-config  { api_base, api_key, api_model }
    ↓
Pipeline:
  1. 根据 URL 自动识别 provider（deepseek/anthropic/custom）
  2. 完整替换 openclaw.json 的 models.providers 段
  3. 更新 agents.defaults.model
  4. 更新 auth.profiles
  5. 为每个子 Agent 创建 auth-profiles.json
  6. docker compose restart
  7. 等待 init.sh 完成（18s）
  8. docker cp 回写配置（修复 init.sh 覆盖）
  9. docker cp auth-profiles.json 到各子 Agent
  10. pkill 网关进程（init.sh 自动重启，使用新配置）
  11. 再等待 15s + 补写一次配置
```

## 文件上传

文件上传走独立端点，不通过 OpenClaw API：

```
用户选文件 → POST /api/v1/openclaw/upload  (multipart, agent_id + file)
    ↓
Pipeline 保存到 /root/.openclaw/{workspace}/oc-uploads/
    ↓    (Docker bind mount 自动同步)
Docker 容器内路径：/home/node/.openclaw/{workspace}/oc-uploads/
    ↓
前端在消息文本中追加文件路径列表：
  "[附件]
   1. paper.pdf（oc-uploads/abc123_paper.pdf）
   （用户上传了以上文件，详见对应路径）"
    ↓
Agent 收到消息 → 用文件系统工具读取 oc-uploads/abc123_paper.pdf
```

支持的 Agent 工作空间目录：

| Agent | 宿主机路径 | 容器内路径 |
|-------|-----------|-----------|
| main | /root/.openclaw/workspace/oc-uploads/ | /home/node/.openclaw/workspace/oc-uploads/ |
| autoresearch | /root/.openclaw/workspace-autoresearch/oc-uploads/ | /home/node/.openclaw/workspace-autoresearch/oc-uploads/ |
| paper-review | /root/.openclaw/workspace-paper-review/oc-uploads/ | /home/node/.openclaw/workspace-paper-review/oc-uploads/ |
| idea-generate | /root/.openclaw/workspace-idea-generate/oc-uploads/ | /home/node/.openclaw/workspace-idea-generate/oc-uploads/ |

图片文件（image/*）通过 OpenClaw OpenResponses 的 `input_image` 类型发送，非图片文件仅上传到工作空间由 Agent 自行读取。

## Docker 部署

### 容器信息

- 镜像：`justlikemaki/openclaw-docker-cn-im:latest`
- 端口映射：`0.0.0.0:18789 → 18789`
- 数据卷：`/root/.openclaw → /home/node/.openclaw` (bind mount)
- 重启策略：`unless-stopped`

### 管理命令

```bash
# 查看 OpenClaw 日志
docker logs -f openclaw-gateway

# 重启 OpenClaw
cd /root/openclaw-docker-cn-im-main && docker compose restart

# 进入容器
docker exec -it openclaw-gateway bash

# 查看当前模型配置
grep -A10 providers /root/.openclaw/openclaw.json
```

## 配置目录结构

```
/root/.openclaw/                     ← Docker bind mount → /home/node/.openclaw/
├── openclaw.json                    ← 网关主配置（会被 Docker 种子覆盖）
├── openclaw.json.bak                ← 配置备份（init.sh 自动生成）
├── workspace/                       ← 主 Agent（颖姗）工作空间
│   ├── AGENTS.md
│   ├── SOUL.md
│   └── oc-uploads/                  ← 上传文件存放目录
├── workspace-autoresearch/          ← Autoresearch 工作空间
│   └── oc-uploads/
├── workspace-paper-review/          ← Paper Review 工作空间
│   └── oc-uploads/
├── workspace-idea-generate/         ← Idea Generate 工作空间
│   └── oc-uploads/
├── agents/                          ← Agent 认证配置
│   ├── autoresearch/agent/auth-profiles.json
│   ├── paper-review/agent/auth-profiles.json
│   └── idea-generate/agent/auth-profiles.json
└── skills/                          ← 跨 Agent 共享技能
```

## 已知问题

### 1. Docker 种子覆盖配置

每次 `docker compose restart` 时，容器 init.sh 会生成一份种子 openclaw.json，覆盖自定义配置。`apply-config` 端点通过「写配置 → compose restart → 等待 → docker cp 回写」的方式绕过，仍可能因网络/超时问题失败。

**解决思路**：修改 init.sh 或禁用种子机制。当前已验证的规避方案是 `docker compose restart` 后立即 `docker cp` 覆盖。

### 2. 子 Agent 认证隔离

每个子 Agent（autoresearch/paper-review/idea-generate）有自己的 `auth-profiles.json`，不继承主 Agent 的认证。
`apply-config` 端点会自动为所有子 Agent 创建/更新认证文件。

### 3. 模型 Key 丢失

容器重启后，种子配置中的 `apiKey` 字段可能被清空。需通过「个人配置」页面重新应用配置。

## 后端 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/openclaw/health | 网关连接状态 |
| GET | /api/v1/openclaw/agents | 可用 Agent 列表 |
| GET | /api/v1/openclaw/status | 网关/容器/Agent 状态面板数据 |
| POST | /api/v1/openclaw/chat | 非流式对话 |
| POST | /api/v1/openclaw/chat/stream | SSE 流式对话（返回 task_id） |
| GET | /api/v1/openclaw/chat/{tid}/stream | 消费 SSE 事件流 |
| POST | /api/v1/openclaw/upload | 上传文件到 Agent 工作空间 |
| POST | /api/v1/openclaw/apply-config | 应用 API 配置到 Docker |
| GET | /api/v1/openclaw/sessions | 活跃会话列表 |
| POST | /api/v1/openclaw/paper-review | （已废弃）论文评审 |
| GET | /api/v1/openclaw/paper-review/{tid}/progress | （已废弃） |

## 相关文件索引

| 文件 | 说明 |
|------|------|
| routes/openclaw.py | 所有 OpenClaw API 路由 |
| services/openclaw_service.py | OpenClaw 网关 HTTP 客户端 |
| services/user_credentials.py | 逐用户凭证解析（含 OpenClaw） |
| public/js/pages/openclaw_shared.js | 前端共享模块（Session/SSE/渲染） |
| public/js/pages/openclaw_main.js | 颖姗页面 |
| public/js/pages/openclaw_autoresearch.js | Autoresearch 页面 |
| public/js/pages/openclaw_review.js | Paper Review 页面 |
| public/js/pages/openclaw_idea.js | Idea Generate 页面 |
| research-agent-main/openclaw.json | OpenClaw 网关配置文件模板 |
| openclaw-docker-cn-im-main/docker-compose.yml | Docker 部署配置 |

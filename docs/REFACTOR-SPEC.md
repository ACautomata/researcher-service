# 重构 spec：单 main-agent OpenClaw 部署

> wayfinder map [#5](https://github.com/ACautomata/researcher-service/issues/5) 的 destination 产物。
> 本 spec 把本仓库（researcher-service，FastAPI 后端 + 单文件 vanilla-JS 前端）重构为围绕
> `acautomata/openclaw-docker-cn-im` 容器运行的**单 main agent** OpenClaw 部署。
>
> 每步标注来源 ticket。详细调研见 `docs/research/r6` / `r7` / `r8` / `r13`。

## 目标三件套

1. **`research-agent-main/` → `ACautomata/researcher`**：删除本地目录，部署期 clone researcher 作为容器 `~/.openclaw` 配置卷（#6）。
2. **新增 compose 栈**：本仓库 `deploy/` 承载 OpenClaw 网关（#9）。
3. **删所有非 main agent 引用**：autoresearch / paper-review / idea-generate（#3、#12）。
4. **传输改 WebSocket**：与网关的连接从 HTTP `/v1/responses` 改为 WS（#13）。

**范围约定（已拍板）**：仅删 3 个子 agent；保留 Wiki 页、ocstatus、profile OpenClaw 配置区、oc-main 对话、以及独立的 Claude Agent SDK（`routes/agent.py`，out of scope）。**不接任何消息 channel**（feishu/discord 全裁）。

---

## 阶段 0 — 前置：移除 `research-agent-main/`

- [ ] `git rm -r research-agent-main/`，加入 `.gitignore` 不再需要（目录消失）。
- [ ] 部署期改为 clone researcher：
  ```bash
  git clone https://github.com/ACautomata/researcher ./researcher
  ```
  researcher 仓库根 = 一份完整 OpenClaw home（`openclaw.json` + `workspace/` + `wiki/` + `skills/`）。researcher **已是单 main agent**（`agents.list` 仅 main、`allowAgents: []`），无需再改其 agent 结构。

## 阶段 1 — compose 栈（deploy/）

已产出原型（#9）：`deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/README.md`。

- [ ] 采用 `deploy/docker-compose.yml`：单服务 `openclaw-gateway`，镜像 `acautomata/openclaw-docker-cn-im`（生产 pin digest，latest=2026.7.1）。
- [ ] 挂载 `${RESEARCHER_DIR:-./researcher}` → `/home/node/.openclaw`（读写）；运行时 `state/`、`logs/` 用匿名卷避免污染 researcher git 树（R6 风险残留）。
- [ ] 4 个 sync flag 全关（`SYNC_OPENCLAW_CONFIG/MODEL_CONFIG=false`、`SYNC_EXTENSIONS_ON_START=false`、`SYNC_EXTENSIONS_MODE=none`）→ init.sh 不覆写挂载的 openclaw.json、不明文写凭证（R6）。
- [ ] env：`LLM_API_KEY`（SecretRef 运行时读，勿写盘）、`GATEWAY_TOKEN`（researcher openclaw.json 用 `${GATEWAY_TOKEN}` 占位；**token 认证始终强制，不设 `ALLOW_INSECURE_AUTH`**）、`OPENCLAW_GATEWAY_BIND=lan`（FastAPI 跨容器访问必需）、`OPENCLAW_PLUGINS_ENABLED=true`（memory-wiki 需）、`DM_POLICY=disabled`/`GROUP_POLICY=disabled`/`ALLOW_FROM=""`。
- [ ] 端口 `127.0.0.1:18789:18789`（Control UI 是 admin 面，勿暴露公网）。

### researcher openclaw.json 精简（不接 channel，R8）

- [ ] 删 `channels`、`bindings`（留 feishu 会因缺 `FEISHU_*` secret 启动失败）。
- [ ] `plugins.slots.contextEngine`: `lossless-claw` → `legacy`；删 `plugins.entries.lossless-claw` / `installs.lossless-claw`。
- [ ] 裁 `plugins.entries.browser`、顶层 `browser`、`plugins.entries.memory-core`（可选）。
- [ ] 留 `plugins.entries.minimax`、`plugins.entries.memory-wiki`（enabled:true）。
- [ ] 走 WS 后 HTTP `responses.enabled` **非必需**（R8/R13）。

## 阶段 2 — 后端：清理子 agent 引用 + WS 接入

### 2a. 删子 agent 引用（#12）

- [ ] `routes/openclaw.py`：
  - 删 `POST /openclaw/paper-review` + `GET /openclaw/paper-review/{tid}/progress`。
  - `_AGENT_WORKSPACES` → 仅 `{"main": "workspace"}`；`POST /openclaw/upload` 强制 `agent_id=main`，落到 researcher `workspace/oc-uploads`。
  - `GET /openclaw/status` 简化为只报 gateway 可达性 + 容器状态 + main；去 subagent_count/agent_count/is_subagent。
  - `apply-config` 删子 agent auth-profiles 循环与所有 `docker cp`/`time.sleep`（见 2c）。
- [ ] `services/openclaw_service.py`：删 `list_agents()` 与 `GET /openclaw/agents`（前端写死 main）。
- [ ] 全仓 grep 确认无残留 `autoresearch` / `paper-review` / `idea-generate` / `idea_generate`。

### 2b. WS 接入 openclaw_service（#13，核心改造）

- [ ] `requirements.txt` 加 `websockets`（`httpx` 保留给 `health()`）。
- [ ] 新增进程级 `OpenClawWsClient` 单例（懒连接 + 自动重连 + `runId→asyncio.Queue` 路由表 + 后台 reader 协程）：
  - 端点 `ws://<host>:18789/`（根路径；WS/HTTP/Control UI 共用 18789）。
  - 握手 `connect.challenge → connect(params.auth.token=GATEWAY_TOKEN, minProtocol/maxProtocol:4, client.id="gateway-client"/mode="backend", scopes=["operator.read","operator.write"]) → hello-ok`。
- [ ] `chat_stream()` 内部替换为 `chat.send`（保留对外 yield SSE 字符串的签名与格式，前端契约 text/done/error/raw 不变）：
  - params：`sessionKey`、`message`、`idempotencyKey`（必填）、`agentId`（缺省=main，**取代 HTTP 的 `model` 字段**）、`attachments:[{mimeType,fileName,content=pure_base64}]`（剥 data URL 前缀）。
  - 订阅 `event=="chat"` 帧按 `runId` 路由；`state: delta→text / final→done / error→error / aborted→done`；终态后再补 `done`。
- [ ] `chat()`（非流式）复用流式路径收集 `text` 拼接。
- [ ] **system_prompt 拼接进 message 前缀**（WS `chat.send` 无 instructions 对等字段）。
- [ ] **会话记忆复用 sessionKey**（历史由网关维护）；`routes/openclaw.py` 的 `chat_stream` 调用需补传 `session_key`（现未传）。
- [ ] `temperature`/`max_tokens` 不再由调用方传，改由网关 openclaw.json agent 配置托管（注释 + commit 说明此行为变化）。
- [ ] `health()` 保留 HTTP `GET /health`（多路复用端口上 HTTP 仍可用）。

### 2c. apply-config 去 Docker 化（#10）

- [ ] 只写 researcher `openclaw.json` 的 `models.providers` + `agents.defaults.model`（单 main；沿用现有 deepseek/anthropic/custom 推断）。
- [ ] 删：子 agent auth-profiles 循环、所有 `docker cp`、明文写 `.env` DEEPSEEK_API_KEY、冗长的 restart→sleep→cp→pkill 流程。
- [ ] 路径 env 可配：新增 `RESEARCHER_CONFIG_PATH`，默认 `./researcher/openclaw.json`（即 compose 挂载源）。
- [ ] 生效 = 后端 `docker compose restart openclaw-gateway`（compose 栈工作目录，非 `/root/...`）。重启后 init 不覆盖（sync 全关，R6 已证）。
  - ⚠ 需后端进程有 docker/compose 权限 + 正确 compose 工作目录（见「待确认」）。

## 阶段 3 — 后端：Wiki 页适配 researcher（#11）

- [ ] `_WIKI_ROOT` 改指向挂载源 `wiki/main`（env 可配，复用 researcher 根路径；容器内 `/home/node/.openclaw/wiki/main`）。
- [ ] `GET /openclaw/wiki` 改为**解析 `wiki/main/index.md` 的 `<!-- openclaw:wiki:index:start/end -->` 生成块**作为页面清单，**不再扫 `domains/<d>/papers/` 子树**；页面归五核心分类（concepts/entities/sources/syntheses/reports）。
- [ ] 跳过 `.openclaw-wiki/`（插件私有 state/cache/locks）、`_attachments/`、`_views/`。
- [ ] frontmatter 兼容双 schema（插件官方 `pageType/id/title/...` + researcher 论文页 `type/domain/paper.*/evidence_level`）。
- [ ] `PUT /openclaw/wiki/...` **只覆盖已存在页面**，不新建、不动 index 生成块。
- [ ] 容忍 0-pages 空骨架（index 块为 `- No concepts yet.` 等占位）。

## 阶段 4 — 前端（#3）

- [ ] 删 `public/js/pages/openclaw_autoresearch.js` / `openclaw_review.js` / `openclaw_idea.js` 及其在 `index.html` 的 `<script>` 引用（index.html:97-99）。
- [ ] 删 `public/js/pages/openclaw.js`（旧单页版，含 paper-review UI 与 `startOcReview`）。
- [ ] `openclaw_shared.js` 的 `OC_AGENTS` 收敛为只含 `main`；oc-main 继续用 `buildOcAgentPage("main")`。
- [ ] `core.js` P_FULL 删 `oc-autoresearch` / `oc-review` / `oc-idea` 导航项（core.js:26,28,29）；保留 `oc-main` / `wiki` / `ocstatus`。
- [ ] `ocstatus.js` 简化：配合 `/openclaw/status` 只报 gateway+main，去 subagent 监控维度。
- [ ] `profile.js` OpenClaw 配置区保留（填 gateway URL + token + LLM provider/key），去子 agent 相关配置项。
- [ ] `wiki.js` 按 #11 改为读 index 生成块；写回只覆盖已有页面。
- [ ] oc-main 对话传输层随 #13 改 WS；前端 EventSource 消费层不变（由后端 openclaw_service 屏蔽）。

## 阶段 5 — 配置 / 文档

- [ ] `config.py` 新增 `RESEARCHER_CONFIG_PATH`（默认 `./researcher`）；`OPENCLAW_GATEWAY_URL` 指向 `http://127.0.0.1:18789`（WS 用 `ws://`）；`OPENCLAW_GATEWAY_TOKEN` = compose 的 `GATEWAY_TOKEN`。
- [ ] `.env.example` 补 `RESEARCHER_CONFIG_PATH`、`OPENCLAW_*`。
- [ ] `requirements.txt` 加 `websockets`。
- [ ] README 更新部署/迁移说明（含「不接任何 channel」、clone researcher、compose 启动步骤）。
- [ ] `AGENTS.md` 架构段更新（单 main、deploy/ 栈、WS 接入）。

---

## 验证清单（go/no-go）

1. `docker compose -f deploy/docker-compose.yml up -d` 起容器，`curl http://127.0.0.1:18789/health` 通。
2. 后端起 `python main.py`，oc-main 页发一条消息，WS 流式回复正常（前端 text/done 渲染不变）。
3. 上传文件到 oc-main，落到 `./researcher/workspace/oc-uploads`。
4. Wiki 页打开（有内容时）按 index 生成块列出；编辑已有页面保存成功。
5. profile 改模型 → apply-config 写 `./researcher/openclaw.json` → 容器重启后新模型生效。
6. ocstatus 只显示 gateway + main。
7. 全仓 grep 无 `autoresearch` / `paper-review` / `idea-generate` 残留。
8. 无 feishu/discord 启动报错。

## 待起容器实测 / 未确认项

- WS path 根路径（R13 三来源互证高置信，仍建议 `websocat ws://127.0.0.1:18789/` 实测）。
- `connect` 的 `client.id`/`mode` 白名单（`gateway-client`/`backend` 是否被接受）。
- `GATEWAY_TOKEN` vs `OPENCLAW_GATEWAY_TOKEN` 在 acautomata fork init.sh 的优先级（R6 未直接验证）。
- `replace=true` 触发频率（决定 SSE 映射是否需复杂替换逻辑）；应用层保活要求；记忆语义是否符合前端预期。
- apply-config「后端自动重启容器」的 docker/compose 权限与工作目录。
- macOS 上 bind-mount 的 `state/openclaw.sqlite` 易损坏（已用匿名卷缓解；必要时删 sqlite 重启）。
- 迁移期：现有服务器 `/root/.openclaw` 数据是否需保留/迁移（未决）。

## 来源 ticket

#6 镜像挂载 · #7 wiki 读取 · #8 渠道插件 · #9 compose 原型 · #10 apply-config · #11 Wiki 适配 · #12 后端清理 · #3 前端删改 · #13 WS 接入

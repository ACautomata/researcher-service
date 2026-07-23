# R8 — researcher 渠道与插件裁剪（wayfinder ticket #8）

目标：本部署**不接任何消息 channel**（无 feishu/discord/任何 IM），只经本仓库前端 Web UI（FastAPI → OpenClaw 网关的 HTTP `/v1/responses` OpenResponses API）与 main agent 对话。调查删除全部 channels 后网关如何配置、哪些插件可裁。

最高信源：`/tmp/researcher-probe/openclaw.json`（researcher 仓当前配置）、`/tmp/researcher-probe/docker/docker-compose.bench.yml` 与 `.github/bench/env_setup.sh`（已禁用全部 channels、只留 LLM provider 的官方范本）、`README.md`、`CONTEXT.md`、`docs/adr/0001`。本仓库后端 `services/openclaw_service.py`。

---

## 1. 删除 `channels` 与 `bindings` 后网关能否启动，仅暴露 loopback UI + OpenResponses API？

**结论：能，且这是 OpenClaw 官方支持的最简部署形态（bench 范本即如此）。但有两个本部署特有的硬性前置。**

**依据：**
- bench 范本把所有 channel 禁用、只留 LLM provider：`env_setup.sh:253-270` 注释「Disable every channel account before the gateway starts … Bench only runs `openclaw agent`, never channels.」；`docker-compose.bench.yml:1-4` 注释「ALL channels, plugins disabled … Only the LLM provider is wired in.」
- **为什么必须禁用而非留空 enabled channel**:`env_setup.sh:247-251`——OpenClaw 的 doctor 会自动安装 feishu/discord 插件，一个 `enabled=true` 的 channel 会要求其 SecretRef(`FEISHU_APP_SECRET` 等），容器里没有就直接 `Gateway failed to start: required secrets are unavailable`。researcher 的 `openclaw.json:136-148` 里 `channels.feishu.enabled=true` 且引用 `${FEISHU_APP_ID}`/`${FEISHU_APP_SECRET}`——**本部署不删/不禁它就是启动失败**。
- **bindings 随 channels 一并删**:`openclaw.json:82-89` 的 `bindings` 只有一条 `{agentId: main, match: {channel: feishu}}`，是把 feishu 消息路由到 main 的绑定。channel 没了它即成孤儿，应一并删除（无 channel 时无任何作用）。

**关闭外联的 env(bench 实证）**——`docker-compose.bench.yml:40-42` 与 `env_setup.sh:576-578`:
```
DM_POLICY=disabled
GROUP_POLICY=disabled
ALLOW_FROM=""
```
这三个 env 是 init.sh 读取并写入 channel 策略的开关；配合 channels 删除后属于「双保险」，确保即便 doctor 重装 channel 插件也不会拨号外联。

**OpenResponses HTTP API 必须显式开启（本部署关键差异）:**
- bench 走的是 `openclaw agent --local` CLI（`docker-compose.bench.yml:26`),**不**经 HTTP，所以它不需要开 responses endpoint。
- 本部署 `services/openclaw_service.py:100,175` 走 `POST {base}/v1/responses`。OpenResponses `/v1/responses` **默认禁用**，必须配置：
  ```json
  "gateway": { "http": { "endpoints": { "responses": { "enabled": true } } } }
  ```
  （来源：https://docs.openclaw.ai/gateway/openresponses-http-api — "Disabled by default … enable with gateway.http.endpoints.responses.enabled"。)
  researcher 的 `openclaw.json:9-28` 的 `gateway` 块**没有** `http` 子块——若直接复用该 gateway 块，HTTP API 不响应。**精简配置必须补上这段。**
- 认证：`Authorization: Bearer <GATEWAY_TOKEN>`，`gateway.auth.mode="token"` + `gateway.auth.token`(`openclaw.json:24-27` 已配 `${GATEWAY_TOKEN}`)。`openclaw_service.py:23-28` 正是发 `Bearer {token}`。GATEWAY_TOKEN 启动时**必填**（即便本地），见 `docker-compose.bench.yml:52-55`。

**model 字段与 agent 选择**：官方文档确认为 `openclaw`（默认 agent）或 `openclaw/<agentId>`(**斜杠**)。`openclaw_service.py:88` `model = "openclaw" if agent_id=="main" else f"openclaw/{agent_id}"` **与官方格式一致，无需改**。

**`OPENCLAW_GATEWAY_BIND` 对本部署的决定性影响(loopback vs lan):**
- `openclaw.json:10` 与 bench 均为 `bind=loopback`。含义：网关只监听**容器内的 127.0.0.1**。
- 官方文档（https://docs.openclaw.ai/web/control-ui):loopback 只对「同一 network namespace 的 127.0.0.1/::1 对等连接」自动放行；LAN bind 才监听所有接口供外部连接。
- **对容器部署的关键推论**：若网关容器 `bind=loopback`，即便宿主 `docker -p 18789:18789` 映射，**宿主/另一容器的 HTTP 客户端也连不到**——Docker 的端口映射只转发到容器的外部接口，不到容器内 loopback（容器内 127.0.0.1 与宿主 network namespace 隔离）。README.md:99-107 也印证：loopback 下远程访问必须走 SSH 隧道 `ssh -N -L 18789:127.0.0.1:18789`。
- **本部署判定**：本仓库 FastAPI（宿主或另一容器）要经 HTTP 访问网关 18789 → **必须 `OPENCLAW_GATEWAY_BIND=lan`**（或让 FastAPI 与网关同容器/同 network namespace 才可保留 loopback)。bind 只接受字面量 `loopback/lan/tailnet/auto/custom`，不收裸 IP(`docker-compose.bench.yml:46-47`)。若选 lan，网关监听 0.0.0.0，此时**务必保留 token 认证 + 不要把 18789 映射到公网接口**(README.md:109 安全提示：Control UI 是 admin 面，`allowInsecureAuth=true` 仅本地便利）。
  - 折中：compose 端口映射用 `127.0.0.1:18789:18789`(`DOCKER_BIND=127.0.0.1`，见 `docker-compose.bench.yml:66`）把对外暴露面收敛到宿主 loopback，再由宿主反向代理/同机 FastAPI 访问。

---

## 2. 各 plugin 对本部署必需性

`openclaw.json:149-233` 现有 5 个 entries + 1 个 contextEngine slot。逐一判定：

| plugin | 判定 | 依据 |
|---|---|---|
| **minimax** | **必需** | 唯一模型 provider。`openclaw.json:48,267-294` 定义 `minimax/MiniMax-M3` 为 primary;`auth.profiles.minimax:cn`。除非换 provider，否则必留。 |
| **memory-wiki** | **必需** | 支撑保留的 Wiki 页（本仓 wiki 功能）。`env_setup.sh:313-315` 即便在「尽量裁」的 bench 里也**显式 `enabled=true`**（注释：research scenarios 需要它的 `wiki_apply`/`wiki_search`,ADR-0002)。本部署 Wiki 页同理必留。 |
| **lossless-claw**(contextEngine slot) | **可裁，换成 legacy** | `env_setup.sh:307-312`:`plugins.slots.contextEngine = "legacy"` 且 `lossless-claw.enabled=false`。bench 注释「bench image lacks lossless-claw but research scenarios require memory-wiki」。legacy 是内置 context engine，无需外部安装。本部署可照样换 legacy 并禁 lossless-claw（也可整段删掉 installs/slots 让默认 legacy 生效）。**注意** `openclaw.json:230-232` 当前 `slots.contextEngine="lossless-claw"`——若不装 lossless-claw 又不改 slot，会加载失败。 |
| **browser** | **可裁** | `openclaw.json:29-34` 顶层 `browser`(headless chromium)+ entry。它给 agent 提供 web fetch/search。本部署不依赖 agent 联网浏览（前端管线自己走 arXiv/Semantic Scholar，见 `services/external_service.py`)，且无 IM 场景需要网页快照。**可裁**；裁后 agent 失去 browser 工具但不影响 `/v1/responses` 对话。若想保留 agent 联网能力则保留——属可选项，非必需。 |
| **memory-core**(dreaming) | **可选/可裁** | `openclaw.json:166-172` 只开了 `dreaming.enabled=true`。bench 范本未启用它，且 `env_setup.sh` 未把它列入必需。dreaming 是离线记忆整理，对「前端 HTTP 对话 + Wiki 页」非必需。**可裁以收敛攻击面/资源**；保留亦无害。判定为可选，默认建议裁（与 bench「最小必需」原则一致）。 |

**contextEngine slot 结论**：非必需外部插件。`legacy` 是有效值（`env_setup.sh:308` 实证）。建议 `contextEngine: "legacy"` + 禁/删 lossless-claw。

---

## 3. `subagents`(delegationMode:suggest / allowAgents:[]）与 spawn self 在无 channel 下是否受影响？

**结论：不受影响。spawn 是 OpenClaw 的同 agent context 隔离机制，与消息 channel 完全解耦。**

**依据：**
- `openclaw.json:66-71` `agents.defaults.subagents`:`delegationMode:"suggest"`、`maxConcurrent:8`、`maxSpawnDepth:4`、`allowAgents:[]`。
- CONTEXT.md:17-18 ——「经 `sessions_spawn` 启动独立子 agent 会话。唯一合法用法是 **spawn self**:main 启动自己的 isolated 子 session，用于批量/并行/context 隔离」。ADR-0001:27-31 同样确认 spawn self 只用同 agent context 隔离，不依赖任何 channel。
- CONTEXT.md:14 与 ADR-0001:33-35 —— judge agent 已退役，`agents.list` 只剩 main（`openclaw.json:73-80` 印证只有 main),cross-agent `allowAgents` 清空（`[]`)。这套是纯 agent 内部编排，由 `/v1/responses` 触发 main 后在网关内部发生，**不经过任何 IM channel**。
- `tools.subagents.tools.alsoAllow: ["sessions_send"]`(`openclaw.json:122-126`）是会话内工具授权，亦与 channel 无关。
- **保留建议**:`subagents` 块原样保留（`delegationMode:suggest` 只是「建议委派」，不强制；`allowAgents:[]` 禁 cross-agent，二者在无 channel 下语义不变）。bench 的 `env_setup.sh:296-304` 也未动 subagents，只调了 sandbox/exec/fs。

---

## 4. benchmark-only 内容是否应随 volume 挂载进容器？

**结论：不应挂载，可裁剪/忽略。它们是 CI benchmark harness，对运行时无任何影响。**

**依据：**
- `docker/docker-compose.bench.yml`、`docker/.env.bench.example`、`.github/bench/{env_setup.sh,run_clawprobench.sh,report_clawprobench.py,test_report_clawprobench.py}`、`.github/workflows/clawprobench.yml` —— 全部是 ClawProBench fork 的 CI 控制代码（README.md:156「活跃的 benchmark CI 使用 ClawProBench fork … 控制代码位于 `.github/bench/` 和 `.github/workflows/clawprobench.yml`」)。
- 挂载进容器的是 `${OPENCLAW_DATA_DIR}:/home/node/.openclaw`(`docker-compose.bench.yml:63-64`)，即**数据目录**(openclaw.json、workspace、wiki)，不是 benchmark 源码。`env_setup.sh:330-334` 的 `bench_tar_repo` 也只是 CI 临时打包 repo 进容器跑 bench，且**显式 `--exclude='.git' --exclude='.github'`**——`.github/bench`、workflows 本就不进容器。
- 对本部署：volume 只需挂 openclaw 数据目录（含精简后的 openclaw.json + `~/.openclaw/wiki/main` 的 memory-wiki vault)。`docker/`、`.github/bench/`、`.github/workflows/clawprobench.yml` **不挂载、可忽略**；裁剪它们对网关运行时零影响。

---

## 5. 最终结论：精简 `openclaw.json` 应保留/删除什么 + 必需 env 清单

**删除：**
- `channels`（整个块，`openclaw.json:136-148`)—— 不接 IM，且留着会因缺 FEISHU secret 启动失败。
- `bindings`（整个数组，`openclaw.json:82-89`)—— 唯一一条是 feishu 绑定，channel 删了即成孤儿。
- `plugins.entries.browser` + 顶层 `browser`(`29-34`)—— 可选裁（见 Q2，本部署不需要 agent 联网浏览）。
- `plugins.entries.memory-core`(`166-172`)—— 可选裁（dreaming 非必需）。
- `plugins.entries.lossless-claw` + `plugins.installs.lossless-claw`(`157-165, 216-228`)—— 换成 legacy 后裁掉。

**修改：**
- `plugins.slots.contextEngine`: `"lossless-claw"` → `"legacy"`(`230-232`)。
- `gateway` 块**新增** `http.endpoints.responses.enabled: true`（否则 `/v1/responses` 不响应，本部署无法对话）。
- `gateway.bind`: `loopback` → **`lan`**(FastAPI 在宿主/另一容器经 HTTP 访问时必需；若 FastAPI 与网关同 network namespace 可保留 loopback)。
- `agents.defaults.model.primary` 等：如换模型/provider 才动，否则保留 minimax。

**保留不动：**
- `gateway.auth`(token 模式，`${GATEWAY_TOKEN}`)、`gateway.port:18789`、`gateway.controlUi`(Web/Control UI 保留）、`gateway.mode:local`。
- `plugins.entries.minimax`、`plugins.entries.memory-wiki`(enabled:true)。
- `agents.defaults.subagents`（原样）、`agents.list`（只 main)、`models.providers.minimax`、`auth.profiles.minimax:cn`。
- `memory`(qmd)、`tools`、`session` 等与 channel 无关的块。

**必需 env 清单（compose `environment:`):**
```
# 网关绑定与端口（本部署需 lan；同 network namespace 才用 loopback）
OPENCLAW_GATEWAY_BIND=lan            # 或 loopback（见 Q1 判定）
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_MODE=local
OPENCLAW_GATEWAY_ALLOW_INSECURE_AUTH=true   # 仅本地便利，勿暴露公网
GATEWAY_TOKEN=<强随机 token>          # 启动必填；FastAPI 端 Bearer 用同一值

# 彻底关闭外联（双保险，配合 channels 删除）
DM_POLICY=disabled
GROUP_POLICY=disabled
ALLOW_FROM=""

# 模型 provider（本部署保留 minimax）
LLM_API_KEY=<minimax key>            # openclaw.json models.providers.minimax 的 SecretRef 读取
LLM_BASE_URL=https://api.minimaxi.com/anthropic   # 可选，默认值

# 关闭 init.sh 的 config/model 同步（防止它改写精简后的 openclaw.json / 写明文凭据）
SYNC_OPENCLAW_CONFIG=false
SYNC_EXTENSIONS_ON_START=false
SYNC_EXTENSIONS_MODE=none
SYNC_MODEL_CONFIG=false

# 插件加载（memory-wiki 需要；bench 默认 false,ClawProBench 显式开 true 以加载 wiki_apply/search）
OPENCLAW_PLUGINS_ENABLED=true

# 数据/工作区
OPENCLAW_WORKSPACE_ROOT=/home/node/.openclaw
```
（来源：`docker-compose.bench.yml:28-62`、`env_setup.sh:556-595`；`OPENCLAW_PLUGINS_ENABLED=true` 依据 `docker-compose.bench.yml:56-62` 注释「memory-wiki plugin (wiki_apply/wiki_search) loads」。)

**端口映射建议**:compose 用 `127.0.0.1:18789:18789`(`DOCKER_BIND=127.0.0.1`）收敛暴露面到宿主 loopback，宿主 FastAPI 经 `http://127.0.0.1:18789` 访问；跨容器则放同一 docker network 用服务名访问。

---

## 对精简 openclaw.json 与 compose env 的直接影响

1. **openclaw.json 必改 4 处**，否则启动失败或 API 不应答：删 `channels`+`bindings`;`gateway.http.endpoints.responses.enabled=true`;`contextEngine`→`legacy`（并裁 lossless-claw);`bind`→`lan`（跨进程访问时）。
2. **plugins 收敛到 3 个必需**:minimax(provider)、memory-wiki(Wiki 页）、其余（browser/memory-core/lossless-claw）可裁；lossless-claw 裁后 slot 必须改 legacy。
3. **compose env 必带 4 组**:`GATEWAY_TOKEN`（启动+认证）、`DM_POLICY/GROUP_POLICY/ALLOW_FROM`（关外联）、`OPENCLAW_PLUGINS_ENABLED=true`(memory-wiki)、`SYNC_*=false`（防 init.sh 改写精简配置）。
4. **bind 决策是唯一与「前端在宿主/另一容器」强相关的开关**：跨 network namespace 必须 `lan`，否则宿主/邻容器连不到 18789;`loopback` 仅当 FastAPI 与网关同 network namespace。
5. **subagents/spawn self 无需动**：纯 agent 内编排，与 channel 解耦，原样保留。
6. **benchmark-only 目录不挂载**:`docker/`、`.github/bench/`、`.github/workflows/clawprobench.yml` 是 CI harness，运行时零影响，volume 只挂 openclaw 数据目录。

# R28 — OpenClaw `models.providers` 自定义接口增删改查（对应 issue #28）

---
> **实测回填（#36, 2026-07-23, openclaw 2026.7.1）**：✅ **热加载无需重启已证实**——改 `models.providers` 即见 `config change detected` → `config hot reload applied`；SecretRef env 缺失时 reload 失败但 `runtime remained on last-known-good`（不崩），env 补齐后自动恢复。apiKey 经 env SecretRef 不落明文已证实。**compose restart 冗余可去**。


> 目标：研究 `openclaw.json` 的 `models.providers` 如何支持对**自定义 openai-compatible 与 anthropic 接口**的增删改查（CRUD），为后端把 `/openclaw/apply-config`（当前只支持覆盖写单 provider，见 `routes/openclaw.py:231-298`）扩展为真正的多 provider CRUD 提供依据。
>
> 信源：本仓库实测在用的 `deploy/openclaw.json`（生产形态，最高置信）+ `research-agent-main/openclaw.json`（researcher 原始配置）+ 官方文档 `docs.openclaw.ai` 的 `/concepts/model-providers`、`/providers/openai`、`/providers/anthropic`、`/gateway/local-model-services`、`/gateway/secrets`、`/gateway/configuration-reference`、`/gateway/configuration`、`/cli/models`、`/reference/secretref-credential-surface`。
>
> 注：文档各页对 `api` 取值与 model 字段名的转写互有出入；凡冲突处以**本仓库实测运行的 `deploy/openclaw.json` 字段形态为准**，文档口径作旁证并标注。

---

## 结论速览（一句话）

自定义 openai-compatible 与 anthropic 接口都以 `models.providers` 下的 **map 条目**声明（key = provider id），靠 `api` 字段区分协议（openai 系 `openai-completions`，anthropic 系 `anthropic-messages`），`apiKey` 用 SecretRef `{source,provider,id}` 经 env 注入**不落地明文**；OpenClaw **watch 配置文件热加载 `models`/`agents` 字段、无需重启**（本仓库现行 `docker compose restart` 是过度手段）；**没有原生「注册/测试自定义 provider」的 API/CLI**——只能改 `openclaw.json`，唯一相关的 CLI 是 `openclaw models set/scan` 与只读探活 `openclaw models status --probe`。

---

## 1. Provider 条目完整 schema

`models.providers` 是 **map（object），key 为 provider id**（如 `"minimax"`、`"vllm"`、`"my-proxy"`），value 为 provider 配置对象。官方 `/gateway/configuration-reference` 明确："`models.providers`: custom provider map keyed by provider id"。

> ⚠ `/providers/anthropic` 页的 WebFetch 摘要曾把它转写成 array 形态（`"providers": [ {id: ...} ]`），与本仓库 `deploy/openclaw.json` 实测的 map 形态及其余全部文档页（`/providers/openai`、`/gateway/local-model-services`、`/concepts/model-providers`）冲突——**以 map 为准**。

### 1.1 Provider 级字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `baseUrl` | string | 是 | 接口根地址。openai 系**须含 `/v1` 路径**（如 `http://127.0.0.1:8000/v1`）；anthropic 系指向 Messages API 根（如 `https://api.minimaxi.com/anthropic`）。 |
| `apiKey` | string \| SecretRef | 通常 | 明文 string（不推荐）、SecretRef 对象、或 `"${ENV_VAR}"` 占位。详见 §2。 |
| `api` | string(enum) | 自定义时必填 | 协议适配器，见 §1.3。openai 系 `openai-completions`，anthropic 系 `anthropic-messages`。 |
| `authHeader` | boolean | 否 | `true` → 以 `Authorization: Bearer <key>` 头发送凭证（本仓库 minimax 用 `true`）。Azure 变体用 `false` 走 `api-key` 头。 |
| `models` | array | 是 | 该 provider 暴露的模型定义数组，见 §1.2。 |
| `timeoutSeconds` | number | 否 | 请求超时（文档示例常见 300）。 |
| `localService` | object | 否 | 本地服务的按需进程托管（`command`/`healthUrl`/`readyTimeoutMs`/`idleStopMs`），仅自托管场景用。 |

### 1.2 `models[]` 单模型条目字段（以本仓库实测形态为准）

`deploy/openclaw.json:234-251` 与 `research-agent-main/openclaw.json:295-313` 一致使用下列字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 模型 id（拼全模型引用为 `<providerKey>/<id>`，如 `minimax/MiniMax-M3`）。 |
| `name` | string | 展示名。 |
| `reasoning` | boolean | 是否 reasoning/thinking 模型。 |
| `input` | array<enum> | 输入模态，取值 `text`/`image`/`audio`/`video`/`pdf`（`/gateway/config-agents` 列举）。 |
| `cost` | object | `{input, output, cacheRead, cacheWrite}` 四个数值（每百万 token 单价），供本地成本估算（`/gateway/configuration-reference` 确认 `models.providers.*.models[].cost` 生效）。 |
| `contextWindow` | number | 上下文窗口 token 数。 |
| `maxTokens` | number | 单次最大输出 token 数。 |

> ⚠ `/providers/anthropic` 页摘要曾出现 `supportsReasoning`/`supportsVision`/`inputCostPer1k`/`outputCostPer1k`/`contextTokens` 等替代字段名——与本仓库实测（`reasoning`/`input`/`cost.input`）冲突，且其余文档页未出现这些名。**以实测字段为准**。精确权威 schema 可运行时用 `openclaw config schema` CLI 或 gateway 工具 `config.schema.lookup` action 按路径拉取（见 §4）。

### 1.3 `api` 字段取值（协议适配器）

各文档页口径汇总（`openai-completions` 与 `anthropic-messages` 在两个体系下都被反复确认；其余为 openai 系的更细分取值）：

| `api` 值 | 适用 | 信源 |
|---|---|---|
| `anthropic-messages` | **anthropic 系** Messages API（含第三方 Anthropic 兼容端点，如 minimax `/anthropic`） | 本仓库实测 + `/providers/anthropic` + `/concepts/model-providers` |
| `openai-completions` | **openai 系** chat-completions 兼容端点（自托管 vLLM/Ollama/LM Studio/LiteLLM、DeepSeek、Zhipu、各类 proxy） | `/providers/openai` + `/gateway/local-model-services` + `/concepts/model-providers` |
| `openai-responses` | OpenAI 原生 Responses API | `/providers/openai`、`/gateway/config-agents` |
| `openai-chatgpt-responses` | ChatGPT/Codex 订阅端点 | `/providers/openai` |
| `openai` / `openai-chat` / `openai-completions` / `openrouter` | openai 系其他别名/适配 | 仅 `/gateway/config-agents` 一页列举，未在他处复现，**低置信** |

> 对 issue #28 的落地建议：CRUD 表单只需暴露两个稳定取值——openai 兼容用 `openai-completions`、anthropic 兼容用 `anthropic-messages`。本仓库 `_infer_provider()`（`routes/openclaw.py:177-207`）当前对所有接口（deepseek/anthropic/custom）一律写 `anthropic-messages`，**对真正的 openai-compatible 接口是错的**，应改为按接口类型分别写 `openai-completions` / `anthropic-messages`。

---

## 2. 凭证（apiKey）经 SecretRef / env 注入、不落地明文

### 2.1 SecretRef 对象形态

`apiKey` 的推荐形态是 SecretRef（`/gateway/secrets` 权威确认）：

```json
"apiKey": { "source": "env", "provider": "default", "id": "LLM_API_KEY" }
```

| 子字段 | 取值 | 含义 |
|---|---|---|
| `source` | `"env"` \| `"file"` \| `"exec"` | 从哪类来源取凭证。env = 进程环境变量。 |
| `provider` | `secrets.providers` 下的 key | 引用哪个 secret provider 条目。**不是** LLM provider id。本仓库 `deploy/openclaw.json:36-38` 配了 `secrets.providers.default = {source:"env"}`，故此处填 `"default"`。 |
| `id` | env 变量名 | `source:"env"` 时即环境变量名；校验要求 `^[A-Z][A-Z0-9_]{0,127}$`。 |

配套 `secrets` 块（本仓库已有，`deploy/openclaw.json:35-44`）：

```json
"secrets": {
  "providers": { "default": { "source": "env" } },
  "defaults":  { "env": "default" }
}
```

`apiKey` 也接受简写：明文字符串、`"${ENV_VAR}"` / `"$ENV_VAR"` 占位（SecretInput 字段上合法）。**CRUD 一律用 SecretRef，禁用明文。**

### 2.2 「不落地明文」的机制（官方确认）

`/reference/secretref-credential-surface` 原文：

> "For SecretRef-managed model providers, generated `agents/*/agent/models.json` entries persist non-secret markers (not resolved secret values) for `apiKey`/header surfaces. Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values."

即：SecretRef 管理的 provider，其运行时生成的 `agents/<agentId>/agent/models.json` 只存 **marker（来源标记，如 `{source,provider,id}` 本身），不存解析后的明文**。明文 key 只存在于容器进程环境变量里，运行时解析，绝不写盘。

**本仓库的对应实现**：`docker-compose.yml:35` 把 `LLM_API_KEY` 作为 env 注入容器；`deploy/openclaw.json:229-233` 用 SecretRef 引用它；`deploy/README.md:47` 明确「`LLM_API_KEY` 经 env 注入、SecretRef 运行时读，勿写盘」。新增 provider 时应遵循同一模式：**每个 provider 用独立 env 变量名（如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`），compose `environment:` 注入，`openclaw.json` 只写 SecretRef。**

### 2.3 `models.providers` 与 `agents/<agentId>/agent/models.json` 的 merge 关系

`/concepts/models` + `/concepts/model-providers`：自定义 provider 配置会 merge 进 agent 目录下的 `models.json`，merge 优先级：

- `models.json` 里**非空 `baseUrl` 优先**（已存在的覆盖 config）。
- `models.json` 里非空 `apiKey` 仅当该 provider **非 SecretRef 管理**时优先。
- SecretRef 管理的 `apiKey` 从 source marker 刷新，不持久化明文。
- `models.json` 里空/缺的 `apiKey`/`baseUrl` 回退到 config 的 `models.providers`。

> 对 CRUD 的含义：直接改 `openclaw.json` 的 `models.providers` 即可；但若 agent `models.json` 已固化了同 id provider 的非 SecretRef `baseUrl`/`apiKey`，会以 `models.json` 为准而覆盖 config——**排障时注意检查 `~/.openclaw/agents/main/agent/models.json` 是否有残留**（`research-agent-main/CLAUDE.md` 也提到该文件存在）。

---

## 3. 改 `models.providers` 后如何生效

### 3.1 官方结论：热加载，无需重启

`/gateway/configuration` 明确：

> "The Gateway watches `~/.openclaw/openclaw.json` and applies changes automatically - no manual restart needed for most settings."
> "Most fields hot-apply without downtime."

其「hot-applies vs restart」表中，**`agent` / `agents` / `models` / `routing` 字段标注为「No」（不需重启）**。

**结论：改 `models.providers` 或 `agents.defaults.model` 属热加载范畴，网关 watch 配置文件自动生效，不需要重启容器。**

### 3.2 本仓库现行做法（过度手段，可在 #28 收敛）

当前 `/openclaw/apply-config`（`routes/openclaw.py:210-228, 285-286`）的「生效动作」是 `docker compose restart openclaw-gateway`，并带注释「失败不阻断——配置已写盘，下次重启容器同样生效」。这与官方热加载机制**冗余**：

- 因为 compose 是 bind-mount `deploy/openclaw.json` → 容器内 `/home/node/.openclaw/openclaw.json`（`docker-compose.yml:60`），宿主改文件即容器内文件变，网关 watch 到即热加载。
- 故 **#28 实现 CRUD 时，写完 `openclaw.json` 后理论上无需 restart**；保留 restart 仅作兜底/防御（如 watch 失效、或配合 4 个 sync flag 全关的环境）。需注意 `SYNC_OPENCLAW_CONFIG=false` 等已确保 init.sh 不会覆写挂载配置（`docker-compose.yml:30-33`、`r6`），热加载路径不被干扰。
- ⚠ 热加载是文档结论，**未在本部署实测**（见 §5 需实测项）。在确认前，保留 restart 兜底是稳妥的。

### 3.3 与多容器编排的关联

本部署是**单容器**（`openclaw-gateway` 单服务），不涉及多容器编排。`models.providers` 只被这一个网关进程读取；改配置只影响该进程的热加载/重启，无跨容器协调问题。（若未来引入多网关副本共享同一 `openclaw.json` 卷，则每个副本各自 watch 热加载，仍无需编排级联动。）

---

## 4. OpenClaw 是否有原生「新增/测试自定义接口」API / CLI

**结论：没有「注册/新增自定义 provider」的专用 API 或 CLI——只能改 `openclaw.json`。测试仅有只读探活，无写入式「测试并保存」。**

依据（`/cli/models` 全部子命令 + `/concepts/models`）：

| 能力 | 命令 | 能否新增/测试自定义 provider |
|---|---|---|
| 设默认模型 | `openclaw models set <provider/model>` | 只写 `agents.defaults.model.primary`，**不创建 provider**（provider 须先存在于 config）。 |
| 扫描目录 | `openclaw models scan` | 只扫 **OpenRouter 公开 `:free` 目录**，探测 tool/image 支持；**不扫任意自定义端点**。 |
| 别名/回退 | `models aliases add/remove`、`models fallbacks add/remove/clear` | 只管理 `agents.defaults.models` / `model.fallbacks` 映射，不动 provider 定义。 |
| 状态/探活 | `openclaw models status [--probe] [--probe-provider] [--probe-timeout]` | **只读**连通性/认证探活（`--check`、`--probe*`），最接近「测试」，但**不写配置**。 |
| 认证 | `models auth login/paste-api-key/setup-token ...` | 交互式把凭证写入 OpenClaw 认证 profile（**不写 `models.providers`**，且多为交互式，不适合后端自动化）。 |
| 精确 schema | `openclaw config schema`；gateway 工具 `config.schema.lookup` | 拉取 live JSON Schema（合并 plugin/channel 元数据），供编辑前校验——**对 CRUD 前端做字段校验有用**。 |

> 对 #28 的直接含义：后端实现 CRUD **绕不开读写 `openclaw.json`**（本仓库 `RESEARCHER_CONFIG_PATH`）。「测试接口连通性」可有两条路：(a) 后端自己对目标 `baseUrl` 发一个最小 openai/anthropic 请求做探活（不依赖 OpenClaw）；(b) 改完 config 后调用网关的 `models status --probe`（CLI）或等价 gateway 工具——但 CLI 需 exec 进容器，路径较重。推荐 (a)，把 OpenClaw 当纯消费者。

---

## 5. 完整 provider 配置样例（JSON）

### 5.1 anthropic 系（Anthropic Messages API 兼容）

以本仓库实测的 minimax 为蓝本（`deploy/openclaw.json:227-255`），泛化为自定义 anthropic 接口：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "my-anthropic": {
        "baseUrl": "https://api.minimaxi.com/anthropic",
        "apiKey": { "source": "env", "provider": "default", "id": "LLM_API_KEY" },
        "api": "anthropic-messages",
        "authHeader": true,
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax M3",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.06, "cacheWrite": 0.375 },
            "contextWindow": 1048576,
            "maxTokens": 524288
          }
        ]
      }
    }
  }
}
```

配套：`agents.defaults.model.primary = "my-anthropic/MiniMax-M3"`；compose `environment:` 注入 `LLM_API_KEY`。

### 5.2 openai 系（openai-compatible chat completions）

以官方 `/providers/openai` + `/gateway/local-model-services` 样例为本（自托管 vLLM / proxy / DeepSeek / Zhipu 通用）：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "my-openai": {
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": { "source": "env", "provider": "default", "id": "ZHIPU_API_KEY" },
        "api": "openai-completions",
        "authHeader": true,
        "models": [
          {
            "id": "glm-4-plus",
            "name": "GLM-4 Plus",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0 },
            "contextWindow": 131072,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

要点：openai 系 `baseUrl` **须含 `/v1`（或对应 API 版本路径，如此处 `/v4`）**；`api` 用 `openai-completions`；本地无鉴权服务可把 `apiKey` 设为占位串（如 `"local-model"`）并省略 `authHeader`。

> 自托管本地服务还可加 provider 级 `localService`（`command`/`healthUrl`/`readyTimeoutMs`/`idleStopMs`）做按需进程托管，本部署（远端第三方接口）用不到。

### 5.3 切换默认模型（agents.defaults）

CRUD 新增/切换 provider 后须同步（本仓库 `routes/openclaw.py:277-281` 已这么做）：

```json
"agents": {
  "defaults": {
    "model":   { "primary": "my-openai/glm-4-plus", "fallbacks": ["my-anthropic/MiniMax-M3"] },
    "models":  { "my-openai/glm-4-plus": { "alias": "GLM-4 Plus" } }
  }
}
```

---

## 6. 对 issue #28 的落地建议（CRUD 映射）

| CRUD 操作 | 对 `openclaw.json` 的动作 | 生效 |
|---|---|---|
| **新增** provider | 在 `models.providers` map 加 key，按 §1.3 选 `api`；`apiKey` 写 SecretRef（新 env 变量名）；compose 注入该 env；可选追加 `agents.defaults.model.fallbacks`。 | 热加载（保留 restart 兜底） |
| **读取** | 读 `models.providers`（本仓库 `/openclaw/status` `routes/openclaw.py:362-370` 已读首个 provider，可扩展为列全部）。 | — |
| **修改** | 改对应 key 的 `baseUrl`/`api`/model 字段；改 key 本身即「改默认模型」→ 同步 `agents.defaults.model.primary`。 | 热加载 |
| **删除** | 移除 map key；**同时清理引用它的 `agents.defaults.model.primary/fallbacks` 与 `agents.defaults.models` 别名**，否则残留悬空引用。 | 热加载 |

关键修正点：
1. **`_infer_provider()` 的 `api_protocol` 写死 `anthropic-messages` 是 bug**（`routes/openclaw.py:186/195/204`）：对 openai-compatible 接口必须写 `openai-completions`。CRUD 表单应让用户选「接口类型 = anthropic / openai」，后端据此选 `api`。
2. **凭证不落盘**：每个 provider 用独立 env 变量名，config 只写 SecretRef；compose `environment:` 加对应注入行。
3. **改后无需 restart**（官方热加载）；现行 `docker compose restart` 可保留为兜底但非必需。

---

## 7. 需实测项（文档→本部署的差距）

1. **热加载是否真生效**：改 `deploy/openclaw.json` 的 `models.providers`（如加一个 dummy provider 或改 `contextWindow`），**不 restart**，观察网关是否自动采用（发一条 chat 看是否走新配置 / `models status` 输出）。本部署 sync flag 全关 + bind-mount，理论上成立，但 `r13`/`r6` 均未直接验证 watch 热加载。
2. **openai-compatible 端到端**：当前部署只跑过 anthropic 系 minimax。需接一个真实 openai-compatible 端点（如 Zhipu GLM `https://open.bigmodel.cn/api/paas/v4`，`api: openai-completions`）实测 chat 是否通——验证 `openai-completions` 适配器在 `acautomata/openclaw-docker-cn-im` 镜像里可用。
3. **`agents/main/agent/models.json` merge 残留**：首次经 UI 改 provider 后，检查容器内 `~/.openclaw/agents/main/agent/models.json` 是否被写入非 SecretRef 的 `baseUrl`/`apiKey` 而后续覆盖 config（§2.3）。若有残留，CRUD 改 config 可能不生效，需清理该文件或确保 SecretRef 管理。
4. **`openclaw config schema` / `config.schema.lookup`**：实测能否在容器内跑通，用于给 CRUD 前端拉精确字段 schema 做校验（替代本文件 §1 的人工 schema）。
5. **删 provider 后悬空引用**：删除当前 primary provider 不清理 `agents.defaults.model` 时网关行为（报错 or 回退），验证 §6「删除须级联清理」的必要性。

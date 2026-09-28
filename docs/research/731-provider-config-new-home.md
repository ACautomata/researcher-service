# 调研结论:model provider 配置新家(热生效 + 白名单 + 配额)

**票**:#731(wayfinder:research)· 父 #734 · 服务 #728(容器规格)/ #733(汇编)
**根决策约束**(#722 已钉,不重开):LLM 调用移控制面侧;provider 配置 DB 热生效 + 端点白名单(防 injection 外送 key)+ 并发配额。

---

## TL;DR(三条硬结论)

1. **现有 models 域 CRUD 能力面被 LangChain JS 双 provider 完全覆盖,不需要再依赖 OpenClaw 的 models.providers 形状**。`initChatModel(model, { modelProvider, apiKey, baseUrl })`(@langchain/langchain `universal.ts` 的 `MODEL_PROVIDER_CONFIG` 实测)覆盖 openai / anthropic 等 19 个 provider;现有 `API_CHOICES = ['openai-completions', 'anthropic-messages']` 恰好 1:1 映射到 `openai` / `anthropic`(OpenAI 兼容端点——vLLM、MiniMax、Together 等——统一走 `ChatOpenAI` + `baseUrl`)。`ConfigurableModel` 内建实例缓存与 per-invoke `configurable` 覆盖,模型实例构造与配置解析都无需自研;但 **API key / baseURL 的动态注入建议自建一层薄封装**(见 §3.3),以挂载白名单校验与版本化缓存失效。
2. **热生效不需要消息总线:配置版本号 + run 粒度快照**。runner 每个 agent run 启动时读一次全局 `config_version`(SQLite 本地读,微秒级),与内存快照版本不一致才重载。进行中的 run 保持旧配置(run 内换模型会破坏会话一致性),变更延迟 = 下一个 run,语义上这恰是期望行为。BullMQ limiter 不适合作为配置热传播通道,Redis pub/sub 在单进程模型下收益为负(复杂度 + 丢消息回退轮询)。
3. **白名单与配额都有现成落点,不引入新依赖**。端点白名单 = 面板级 `provider_endpoints` 表 + **双层校验**(CRUD 时 origin 精确匹配 + runner 实例构造/请求发出前复验,禁 redirect);并发配额 = `users.maxConcurrentRuns` 列 + runner 进程内信号量(BullMQ+Redis 是单进程模型,#734 Notes 已确认),BullMQ 原生 limiter 的 per-user 组限流是 **Pro 专属功能**(OSS 3.0 起移除 groupKey),不可用。

---

## 1. 现状盘点(仓库只读调研)

### 1.1 现有 provider CRUD 能力面(models 域,#336 落地)

| 能力 | 位置 | 说明 |
|---|---|---|
| REST CRUD | `server/src/models/routes.ts` | `GET/POST/PUT/DELETE /api/v1/containers/:name/models/providers[/:pid]`;归属前置(getInstanceForUser,20040 防探测);creating/removing 拒写(20043) |
| 事务语义 | `server/src/models/service.ts` | DB mutation + 读全量 providers + writer.rewrite 同事务;写盘失败 `ConfigWriteError` → DB 回滚(90003);catch reconcile 盘=DB 自愈;per-container 写锁防 stale-write |
| 写盘渲染 | `server/src/models/configWriter.ts` + `configBuilder.ts` | DB → `ProviderConfigBuilder.build()` 合并进模板 base → `FileArchive.writeConfig`(putArchive)写容器内 `~/.openclaw/openclaw.json`;**静态 config,写盘后须重启容器生效** |
| 枚举/校验 | `server/src/models/values.ts` | `API_CHOICES`(openai-completions / anthropic-messages);`PROVIDER_ID_REGEX`(DNS-label);`API_KEY_ENV_ID_REGEX`;`ALLOWED_API_KEY_ENV_IDS = {LLM_API_KEY}` |
| DB 行 | `server/prisma/schema.prisma` `ModelProvider` | `(containerId, providerId)` 唯一;`apiKeyEnvId`(SecretRef 引用,不落明文);`modelsJson`(模型条目数组文本) |

### 1.2 openclaw.json 模板中 provider 配置形状(`deploy/openclaw.json`)

```jsonc
"models": { "mode": "merge",
  "providers": { "minimax": {
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "apiKey": { "source": "env", "provider": "default", "id": "LLM_API_KEY" },  // SecretRef,不落明文
    "models": [ { "id": "MiniMax-M3", "name": "MiniMax M3", "reasoning": true,
      "input": ["text","image"], "cost": {...}, "contextWindow": 1048576, "maxTokens": 524288 } ],
    "api": "anthropic-messages", "authHeader": true } } },
"agents": { "defaults": {
  "model": { "primary": "minimax/MiniMax-M3", "fallbacks": ["minimax/MiniMax-M3"] },  // 按 CRUD 入参序重算
  "models": { "minimax/MiniMax-M3": { "alias": "MiniMax M3" } },                      // 别名表
  "modelPolicy": { "allow": ["minimax/MiniMax-M3"] } } }                              // 模型级白名单先例
```

### 1.3 根决策带来的结构性变化

LLM 调用移控制面 runner 后,**provider 配置的消费方从「容器内 OpenClaw 进程」变为「控制面 runner 进程」**:

- 写盘(putArchive)+ 重启容器生效的整条链路(configWriter / ProviderConfigBuilder / catch reconcile)退役;
- `ALLOWED_API_KEY_ENV_IDS` 的存在理由(「容器 env 在 docker run 固定,SecretRef 只能引用已注入 env」)消失——runner 直接持有凭证;
- 归属粒度可上移:provider 配置本来挂在容器(containerId)下,新架构下「用户」才是配置主体(容器退化为执行沙箱,一个用户多个容器共享同一 LLM 配置面)。

---

## 2. LangChain JS provider 抽象调研(2026-09,源码级)

### 2.1 provider 覆盖面

`MODEL_PROVIDER_CONFIG`(`langchain-ai/langchainjs` `libs/langchain/src/chat_models/universal.ts`)硬编码 19 个 provider:openai、anthropic、azure_openai、langsmith、cohere、google、google-vertexai、google-vertexai-web、google-genai、ollama、mistralai/mistral、groq、bedrock/aws、deepseek、xai、cerebras、fireworks、together、perplexity。未列出的 provider 可经 `openai` + `baseUrl` 兼容路径覆盖(vLLM / MiniMax / 任意 OpenAI 风格网关)。

**对齐结论**:面板初期只需放行 `openai` 与 `anthropic` 两个 provider 值,与现有 `API_CHOICES` 严格 1:1:

| 现有 wire 值 | LangChain `modelProvider` | 说明 |
|---|---|---|
| `openai-completions` | `openai` | `ChatOpenAI` 接受任意 OpenAI 兼容端点(baseUrl 覆盖) |
| `anthropic-messages` | `anthropic` | `ChatAnthropic` |

### 2.2 动态 apiKey / baseURL

```ts
const model = await initChatModel("MiniMax-M3", {
  modelProvider: "openai",        // 或 provider 前缀形式 "openai:MiniMax-M3"
  apiKey: "sk-...",               // 显式传,不依赖 OPENAI_API_KEY 环境变量
  baseUrl: "https://api.minimaxi.com/v1",   // OpenAI 兼容端点
  maxRetries: 2, timeout: 60_000,
});
```

未匹配 provider 时 `_initChatModelHelper` 抛 `Unsupported modelProvider`(错误面干净,可直接转 90002)。provider 包按需 dynamic import(`ERR_MODULE_NOT_FOUND` 有友好提示)——runner 打包时只需把 openai/anthropic 两个包声明为依赖。

### 2.3 运行时切换模型(model per request)

- `initChatModel` 返回 **`ConfigurableModel`**(惰性代理):每次 `invoke/stream` 时 `_getModelInstance(config)` 合并 `defaultConfig` + `config.configurable` 参数实例化,内部 `_modelInstanceCache` 按 cacheKey 缓存实例;`configurableFields` 默认 `["model", "modelProvider"]`(可设 `"any"` 放行 apiKey 等全部参数)。
- LangChain 1.x `createAgent` 官方动态选模型机制是 **middleware `wrapModelCall`**:按 request state 换 `model` 后继续 handler——per-user / per-run 模型选择有官方扩展点。
- **fallback 链**:LangChain 无 OpenClaw `fallbacks` 等价内建;Runnable 标准组合子 `.withFallbacks({ fallbacks: [...] })` 可对 chat model 直接使用,承担 primary/fallbacks 语义。

### 2.4 对「自建薄封装」的建议

`ConfigurableModel` 的 configurable 注入适合「少数固定模型 + 用户运行时选择」;面板场景是「配置可变(用户 CRUD)+ 白名单必须在实例构造与请求前强制」,建议 **runner 侧自建 `ProviderRegistry`**:

- 内部仍用 `initChatModel` 构造(省掉 19 家类的 dynamic import 管理),但缓存 key 自定义为 `(ownerId, providerId, configVersion)`;
- 实例构造前过白名单(§5);`configVersion` 变更 → 丢弃该用户缓存 → 下个 run 重建;
- 这样白名单校验点、审计点(TextTrace 挂钩)、失效时机全部收口在一处,不依赖 `ConfigurableModel` 的 key 语义(其 cacheKey 含 apiKey,凭证轮换时 key 漂移不可控)。

---

## 3. 表结构草案(字段对齐现有 CRUD wire 契约)

三表一列一计数器。命名 snake_case 落 `init.sql` 风格(与 `model_providers` 现表一致)。

### 3.1 `provider_endpoints` —— 端点白名单(admin 管理,面板级)

```sql
CREATE TABLE "provider_endpoints" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "scheme"     TEXT NOT NULL,              -- 'https'(生产仅 https;'http' 限 dev)
    "host"       TEXT NOT NULL,              -- 精确 host;通配仅 admin CLI/API 且记审计
    "port"       INTEGER,                    -- NULL = 默认端口
    "note"       TEXT NOT NULL DEFAULT '',
    "createdBy"  TEXT NOT NULL,              -- users.id
    "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("scheme", "host", "port")
);
```

- 匹配语义:**origin 精确匹配**(scheme + host + port),不做路径通配、不做子域通配(防 `attacker.example.com` 绕过 `example.com`)。
- seed:迁移脚本把现有 `deploy/openclaw.json` 的 `https://api.minimaxi.com`(端口 NULL)写入。

### 3.2 `model_providers` —— 改造现有表(归属上移)

```sql
CREATE TABLE "model_providers"(   -- 新形状;旧表迁移见 §6
    "id"            TEXT NOT NULL PRIMARY KEY,
    "ownerId"       TEXT NOT NULL,            -- containerId → ownerId(users.id,Cascade)
    "providerId"    TEXT NOT NULL,            -- 沿用 PROVIDER_ID_REGEX(DNS-label)
    "lcProvider"    TEXT NOT NULL,            -- 'openai' | 'anthropic'(LangChain provider;初期白名单二值)
    "baseUrl"       TEXT NOT NULL,            -- 完整 URL;origin 须命中 provider_endpoints
    "credentialEnvId" TEXT,                   -- 过渡期:引用 LLM_API_KEY(对齐现 apiKeyEnvId)
    "credentialCipher" TEXT,                  -- P1 扩展:per-user key,AES 密文(对齐 Container.token 先例,复用 CREDENTIAL_ENCRYPTION_KEYS)
    "authHeader"    BOOLEAN NOT NULL DEFAULT true,
    "modelsJson"    TEXT NOT NULL,            -- 模型条目数组(原样保留 id/name/reasoning/input/contextWindow/maxTokens)
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("ownerId", "providerId"),
    FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE
);
```

- `api`(旧 enum `openai-completions`/`anthropic-messages`)与 `lcProvider` 二选一保留即可;建议保留旧 enum 列名以复用 wire 契约,`lcProvider` 由映射函数派生(API_ENUM_TO_WIRE 机制倒置)。二值白名单即「provider 种类白名单」,与端点白名单正交(种类限定 LangChain 集成面,端点限定出口)。
- `modelsJson` 的 `cost` 字段对 LangChain 无用(LangChain 1.x 能力面走 model profile,`initChatModel` 支持显式 `profile` 覆盖)——保留为面板展示/成本核算输入,**记账真值建议改采 LLM 响应 `usage_metadata`**(runner callback 采数,TextTrace 已有挂点)。

### 3.3 `users` 加列 + 全局计数器

```sql
ALTER TABLE "users" ADD COLUMN "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2;  -- per-user 在飞 run 配额
CREATE TABLE "config_meta" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1),
    "version" INTEGER NOT NULL DEFAULT 1);   -- 单行计数器,provider/endpoint CRUD 同事务 +1
```

- 全局并发上限走 env(对齐 `LIFECYCLE_WORKER_CONCURRENCY` 先例,如 `RUNNER_MAX_CONCURRENT_RUNS`),不入库。
- 速控类字段(RPM/token 桶)首期不建表:见 §5.3 结论,需要时再加。

---

## 4. 热生效机制建议(runner 感知配置变更)

三个候选对比:

| 方案 | 延迟 | 复杂度 | 单进程模型适配 |
|---|---|---|---|
| 启动读取(DB → 内存,重启生效) | 冷生效 | 最低 | ✗ 不满足根决策 |
| **版本号 + run 粒度快照** | 下一个 run | 低 | ✓ **推荐** |
| Redis pub/sub 推送失效 | ~0 | 中(丢消息需回退轮询,重连语义) | ✗ 收益为负 |

**推荐机制(方案二)**:

1. runner 每个 agent run 启动第一步:`SELECT version FROM config_meta`(SQLite 同机,微秒级)。
2. 与内存快照 version 判等:相等 → 直接用缓存;不等 → 重载该 ownerId 的 providers + 全量 endpoints → 过白名单 → `ProviderRegistry` 重建该用户模型实例缓存 → 更新快照 version。
3. **进行中的 run 不感知变更**(run 粒度快照):run 内多轮 LLM 调用保持同一配置,杜绝会话中途换模型的一致性问题;这也天然规避了「读到写了一半的配置」——配置变更经 API 事务提交,读侧永远看到完整版本。
4. CRUD 侧:`ModelProviderService` 事务里删掉 writer.rewrite 段,改为同事务 `UPDATE config_meta SET version = version + 1`;catch reconcile / per-container 写锁 / putArchive 整段退役(事务大幅简化,DB 即盘)。

与根决策「DB 热生效」的对应:热生效延迟 = 下一 run(秒级),无重启、无容器操作,满足「替代写盘+重启」。

---

## 5. 白名单与配额机制建议

### 5.1 端点白名单:双层校验(防 prompt injection 外送 key)

**威胁模型**:LLM key 由 runner 发往 provider 端点;若用户可把 `baseUrl` 指向任意端点,key 即外送。agent 自身无法直接改 LLM 端点(端点由 runner 读取配置决定),攻击面是「诱导用户/管理员经 API 配置恶意端点」与「agent 输出注入影响 runner 对配置的读取/构造」。

**第一层:创建/更新时校验**(`ModelProviderService.create/update` 内,事务前):

1. zod 校验 URL 形态(新 schema 字段,`validation/schemas.ts`);
2. `new URL(baseUrl)` 取 origin → 与 `provider_endpoints` 精确匹配(scheme+host+port),未命中 → 90002(字段级 `base_url` 错误);
3. 解析 host 的 DNS → 拒绝解析到私网/环回/链路本地地址的条目(`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`::1` 等)——防借白名单条目名做内网探测的变体;白名单内网端点(vLLM 自建)走 admin 显式条目 + `allowPrivate` 标记位(首期可不实现,env 开关)。

**第二层:运行时校验**(`ProviderRegistry` 实例构造 + provider HTTP client 装配点):

1. 实例构造前复验 origin ∈ 白名单(配置可能被 admin 直接改库,绕过 API 层);
2. LangChain `ChatOpenAI`/`ChatAnthropic` 支持注入自定义 fetch/`configuration.baseURL`:包一层 fetch wrapper,**校验最终请求 URL origin + `redirect: 'manual'` 禁跟随重定向**(防白名单端点 302 跳恶意端点带 key);
3. 运行时未命中 → run 失败,错误进事件流(码段建议 4xxxx models 复用,新码 40042「端点不在白名单」,不泄露白名单内容)。

### 5.2 模型级白名单(承接 `modelPolicy.allow` 语义)

OpenClaw 模板有 `agents.defaults.modelPolicy.allow`(模型引用白名单)。新家下该语义被两件事覆盖:① 用户 `modelsJson` 里列出的模型即「该用户可用模型」(列表本身是用户自有的,无越权面);② agent 每轮选模型经 LangChain middleware `wrapModelCall`,选值域 = 配置快照内 `modelsJson` 的 id 集合,runner 侧拒绝集合外值即可(判定为编程错误而非白名单攻击,因为快照本身就是边界)。**无需单独的模型白名单表**。

### 5.3 并发/配额限流:进程内信号量,不用 BullMQ limiter

关键事实:**BullMQ 原生 limiter 的 per-user 组限流(groupKey)自 3.0 起是 Pro 专属功能**,OSS 只有 queue 级 `{max, duration}`(启动速率语义,非「在飞并发」语义);Bottleneck 等第三方库维护停滞。而 #734 Notes 确认「BullMQ+Redis 为单进程模型」——runner 同为单进程,进程内原语就是正确的分布式边界。

**推荐分层**:

| 层 | 机制 | 说明 |
|---|---|---|
| per-user 在飞 run 并发 | `users.maxConcurrentRuns` 列 + runner 进程内计数器(Map<ownerId, n> + 入队检查) | 超额 → 4xxxx 段新码(建议 40043「并发配额已满」),前端提示排队;run 结束 finally 释放 |
| 全局在飞 run 并发 | runner 进程内全局信号量(env `RUNNER_MAX_CONCURRENT_RUNS`) | runaway agent 最后防线之一(#728 的容器资源 limit 是另一道,互补) |
| LLM 请求速率/token 速率 | **首期不做**;LangChain callback 的 `usage_metadata` 全量落 TextTrace,后置按需加(Redis 原子令牌桶,Lua INCR + TTL,~20 行) | 速率限流的正确触发时机是「实测出现滥用/成本失控」,PoC 前建机制是投机设计 |

升级路径:runner 未来多副本时,把两个进程内计数器换成 Redis Lua 原子 INCR/DECR(接口不变,实现替换)——表结构与列设计不受影响。

---

## 6. 迁移映射表:openclaw.json provider 配置 → 新 DB 配置(逐字段)

| 来源(openclaw.json / 旧 `model_providers` 行) | 去向(新 DB) | 处理 |
|---|---|---|
| `models.providers.<pid>`(map key) | `model_providers.providerId` | 值原样迁移;DNS-label 校验规则沿用 `PROVIDER_ID_REGEX` |
| `providers.<pid>.baseUrl` | `model_providers.baseUrl` | 值原样迁移;origin 同事务写入 `provider_endpoints` seed |
| `providers.<pid>.apiKey {source:env, provider:default, id:LLM_API_KEY}` | `model_providers.credentialEnvId = 'LLM_API_KEY'` | SecretRef 机制随 OpenClaw 退役,退化为 env id 引用;P1 演进 per-user `credentialCipher`(AES,复用 `CREDENTIAL_ENCRYPTION_KEYS`,对齐 `Container.token` 先例) |
| `providers.<pid>.api`('anthropic-messages'/'openai-completions') | `model_providers.api`(enum 保留)→ `lcProvider` 派生('anthropic'/'openai') | 1:1 映射,见 §2.1 |
| `providers.<pid>.authHeader` | `model_providers.authHeader` | 语义保留:映射到 LangChain 侧凭证 header 策略(anthropic=x-api-key;openai=Authorization Bearer;自定义网关经 defaultHeaders) |
| `providers.<pid>.models[]`(`id/name/reasoning/input/cost/contextWindow/maxTokens`) | `model_providers.modelsJson` | 原样保留;`cost` 降级为展示/核算输入,运行时能力面由 LangChain model profile 承担 |
| `agents.defaults.model {primary, fallbacks}`(CRUD 入参序重算) | `modelsJson` 序 + runner 侧 `.withFallbacks({fallbacks})` | 不落盘;primary=首 provider 首模型,fallbacks=余序,由 runner 每次从快照派生 |
| `agents.defaults.models`(别名表) | 不迁移 | 由 `modelsJson` 的 `name` 派生,纯投影 |
| `agents.defaults.modelPolicy.allow` | 不迁移(语义被 §5.2 两机制覆盖) | 退役 |
| `deploy/openclaw.json` 模板 `minimax` 默认 provider(P0 兼容语义) | 迁移脚本 seed:每存量用户一行 `ModelProvider`(minimax + LLM_API_KEY)+ 白名单条目 `https://api.minimaxi.com` | 对齐现 ProviderConfigBuilder「空 providers → 模板默认」的行为,改为显式 seed |
| 旧表 `(containerId, providerId)` 唯一 | `(ownerId, providerId)` 唯一 | 迁移脚本按 owner 去重(同 owner 多容器重复 provider 行折叠为一条;冲突取 createdAt 最早行) |
| `server/src/models/configWriter.ts` / `configBuilder.ts` / catch reconcile / per-container 写锁 | 无去向 | 随 OpenClaw 退役;`ModelProviderService` 保留 CRUD + 事务骨架,rewrite 段换 version bump |

**迁移脚本形态**(对齐 `scripts/apply-schema.mjs` 不经 prisma CLI 的先例):`ALTER TABLE` 加列 + 新建 `provider_endpoints`/`config_meta` + 数据折叠 seed,幂等可重跑;退役窗口(#722「老容器冻结 + 30 天」)内旧 openclaw.json 写盘链路不删,与 #732 退役方案统一拆除。

---

## 7. 对下游票的输入摘要

**给 #728(容器规格)**:
- 容器不再需要 `openclaw.json`、`LLM_API_KEY` env 注入、18789 网关端口、设备配对——**镜像内容可再精简**;宿主端口池 19000–19999 的「容器网关」用途消失(呼应票面「端口池存废」问题,建议 #728 直接判废,工具通道走 docker exec / Archive API);
- 网络出口白名单(provider_endpoints)与容器出口策略是互补防线:provider 白名单管「LLM key 流向」,容器出口策略管「容器内 exec 的 SSRF 面」——#728 票面「网络出口策略」一节可直接引用 §5.1 的双层校验设计。

**给 #733(汇编)**:
- 「provider 配置域」章节骨架建议:① 存储设计(§3 三表一列一计数器)② CRUD API(现有 REST 面保留,仅内部事务简化)③ runner ProviderRegistry(§2.4)④ 热生效(§4)⑤ 白名单/配额(§5)⑥ 迁移(§6)。
- 模块边界变化:models 域删 configWriter/configBuilder 两文件,新增 `providerRegistry.ts`(runner 侧)+ `endpointAllowlist.ts`(校验纯逻辑,可纯单测);码段新增 40042(端点不在白名单)/ 40043(并发配额满),建议计入信封码段表。
- 待与 #723(LangGraph 运行时)交叉确认一件事:deepagentsjs 基座下 `wrapModelCall` middleware 与 per-run 配置快照的接法(PoC #724 一并验证)。

## 8. 开放问题(少量,不阻塞 #728/#733)

1. **per-user key(`credentialCipher`)优先级**:共享 `LLM_API_KEY` + 白名单已把外送面收窄到可信端点;per-user key 的增量收益是爆炸半径减半。建议 P0 平移共享 key,P1 评估 per-user(改动仅在 credential 解析函数,表已预留)。
2. **白名单通配符需求**(如 `*.minimaxi.com`):首期精确匹配;出现真实需求再加通配 + 更严格审计。
3. **token 速率配额阈值**:等 PoC(#724)出实测消耗数字后定,机制见 §5.3。


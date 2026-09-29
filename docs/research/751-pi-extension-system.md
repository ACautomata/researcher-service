# 751 Pi-agent 扩展系统完整能力面与本项目映射表

> Wayfinder 票 [#751](https://github.com/ACautomata/researcher-service/issues/751)，map [#750](https://github.com/ACautomata/researcher-service/issues/750)；根决策 [#749](https://github.com/ACautomata/researcher-service/issues/749)。
> 调研时间 2026-09-29。版本基线：`badlogic/pi-mono` @ `cb7969d`（2026-09-28），包 `@earendil-works/pi-coding-agent` **0.87.1**；pi.dev/docs/latest（extensions / packages / virtual-models / custom-provider / rpc-extension-ui / tui 各页）与仓库内 docs 逐点核对一致。接口事实以官方源码为准：`packages/coding-agent/src/core/extensions/types.ts`（类型全录，下称 types.ts）、`runner.ts`、`agent-session.ts`、`loader.ts`、`virtual-modules.ts`。
> 状态：research 定稿。本文是事实底座——根决策 #749 已钉结论（概念对齐、V1 三件套、providers 不开等）不重开，为「设计：插件系统契约规格」票补齐 Pi 侧证据，并为 V2 roadmap（事件钩子/动态激活/消息面）供依据。

## 0. 结论（TL;DR）

1. **Pi 扩展 = 进程内 TS 模块 + 单一 `ExtensionAPI`**。扩展导出 default factory `(pi: ExtensionAPI) => void | Promise<void>`，在 factory 里一次性完成全部注册（工具/命令/快捷键/CLI flag/渲染/provider/虚拟模型/事件订阅）。注册面 10 个方法、订阅面 40 个类型化事件、消息面 3 个方法、动态面 4 个工具控制方法（types.ts `ExtensionAPI`）。
2. **V1 三件套在 Pi 里有精确同构，且比预想多两样可白拿的声明面**：工具的 `promptSnippet` / `promptGuidelines`（声明式进系统 prompt）与命令的 `getArgumentCompletions`（参数补全）都是低成本的契约面，建议契约规格一并收录。
3. **`content` / `details` 双面契约是三件套的隐藏第四件**：工具结果 `content` 只给模型（文本/图片），`details` 只给渲染与状态重建（不进模型上下文）——这正是 #726 SSE 事件面 + #730 单管线渲染需要的接缝，应原样搬进插件工具契约。
4. **事件钩子是 V2 最大也最危险的面**：`tool_call` 可拦截可变换的语义（block/reason、args 原位改且不再校验、handler 失败 fail-safe 拦截）恰好是 #729 审批漏斗规则层想要的一切——V2 若把钩子做成漏斗之外的平行闸门会破坏「单漏斗」裁决，正确形态大概率是「钩子作为漏斗规则层的插件扩展点」。
5. **生命周期约束直接可借**：factory 禁长驻资源（进程/socket/watcher/timer）、`session_start` 起 / `session_shutdown` 幂等收、reload 后旧 context 全部失效（`assertActive` 抛错）——这套纪律映射到本项目 = 插件不得自持连接/定时器，一切资源归 runner 会话生命周期。
6. **命令双源在 Pi 有现成同构**：extension commands（代码 backing，`registerCommand`）与 prompt templates / skills（内容命令）同列一个 `/` 菜单——直接印证 #749「能力实现层与用户交互层双源并存」裁决，`/skill:name` 命名空间先例可借。

---

## 1. 加载形态与信任模型（概览）

- **形态**：扩展是 TS/JS 模块，经 **jiti** 免编译热载进 Pi 进程，与宿主**同 OS 权限**运行（`docs/extensions.md`、`docs/security.md`）。官方明示这不是安全边界：「Watching the transcript, using project trust, and reviewing changes do not create a security boundary」。
- **发现路径**（`loader.ts:777-820`，按序）：① 项目 `.pi/extensions/`（cwd）→ ② 全局 `~/.pi/agent/extensions/` → ③ 托管包目录 → ④ `--extension`/`-e` 显式路径。目录发现规则：单文件 `*.ts|*.js`，或子目录带 `index.ts|index.js`，或子目录 `package.json` 带 `pi.extensions` manifest。
- **可用导入白名单**（`virtual-modules.ts`）：扩展只能 import 宿主注入的虚拟模块——`typebox`、`@earendil-works/pi-ai`（compat 入口）、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`@earendil-works/pi-coding-agent`（含旧 `@mariozechner/*` 别名）。物理拷贝这些包会绕过模块映射造成重复类/注册表，Pi 会在 manifest 配置上告警。
- **project_trust 决策链**（`docs/security.md`）：CLI `--approve`/`--no-approve` 覆盖 → **扩展裁决**（project_trust 事件，第一个返回 yes/no 的 handler 拥有决定权；仅个人扩展与显式命令行扩展可参与——项目扩展此时尚未加载）→ `~/.pi/agent/trust.json` 按最近目录取已存决策 → 全局 `defaultProjectTrust` 设置（默认 `"ask"`）。protected 资源：`.pi/settings.json`、`.pi/extensions|skills|prompts|themes`、`.pi/SYSTEM.md|APPEND_SYSTEM.md`、项目 `.agents/skills`。context 文件（AGENTS.md/CLAUDE.md）**不受信任决策影响**照常加载。非交互模式（print/json/rpc）无法弹信任框，走 `--approve` 或设置默认值。
- **与本项目的根本差异**（#749 已钉，列作对照）：Pi 的信任在**运行时**（用户决定是否加载一段会进自己进程的代码）；本项目信任在**发布流程**（多租户控制面下插件代码 = 核心代码，编译期打包，无运行时第三方加载、无 self-extensible）。

---

## 2. 注册面细节

### 2.1 registerTool（types.ts `ToolDefinition`）

```ts
registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void
```

字段全录与能力边界：

| 字段 | 类型 | 语义 |
|---|---|---|
| `name` | string | LLM 工具调用名 |
| `label` | string | UI 人类可读标签 |
| `description` | string | 给 LLM 的描述 |
| `promptSnippet` | string? | 一行摘要，进默认系统 prompt 的 Available tools 段；**不提供则该自定义工具从该段省略** |
| `promptGuidelines` | string[]? | 工具激活时追加进默认系统 prompt 的 Guidelines 段的 bullet |
| `parameters` | TypeBox `TSchema` | 参数 schema（校验强制） |
| `constrainedSampling` | false \| Config? | provider 侧受限采样请求 |
| `renderShell` | "default" \| "self"? | 工具行渲染用标准外壳还是自绘边框 |
| `prepareArguments` | (args) => Static\<TParams\>? | schema 校验**前**的兼容 shim（清 raw args） |
| `executionMode` | "sequential" \| "parallel"? | 覆写默认并行度；共享可变内存态的工具用 sequential |
| `execute` | (toolCallId, params, signal, onUpdate, ctx) => Promise\<AgentToolResult\<TDetails\>\> | 执行体：`signal` 中止信号；`onUpdate` 上报部分结果（→ `tool_execution_update` 事件）；`ctx` 全量 ExtensionContext |
| `renderCall` / `renderResult` | (args/result, options, theme, ctx) => Component? | 工具调用/结果自定义渲染 |

**结果契约**（pi-agent-core `AgentToolResult<T>`，`packages/agent/src/types.ts:420`）：

```ts
{ content: (TextContent | ImageContent)[];   // 给模型看
  details: T;                                // 只给渲染/日志/状态重建，不进模型上下文
  usage?: Usage;                             // 嵌套模型调用的 usage 须并入，保证会话总量准确
  terminate?: boolean }                      // 跳过自动 follow-up 的提示；须整批工具结果全部同意才生效
```

语义约束（`docs/extensions.md` Tools 节）：

- `content` 是模型可见面，**大结果应截断并在 content 里指引模型去哪读全文**（`truncated-tool.ts` 示例）；`details` 是渲染与分支态重建的载体，`details: undefined` 合法。
- **throw = failed tool result**；返回对象不标记错误。
- 文件改动类工具应包 `withFileMutationQueue()` 完成读-改-写全程。
- `defineTool()` 辅助函数保参数类型推断（经数组/变量传递时不被扩宽为 unknown）。

### 2.2 registerCommand

```ts
registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (prefix) => AutocompleteItem[] | null | Promise<...>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void
```

- handler 拿到的是 **ExtensionCommandContext**（比事件 handler 的 ExtensionContext 多一批**仅限命令**的操作：`waitForIdle` / `newSession` / `fork` / `navigateTree` / `switchSession` / `reload` / `getSystemPromptOptions`——这些操作从生命周期 handler 里调用会死锁运行时，故类型上隔离）。
- 命令菜单三源同列（`docs/slash-commands.md`）：内置命令 + **extension commands（代码 backing）** + **prompt templates（内容命令，`/模板名`）+ skills（`/skill:name`）**。

### 2.3 registerShortcut / registerFlag

```ts
registerShortcut(shortcut: KeyId, { description?, handler(ctx: ExtensionContext) }): void   // TUI 键盘快捷键
registerFlag(name: string, { description?, type: "boolean"|"string", default? }): void      // CLI flag
getFlag(name): boolean | string | undefined   // 默认值注册期进 runtime state，CLI 值其后填充
```

纯终端/CLI 面，Web 面板无对应物（见映射表 #4）。

### 2.4 registerProvider / unregisterProvider（#749 已钉不开，录签名备查）

```ts
registerProvider(provider: Provider): void            // pi-ai 原生完整 Provider
registerProvider(name: string, config: ProviderConfig): void   // 遗留配置形态
```

- `ProviderConfig`：`baseUrl` / `apiKey`（`$ENV`、`${ENV}`、`!command` 插值）/ `api` / `streamSimple`（自实现流协议）/ `images` / `classifiers` / `headers` / `authHeader` / `models`（chat/image/classifier 三型）/ `refreshModels`（动态目录 + 持久化发布）/ `oauth`（login/refreshToken/getApiKey，凭证落 `~/.pi/agent/auth.json`）。
- **排队与生效时序**：初始加载期的调用进 pending 队列，runner bind 后一次应用；其后（命令/事件 handler 里）调用**立即生效**，无需 `/reload`。只给 `baseUrl`/`headers` 则保留内建模型；给 `models` 则整组替换。
- 自定义 `streamSimple` 有严格契约：须调 `options.onPayload/onResponse/onProviderStreamEvent` 三个钩子（它们正是扩展审查请求/响应的机制，省略则行为与内建 provider 不一致）、恰好一个终态 `done|error` 事件、取消转 aborted。

### 2.5 registerVirtualModel（#749 已钉不开，录语义备查）

- **选择面与分派面分离**：用户选的是虚拟 (model, thinkingLevel)，记入 `model_change` 条目；每个请求经 `route(request, ctx)` 路由到物理 (model, thinkingLevel)，记入 assistant message——重放/换物理模型恢复语义与手动切换一致。
- `request.reason` 四值：`user`（用户消息后的首个请求，含 steer/followUp）/ `continuation`（循环内其余请求）/ `retry`（自动重试，含 compaction 后）/ `direct`（循环外，如 compaction 摘要）。`previous`/`failed` 粘滞语义保 prompt cache 与 thinking 签名有效。
- `route` 可返回 `state`（JSON 可序列化，随会话分支存储、fork/tree 导航可见、survive compaction；`direct` 请求无状态）。不能路由到另一个虚拟模型；route 抛错 → 请求错误终态。

### 2.6 渲染注册（TUI 自定义渲染 = 三件套的渲染件）

| API | 渲染对象 | 是否进 LLM 上下文 |
|---|---|---|
| `ToolDefinition.renderCall` / `renderResult` | 工具调用行 / 工具结果（渲染输入 = `result.details` + `ToolRenderContext`：expanded/isPartial/state/toolCallId/args…） | details 不进 |
| `registerMessageRenderer(customType, renderer)` | CustomMessage（自定义消息，**进**上下文） | 进 |
| `registerEntryRenderer(customType, renderer)` | CustomEntry（自定义条目，仅会话记录展示） | 不进 |
| `registerMarkdownTransformer(transformer)` | user/assistant 消息 markdown 渲染前的文本变换（含 thinking 变体、流式/终态区分） | —（渲染层） |

另有一整层 `ctx.ui`（`ExtensionUIContext`）：阻塞对话框 `select/confirm/input/editor`（支持 `timeout` 自动消解 + AbortSignal）、`notify`、`setStatus`、`setWidget`（编辑器上/下方）、`setFooter/setHeader/setEditorComponent`（整块替换工厂）、`custom()`（自绘 overlay 组件拿键盘焦点）、主题读写、编辑器文本读写、`addAutocompleteProvider`。**模式降级**见 §4.4。

---

## 3. 事件钩子全集（`pi.on()` 40 事件）

**链序通则**（types.ts + `docs/extensions.md` Events 节）：handler 按扩展**加载序 × 注册序**执行；`pi.on()` 返回退订函数；退订/新增**不影响已在进行的 dispatch**（快照分发，`runner.ts` `snapshotEventHandlers`）。**错误面**：报告后继续（`ExtensionError` 监听器），唯一例外 `tool_call` handler 失败 = fail-safe 拦截该工具。**用各事件声明的 result 类型判断效果**——不是每个返回值都有副作用。

分类总表（「可拦截」= 能取消操作；「可变换」= 能替换数据；「边界」= 可追加条目并续跑；「通知」= 无返回效果）：

### 3.1 信任与资源

| 事件 | 语义 | 效果 |
|---|---|---|
| `project_trust` | 信任裁决（§1 决策链第 2 环，项目扩展加载**前**） | 可决定（yes/no/undecided + remember） |
| `resources_discover` | 启动/reload 后贡献资源路径 | 可贡献（skillPaths/promptPaths/themePaths） |

### 3.2 会话生命周期

| 事件 | 语义 | 效果 |
|---|---|---|
| `session_start` | 会话开始/载入/重载（reason: startup\|reload\|new\|resume\|fork） | 通知（分支态重建点：`getBranch()`） |
| `session_info_changed` | 会话名变化 | 通知 |
| `session_before_switch` | 切会话前 | 可拦截（cancel） |
| `session_before_fork` | fork 前 | 可拦截（cancel + skipConversationRestore） |
| `session_before_compact` | 压缩前（reason: manual\|threshold\|overflow） | 可拦截 / 可自备压缩结果 |
| `session_compact` / `session_compact_failed` | 压缩后 / 失败 | 通知 |
| `session_before_tree` | 会话树导航前 | 可拦截 / 可替换 summary |
| `session_tree` | 树导航后 | 通知 |
| `session_shutdown` | runtime 拆除前（reason: quit\|reload\|new\|resume\|fork） | 通知（**清理须幂等**——取消/reload/换会话/进程退出收敛同一路径） |

### 3.3 LLM 请求管线（变换链）

| 事件 | 语义 | 效果 |
|---|---|---|
| `context` | 每次 LLM 调用前的消息变换（不含 system prompt/tool 声明——Pi 事后恢复，handler 丢不掉也不必保） | 可变换（替换 messages） |
| `context_with_system` | 其后：全 transcript 含系统消息，handler **拥有** prompt 与工具声明（须保持 index 0 为 system） | 可变换（仅在必须请求级改写完整 transcript 时用） |
| `cache_warming_decision` | 空闲 prompt-cache 刷新决策 | 可覆盖（`{action:"warm"|"stop"}`，**最后一个返回 action 的赢**） |
| `before_provider_request` | provider 请求发出前 | 可变换（替换整个 payload） |
| `before_provider_headers` | 头组装后、HTTP 前 | 可变换（原位改 headers，null 删头，返回值忽略） |
| `after_provider_response` | 响应收到、流消费前（status/headers） | 通知 |
| `provider_stream_event` | 每个解析后的 provider 流事件、归一化前（data 是 Pi 最早拿到的结构化值，非原始字节；**只读、不持久化**；handler 顺序 await，慢 handler 拖慢流消费） | 通知 |

### 3.4 Agent 运行流

| 事件 | 语义 | 效果 |
|---|---|---|
| `before_agent_start` | 用户提交后、循环开始前（prompt 展开后原文 + 当前系统 prompt + **可变 systemPromptOptions**，后者改动后续 handler 可见） | 可变换（附 message；返回 systemPrompt 整体替换当轮 prompt，transcript 继续记结构化段） |
| `agent_start` / `agent_end` | 循环开始 / 结束（end 带 messages） | 通知 |
| `turn_start` | 每轮开始（turnIndex） | 通知 |
| `turn_end` | 每轮结束（**边界**：可链式追加 custom/custom_message/context_edit/compaction 条目 + `continue:true` 续跑一次） | 边界 |
| `agent_before_settle` | **最终可行动边界**：自动重试/压缩/排队续跑都不再发生前 | 边界（同上） |
| `agent_settled` | 完全落定、无任何自动续跑将发生（一次性，防重入由 `_isEmittingAgentSettled` 保证） | 通知 |
| `ui_prompt_start` / `ui_prompt_end` | 阻塞式扩展 UI 提示等待窗口 | 通知 |

**边界链语义**（`runner.ts:954-1003` `emitBoundary` 实测）：entries/continue 在 handler 间**链式传递**——后手看到先手追加的 entries，continue 可被后手覆写（**最后声明者赢**）；entries 非法 → valid=false → continue 强制 false。**一次性约束**：`continue:true` 只保证**下一次**模型请求；该请求完成后边界再次触发（`agent-session.ts:1633` `_runBeforeSettleBoundary`）——链式多次续跑在机制上可行，但官方警告「unconditional continuation can loop」，续跑条件由扩展自守。

### 3.5 消息与工具流

| 事件 | 语义 | 效果 |
|---|---|---|
| `message_start` / `message_update` | 消息开始 / 流式 token 级更新 | 通知 |
| `message_end` | 消息定稿 | 可变换（替换 message，**角色必须保留**） |
| `tool_call` | 工具执行前 | **可拦截**（`{block, reason, terminate}`；`event.input` 原位改即生效且**改后不再校验**；terminate 须本批全部 finalized 结果同意才提前收束） |
| `tool_result` | 工具执行后 | 可变换（content/details/isError/usage；**handler 组合**，后手见先手改动） |
| `tool_execution_start` / `update` / `end` | 执行生命周期（update 载 onUpdate 上报的部分结果） | 通知 |

内置八工具（bash/powershell/read/edit/write/grep/find/ls）的 call/result 事件按 toolName 字面类型收窄（`isToolCallEventType` 泛型守卫）；自定义工具 input 为 `Record<string, unknown>`。**同一 assistant 消息的多个工具调用可并行**——不假设兄弟调用/结果存在；嵌套工作用 `ctx.signal`。

### 3.6 模型与输入

| 事件 | 语义 | 效果 |
|---|---|---|
| `model_select` / `thinking_level_select` | 模型/思考级切换（source: set\|cycle\|restore） | 通知 |
| `user_bash` | 用户 `!`/`!!` 直发命令 | **可接管**（返回 `operations` 自定义执行或 `result` 完全替换；返回 undefined → 传给下一 handler → 无 handler 接则本地执行；handler 失败**阻塞命令**不落地执行） |
| `input` | 用户输入收到、处理前（source: interactive\|rpc\|extension；含 streamingBehavior） | 可变换（continue \| transform{text,images} \| handled 三态） |

---

## 4. 生命周期

### 4.1 factory 约束

- factory 可同步可异步；**异步 factory 被等待**——允许启动前取配置/注册 provider（`pi --list-models` 可见）。
- **禁长驻资源**：factory 里不得起进程、socket、watcher、timer——「some invocations load extensions without starting a session」。长驻资源一律 `session_start` 起，`session_shutdown` **幂等**收。
- 加载期即有共享 runtime state（flagValues、pending provider/虚拟模型注册队列）；`createContext()` 在 runner bind 前调用会抛。

### 4.2 session_start / session_shutdown

- `session_start` reason 全谱：startup（进程启动）/ reload（热重载）/ new（新会话）/ resume（恢复）/ fork（分叉）——**同一 handler 覆盖全部入口**，分支敏感状态在此从 `getBranch()` 重建（勿扫全文件：弃分支是替代历史）。
- `session_shutdown` reason：quit / reload / new / resume / fork——换会话也触发；换会话后旧 ExtensionContext **失效**（`assertActive()` 抛错），须换用 `withSession` 回调给的全新 context。

### 4.3 run 流全序

```
用户输入 → input → before_agent_start
  → 每轮 turn: [context → context_with_system → before_provider_request
     → before_provider_headers → (HTTP) → after_provider_response
     → provider_stream_event* → message_start → message_update*
     → tool_call → tool_execution_start/update* → tool_result
     → tool_execution_end → message_end → turn_end(边界)] × N
  → agent_end → agent_before_settle(边界) → [续跑一次 ⇒ 回循环] | 落定
  → agent_settled（终态，一次性）
```

`steer` 消息在当前 assistant turn 后插入；`followUp` 在 agent 收尾后插入；abort 停当前 run、排队消息退回编辑器（`docs/how-pi-works.md`）。

### 4.4 三/四运行模式行为差异

`ExtensionMode = "tui" | "rpc" | "json" | "print"`；**扩展在四种模式都加载**。

| 面 | tui | rpc | json / print |
|---|---|---|---|
| 对话框 select/confirm/input/editor | 原生终端 | **经 `extension_ui_request`/`extension_ui_response` 子协议转发**（dialog 带 timeout 时 agent 侧自动消解） | 无 UI |
| fire-and-forget（notify/setStatus/setWidget/setTitle/set_editor_text） | 原生 | 转发（widget 仅支持字符串行数组） | 无 |
| 自绘组件 custom()/setFooter/setHeader/setEditorComponent/主题 | 全量 | **不可用**（custom 返回 undefined、其余 no-op、主题切换报错） | 无 |
| `ctx.hasUI` | true | **true**（对话框子协议可用） | false |
| 守卫建议 | — | `ctx.mode === "tui"` 才碰终端组件；`ctx.hasUI` 判断对话框可用性 | 行为与渲染解耦，保非交互模式功能完整 |

（`docs/rpc-extension-ui.md`：本项目视角这恰是「逻辑在 server、渲染在前端」的同构先例。）

### 4.5 reload 语义

`/reload` 或 `ctx.reload()`（仅命令 context）= **重建整个扩展 runtime**：旧 runtime 全部 handler/注册作废 → `session_shutdown(reason:"reload")` → 重发现重载 → `session_start(reason:"reload")`。reload 之后旧 context 上任何调用 `assertActive()` 抛错；`await ctx.reload()` 之后的代码不得复用旧 runtime 状态。`resources_discover` 的 reason 区分 startup/reload 两入口。

---

## 5. 消息面与动态面

### 5.1 sendUserMessage / sendMessage / appendEntry

| API | 语义 | 关键约束 |
|---|---|---|
| `sendUserMessage(content, {deliverAs?, expandPromptTemplates?})` | 以用户身份发消息，**总是触发 turn** | `deliverAs: "steer" \| "followUp"` 决定流式中排队位置；`expandPromptTemplates` 可让扩展命令/技能命令/提示模板展开 |
| `sendMessage({customType, content, display, details?}, {triggerTurn?, deliverAs?})` | 自定义消息入会话（可进 LLM 上下文，配 registerMessageRenderer 定制渲染） | `triggerTurn` 控制是否引发模型请求 |
| `appendEntry(customType, data?)` | 自定义条目持久化，**不进 LLM 上下文**（配 registerEntryRenderer） | 状态持久化通道 |

**状态选型表**（官方 `docs/extensions.md` State 节，V2 消息面设计可直接引用）：

| 状态性质 | 存储 |
|---|---|
| 跟随活跃分支的工具态 | 工具结果 `details` |
| 耐久但不进模型上下文 | `appendEntry` |
| 自定义内容且进模型上下文 | `sendMessage` |
| 跨会话数据 | 外部存储 |

### 5.2 setActiveTools 动态激活

- 模式：**先全量注册，可选工具保持 inactive，运行中（典型：经一个 loader 工具）`setActiveTools(names)` 选择激活集**。未知名字**忽略**（不报错）。
- transcript 语义：首个 system 消息记录初始 prompt + 工具集；此后**每次变更在下一次模型请求前作为 delta 追加**进 transcript；无法表达「中途换工具」的 provider 收到**完整 checkpoint**（代价：缓存前缀失效）。
- 配套读面：`getActiveTools()` / `getAllTools()`（含 schema/guidelines/来源）/ `getCommands()`；`setModel` / `setThinkingLevel` 是会话级（不改新会话默认），`setModel` 返回 false 表示该 provider 未配认证。

---

## 6. 分发与信任

- **pi packages**（`docs/packages.md`）：`pi install npm:|git:|local` 三源；个人装写 `~/.pi/agent/settings.json`，项目装写 `.pi/settings.json`（**信任通过后才读**）。manifest 惯例目录 `extensions/ skills/ prompts/ themes/`，或 `package.json` 的 `pi` 键显式声明（glob + `!` 排除）；npm 包以 `pi-package` keyword 进官方 gallery。宿主包（typebox/pi-ai/pi-agent-core/pi-tui/pi-coding-agent）走 peerDependencies `"*"` + 虚拟模块注入，**禁物理拷贝**；已装包各有独立 module root，不保证跨包共享依赖实例。资源选择器（`{source, extensions, skills, ...}`）按类型收窄加载；同包个人+项目双声明时项目项默认替换（`autoload:false` 退化为过滤 delta）；身份去重：npm 按包名、git 按仓库 URL、本地按解析绝对路径。
- **信任**（§1 已详）：无沙箱同进程；project_trust 是「防文件夹静默装载可执行扩展」的启动门，官方明示**它不构成安全边界**、也不限制工具调用权限；真正的边界是 OS 隔离（容器/VM 最强）。扩展代码可审视 prompt、工具调用、文件、凭证、会话历史——「load extensions only from sources you trust」。
- **self-extensible**：Pi 生态无「agent 运行中自装扩展」的内建机制面（扩展集在启动/reload 时确定），但其无沙箱模型下扩展与宿主同权，任何「会话内写代码再加载」等价 root——与本项目 #749 的出局理由完全一致，可作证据引用。

---

## 7. 映射表（核心产出）

图例：**V1** = 根决策已选三件套；**不开** = 根决策钉死不做；**V2** = V2 roadmap 候选；**不迁移** = 架构不适用（非价值否定）；**对齐/不对齐** = 概念对齐、机制不对齐。

| # | Pi 能力面 | 本项目对应物 | 采否 | 接缝说明 |
|---|---|---|---|---|
| 1 | `registerTool`（TypeBox schema / execute / content+details / promptSnippet+promptGuidelines / executionMode） | LangGraph + deepagents 工具面（#737 工具清单、`createDeepAgent` tools） | **V1** | TypeBox schema ↔ 工具 JSON schema（LangChain 侧校验等价）；`AgentToolResult.content`（模型可见）↔ 工具结果回灌 LLM，`details`（仅渲染）↔ **SSE 事件面里给 ToolLine/自定义渲染的结构化载荷**（#726）——双面契约原样搬；`execute(toolCallId, params, signal, onUpdate, ctx)` 的 signal/onUpdate ↔ run 中止与部分进度事件；promptSnippet/promptGuidelines ↔ runner 系统 prompt 组装的**声明式**注入面（V1 建议收录，避免插件运行时碰 prompt）；插件工具注册 = 编译期收集进 tools 集 + **用户启用位过滤**；文件/exec 类工具类别声明强制走 #729 漏斗（根决策） |
| 2 | 工具结果渲染：`renderCall`/`renderResult` + `renderShell` + ToolRenderContext（expanded/isPartial/state） | #730 单管线渲染 + 插件前端面（Vue 组件编译期收录进 bundle） | **V1**（渲染件） | `renderCall/renderResult` 返回 TUI Component ↔ 插件注册 **Vue 组件**（#749 单包双面之前端面）；渲染输入 = `result.details` + 渲染选项（expanded/isPartial）——与 #730「同一归约器产出视图模型」咬合：插件组件是归约产物的 custom-render 分支，**不是第二条管线**；`isPartial` 对应实时路径的进行态装饰，回放路径不构造 |
| 3 | `registerCommand`（name/description/getArgumentCompletions/handler 拿命令级 context） | #742 命令模型（用户交互层双源并存） | **V1**（命令件） | Pi 同构精确成立：extension commands（代码 backing）↔ **插件贡献命令源**；prompt templates + skills（内容命令，同列 `/` 菜单、`/skill:name` 命名空间）↔ **用户纯内容自定义源**——双源一个菜单即 #749「能力实现层 vs 用户交互层」的 Pi 实证；`getArgumentCompletions` 可借为命令参数补全设计；命令触发能力实现（背后是工具），不经 agent 自由裁量（`/figure` 先例） |
| 4 | `registerShortcut` / `registerFlag` + `getFlag` | 无对应物 | **不迁移** | Web 面板无终端快捷键与 CLI flag 面；Pi 里这两个面承载的「面板级偏好」在本项目归 #749 V1 面板级配置。若 V2 出面板快捷键需求另开票，不预设 |
| 5 | `registerProvider` / `unregisterProvider`（baseUrl/apiKey 插值/models 三型/oauth/streamSimple/refreshModels） | ProviderRegistry（#731 单出口 + provider CRUD + 端点白名单） | **不开**（根决策） | 凭证纪律：LLM key 全面板共享 env 注入、`provider_endpoints` 白名单 + 运行时复验禁 redirect——插件自带 provider 即绕开单出口与凭证纪律，#750 Out of scope 明列；本节签名录存仅为对照 |
| 6 | `registerVirtualModel`（route 选择/分派分离、reason 四值、分支态 state） | 同上（ProviderRegistry 域） | **不开**（根决策） | 虚拟模型属 provider 注册面；若 V2 出多模型路由/成本路由需求，归核心 ProviderRegistry 实现（#731 域），不归插件贡献 |
| 7 | 事件钩子 `tool_call` / `tool_result`（拦截 + args 原位变换 + 结果变换链） | #729 审批三层漏斗（规则层 → judge → 人工） | **V2 候选**（map「Not yet specified」首项） | **重叠与风险**：Pi 的拦截语义（block/reason、terminate 全批同意、handler 失败 fail-safe 拦截、args 改后不重校验）是漏斗规则层需求的超集——V2 若把钩子做成漏斗外的平行闸门即破坏 #749「工具类别强制走漏斗」的单闸门裁决。可行形态：钩子作为**漏斗规则层的插件扩展点**（插件声明路径/命令类规则，执行仍归漏斗统一闸门 + 全量审计）；`tool_result` 变换 ↔ 事件面归一化点（进 SSE 前的最后修改权），须与 #726「投影是权威读模型」对齐时序 |
| 8 | 事件钩子 `context` / `context_with_system` / `before_agent_start`（prompt 与消息变换） | runner prompt 组装 / LangGraph state reducer | **V2 候选** | V1 用声明面（#1 的 promptSnippet/promptGuidelines）已覆盖「插件往 prompt 注引导」的需求；运行时变换整段 prompt/上下文在本项目 = 侵入 runner 组装与 LangGraph 状态，V2 按需求再评估；若开，对齐 Pi 的「context 不含 system 态、宿主事后恢复」职责切分 |
| 9 | 生命周期通知类钩子：`session_start/shutdown`、`agent_start/end`、`turn_*`、`message_*`、`tool_execution_*` | SSE 事件面（#726 事件流 / 待发出箱 / 会话投影） | **V2 候选** | Pi 是同进程回调；本项目对应物是事件流的**订阅/观察面**——候选位置：待发出箱出口的订阅权（插件只读事件）或 LangGraph `streamMode:"custom"` 事件桥。前置问题：插件可见事件的权限边界（用户消息原文/工具参数是否脱敏），V2 设计票定 |
| 10 | `turn_end` / `agent_before_settle` 边界（条目链 + `continue:true` 一次续跑）+ `agent_settled` 一次性终态 | 无直接对应（LangGraph interrupt/resume 或「追加消息再触发一轮」可模拟） | **V2 候选**（与 #9 绑定设计） | 若开事件钩子须同时定义「续跑一次」的 runner 层语义（LangGraph 上 = resume 后再一 superstep 的包装）；Pi 的教训直接搬：continue 是一次性的、无条件下会死循环、非法 entries 强制不续跑（emitBoundary 的 valid 门） |
| 11 | `ctx.ui` 对话框原语（select/confirm/input/notify + timeout 自动消解 + RPC 子协议转发） | #729 人工升级审批卡 + 前端交互面 | **部分已有**（审批卡 V1）；通用 ui 抽象**不开** | 本项目用户交互由**固定前端组件**承载（审批卡/通知），插件不自由绘制对话框；Pi 的 RPC 模式「对话框经协议转发、自绘组件不可用」正是本项目「逻辑在 server、渲染在前端」的同构先例——若 V2 插件需请求用户输入，走预定义交互原语（对齐审批卡的 resolve 协议），不开 custom 绘图面 |
| 12 | TUI 组件面（setWidget/setFooter/setHeader/setEditorComponent/custom overlay/主题） | 无 | **不迁移** | Web 前端渲染面被 #730 单管线收口；插件渲染已由 #2 三件套覆盖 |
| 13 | `sendUserMessage`（总触发 turn、steer/followUp 排队、expandPromptTemplates） | 会话写入面（#727 checkpoint 树 + #726 排队语义） | **V2 候选** | steer/followUp ↔ #726 排队/待发出箱语义，概念直译；**前置问题**：插件发起「以用户身份的 turn」的权限边界（Pi 中扩展与用户同权，本项目多租户下不成立）——V2 需定义插件消息的归属与展示形态（更可能是 `sendMessage` 式 custom 消息而非 sendUserMessage） |
| 14 | `sendMessage`（custom message 进上下文）/ `appendEntry`（不进上下文持久化） | custom 事件管线（#726）/ 非上下文持久面（TextTrace 审计、会话元数据） | **V2 候选** | Pi 状态选型表（§5.1）可直接引用为本项目设计底稿：details=分支态、appendEntry=耐久非上下文、sendMessage=上下文内容、外部存储=跨会话——四分法与 #726/#727 的存储分层天然同构 |
| 15 | `setActiveTools` 动态激活（先全注册、激活集选择、未知忽略、transcript 记 delta、不支持的 provider 收全量 checkpoint） | 插件启用位（#749：禁用 = 新 run 不再见工具/命令） | **V1**（启用位静态实现）；**run 内动态激活 V2 候选** | V1：启用集在 run 装配时静态过滤 tools/commands，即 Pi「全量注册 + 激活集选择」的零子集；V2 若开 run 内激活，Pi 语义整包可借（teammate 继承启用集的时机语义也对齐）；LangGraph 侧对应 = graph config/middleware 的工具集注入 |
| 16 | 分发：目录发现 + pi packages（npm/git/local、manifest、gallery、身份去重、peerDeps 虚拟模块） | 官方插件目录（静态清单 + 编译期打包 + 一键启用） | **对齐/不对齐**（根决策） | 概念对齐（「我们提供的插件」静态清单、安装=启用非代码获取）；机制不对齐（无运行时安装）。可借的**纯 schema 设计**：目录清单的 manifest 字段（能力声明/版本/过滤）、身份去重（本场景 = 插件 id 唯一性） |
| 17 | 信任：jiti 同进程热载 + project_trust 事件 + trust.json + defaultProjectTrust | 编译期信任 + 发布流程 + #729 漏斗 | **不对齐**（根决策） | 多租户控制面下插件代码 = 核心代码，信任锚在 git 审查与发版，无运行时信任门可开；project_trust 的「首个裁决者赢」链式设计如 V2 出「per-user 实验性插件开关」再回看 |
| 18 | `pi.events` EventBus（扩展间通信） | 无 | **不开**（暂无需求） | 插件间无通信场景；真需要时经核心事件面中转，不做插件直连 |
| 19 | 便利设施：`ctx.exec`、`withFileMutationQueue`、`ctx.modelRegistry.streamSimple`（嵌套模型调用）、`ctx.compact`/`getContextUsage` | 核心已有：files 域 fsPort、沙箱 exec 工具、#731 LLM 出口、#727 compaction | **不迁移** | 这些是 Pi 单进程形态的便利封装；本项目对应能力散在控制面各域，插件经注册的工具间接使用，不给插件直连口 |

---

## 8. 对 V2 roadmap 与设计票的供据

1. **契约规格票（V1）应收录的低成本增量**：① 工具契约加 `promptSnippet`/`promptGuidelines` 声明字段（ runner 组装系统 prompt 时统一注入，插件不碰 prompt 运行时）；② 命令契约加参数补全（Pi `getArgumentCompletions` 同构）；③ 工具结果双面 `content`/`details` 写死在契约里（details 为空合法；嵌套 LLM 调用 usage 须并入——本项目对应「judge/分类调用的 usage 归会话总量」审计口径）。
2. **V2 首项（事件钩子）的裁决框架**：先回答「钩子相对漏斗的位置」——按 §7#7 的分析，答案几乎必然是「规则层扩展点」而非「平行闸门」；再回答「事件可见性的权限边界」（#9）与「续跑一次的 runner 语义」（#10）。Pi 的 40 事件目录按 §3 的四分类（可拦截/可变换/边界/通知）逐类评估即可，无须全收——通知类（观察）风险最低、边界类（续跑）风险最高。
3. **消息面（V2）从 Pi 状态选型表起步**：四分法（details/appendEntry/sendMessage/外部存储）与本项目 #726/#727 分层同构，设计票可直接引用 §5.1 表格做语言对齐。
4. **不迁移面要有明示**：shortcut/flag/TUI 组件面/EventBus/便利设施直连（§7 #4/#12/#18/#19）建议在契约规格票里写一句「评估过 Pi 对应面，架构不适用」，避免后续重复开题。

## 9. 引用与基线

- 仓库：`github.com/badlogic/pi-mono` @ `cb7969d`（2026-09-28；`packages/coding-agent` v0.87.1；docs 内链指向 `github.com/earendil-works/pi` 同源）。本文所有行号引用均属该 commit。
- 核心文件：`packages/coding-agent/src/core/extensions/types.ts`（ExtensionAPI/40 事件/ToolDefinition/ProviderConfig 全录）、`runner.ts`（emitBoundary :954-1003、分发与错误面）、`../core/agent-session.ts`（_runBeforeSettleBoundary :1633、agent_settled 防重入）、`loader.ts`（发现 :777-820）、`virtual-modules.ts`（导入白名单）。
- 文档：`docs/extensions.md`（生命周期/事件/工具/状态/模式通则）、`how-pi-works.md`（agent loop/steer-followUp）、`security.md`（信任模型）、`packages.md`（分发）、`custom-provider.md` / `virtual-models.md` / `rpc-extension-ui.md` / `tui.md` / `slash-commands.md`。
- pi.dev/docs/latest 与仓库 docs 于 2026-09-29 核对一致（extensions 页三点抽验：注册面表格、settle 语义、project_trust + jiti）。

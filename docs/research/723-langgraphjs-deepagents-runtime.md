# 调研报告：LangGraph JS 与 deepagentsjs 运行时能力（选型确认书）

> 回答 #723 全部问题点。结论先行，供 PoC 票 #724 与会话存储设计票 #727 直接引用。
> 调研时间 2026-09；版本以 npm 当前 latest 为准，接口形态以官方文档 + GitHub 源码（langchain-ai/langgraphjs、langchain-ai/deepagentsjs）验证。

## 结论（TL;DR）

**LangGraph JS + deepagentsjs 胜任自研 agent runtime 基座，且 compaction 缺口比预想小得多**——deepagents 自 1.6.0 起内置两层上下文压缩（tool 结果 offload 落盘 + 85% 窗口触发 summarization + ContextOverflowError 自动重试），默认开启，不是从零自研。真正要自研的是四件事：

1. **DockerArchiveBackend**：实现 deepagents 的 `BackendProtocolV2` 七个方法，映射到现有 `files/` 域 fsPort（Docker getArchive/putArchive 之上）——抽象完全为定制而设计，可行性高；
2. **checkpointer retention**：checkpoint 按 superstep 无限累积，按策略清历史 + 删容器时 `deleteThread`（接口已有，策略自建）；
3. **事件桥**：`streamMode: ["messages","updates","tools"]` → 现有前端 eventTranslate 事件协议的映射层；
4. **runner 编排**：BullMQ worker + 同一 thread_id 严格串行（LangGraph 乐观并发会拒绝同 thread 并发写）。

版本锁定建议：`@langchain/langgraph ~1.4.18` + `deepagents ~1.14.1` + `langchain ~1.5.14`，三者版本互相咬合需联动升级。

---

## 逐题回答

### 1. checkpointer 后端与持久化形态

**官方后端**（`@langchain/langgraph-checkpoint` 系列独立包）：

| 包 | 后端 | 定位 |
|---|---|---|
| `@langchain/langgraph-checkpoint` | `MemorySaver` + `BaseCheckpointSaver` 基类 + `SerializerProtocol` | 仅开发用，重启即失 |
| `@langchain/langgraph-checkpoint-sqlite` | `SqliteSaver` | 本地文件，开发/单机 |
| `@langchain/langgraph-checkpoint-postgres`（当前 1.0.5） | `PostgresSaver` / `AsyncPostgresSaver` | 生产推荐 |
| `@langchain/langgraph-checkpoint-redis` | `RedisSaver`（另有 shallow 变体） | 生产可用 |
| `@langchain/langgraph-checkpoint-mongodb` | `MongoDBSaver` + `MongoDBStore` | 生产可用 |

**自定义接口**（源码验证 `libs/checkpoint/src/base.ts:113`）：继承 `BaseCheckpointSaver` 实现 5 个抽象方法——`put` / `putWrites` / `getTuple` / `list` / `deleteThread`（注意：JS 文档页未列 `deleteThread`，但源码 `base.ts:162` 确认为 abstract 方法，删容器清 thread 可直接用）。全部 async，后端可为任意存储。每 thread 每 superstep 落一个 `StateSnapshot`（`values`/`next`/`config`/`metadata`/`createdAt`/`parentConfig`/`tasks`），`thread_id` 是主键；`checkpoint_ns` 管子图命名空间。序列化走 `SerializerProtocol`，默认 JSON。

**与我们栈的匹配**：现栈是 SQLite + Redis、无 Postgres。三条零新增基础设施的路：
- **SqliteSaver**（`@langchain/langgraph-checkpoint-sqlite` 1.0.4，现成依赖 better-sqlite3 同款引擎）——文件放 named volume、runner 单写者独占即可；注意它是同步 API，写 checkpoint 会占事件循环；
- **RedisSaver**——已有 Redis，但 checkpoint 历史（时间旅行）的长期持久性弱于文件；
- **自定义 saver 落 Prisma/SQLite**——5 个方法映射到现有 Prisma 栈，代价是实现 + 测试。
PoC 建议先 `SqliteSaver` 跑通，存储设计票 #727 再定夺是否自定义 saver 进 Prisma 体系。

**配套概念**：跨 thread 长期记忆是另一套 `BaseStore`（与 checkpointer 平行，`compile({ checkpointer, store })`），deepagents 的 `StoreBackend` 建在其上——对应「每用户跨会话记忆」，#727 设计时应一并考虑两套存储。

### 2. interrupt / 程序化 resume（自动审批三层漏斗依赖此机制）

**机制完整，程序化 resume 是一等公民**：
- 节点或 tool 内任意点 `interrupt(payload)`（JSON 可序列化），图暂停、状态经 checkpointer 持久化，payload 出现在结果 `__interrupt__` 字段；
- resume：`graph.invoke(new Command({ resume: X }), { configurable: { thread_id } })`——同一 thread，`X` 成为原 `interrupt()` 调用的返回值。**resume 值由调用方程序化构造，不要求人类在场**——这正是三层漏斗（自动 approve 层直接 `Command({ resume: { approved: true, ... } })`，仅兜底层进人工）需要的形态；
- 并行多 interrupt：`Command({ resume: { [interruptId]: answer } })` 按 id 匹配。

**关键语义约束**（漏斗设计须遵守）：
- resume 后**节点从头重跑**（interrupt 靠抛特殊异常实现）——interrupt 之前的副作用必须幂等或挪到 interrupt 之后；
- 多个 interrupt 的匹配是**严格按序**的，interrupt 调用点须确定性；
- 不可裸 try/catch 包 `interrupt()`（会吞掉暂停异常）、不可在非确定性循环里包它。

**deepagents 层封装**：`createDeepAgent({ interruptOn: { toolName: true | false | { allowedDecisions: [...] } } })` 注入 `HumanInTheLoopMiddleware`；decision 四类 `approve` / `edit` / `reject` / `respond`；同一批多个 tool call 合并为一个 interrupt，按序 resume `Command({ resume: { decisions } })`；`PatchToolCallsMiddleware` 自动修复被中断的 tool call 历史；子代理可覆写父级 `interruptOn`。漏斗的「per-tool 审批策略」可直接落在 `interruptOn` 配置上。

### 3. streaming 事件粒度

**token 级与节点级并存，一次调用可同时拿**：
- `graph.stream(input, { streamMode })`，模式：`values`（每步全量状态）/ `updates`（每节点增量，节点级）/ **`messages`（token 级，`[messageChunk, metadata]` tuple，metadata 含 `langgraph_node` 等归属信息）** / `custom`（`config.writer` 自由事件）/ `tools`（`on_tool_start/event/end/error` 生命周期，async generator tool 的每个 yield 成为一个事件）/ `debug`；
- **多模式并行**：`streamMode: ["updates", "messages", "tools"]` → 输出变 `[mode, chunk]` tuple，单次调用同时支撑前端流式投影（token 逐字 + 节点/工具事件）——与现有 `eventTranslate.ts` 的翻译层模型对齐；
- `subgraphs: true` → 输出加 namespace 前缀，**子代理的 token 也能透出**（deepagents 的 task 工具场景必需）；
- LangGraph 1.2+ 另有「event streaming」typed projection API（messages/values/subgraphs/output 分迭代器）；deepagents 有专属 event-streaming 文档页（子代理流、tool 调用、最终输出）；
- summarization 产生的 token 带 `metadata?.lcSource === "summarization"`，可过滤不进聊天流。

结论：**足够支撑前端流式投影**，无需额外自研流机制；工作在事件桥（映射到现有 ToolLine/ThinkingCard 事件协议）。

### 4. 上下文管理 / compaction 现状

**这是本次调研最重要的修正：deepagents 已内置 compaction，默认开启，缺口远小于「OpenClaw 有、LangGraph 无」的预期。**

分层现状：
- **LangGraph 本体**：无自动 compaction，只有原语（`RemoveMessage` 删消息、自定义状态）。旧的 `SummarizationNode` 已不是 langgraph 1.x 导出（代码搜索确认）；
- **`langchain` 1.5.x（createAgent middleware 体系）**：`summarizationMiddleware`（`libs/langchain/src/agents/middleware/summarization.ts`）+ `trimMessages`（@langchain/core）；
- **deepagents（>=1.6.0，当前 1.14.1）内置两层，默认启用**：
  1. **Offloading（文件化）**：tool 输入/结果超 **20k tokens**（默认阈值）即写入 backend 文件，原位替换为「文件路径 + 前 10 行预览」，agent 可事后 re-read/grep；窗口过 ~85% 时大 write/edit 输入也截断落盘；
  2. **SummarizationMiddleware**：达模型 `max_input_tokens` 的 **85%** 触发、保留 10% 近期上下文；无 model profile 时 fallback 170k tokens / 6 条消息；摘要为 LLM 生成的结构化摘要（session intent / artifacts / next steps），同时把**全文渲染写到文件系统作为 canonical record**；模型抛 `ContextOverflowError` 时自动带摘要重试。

**剩余自研量（对齐 OpenClaw 语义的部分）**：触发阈值/保留比例的可配置化、摘要模板对齐 OpenClaw compaction 的语义（如保留最近 N 轮原文的结构）、compaction 事件接入前端展示、以及（见下）checkpoint 历史的清理策略。均属「调参 + 薄封装」，非机制自研。

### 5. deepagents filesystem backend 抽象 → Docker Archive API

**可行，且这是该抽象的预期用法**。接口为 `BackendProtocolV2`（源码验证 `libs/deepagents/src/backends/v2/protocol.ts`），自定义后端只需实现：

```ts
interface BackendProtocolV2 {
  ls(path: string): MaybePromise<LsResult>;                    // 非递归，FileInfo{path,is_dir?,size?,modified_at?}
  read(filePath: string, offset?: number, limit?: number): MaybePromise<ReadResult>;  // 文本按行分页（默认 500 行），binary 返回 Uint8Array
  readRaw(filePath: string): MaybePromise<ReadRawResult>;      // 原始 FileData
  write(filePath: string, content: string): MaybePromise<WriteResult>;   // create-or-overwrite
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): MaybePromise<EditResult>;
  glob(pattern: string, path?: string): MaybePromise<GlobResult>;
  grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null): MaybePromise<GrepResult>;  // 字面量匹配，{matches:[{path,line,text}],truncated?}
  delete?(filePath: string): MaybePromise<DeleteResult>;       // 可选
}
```

**硬约束：所有方法返回结构化 Result（带 `error` 字段），不得 throw**；`SandboxBackendProtocolV2` 追加 `execute(command)` + `id`。

**映射到现有 `files/` 域（`server/src/files/fsPort.ts`，Docker getArchive/putArchive/exec rm 之上）**：
- `read`/`write`/`ls`/`delete` 与现有 fsPort CRUD 一一对应，`write` 的 create-or-overwrite 语义与 PUT 对齐；
- 需补齐：`read` 的 offset/limit 分页（在 fsPort 上加行级切片）、`glob`/`grep`（容器内 `exec` 跑 find/grep 或宿主侧对已拉取树做匹配）、`edit`（read-modify-write 三步合成）；
- `CompositeBackend` 按路径前缀路由：`/wiki/` → wiki 树 root、`/workspace/` → workspace 树 root，同一 agent 两树共存——与我们双树模型天然对齐；
- 每容器一个 backend 实例（持 dockerode handle + container id），图实例本身无容器态、state 在 checkpointer，与「runner 不驻留容器资源」的集中式架构相容。

内置后端参考：`StateBackend`（thread 内 state，默认）、`FilesystemBackend`（真实磁盘，`virtualMode: true` 沙箱路径）、`StoreBackend`（跨 thread）、`CompositeBackend`、sandbox 系（LangSmith/Daytona 等）。

### 6. 与 Node.js 长驻进程（独立 runner）集成的已知坑

按严重度排序：
1. **同一 thread_id 并发写**：LangGraph 用 checkpoint 版本做乐观并发，同 thread 并发 invoke 会冲突报错。runner 必须做 **per-thread 串行化**——现栈 BullMQ 天然可用（一个 session 一个 job 链，或按 threadId 分 key 的互斥）；
2. **MemorySaver 在长驻服务 = 设计上的内存泄漏**：所有 checkpoint 常驻堆。必须换持久 saver；同理注意进程级 map 缓存 graph/stream 引用；
3. **checkpoint 无限累积**：每 superstep 一份快照，长会话下 SQLite 文件/存储快速增长（社区有 checkpoint 序列化 ~85% storage bloat 的 issue，2026-05）。需 retention 策略（保最近 N 步或按时间清理）+ 删容器时 `deleteThread`；Postgres 后端另有 thread_id ≤255 字符限制；
4. **LangSmith/tracing 已知泄漏**（langsmith-sdk #2097：~200 次图执行后 span 累积）：deepagents peer deps 含 `langsmith`，runner 内**显式关 tracing**（不设 LANGSMITH_API_KEY / `tracing: false`）；
5. **同步 IO 占事件循环**：`SqliteSaver` 基于 better-sqlite3（同步 API），checkpoint 写入 + 大 state 的 JSON serde 会阻塞事件循环；runner 内多图并发时吞吐受限。缓解：单 runner 限并发图数（BullMQ worker concurrency 调低）、或自定义 saver 走异步栈、或上 Postgres/Redis saver；
6. **图实例缓存**：`CompiledStateGraph` 可跨请求复用（编译产物无请求态），按 agent 配置缓存、按需重建；state 全在 checkpointer，进程重启不丢会话——这是「集中式 runner + 可恢复长任务」成立的前提。

### deepagents 成熟度与版本面

- npm 包名就是 **`deepagents`**（非 scoped），当前 **1.14.1**；repo langchain-ai/deepagentsjs（1.6k stars / 637 commits），MIT；
- `createDeepAgent({ model, tools, systemPrompt, backend, interruptOn, subagents, ... })` 返回**编译后的 LangGraph 图**——checkpointer、streaming、interrupt 全部继承 LangGraph 原生语义，无第二套运行时；
- 内置能力面：`write_todos`（planning）/ 文件六件套 `read_file`/`write_file`/`edit_file`/`ls`/`glob`/`grep` / `task` 子代理（隔离上下文、返回最终报告；另有 async subagents 并发模式）/ HITL middleware / 默认压缩 / skills（AGENTS.md 渐进披露）/ MCP；
- 入口分包：`deepagents`（Node）/ `deepagents/browser`——runner 与浏览器侧都有官方面；
- **成熟度判定：API 演进快但方向稳定**。证据：backend 协议刚经历 v1→v2 迁移（`adaptBackendProtocol` 兼容层、`createDeepAgent` 自动适配 v1）；1.6.0 才有 in-model summarization。锁版本 + 小步升级窗口是必须的。

---

## 选型确认书

**判定：LangGraph JS（1.4.x）+ deepagentsjs（1.14.x）胜任自研 agent runtime 基座。** 基座提供的四根支柱（持久化 + 中断恢复 + 流式 + 压缩）全部原生或内置；与我们栈的关键接缝（fsPort、BullMQ、Redis、SQLite、eventTranslate）均有明确映射路径。

### 缺口清单（须自研的运行时能力，按 PoC 优先级）

| # | 缺口 | 性质 | 归属票 |
|---|---|---|---|
| G1 | **DockerArchiveBackend**：`BackendProtocolV2` → fsPort 映射（含 read 行分页、glob/grep、edit 合成、Composite 路由 /wiki/ /workspace/） | 新代码，接口明确 | #724 PoC |
| G2 | **事件桥**：`streamMode ["messages","updates","tools"]` + `subgraphs:true` → 前端事件协议（ToolLine/ThinkingCard/subagent 卡）；过滤 `lcSource==="summarization"` | 映射层 | #724 PoC |
| G3 | **runner 编排**：BullMQ worker + per-thread 串行 + 图实例缓存 + 关 tracing | 进程模型 | PoC + spec |
| G4 | **checkpoint retention**：清理策略 + `deleteThread`（删容器联动） | 策略自建，接口已有 | #727 |
| G5 | **compaction 对齐**：阈值/保留比可配、摘要模板对齐 OpenClaw 语义、compaction 前端事件 | 薄封装（机制已内置） | #727 + spec |
| G6 | **LLM provider 翻译**：models/ 域的 provider 配置 → langchain chat model 实例（`ChatOpenAI` 等 baseURL 兼容面） | 映射层 | PoC |

### 风险清单

- **R1 版本联动**：`@langchain/langgraph` / `langchain` / `deepagents` 三包互相咬合（peer deps 含 langsmith），升级需整组联动；deepagents API 仍在快跑（backend v1→v2 刚落地）。→ 锁 `~1.4.18` / `~1.5.14` / `~1.14.1`，升级窗口人工把关；
- **R2 依赖面变重**：从零 langchain 依赖到现在，bundle、审计面、供应链面显著扩大（langchain 全家桶 + langsmith peer）；可控但须知；
- **R3 同 thread 并发**：框架只会报错不排队，串行化责任完全在我们（BullMQ key 设计）。漏斗的「程序化 resume 与新用户消息竞争同一 thread」是 PoC 必测用例；
- **R4 SQLite 同步 IO**：runner 多图并发下事件循环阻塞；PoC 实测 checkpoint 写延迟，必要时自定义 saver 或限并发；
- **R5 集中式单点**（架构评审内化风险）：runner 崩溃 = 全 fleet 停摆，但 checkpointer 使图执行可恢复——重启 runner 后同 thread resume 即可，长任务恢复语义成立；
- **R6 双栈不可逆**（架构评审内化风险）：会话数据模型一旦落 LangGraph checkpoint 形态，与 OpenClaw 容器内 SQLite 分叉。→ #727 设计 checkpoint schema 时按「可导出为中性格式」约束。

### 版本锁定建议

```
@langchain/langgraph                ~1.4.18   （1.x stable line，next 分支不跟）
langchain                           ~1.5.14   （createAgent + summarizationMiddleware）
deepagents                          ~1.14.1   （须 >=1.6.0，in-model summarization 前提）
@langchain/langgraph-checkpoint     1.x       （BaseCheckpointSaver）
@langchain/langgraph-checkpoint-sqlite ~1.0.4 （PoC 起）
@langchain/langgraph-checkpoint-postgres ~1.0.5（若上 Postgres 再引入）
```

升级策略：三包 + checkpointer 同一 PR 联动升级，跑通 PoC 的行为快照测试后再合入。

---

## 对下游票的接口

- **#724（PoC）**：最小路径 = `createDeepAgent` + `SqliteSaver` + DockerArchiveBackend（先只 read/ls/write 三方法）+ `streamMode ["messages","updates","tools"]` + 一个 `interruptOn` 审批用例 + 程序化 `Command({ resume })` 自动 approve 用例；
- **#727（会话存储设计）**：决策输入 = checkpointer（5 方法接口 + StateSnapshot 形态）与 Store（跨 thread）两套存储的分合、checkpoint retention 策略、thread_id 命名（建议含容器 id）、G4/G5/R6。


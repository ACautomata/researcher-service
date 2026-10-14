# #927 A1·research：loop 收尾挂钩与取数路径盘点

问题（#927，wayfinder #924）：轮次正常结束时在对话流末尾追加「文件修改卡片」（本轮新建/修改/删除的文件列表 + 每文件下载链接），在现有 runner 里的实现位置选项对比与推荐。全程只读盘点，行号基于 `7fb42f1`。

## Agreements

- The user agreed that 卡片只在轮次**正常结束**时追加（aborted/failed/suspended 半成品轮不出卡，对齐 D9 媒体扫描「仅 completed 路径扫」的既有语义）。
- The user agreed that 「轮次结束 ≙ run 进入 completed 终态且无后续 resume」是本票采用的工作语义，run/轮次的语义差须在报告讲清（见 §1）。
- The user agreed that 至少盘点三个候选位置并给出推荐位。
- The user agreed that 取数路径盘清 file_journal 查询面 / archivedAt 软删语义 / attachments 下载端点复用关系。

## 1. 语义澄清：轮次（turn）≠ run

- **轮次**（GLOSSARY.md:147）：用户一次发送触发的完整 agent loop——一条 user 消息 + 一条 assistant 回复，消息流上恰对应一条 assistant 消息。产品折叠/计时/异常判定的单位。
- **run** 是执行单位：一条 BullMQ 命令（`cmd.kind = message | resume | recover` + `operation = compact | plugin-execute`），一个 runId，一块独立 `TurnReducer` 聚合（runService.ts:892-896）。
- 一条轮次可跨**多个 run**：message run → interrupt 命中（审批/plan review）→ **不发终态事件**（runService.ts:1084「interrupted 态无终态事件」硬契约）→ resume 是**新 run**（`run.resumed` 事件，runService.ts:859-863；前端 `applyEvent` 据此新建独立 overlay 气泡，projection.ts:317-321）→ 最终某段 run completed。
- 持久化侧同步印证：每个 run 终态各自 `recordTurn` 落一条 assistant 行（runService.ts:1237-1248），resume 段只含本段聚合、「缺口固化」（runService.ts:1213-1216 注）。故「一条轮次 = 一条 assistant 投影行」只在无 interrupt 的常态下成立。
- **推论**：挂在 `run.completed` 上的收尾天然是 **run 段级**；无 interrupt 的轮次 run ≙ 轮次，卡片即轮次级；有 interrupt 的轮次会按段出多张卡（与分段气泡/分段落行现状同构，可接受；若强求「轮次唯一卡」需以锚点 checkpoint 链划窗聚合，复杂度显著上升，建议 V1 不做）。

## 2. 三个候选位置

### (a) downloadNode 式工具级后置钩子扩为轮次级

**现状机制**（`server/src/runner/runtime/downloadNode.ts`）：LangChain `createMiddleware({ wrapToolCall })` 后置钩子，挂在 graphFactory 的 middleware 数组（runService.ts:1763-1768 装配）。仅拦 `write`/`edit` 且声明 `/lab/**` 路径的工具调用：成功 → `materialize` 物化 Attachment 行 + 在 ToolMessage 文本尾追加 `[download attachmentId=… fileName=… mime=… size=…]` 标记（downloadNode.ts:75-84）；失败 → 错误 ToolMessage 回喂 agent 自纠。前端 `toolRender/downloads.ts:4-8` 正则抽取标记 → ToolLine.vue 展开区渲染下载入口。

**能否承载轮次级**：不能直接承载。
- 触发粒度是**每个工具调用**，钩子签名 `WrapToolCallHook`（request, handler）内没有「本轮还有哪些调用 / 本轮是否结束」的视野；做轮次聚合需在 middleware 里维护 per-thread 跨调用状态并自行猜测轮次边界（AI 消息无 tool_calls？）——复刻图内部推进逻辑，必然漂移。
- **图末追加节点**的变体撞两条硬约束：① graphFactory 头注钉死的「图拓扑必须可由持久化状态推导」（graphFactory.ts:12-16，PoC 坑 2：resume 重建异拓扑图 → 静默假 done）——生产工厂只收 model/backend/checkpointer/interruptOn/tools/middleware 七参，没有插末端节点的口子；② 轮次可停在 interrupt（图暂停非结束）或 abort（`goto END`，runService.ts:1036-1038）——末端节点在 interrupt 路径不触发、在 goto 路径的触发时序不可控，「轮次正常结束」语义恰好接不住。
- **上下文污染面**：downloadNode 的产出通道是改写 ToolMessage content（进模型上下文）。轮次级卡片若沿用此通道，要么污染对话历史（卡片文本被模型当输入读），要么需要图外旁路——那就已经不是这个钩子的形态了。

**改动面**：无既有改法（需新增 hook 类型/图拓扑扩展，动 deepagents 装配契约）。
**风险**：拓扑可推导约束破坏；interrupt/abort 路径漏触发；上下文污染；轮次边界自猜漂移。
**结论**：该先例的价值在「物化 + 下载引用」的**单文件取数闭环**（每文件 Attachment 行 + 下载标记），不在收尾时机；轮次级收尾应复用它的产物面而非它的挂载点。

### (b) runService 终态路径聚合 + 事件/投影聚合行（推荐）

**现状机制**：completed 分支（runService.ts:1114-1175）在 publish `run.completed`（:1174）之前已有一个**轮次末聚合区**——D9 媒体块扫描（:1120-1172）：扫终态 assistant 回复媒体块 → 校验/物化 Attachment 行 → `attachment` 事件同时 `turn.feed` + `publish`（实时 ≡ 回放）→ 降级面占位。这正是「server 侧终态聚合 + publish 卡片事件 + 落投影聚合行」的完整先例，卡片只是同位的第二个聚合产物。

**挂载点与顺序**：文件卡片聚合必须放在**同一时隙**（媒体扫描之后、`run.completed` 之前）：前端归约器收到终态事件即 `finalizeOverlay`（剥进行态 + 折叠轨迹 + 空 overlay 剥落，projection.ts:296-335），卡片事件若晚于终态将落不进 overlay——媒体扫描「先物化后终态」的顺序就是这条约束的既有解。

**数据源与查询面**：journal 锚点回填（runService.ts:1070-1079）已在本分支早前执行——`fileJournal.updateMany({where: {sessionId, runId}, data: {checkpointId: 锚点}})`。聚合查询即 `fileJournal.findMany({where: {sessionId: sandboxSessionId, runId: cmd.runId, archivedAt: null}})`，行集 = 本 run 段全部 /lab fs 写面（write/edit/delete，journalingBackend.ts:1-4）。op → 卡片语义映射：`write ∧ beforeSha256=null` = 新建；`write/edit ∧ beforeSha256≠null` = 修改；`delete` = 删除（tombstoneKey 面）。
**两个必须的过滤**：
- **剔除物化旁路行**：附件 ingestion 与 D9 媒体物化也经 `journalMaterialize` 落 journal 行，toolCallId 是确定性前缀 `ingest-`/`media-`（runService.ts:987/:1146，常量 `IDEMPOTENCY_INGEST_PREFIX`/`IDEMPOTENCY_MEDIA_PREFIX`，filejournal/values.ts:30-31）——不过滤会把用户上传物化误报为「本轮修改」。
- **journaling 关闭降级**：`fileJournal` dep 可缺省（runService.ts:219，测试/降级面不挂）——无行即无卡，静默跳过即可。

**下载链接复用**：journal 行只有路径 + sha，没有可外链字节。既有 agent→用户字节通道唯一：Attachment 行 + `GET /attachments/:id/download`（attachments/routes.ts:72-78，owner/admin 门 + 50002 同码防枚举，成功豁免 #312 信封）。两条既有产线（downloadNode、D9 媒体）都终于此端点。卡片逐文件物化 Attachment（copy 容器内 attic blob → `/lab/uploads/<id>/<name>`，`materializeAgentMedia` 同形态）后出 `attachmentId`；**delete 行无字节**，卡面只列路径不出链接（恢复语义归 rewind，不归卡片）。

**事件/投影形态（两个子变体）**：
- **b1 最小面**：逐文件复用 `attachment` 事件 + `TurnSnapshot.media[]`（MediaRef，reducer.ts:38-47）。零新事件类型、零归约器/序列化改动，下载 chips 前端已会渲染。代价：media 语义是「回复内媒体块」，无 op/删除维度的「卡片」形态，UX 折损。
- **b2 正形卡片**：新事件（如 `turn.files`）+ `TurnSnapshot` 增可选 `files` 字段。**硬纪律**：`serializeAttachments`（reducer.ts:104-112）与前端 `applyEvent`/`fromProjection`（projection.ts:314-458）必须同步扩展——「实时 ≡ 回放零差异」由 projection.test.ts 锁死，任何只走 SSE 不进聚合面的产物都会刷新即消失。读侧对未知键一律忽略（sessions/service.ts:234-243 `toProjectionMessage` 展开余项；serializeAttachments 头注同纪律），`attachmentsJson` 增可选键向后兼容，无需 v2 翻版。

**改动面**：runService completed 分支一段聚合逻辑（复用媒体扫描位形）+ TurnReducer/reducer.ts 增字段 + serializeAttachments + 前端 applyEvent/fromProjection + 卡片组件；可选 `@@index([sessionId, runId])`（现有索引只有 (sessionId, seq)/(sessionId, toolCallId)/(sessionId, checkpointId)，schema.prisma:603-605；runId 无索引，会话内行数有限，V1 可不加）。
**风险**：终态时隙串行物化 N 个文件增加 completed 延迟（可设上限/截断，对齐 tool.end details ≤4KB 截断纪律）；attachmentsJson 契约面扩键需测试同步；exec 写面（shell）与 /wiki 写不打点（journalingBackend.ts:2-4 显式降级）——卡片覆盖域 = /lab fs 工具，须在卡面或文档标注盲区。

### (c) 前端投影装饰层（不动 server）

**现状机制**：前端单管线两入口（实时 `applyEvent` / 回放 `fromProjection`，projection.ts）已持有轮次内全部工具轨迹：write/edit 的 `ToolRow.input` 是 `JSON.stringify(args)`（含路径参数，server 侧 `FILE_PATH_PARAM_NAMES` 同名单可镜像），`ToolRow.result` 的 details 含 downloadNode 下载标记（`downloadReferences` 正则已能抽取）。挂在 `run.completed` 的 `finalizeOverlay`（projection.ts:298-310）处派生卡片 = 纯前端装饰函数（形态先例：`shouldFoldTrace`/`hasTrace` 归约器与渲染层共用单一实现，projection.ts:84-92）。

**优点**：零 server 改动；实时/回放两入口天然同构（同一纯函数吃 Msg）；落在折叠外不违 GLOSSARY:156「正文与附件恒在折叠外」。
**风险/缺口**：
- **真相源错位**：卡片数据从工具轨迹**推导**，file_journal 权威账本弃用——downloadNode 校验失败（feedback_error 回喂，无 Attachment）的写、`delete` 工具（downloadNode V1 不打标，无下载引用）、input 截断（>1KB 时 `JSON.parse` 失败回退原串，路径可能取不到）都会造成漏报/错报，且无对账面。
- **知识重复**：路径参数名、op 语义、覆盖/去重（同文件多次 edit 取末次）在前端复刻一份，与 server 演进漂移（新写类工具、插件写面加入时双侧改）。
- exec 写面同样不可见（工具轨迹里 exec 只有命令文本）。

**结论**：可实现但把「权威盘点」降级为「轨迹抽样式盘点」；作为 b 的**过渡态**（先前端装饰出卡片、后续票补 server 权威数据）可行，作为终态不推荐。

## 3. 取数路径现状

### 3.1 file_journal（`server/prisma/schema.prisma:580-607`）

- 行 = 会话级全序文件操作账：`(sessionId, seq)` 全局唯一（跨 thread，teammate 并发写同序）、`(sessionId, toolCallId)` 幂等唯一；`op ∈ write|edit|delete`、`path`（normalizeFilePath 后 /lab 相对路径）、`beforeSha256`/`afterSha256`（blob 在容器 `/.attic/blobs`，attic 去重）。
- **checkpointId 锚语义**：打点时终态未定，恒记 `PENDING_CHECKPOINT_ID = ''`（values.ts:15，writer.ts:47-49）+ 带 runId；run 终态由 runService 按 `(sessionId, runId)` updateMany 回填锚点（runService.ts:1070-1079）。media 物化因晚于回填直盖 checkpointId（runService.ts:1148-1151）。**aborted/failed run 保持 pending ''**——被放弃段的操作恒可逆放（保守方向）。
- **archivedAt 软删**（#770 rewind）：checkpointId 落在被放弃路线的行打标。语义分野：**卡片是历史陈述**（「当时改了什么」），不应随事后 rewind 改写——出卡时的查询若带 `archivedAt: null` 只影响「卡即将生成」的窗口（completed 分支与本轮行无 rewind 竞态，实为防御项）；而 **rewind 预览/逆放**（反映当前 /lab 状态的面）必须过滤：preview 查询 `where: {sessionId, fileRevertedAt: null}` 后在内存做 chain 判定（preview.ts:55-59），归档行经 checkpointChain.visibleRowIds 传递挂靠。另注意 `fileRevertedAt`（已逆放处置）与 `archivedAt`（路线归档）是两个独立标记。
- **现有查询面清单**：writer 幂等键查询（writer.ts:76/:134）、seq 分配 findFirst（writer.ts:109）、终态回填 updateMany（runService.ts:1072）、rewind 面 findMany + planRevert 内存判定（service.ts:206、preview.ts:55）、reconcile pending 扫描（reconcile.ts:87/:140）、GC 引用（gc.ts:48）、覆盖审计 findFirst（writelock/overwriteAudit.ts:59）、fork 复制 tx findMany（sessions/service.ts:1049）。**尚无按 runId 的 findMany**（runId 只做 updateMany 回填键）——卡片是第一个按 runId 读的消费方。
- checkpointId 锚查询先例：fork/rewind 用 `@@index([sessionId, checkpointId])`；「轮次级」按锚查需先算 chain（checkpointChain.ts，rewind 面已封装）——按 runId 查是更直的键（回填机制就是为它建的）。

### 3.2 attachments 下载端点复用

- `GET /api/v1/attachments/:id/download`（attachments/routes.ts:72-78）：`requireAuth` + owner/admin 门（service.download，越权/不存在同码 50002 防枚举），成功裸字节 + Content-Type 透传、豁免 #312 信封。
- 建行两条既有产线：上传（POST /sessions/:id/attachments）与 agent→用户物化（downloadNode.materialize / materializeAgentMedia，均落 `path = /lab/uploads/<attachmentId>/<fileName>`）。卡片逐文件物化走第二条产线形态即可，前端零新增取数代码（MediaAttachment 组件 + `api/sessions.ts` 的 download fetch 已在用）。

### 3.3 事件目录与前端消费

- SSE 事件无 server 侧封闭枚举（`CatalogEvent.type: string`，events/logic.ts:20-26）；**事实目录 = 前端订阅清单** `EVENT_NAMES`（useEventStream.ts:33-42，26 个名字，含 `run.completed/failed/aborted/suspended`、`tool.start/tool.end`、`attachment` 等）。新增卡片事件须双侧登记（前端 addEventListener 按 name 订阅，漏登记 = 静默丢帧）。
- 前端归约：`applyEvent` 白名单分派（projection.ts:338 事件组），`attachment` 直推 media；终态四事件共用 `finalizeOverlay`。diff 渲染先例 `tool-call-diff.ts`（edit details 预算行 diff + `buildWriteDiffLines` write 全加行）——卡片若要 diff 摘要可直接复用，不必等 server 出 diff。

## 4. 推荐位与理由

**推荐 (b) runService 终态路径**（形态取 b2 正形卡片，字节面复用 attachments 下载端点），一句话：**轮次收尾的权威真相（file_journal 按 runId 的行集 + 终态锚回填）恰好在这个时点、这个文件里已经就绪，且同位已有媒体扫描这个「终态聚合 + publish + 落投影」的完整先例可照抄**。

理由展开：
1. **时机唯一正确**：只有 completed 分支同时具备「journal 行已回填锚点 + 终态判定完成 + turn/publish 通道仍打开 + run.completed 未发」四个条件；(a) 的工具级/图末挂载接不住 interrupt/abort/拓扑约束，(c) 拿不到权威账本。
2. **纪律成本已付**：「实时 ≡ 回放」的基础设施（TurnReducer → serializeAttachments → recordTurn → fromProjection）是现成管线，卡片增字段是顺势扩展而非新建面。
3. **(c) 可作为降级/过渡**：若实现排期要先出 UX，可先落前端装饰版卡片（复用 `downloadReferences`），server 权威面跟上后切换数据源——两者不互斥，但终态应归 (b)，否则「改了什么」永远以推导代替账本。

**实现票需带走的三个坑**：① 聚合查询必须剔除 `ingest-`/`media-` 前缀物化行（否则用户上传被报成本轮修改）；② 卡片事件必须先于 `run.completed` 发布（晚于终态落不进 overlay）；③ 卡片是历史陈述，archivedAt 过滤只是防御项，不要把 rewind 语义引进卡片。

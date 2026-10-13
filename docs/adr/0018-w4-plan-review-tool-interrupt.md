# ADR 0018：W4 实验方案人审——工具内 interrupt + spec 落盘短路 + ctx.lab 写面

## 状态

已接受。经 wayfinder 票 [#846](https://github.com/ACautomata/researcher-service/issues/846) 十票链定稿（#848/#850/#851/#852/#867/#868/#869 决议）+ 实现票 [#912](https://github.com/ACautomata/researcher-service/issues/912) 落地（2026-10-13），规格见 [docs/research/853-research-workflows-plugin.md](../research/853-research-workflows-plugin.md) §4.4–§5（含 §11.3 拍板记录）。#852 交接项「机制形态够格 ADR，实施期再立」的兑现。

## 背景

科研工作流插件（research）W4「实验自主设计与执行」是三调用两段式：调用①（图）产出沙箱执行规格（spec）、调用②（非图，主 agent 按规格在沙箱执行）、调用③（`phase='collect'` 图，对账产出实验报告页）。站立约束「实验 = 沙箱真实执行 + **方案整体人审**」要求调用①完成后必停等人工审批——无条件门禁，与 `users.approvalMode` 无关。

审批三层漏斗（ADR 0015 / #729）的 interrupt 通道挂在 langchain 中间件层（`request.runtime.interrupt`——框架从外层 Runtime 显式传入）。插件工具的 execute 不在中间件层，且 W4 的工具内嵌套路由图是**手动 invoke**（无 checkpointer，853 §2.2 已接受代价）——手动 invoke 内调顶层 `interrupt()` 必然抛 `No checkpointer set`。挂起点怎么落在插件工具边界，是本 ADR 的核心决策。

规格 §11.3 解读点 B 同时留了一个缺口：spec 落盘 lab 的写面形态两候选（① ctx.docs 扩 `writeSpec` / ② ctx 增 `ctx.lab.write` 窄口），选择归实现票首项。

## 决定

1. **挂点 = 工具内 interrupt，复用主 agent 图 checkpoint**。`PluginToolExec` 增可选 `interrupt: (value: unknown) => unknown` 面：`toLangChainTool` 从工具 runtime（RunnableConfig——即主 agent 图 pregel config，携带 `__pregel_checkpointer` 与 scratchpad）检测后注入闭包 `(v) => AsyncLocalStorageProviderSingleton.runWithConfig(runtime, () => interrupt(v))`——在工具栈内恢复主图 ALS 再调顶层 interrupt，`GraphInterrupt` 穿透嵌套路由图 invoke 冒泡主图挂起（checkpoint 落库，走 resolveApproval/48h suspended/审批卡既有链全链零改动）。`{execute}` 命令直达路径不经图（runtime 无 checkpointer）→ `interrupt` 缺省 = 不可挂起。
2. **命令直达路径的裁决**：`/experiment` 命令直达（executePluginToolRun，无 agent loop/无 checkpoint，853 §1.1 既有面原样）下 W4 返回 clarify 形态引导用户走 NL 路径——**无条件人审不破**（命令路径不进方案生成），零核心执行面改动、无「绕过审批」面。{execute} 契约（#752 R9）不动。
3. **幂等短路点 = spec 落盘 lab（新端口 `ctx.lab`，拍板形态②）**：写面 `/lab/specs/` 固定前缀窄口（`mkdir -p` + 单文件 tar putArchive——无 shell 转义面）、读面 `/lab/` 前缀白名单（MAX_FILE_READ_BYTES 16MiB 护栏 + NUL 嗅探，与 files 域 readLab 同口径；getArchive 直打文件路径——dockerFs.probeFile 先例）。调用①产物（design/spec/audit 三件 + deliverables.json 对账旁车）**按 round 键控**落 `/lab/specs/<slug>/r<N>/`——多轮人审的 resume 重放语义（LangGraph scratchpad 队列：每次重放消费历史 resume 值至队列末位前，末位对应新挂起点）要求历史轮产物可逐轮读回：重放历史轮（含修订轮）→ 本 round spec 已落盘 → 短路零 LLM；修订输入 = 上轮（round-1）spec + 用户理由；内容一致性 = 用户第 N 次审批卡面 spec 即 r<N> 文件，重放读回同一文件。
4. **修订历史 = LangGraph resume 队列，零额外持久化；历史轮审计跳过**：人审循环（planReview.ts）由 `interrupt()` 的返回值驱动——第 N 次调用返回第 N 个历史 resume 值（scratchpad 按序对应），轮次/拒绝理由从循环重建；escalation 载荷 id 确定性派生 `fnv1a(toolCallId|planHash|round)` 填 uuid 模板（resolveApproval 按 id 校验，重放必须稳定——funnel `escalationMemos` 先例的纯函数等价物：工具 execute 重放是新函数实例，无 per-thread 存活面可挂 memo）。interrupt 闭包按 scratchpad 判别**历史轮**（callIdx < resume.length）并随返回值上报——重放消费历史 resume 值的轮次跳过审计落行，只当前轮写——「3 轮修订 = 3 行 round 关联」（853 §5.2）在多轮重放下不破（review 修复：初版实现重放全量重跑历史修订 LLM + 重复落行 + spec 覆盖致内容错位，三约俱破）。
5. **审批审计落 `tool_approval_logs`**：批准/拒绝逐轮 `ctx.audit.recordToolApproval`（audit sink 按 run 身份自动补 traceId/runId/userId——funnel `writeAudit` 同款），`toolName='experiment_plan'` 专值、`toolCall = {planTitle, planHash, planRef, round}` 引用快照不存全文、3 轮修订 = 3 行 round 关联；写失败 fail-closed throw（审批是安全路径，审计不能丢——ADR 0015 同原则）。
6. **执行段层级正交**：方案批准不豁免执行段逐命令漏斗（方案审「做什么」，漏斗审「怎么做」）；图内 ctx.wiki/ctx.lab 程序化写入双不适用漏斗与覆盖审计的理由沿用 #852 决议（非 agent 自由裁量 + 无 journal 行套不上），零特殊化。

## 为什么

- **kind/source 复用 + 载荷扩面是既有链的最小扰动**：`kind='tool-approval'` 不动（`isApprovalInterruptPayload` 只查 kind+escalation）、`EscalationSource` 扩第五值 `'experiment-plan'`、escalation 增可选 `plan{title, summary, text, round}` 块——resolveApproval / 48h→suspended / inFlight 投影 / 前端 pending→resolving→resolved 状态机全链零改动（#852 钉），前端 PlanApprovalCard 分流（按 source）归第 7 票。
- **工具 runtime 即主图 config 是关键事实**：agent 执行把 RunnableConfig 一路传进工具 func（funnel 的 signal 提取面同源），`__pregel_checkpointer` 检测 = 「图内可挂起」的精确判别（区分 agent 路径与命令直达），`runWithConfig` 恢复 ALS 使顶层 interrupt 读到主图 scratchpad——不改 langchain/deepagents 任何一行。
- **选 ctx.lab.write（形态②）不选 ctx.docs 扩 writeSpec（形态①）**：语义正（docs = PDF 提取读面，spec 落盘是 lab 中间产物写）；写面更窄（`/lab/specs/` 固定前缀 < `/lab/` 全前缀——最小权限）；W4 写三件产物 + 修订覆盖 + collect 对账读回，与 `writeSpec` 单件名实不合。纪律复用 normalizeLabPath 同族（穿越/反斜杠/空字节/超长拒止）。
- **短路点放 spec 落盘而非内存**：工具 execute 重放 = 全新函数实例（无内存可继承）；产物状态必须落盘。spec.md 作为哨兵（audit fail 不落盘 → 重跑重新生成，fail 语义自洽）。

## 考虑过但否决的方案

- **给嵌套路由图传 checkpointer**：手动 invoke 的图非编译子图节点，嵌套 checkpoint 寻址/rewind 语义未定义（853 §2.1 选型表「子图 interrupt 冒泡」仅对编译子图成立）——否决，用 runWithConfig 直绑主图 config。
- **executePluginToolRun 造 run 级挂起（平行机制）**：48h suspended/pendingApprovalProjection/50005 发送门禁全假设图 checkpoint 面，平行机制改动面大且违背「全链零改动」——否决，命令直达直接 clarify 引导。
- **escalation id 随机 + RunService 级 memo map**：memo 需 per-thread 存活面，runService 改动态面大；确定性 id 从（toolCallId, planHash, round）派生天然稳定——否决 memo。
- **修订历史持久化（旁车落盘轮次/理由）**：LangGraph resume 队列已按序携带全部历史 resume 值，再落盘 = 双写漂移面——否决。
- **同目录覆盖式产物（初版实现）**：修订轮覆盖同目录 spec.md 使 resume 重放读回末轮内容（与用户当轮审批卡面错位）且历史修订轮无法短路（重跑 LLM）——round 键控目录否决之。
- **审计按 planHash 判重**：重放重生成的修订 spec 内容非确定（planHash 漂移），hash 判重失效——改按「历史轮跳过」判别（resume 队列位次）否决 hash 判重。
- **审计行走 ctx.audit.emitPluginRun（TextTrace）**：规格钉落 tool_approval_logs（admin 按 runId 检索同面、3 行 round 关联）——TextTrace 无结构化行语义——否决，audit port 增 `recordToolApproval` 方法。

## 后果

- **核心增量**：`PluginToolExec.interrupt` 可选面 + `PluginAuditPort.recordToolApproval` 可选方法 + `PluginLabPort`（runner/labToolPort.ts）+ `EscalationSource` 第五值 + `ApprovalEscalation.plan` 块。figure 插件零感知（可选面缺省）。
- **W4 形态**：调用①图（experiment.ts）+ 人审循环（planReview.ts）+ 调用③图（collect.ts）+ 确定性校验（experimentValidate.ts）+ plan 数据面（experimentPlan.ts）；progressStages 并集 +5（preflight/design/plan-review/collect/summarize——plan-review 为白名单内唯一非节点名值，853 §6.1 解读点 D）。
- **已知边界（V1 明示）**：interrupt 穿透「工具 func → 嵌套路由图 invoke → agent node」双层的生产行为依赖 LangGraph GraphInterrupt 穿透语义，S2 fake 测试覆盖不到——集成 smoke（真 agent 路径挂起/resume）随前端票（第 7 票）端到端验证；命令直达 W4 仅 clarify 引导（人审只在对话式会话可用）。
- **关联**：前端 PlanApprovalCard/ApprovalItem.plan 解析/resolve reason 链归 [#873·7]；idea card 页渲染增 `## Idea Card Fields` 节（openwiki 读面契约——无节页不可 readPage，W4 映射池/design 输入材料消费前提，#911 页形的兼容性补钉）。

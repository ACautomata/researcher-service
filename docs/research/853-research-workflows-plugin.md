# 853 科研工作流插件交接规格（researcher skills → LangGraph 单入口意图路由四流程插件）

> Wayfinder 票 [#853](https://github.com/ACautomata/researcher-service/issues/853)，map：[#846 researcher skills → LangGraph 单入口意图路由四流程插件（交接规格）](https://github.com/ACautomata/researcher-service/issues/846)。
> 本文档把 map 下 10 张已决票的决议汇编成一份**可直接交接给实现 effort** 的规格。
> 本规格**零新决策**：所有形状均以上游票决议原文为最终准据；凡冲突处，以上游票为准。汇编面需口径归一的解读点与票间缺口在 §11.3 显式列出，定稿评审时拍板。
> 术语以 GLOSSARY.md 为准（**意图识别 / 路由 / workflow 流程 / 实验方案人审 (plan review)** 为 #846 图随附新增词条；**单发节点 (single-shot node) / 节点内 agent 循环 (node-internal agent loop)** 为 #899 图修订随附新增词条）。「researcher 谓词/编排 skill」专指源仓库提示词工作流资产（`/Users/junran/Documents/researcher`，只读参考、禁改动），**区别于** #787 官方内容目录 skills。
> 蓝本：[752 插件契约](./752-plugin-system.md) · [744 AutoFigure 插件先例](./744-autofigure-langgraph.md) · [729 审批三层漏斗](./729-approval-funnel.md) · [723 LangGraph runtime](./723-langgraphjs-deepagents-runtime.md) · [725 OpenWiki/OKF](./725-openwiki-embedding-okf.md)。
> 路由图验证骨架：[routing-skeleton/](./routing-skeleton/)（#847，已 squash 入 master e7f8976）。
> **修订**（2026-10-10）：[wayfinder map #899](https://github.com/ACautomata/researcher-service/issues/899)（四流程节点 agent loop 化修订）定案落盘——证据链 [#900](https://github.com/ACautomata/researcher-service/issues/900) 节点盘点 / [#901](https://github.com/ACautomata/researcher-service/issues/901) 形态调研 / [#902](https://github.com/ACautomata/researcher-service/issues/902) 实测拍板 / [#903](https://github.com/ACautomata/researcher-service/issues/903) 对照实测 / [#904](https://github.com/ACautomata/researcher-service/issues/904) 定案；受动四处 = §4.3 口径注记 / §7.1 `PAGE_GENERATE_MAX_RETRIES` 触发面扩展 / §10 新增宽口径否决条目 / GLOSSARY 两词条（单发节点 · 节点内 agent 循环）。**#899 图决议并入本规格上游票链**——凡冲突处，以上游票（#846 图 + #899 图）为准；§10 否决记录只增不删。
> 状态：**定稿**（2026-10-08 评审通过；解读点 A/C/D 按文拍板，B 两候选形态经评审认可、选择归实现票首项）。**2026-10-10 修订**（#899 图 [#905](https://github.com/ACautomata/researcher-service/issues/905) 落盘，修订评审通过）：四处受动见上修订记录。

## 0. 目标形态总览

**终点产品语义**（map Destination）：以插件形式在本仓库实现 researcher 仓库 skills 描述的科研工作流——chat 会话内单一入口、入口意图识别（显式 slash 命令优先 + LLM 分类兜底）、路由至 4 条固定流程。地图走到规格定稿即止；实现另行开票。

**charting 站立约束**（2026-10-07 用户拍板，map Notes）：

1. 目的地 = 交接规格（实现另行开票）。
2. 路由互斥 + 产物串联（单请求单流程；后段经 wiki/lab 产物读前段产物）。
3. 显式 slash 命令优先 + LLM 分类兜底（复用 #787 commandResolution 接缝）。
4. 实验 = 沙箱真实执行 + 方案整体人审（升级通道）。
5. 入口 = chat 会话内（自然语言/命令触发，轨迹走会话投影 + SSE）。
6. 可信 = 证据可溯源（衔接 #789 OKF claims：论断 + evidence + fresh|drifted）。
7. 发现/假说落 wiki（页面 + claims），中间产物落 lab。
8. 实现形态 = 插件（仓库根 `plugins/<id>/` + server 注册，复用 enablement/目录面）。

```
chat 会话（deepagents 主 agent，run = 轮次）
  └─ research_workflow 工具（插件 research，category=domain，不进审批三层漏斗）
       └─ 嵌套路由图（工具 execute 内构造；纯函数工厂 + 端口注入；不进 RunService 图实例缓存）
            ├─ classify（意图识别：命令 seed 透传免分类 / NL 结构化分类）
            └─⌗ addConditionalEdges 互斥分发（恰一分支在跑）
                 ├─ ingest        W1 知识库深度构建（新写图，V1 单篇）
                 ├─ discover      W2 科学问题可信发现（extract→critic 链）
                 ├─ hypothesize   W3 科学假说自主生成（Send[]×5 桶扇出）
                 └─ experiment    W4 实验自主设计与执行（三调用两段式 + 方案人审）
       └─ 产物去向：发现/假说/实验报告落 wiki（页面 + claims），中间产物落 lab
       └─ 进度/审计：research_run.progress 落 SSE + emitPluginRun 五类落 TextTrace
```

与蓝本的关系：插件宿主形态 = figure 先例放大（#849 D1）；插件契约总形 = #752；人审闸门 = #729 审批架构的第五 source 扩展（#852）；wiki 写入 = #784 wiki 容器 + #789 OKF claims 旁车的插件消费面（#850 D3 防腐层）。

## 1. 入口与意图识别（#849 D3–D5 · #850 D2/D17 · #866）

### 1.1 工具与命令面

- **单入口工具** `research_workflow`，参数 = 结构化 schema `{workflow?, topic?, question?, source_paths[]?, phase?}`（#850 D2 钉定，否决自由 text input；`phase` 为 W4 调用③ `phase='collect'` 专用槽位，#850 调用③）。category=domain 不进三层漏斗（#752 §3；一条执行面 = 一处审计/事件族/配额）。
- **4 命令 `/ingest` `/discover` `/hypothesize` `/experiment`**：handler 返 `{execute:{tool:'research_workflow', args:{input 槽位 + workflow:'<显式值>'}}}`——`{execute}` 直达执行面（#752 R9，两条触发面一条执行面；runService.ts:832-839 既有面原样：无 agent loop / 无 checkpoint / 终态 completed / toolCallId 幂等形态沿 figcmd-\<runId\> 先例）。
- **不加第 5 个 NL 入口命令**（/research 出局，#849 D4）：命令路径无 agent loop，分类后低置信只能落拒绝文案，半残入口与「NL 直接说话」有心智歧义。
- **命令参数补全 V1 不提供**（#851 D9）：PluginCommandContext 无容器访问面列不出 /lab/uploads 文件名；体验兜底 = resolveInputs 存在性回查的错误信息列现有文件供自纠；补全面扩 ctx 留 V2。
- NL 路径 = 主 agent 经 promptSnippet/promptGuidelines 引导调用（一级自由裁量）→ 图内 classify 结构化分类（二级，§2）。input 由主 agent 组织（用户原话 + promptGuidelines 引导的上下文，#849 D4）。

### 1.2 classify 节点

- **标签集 = 5 值枚举** `ingest | discover | hypothesize | experiment | none`（前四者与四流程 1:1；`none` = 显式拒识出口，与低置信同走兜底）+ **confidence ∈ [0,1]**。schema = `withStructuredOutput(z.object({label, confidence}))`（#847 实测写法，chat_models.d.ts ZodV3Like 重载）。
- **分类输入 = 结构化请求槽位的文本序列化**（topic/question 由主 agent 组织填入；数据槽位 source_paths 归 resolveInputs 确定性校验，不进分类面）——见 §11.3 解读点 A。
- **`MIN_CONFIDENCE = 0.60`**（#866 实测定标，代码常量落 `plugins/research/values.ts`，测试锁定）：40 条中文科研 bad case × 3 轮 MiniMax M3 实测——τ≤0.55 出现坏放行（conf 0.55 错误条目放行）、τ≥0.60 坏放行归零且正确误拦最小化；正例/none 三轮全对（0.82–0.99 零抖动）；多意图条目置信天然 0.55–0.65，恰由兜底接住。
- **文本退化双保险**（#866 发现①，生产 IntentClassifier 封装必须处理）：MiniMax M3 偶发不发起 tool call → prompt 内 JSON 输出约束语句（显著缓解）+ raw 文本通道取文本 → 提取 JSON → zod 校验兜底；双保险下 120 次调用零失败。
- **裸文本指代是已知边界**（#866 发现③）：「这些问题」类高置信 none 阈值拦不住；缓解 = 主 agent 组织 input 的既有钉定（实况不会裸），评估集保留该条作边界锚点。

### 1.3 低置信兜底：clarify Result 回喂（#849 D5 · #866 §6）

- 分类 `none` 或 `confidence < MIN_CONFIDENCE` → 工具返回 `{status:'clarify', candidates, question}` 作为 content，主 agent 自然语言反问；用户回复后再次调用（可带显式 workflow）。**零新机制**——不新增 interrupt payload/resume schema/事件族。
- **两形态模板文本**（#866 §6 交付，question 面向主 agent 指令性引导，最终用户文案由主 agent 组织）：
  - 低置信（label≠none 且 conf<0.60）：`candidates` = 置信 Top-2，元素 `{label, name, fit}`（四流程目录：ingest 知识库深度构建 / discover 科学问题可信发现 / hypothesize 科学假说自主生成 / experiment 实验自主设计与执行）；`question` =「用户的请求语义不够明确。请向用户列出以下候选工作流（名称 + 适用场景），请其选择其一或补充说明需求：」
  - none（显式拒识退化形态）：`candidates = []`；`question` =「用户的请求不属于科研工作流工具支持的四个流程（知识库深度构建 / 科学问题可信发现 / 科学假说自主生成 / 实验自主设计与执行）。请如实告知用户这一点，请其改述需求，或直接在对话中回答其问题。」
- 命令路径恒带 workflow 永不触发兜底（嵌套图无 checkpointer 的限制在命令路径无影响，自洽）。
- **多意图输入**（#850 D17）：高置信选首个路由，summary 尾注「检测到后续意图 X，可继续发起」；否决多意图必 clarify（打断流）与多标签 schema（超范围）。
- **命令直达参数不全**（#850 D17）：resolveInputs 确定性诊断回喂（同 clarify 通道形态），错误信息列 /lab/uploads 现有文件。

## 2. 路由图架构（#847 · #849 D1–D2）

### 2.1 选型：单 StateGraph + addConditionalEdges

三形态对比结论（#847，全部以安装版 d.ts/源码为准）：

| 维度 | ✅ 形态 1 单图 + 条件边 | ❌ 形态 2 入口图 + 4 子图 | ❌ 形态 3 deepagents 委派 |
|---|---|---|---|
| 分支内 interrupt/resume | `state.next`/`tasks.interrupts` 判定原样命中（runService.ts:968-969）；resume = `Command({resume})` | 子图 interrupt 冒泡父图，载荷落子图 ns 行 | interruptOn 需 checkpointer |
| checkpoint 粒度 | 单 thread + ns=''，缺省寻址/rewind/recover 语义原样成立 | saver 缺省寻址不过滤 ns（prismaCheckpointSaver.ts:85-87）→ rewind/recover 需补 ns 过滤，实质改造面 | 父 checkpoint 只见 ToolMessage |
| streamEvents → 投影 | 标准 v3 事件原样透传（projector 白名单命中） | method 面不变 | 子代理事件需新做 stage 面 |
| 并行 Send | pathFn 返 `Send[]` 零结构变更 | 支持但叠 key 投影 | 不支持 |
| 「同参数必同拓扑」硬约束（graphFactory.ts:11-15） | 天然成立 | 成立但 5 编译产物 | **不成立**（LLM 自由裁量路由） |

关键事实：deepagents 1.14.1 无 teammates 概念——形态 3 的「分支」是 LLM 自由裁量，不满足「4 固定分支」确定性要求。

### 2.2 入口图终形（#849 D2）

```
START → classify →⌗ addConditionalEdges(routeByIntent) → ingest | discover | hypothesize | experiment → END
```

- **去除公共 synthesize**：路由互斥下恰一分支在跑，「归并」是骨架演示件假象；每条 workflow 以自己的产出节点自终，分支内汇总归各流程设计（§4）。
- **classify seed 透传**：state 已有 workflow（命令直达 / 主 agent 显式传 / W4 collect 调用）→ 透传不调分类器；缺省 → 调 IntentClassifier。单一 classify 入口保拓扑恒定（不为 seed 开第二 START 出口）。
- **嵌套图无 checkpointer**（已知代价，#849 D1 接受）：分支内人审闸门走工具边界拆分（W4，§5）；低置信兜底走 clarify Result 回喂（§1.3，零 interrupt 机制）。
- **`Send[]` 扇出**（fanoutGraph.ts 验证件）留给 W3 多桶并行生成。
- **宿主**：路由图在 `research_workflow` 工具 execute 内构造执行——纯函数工厂 + 全计算面端口注入（风格对齐 `plugins/autofigure/pipeline/graph.ts`）；核心零改动（不动 graphFactory/图缓存键/门禁/幂等面）；不进 RunService 图实例缓存（autofigure 同构）。
- **stage 进度出图**：节点经 `configurable.onStage` 上报（autofigure 先例）→ 翻译面落 `research_run.progress`（§6）。
- **骨架 → 生产图差异**：routing-skeleton 为验证件（literature/data/method/writing 演示标签、methodGate 演示 interrupt、synthesize 演示归并）——生产图标签集/拓扑/节点名以本规格 §1–§4 为准；Command 回写 + 条件边 + 端口注入风格沿用。

否决记录（防重开）：会话主图改造（每消息付一次分类调用、误路由敞口大、核心大改，突破「插件=能力贡献者」边界）；teammate 式独立 run（新 run kind 核心改动、低置信反问需新交互面、后台治理语义不贴对话内交互流）。

## 3. 插件契约（#851 · #849 D6 · #850 D1–D5）

### 3.1 manifest 定形

```ts
// plugins/research/manifest.ts（#851 契约终形速览）
definePlugin({
  id: 'research',                       // 显示名「科研工作流」
  run: { kind: 'research' },            // 域标识 → 事件族 research_run.*（核心按声明派生 SSE 事件名）
  tools: [research_workflow],           // 单入口工具，category=domain
  //   工具级 progressStages: readonly string[] —— 四流程节点名并集（§6.1 白名单）
  //   注册期校验：非空、值唯一、kebab/snake 形态（「插件声明、核心校验」）
  commands: [/ingest, /discover, /hypothesize, /experiment],   // {execute} 直达，无补全（§1.1）
  configSchema: { env: [{ name: 'RESEARCH_MODEL', required: false }] },
  //   单键可选模型 pin；缺省 = owner 默认链 primary（AUTOFIGURE_SVG_MODEL 先例同构）
  //   零其余 env 键：阈值=代码常量、桶档位=参数、凭证全走 owner provider 面
})
```

- 前端面 `plugins/research/web.ts` + `components/`（§6）；收录 = `plugins/index.ts` + `frontend/src/plugins/index.ts` 各一行（#752 §1）。
- 插件包依赖经 `server/src/plugins/autofigureDeps.ts` 桥 re-export（plugins 树禁裸包名 import 铁律，#791 布局钉子；Command/Send/interrupt 已在桥导出，autofigureDeps.ts:10）。
- 启用语义沿 #752 §4.2：默认未启用、目录一键启用、per-run 快照、禁用不中断进行中 run、历史回放不受影响。

### 3.2 ctx 增量六件（核心 API 增量清单）

| # | 增量 | 形状与语义 |
|---|---|---|
| 1 | **`ctx.wiki`（PluginWikiPort）** | `search(query)` / `readPage(path)`——读面复用通道① wikisearch 同款封装（openwiki searchWiki/readWikiSections 直调，SKIP 集过滤），插件与主 agent 同一套检索。`createPage(draft: PageDraft) → Promise<{created: boolean}>`——**幂等哨兵**：目标页已存在返回 `{created:false}` 不抛错（重放窗口防重复建页，幂等跳过是常态路径不进 error 通道）。**port 内 owner 级进程内锁**：key=(ownerId, relPath)，createPage 整体（probe+put+claims 渲染）在锁内，关闭并发 probe→put 竞态窗口（Docker 无 O_EXCL）；**不动 writelock registry**（#785 互斥域=沙箱 parent session，语义不贴）。**V1 无 updatePage/deletePage**（编辑已存在页=越权改用户/治理产物，语义未定不留口）。核心内组装：ensure(ownerId) 容器前置 + SKIP 集 assertNotManaged + 页内 Atomic Claims md 块核心渲染 + frontmatter 组装（§3.3）。与在飞治理 run（通道②③）共存 = base-hash 乐观并发不变——任何 wiki 写都可能使治理 run 弃回 + 冲突信箱（接受，写进规格） |
| 2 | **`ctx.docs.extractPdfText`（PluginDocsPort）** | `extractPdfText({sandboxPath}) → Promise<{pages: readonly string[]}>`。sandboxPath 强制 /lab/ 前缀白名单 + 存在性校验（approval 同款纪律）；**按页数组**返回（pdftotext 天然分页），PDF 全文不进主上下文。字符上限常量（§7 表，数值待定稿拍板）**超限明确报错不静默截断**——截断致 extract 缺节 → validate 拒 → 重试循环浪费 token。实现前提 = 沙箱镜像含 poppler-utils（核心固定 pdftotext 命令、沙箱内执行；GLOSSARY 沙箱词条工具链已列 poppler，实施列为镜像验收项）。**仅此窄域端口，无通用 exec/fs 透传**（#752 已钉） |
| 3 | **`ctx.llm.generateStructured`** | `({schema, contents, model?, maxTokens?, temperature?}) → zod 校验产物`。withStructuredOutput 语义封装在核心、走 owner 回退链 + 白名单第二层复验（#792「llm 回退链封装在核心」延伸）；IntentClassifier 端口构造其上；四流程内部节点（challenge/critic/audit 判定 schema）同受益。否决：插件直用 ProviderRegistry；generateMultimodal 出 JSON 自行解析 |
| 4 | **`PluginRunFrame.signal`** | frame 增 `signal: AbortSignal`（RunService 构造 frame 时放入，源 = run abort 传播链）；核心 llm port 实现闭包捕获自动传给底层 invoke。`generateMultimodal`/`generateStructured` **签名不出现 signal**——插件零感知、结构性防忘传（W3 扇出下「忘传 = abort 后继续烧钱」代价放大 5–8 倍）。**顺带修复 autofigure 现状缺口**（abort 后照跑照计费）。per-call 定制 signal 组合留 V2 |
| 5 | **`ctx.audit.emitPluginRun` 泛化** | `emitFigureRun` → 中性 `emitPluginRun({event, toolCallId, detail})`，五类枚举 created/stage_transitions/completed/failed/aborted 同构保留；**runKind 由核心按工具名反查盖章**（翻译面已查所属插件，插件不传），落 TextTrace 带 runKind 列。figure 现状事件面零改动（其 kind 隐含 'figure'，迁移不做）。否决 `plugin_run.*` 泛化统一事件名（破坏双先例） |
| 6 | **onUpdate 翻译面泛化（progressStages）** | runner 翻译面按「toolCallId→工具名→所属插件」查 manifest 声明的 progressStages 白名单，**命中才落 SSE + TextTrace 双面**；白名单外丢弃不放大（对齐 projector「多出的不进投影」纪律）。现状 figure 六值白名单会静默丢弃 research 的 stage 上报——本机制为泛化解法（第三个域插件零核心改动）。通用 `tool.progress` 事件仍留 V2 |

DTO（#850 D3 / #851 D6）：

```ts
interface PageDraft { path: string; title: string; type: PageType; content: string; claims?: ClaimDraft[] }
interface ClaimDraft { statement: string; evidence: string[] }
```

- **claims 结构化提交、表示归 wiki 域**：图内 zod 校验 ClaimDraft[] → port 提交 → 核心 V1 渲染为页内 Atomic Claims md 块（人读面 + 检索面可溯源）；机器 `.claims` 旁车 = 核心内部演进，**插件不知道 .claims 存在**（防腐钉界）。
- 治理再生（通道②③）保持异步，workflow 不同步调用（否决 .claims 直写与 lifecycle submit_page 同步调用，V2 重评）。
- `PageType` 枚举值集见 §11.3 待拍板项 B。

### 3.3 frontmatter = 核心组装产出（#851 D11 · #868 D2）

- 插件只给 PageDraft 元数据（path/title/type），**frontmatter 由核心组装时拼装**：title/type + OKF 徽章（status=generated / stale_after / generated 时间戳，#789 徽章面直接有数据）+ 溯源字段（source=research / toolCallId / workflow）+ **`related_pages`**（W4 报告页记输入页集：论文页/critic 页/idea card 页，#868 D2）。建议字段集见 §11.3 待拍板项 C。
- 页格式单源：四流程建页格式一致（防四套模板四个样），插件零格式知识。否决插件 content 内嵌 frontmatter（格式漂移面）；否决 V1 裸 md（#789 徽章面缺位）。

## 4. 四条 workflow 图内设计（#850 · #848 · #868 修订）

四流程共享横切机制（#850 D1–D6）：**resolveInputs 确定性首节点**（路径前缀白名单 + 存在性回查，幻觉路径确定性拒绝回喂）；**证据闸门两档**（形状档 zod 全流程必备 + 存在性档 evidence 引用回查，剔除清单必进 summary——剔除本身就是溯源信息）；**模型治理** = RESEARCH_MODEL 面板级 pin 可选 + 缺省 owner 默认链（「回退链致同图多模型」列已知边界）；进度/审计泛化见 §3.2/§6。rejected 卡与单桶失败记录落审计域（TextTrace）+ summary 摘要，不落 wiki/lab。

**产品定义**（#850 D14 核心）：固定的是**骨架时序**（设计→规格→人审→执行→收集→落盘），不是执行段内部行为——执行段是 agent 解释 spec，忠实性靠 spec 结构化 + 人审闸门 + collect 对账三件套。

### 4.1 W1 ingest 知识库深度构建（新写图）

```
capture → extract → create → validate ─┐ 不过→回 create 重试 1 次
 (确定性)  (ctx.docs) (LLM 11节) (确定性) │
    ↓                ←───────────────────┘
 persist → verify → summary
 (幂等哨兵) (回读哈希)  (≤1k)
```

| 节点 | 职责 | 关键规则 |
|---|---|---|
| capture | PDF ∈ /lab/uploads 前缀 + 存在性 | **URL 来源 V1 不收（明示降级）** |
| extract | ctx.docs.extractPdfText 取页数组 | 超限报错（§3.2） |
| create | 11 节论文页 LLM 生成 | prompt 注入对标 officialContent 两段式 |
| validate | 确定性校验 | 11 节标题齐全 / frontmatter 必填 / ≥100 行 / Results 含具体数字；不过 → 回 create 重试 1 次（附诊断） |
| persist | 经 wiki 写 port | 幂等哨兵（FileExists = 重放窗口防重复建页） |
| verify | 回读哈希对账 | 确定性 |
| summary | 工具 content | ≤1k + 产物路径 |

- **V1 单篇**（一次调用一篇）；批量 Send[]+fan-in 串行 persist 留 V2（写锁/索引竞态未解）。
- **显式砍掉**：index/log 维护（SKIP_FILES 黑名单冲突，面板树是派生视图——显式砍非绕）；staged md 中间态（图状态下天然消解）。
- prompt 资产（#848 §1）：11 节论文页模板 + frontmatter schema + Experiments/Results 最低标准（「≥100 行、Results 含数字、frontmatter 必填」做确定性校验）；wiki-conventions（命名/链接/矛盾约定，kebab-case 等做确定性检查）。完整模板与填写规则以 #848 决议 §1 为单一来源。

### 4.2 W2 discover 科学问题可信发现（单论文 extract→critic 链）

钉界：跨论文 gap 发现归 W3 contextPack；忠实 #848 ②。

```
resolveInputs → load → extract → validate¹ → critic → validate² → evidenceGate → persist → summary
 (论文页存在，       (12 节)   (三态禁语+    (§0–§7)  (候选 2–4 +   (引用存在性     (critic 页)
  缺→clarify 提示先 ingest——产物串联)    节checklist)        category标签)  回查)
```

- **两个 validate 检查对象不同，分列不共享 schema 名**：validate¹ 针对 extract 12 节（节标题 checklist + 三态标注禁语扫描——禁「可能是/应该是/推测为」，强制「论文中未明确说明」类规范用语）；validate² 针对 critic §0–§7（节齐全 + `category: critic` 机读标签 + 候选问题 2–4 个）。
- evidenceGate：evidence 引用的 wiki 页/章节/上传件路径存在性回查；剔除条目清单必进 summary。
- prompt 资产（#848 §2）：extract 12 节模板 + 三态标注规则（「论文报告/间接观察/未提供」——问题发现可信度的证据底座）；critic §0–§7 模板 + 审稿式质疑 9 类型 + 证据强度三档（较强证据/间接暗示/仍需验证）+ `category: critic` 机读标签。节结构：extract = ##0 定位/##1 实验目标/##2 实验设置总览[2.1–2.5]/##3 主结果/##4 消融/##5 参数敏感性/##6 效率复杂度/##7 鲁棒性泛化/##8 实验现象 3–6/##9 证据充分性/##10 后续问题价值/##11 总结；critic = §0 定位/§1 方法机制与前提/§2 贡献声明与质疑[3–5 claim]/§3 问题分析/§4 验证候选问题 2–4/§5 研究空缺/§6 回写建议/§7 结论。完整填写规则以 #848 §2 为单一来源。**critic §4 候选问题列表 = critic→design 的边上传输 schema（带优先级）**。

### 4.3 W3 hypothesize 科学假说自主生成（Send[] 扇出）

否决 teammate 常驻协作：一次性生成语义足够；源 brainstorm 桶本就无自检索（pre-flight 检索是 main 的活）——Send 非损失是保真。

```
resolveInputs → contextPack ──→⌗ Send[]×5 → bucket×N → dedup → challenge → validate → persist → summary
 (论文页路径)    (检索+brief；     (固定桶)   (LLM；节点内  (纯函数) (LLM 顺序  (idea_cards (survived
                 证据不足→END+clarify)       catch 降级)           逐卡)    TS 化)      整批)
```

| 决策点 | 定形 |
|---|---|
| 桶档位（#850 D11） | **5 固定**（gap/contradiction/failure/transfer/constraint）+ **3 opt-in**（ablation/metric/assumption-challenge，仅经参数显式追加——非 LLM 自由裁量）；`BUCKETS_MAX = 8` cap（#869 D7） |
| contextPack | 集中检索 + Brief 10 字段（research_topic/target_task/current_baseline/available_data/available_code/available_compute/preferred_metrics/hard_constraints/known_failures/desired_risk_level，字段缺失不阻塞写 ASSUMPTION 继续）；**证据不足 → END+clarify**（复用低置信机制，不生成泛化 idea）。预算 `CONTEXT_PACK_BUDGET_TOKENS = 16000` 构建时裁一次：evidence 按证据等级降序 + 页级节选（非全文）+ Brief 恒保全；Send[] 分发全量拷贝不分桶裁（#869 D3）；「证据不足」判定在裁剪后；换算口径复用 JUDGE_CHARS_PER_TOKEN=2 |
| bucket | 每桶 LLM 生成 1–3 张候选卡；**节点内 catch 降级**：单桶失败 → `{bucket, error}` 记录不阻断其余桶（源容错语义，#850 D12） |
| dedup | idea_dedup 纯函数（键 = (norm(title), norm(mechanism), norm(minimum_experiment))，同键保留 evidence_chain 总长更长者）；**语义去重并入 challenge 输入**（challenge 前合并——#848 只覆盖机制去重，此处补钉） |
| challenge | 顺序逐卡 LLM：`challenge / verdict: rejected|survived / verdict_reason` schema；只有使核心假设/可行性/可检验性不成立的具体反驳才是 rejected（笼统不确定性不是）；基于 Context Pack |
| validate | validate_idea_cards.py → **TS/zod 全规则迁移**（#848 §3.3）：14 必填、evidence_chain 空须 low-confidence、anchor_sources 1–4 个 + 泛化锚黑名单（GENERIC_ANCHOR_TERMS/FRAGMENTS + CONCRETE_ANCHOR_MARKERS 判据）、target_problem ≥30 字符 + 痛点具体度 marker、wiki 源锚须 wiki_writeback、minimum_experiment <20 字符 warning |
| persist | survived 整批先生成再逐页写；**非原子风险 V1 明示接受**（幂等哨兵使重跑可续）；无 survived 时不写 wiki、回复全部淘汰原因 |

- **W3 调用上界**：classify 1 + 桶 ≤8 + challenge 逐卡 ≤24 + summary ≈ **≤35 次 LLM/run**（固定拓扑天然有界，#869 D4）。口径注记（#899 图 #904 澄清，非变更）：**≤35 = 固定拓扑节点调用数**——`PAGE_GENERATE_MAX_RETRIES` 兜底重试不改变拓扑计数口径（#869 本就是节点数推导；且 W3 的 LLM 节点不在长页生成五节点重试覆盖面〔§7.1〕内，触发面扩展对 W3 调用数零影响）。
- prompt 资产（#848 §3）：Brief 模板 10 字段、Idea Card 15 字段（idea_id/title/one_sentence_hypothesis/anchor_sources/target_problem/mechanism/paper_insight_or_limitation/evidence_chain/minimum_experiment/expected_metric_change/implementation_scope/risks/confidence/recommendation_reason/wiki_writeback——锚含 wiki 源时必填）、7 种生成策略（按桶注入对应策略段）、质量检查清单（output-spec）。完整填写规则以 #848 §3 为单一来源。

### 4.4 W4 experiment 实验自主设计与执行（三调用两段式）

执行段 = 主 agent（agent loop），人审闸门落在工具边界（#849 D7 落位）：

```
调用① (图)：resolveInputs → preflight → design → validate¹ → spec → validate² → audit → summary
            (critic 页∨idea (材料清单； (10 节) (映射校验  (9 段最小  (占位符  (①②④确定性+ (spec 路径+
             card 页至少其一， 缺失→clarify       泛化，     改+交付物  未填充)  ③⑤⑥ LLM；   awaiting_review)
             #868 修订)      列缺失清单)          §4.4注)   声明)              必须修复项非空→fail)

调用② (非图)：主 agent 按规格在沙箱执行——用户明示后；exec 漏斗逐命令生效；轨迹可见；
              每次 bash 可自然插审批；长命令 nohup 后台化（§7）

调用③ (图，phase='collect')：collect → summarize → validate → persist → summary
                            (确定性：结果文件解析 + 与 spec 交付物声明对账) (LLM 实验报告页落 wiki)
```

- **preflight**（#850 D16 + #868 D2 修订）：从「critic 页存在」放宽为「**critic 页或 idea card 页至少其一**」；材料缺失 → 缺失清单 + clarify（用户/主 agent 准备后重跑，幂等哨兵使重跑便宜）。resolveInputs 接受 idea card 页路径（source_paths 前缀白名单 + 存在性回查照常）。否决执行段自行 clone（0 信任面扩大 + 半截失败难对账）与图内获取节点（需通用网络/exec 面）。
- **design**：10 节（##0 定位/##1 验证目标总览 3–6 条/##2 设计原则/##3 核心验证实验 3–6 个/##4 可选补充 2–4 个/##5 优先级排序/##6 最优先 3 个/##7 后续方向/##8 总结/##9 输出要求）。validate¹ = **映射校验泛化**（#868 D3）：每实验至少映射 **critic §4 候选问题 ∨ idea card minimum_experiment** 之一，双输入时允许双映射；design 模板措辞改「服务一个明确的验证目标（critic 问题或假说）」。否决 idea card 输入豁免映射校验（假说驱动路径恰是最需忠实性校验的路径）。
- **spec**：9 段结构保留（任务背景/可用输入材料/方法与验证目标/优先实验[对齐 design ##6 top-3]/总体实现要求/建议查看代码位置/交付内容/完成标准/汇报格式）；**三处再语义化**（#850 D15）：标题「发给 claude-code」→「沙箱执行规格」、占位符指向沙箱路径、汇报格式 → collect 输入约定；**新增结构化交付物声明**（文件路径清单 + 每件成功判据）——collect 确定性对账的消费面。占位符约定保留（缺失信息显式占位而非编造——自主执行无人可问）。**DROP 外发 claude-code hand-off**（#850 用户明确：执行收敛进沙箱，spec 产物仅供人审与执行参考）。validate² = 占位符未填充检查。
- **audit 节点**：#848 六维中 **①②④ 确定性化**（节标题 checklist / 字段非空 / 禁语扫描）+ **③⑤⑥ LLM**（边界遵守/证据分级/跨阶段一致性）；「必须修复 vs 建议改进」= severity 二值（blocking/non-blocking）；**必须修复项非空 → 该调用 fail**（不进人审）。
- **调用③ collect**：确定性对账（结果文件 ↔ spec 交付物声明）→ summarize（LLM 实验报告页）→ validate → persist（报告页落 wiki，frontmatter `related_pages` 记输入页集）→ summary。报告页正文增「**关联页面**」节放 markdown 相对链接（链接目标 = resolveInputs 输入页集，确定性可得）→ #789 story 43 graph 派生边，WikiGraph 可见关联（#868 D4）。idea card 页自身 V1 不动，graph 边单向从报告页指出。
- **stage 序列（W4）**：design→plan-review→executing→collecting（#852）；人审挂起 = stage 停 plan-review + `approval.requested`（SSE 面）；stage_transitions 记进出（修订轮不发新 stage，detail 带轮次）。与节点名白名单的口径归一见 §11.3 解读点 D。
- prompt 资产（#848 §4）：design 10 节模板 + 实验设计准则 + 11 类推荐实验类型 +「每个实验必须明确」清单；spec 9 段 + 占位符清单；audit 6 维 + 阶段边界禁止清单（各节点 prompt 负约束）+ 审计报告 7 节。完整填写规则以 #848 §4 为单一来源。

## 5. 实验方案人审与审批审计（#852）

### 5.1 门禁机制

- **触发语义：流程内置无条件门禁**——W4 design 段完成后必停等审，与 `users.approvalMode` 无关（谨慎模式只作用于执行段灰区命令）。站立约束「方案整体人审」是人审承诺，不是可配置护栏。
- **挂点与机制（内聚插件图）**：人审闸门在 `research_workflow` 工具 execute 层（W4 分支）：spec 落盘 lab = **幂等短路点**（LangGraph 工具内 interrupt 的 resume 重放会从头执行工具函数，spec 已落盘则跳过 design LLM 直达 interrupt 点）→ `interrupt({kind:'tool-approval', source:'experiment-plan', escalation:{plan}})`。
- **契约增量（全链最小改动）**：`kind` 不动（`APPROVAL_INTERRUPT_KIND='tool-approval'`，approval/values.ts 既有常量）；`EscalationSource` 扩第五值 **`'experiment-plan'`**（values.ts:126 四值枚举扩值）；escalation 增可选 **`plan {title, summary, text, round}`** 块（全文内联几 KB 载荷；`round` 为 #867 钉的唯一新增契约面）——resolveApproval / 48h→suspended / inFlight 投影 / 前端 pending→resolving→resolved 状态机全链零改动。actionRequests = 空数组（批准对象是方案不是调用）。
- **呈现 = 审批卡路（否决 NL 确认）**：NL 确认无结构化记录、无超时、无多端同形卡、发送门禁不生效，与「升级通道」定性不符。复用 `approval.requested/resolved` 事件族与 ApprovalCard 骨架。
- **decision 语义**：`approve`（可选附言——落审计、不触发重跑、随 resume 值作为执行注意事项传达）/ `deny`（**必填理由 ≤2000**——server 回发 schema 已支持，validation/schemas.ts:218，前端未传需补）。修订 = 回 design 节点**修订模式**（输入 = 上轮 spec + 用户理由），复用 design 节点零新图节点。**上限 3 轮**（`PAGE_GENERATE_MAX_RETRIES` 之外的独立常量，卡显轮次，第 2/3 轮「最后一轮」提示）。
- **超限终局**：第 3 轮 deny → 工具返回 `{status:'plan_review_exhausted', lastReason}`，主 agent 向用户说明后 run 正常 completed（**非 failed**，errorKind 三分类不动——人审不通过是终局分支不是故障归因）；spec 停留 lab。
- **approve 后执行段自动续跑**：resume 语义天然——工具 return「已批准 + spec 引用 + 附言」→ 主 agent 同一 run 内继续发起执行段；promptSnippet 约定「批准后立即执行」。
- **挂起门禁**：方案卡 pending 期发送门禁复用 leader 卡 50005 链（修订走卡不走新消息）；48h 超时 → suspended 复用（resume 后卡重现，spec 短路保证零 LLM 重调）。

### 5.2 与漏斗及审计的关系

- **`research_workflow` 本身 category=domain 不进漏斗**（funnel.ts:248 domain 直通、零审计行）；**入口免审 + 执行段全审，组合安全面无洞**。
- **W4 执行段主 agent 的 exec/file 调用照常过漏斗**（funnel.ts:250-281 通路已全通，零新代码）：standard 模式灰区 judge 自动判，仅 cautious / judge 超 20 / 同 hash 拒 3 弹人工。
- **图内程序化写入双不适用（规格写明理由防后人误加）**：ctx.wiki port 写 wiki、ctx.docs.extractPdfText 读 PDF 是图内确定性调用、不走工具调用面——(1) **不进漏斗**（非 agent 自由裁量；createPage 幂等哨兵 + frontmatter 溯源已治理）；(2) **不触 file-overwrite-logs**（其挂在沙箱 backend write/edit/delete + putArchive，靠 file_journal 行检测 write-after-write——wiki 直写无 journal 行套不上；overwriteAudit 是 fail-soft 观测面非安全闸，V1 不为 wiki 直写开覆盖审计）。
- **W4 执行段沙箱写文件照常走锁 + journal + 覆盖审计，零特殊化。**
- **方案人审落 `tool_approval_logs`**：layer=human、decision allow/deny、toolName **专值 `'experiment_plan'`**（流程门禁特例行，避免与真实工具混淆）、toolCall = 引用快照 `{planTitle, planHash, planRef, round}` 不存全文（729 §4.2 控体积口径）、reason = 用户附言/拒绝理由。3 轮修订 = 3 行，round 字段关联。**执行段命令行照常落**（与普通会话命令无异，方案关联靠 runId），**不加 runKind 列**（admin 检索按 runId 已够，729 表结构不动）。
- **层级正交**：方案批准不豁免执行段逐命令漏斗——方案审科学内容（「做什么」），漏斗审系统安全（「怎么做」）；执行段 LLM 仍可能偏离方案自由发挥命令，漏斗是兜底。
- 机制形态（工具内 interrupt + spec 落盘短路 + kind/source 复用）够格 ADR，**实施期再立**。

## 6. 事件族与前端呈现（#851 D5/D8/D12 · #867）

### 6.1 事件族 `research_run.*`

| 事件 | 面 | 载荷/说明 |
|---|---|---|
| `research_run.progress` | SSE 用户面 | `{toolCallId, stage, workflow}`；stage = 裸节点名 + payload 带 workflow 字段 |
| `research_run.created` / `.stage_transitions` / `.completed` / `.failed` / `.aborted` | 审计（TextTrace，runKind='research' 核心盖章） | emitPluginRun 五类同构；stage_transitions 与 progress 同一事实两面的审计面 |

**stage 白名单 = 四流程节点名并集（22 值，注册期从图拓扑推导校验 + 测试锁定）**：

- W1：capture / extract / create / validate / persist / verify / summary
- W2：resolveInputs / load / extract / validate / critic / evidenceGate / persist / summary
- W3：resolveInputs / contextPack / bucket / dedup / challenge / validate / persist / summary
- W4：resolveInputs / preflight / design / spec / audit / plan-review / summary + collect 段（collect / summarize / validate / persist / summary）

跨流程重名（validate×4、persist/summary/resolveInputs×3）在 workflow 字段语境下无歧义。**plan-review 是白名单内唯一非节点名值**（W4 人审挂起期专用，#852）；`executing`/`collecting` 为 W4 流程级阶段描述，不进白名单（调用②非插件工具无 progress 事件；调用③ stage 走 collect 段节点名）——口径归一记录见 §11.3 解读点 D。

### 6.2 前端呈现（#867 定形）

- **ResearchRunCard**（`plugins/research/web.ts` + `components/ResearchRunCard.vue`，autofigure 同款布局）：
  - **进行态 = 单行双段徽标**「workflow 中文名 · stage 中文名」（如「假说生成 · 分桶生成中…」）；组件持 workflow→{stage→中文} label 字典（**不持拓扑序列**），未知 stage 值 fallback 裸名。**否决 FigureCard 式线性阶段条**（W3 Send[]×5 并行扇出下「✓ 已完成」失真；4 套硬编码节点序列与图拓扑演进对冲）。progress 未到 = 通用文案「工作流运行中…」。
  - **终态 status 四值面**：`completed`（✓ + artifactPages 深链清单 + summary 经 MarkdownRenderer 渲染）/ `clarify`（提示条 + 候选或缺失清单，**纯展示**——插件组件 props-in 无发送通道，重发走自然语言）/ `approved`（W4 调用① 终态，spec 路径由 summary 文本承载，不加 details 字段）/ `plan_review_exhausted`（⚠ 3 轮未通过 + lastReason 展示；run completed 非错误面）。failed 走 ToolRow state='error' 通用错误面不入 status 值域。
  - **details 形状（#851 D12 契约一部分）**：`{workflow, status, artifactPages: [{path, title}], summary?, clarify?}`——引用形态不内联页内容（R6 事实同源不变量：卡面结论性事实 ⊆ content；content = summary ≤1k + 产物路径清单 + clarify 回喂形态）。
  - **artifactPages 深链**：`<a target="_blank" rel="noopener" href="/wiki?path=<encodeURIComponent(path)>">`（标题+路径两行）；**WikiView 增 query.path 消费**（onMounted 首容器选定后 openPage(query.path)；owner 下容器共享 wiki 容器，深链无需 container 参数）。
- **W4 两态**：`awaiting_review` = 调用① running + stage='plan-review'：徽标「实验 · 方案待审批」+ 卡内提示条引导 dock（工具行与审批卡两处分离）；collect 调用③ = phase 徽标「结果对账」（phase 从 tool.start input.phase 推）；**调用②（主 agent 沙箱执行段）非插件工具——bash/file 默认工具行现状不变**。
- **PlanApprovalCard**（ApprovalDock 按 `source==='experiment-plan'` 分流的专用子组件；其余四 source 仍 ApprovalCard 原样）：
  - 卡内容：标题「实验方案待审批」+ 轮次徽标「第 N/3 轮」（第 2/3 轮加「最后一轮」提示）+ plan.title + plan.summary + ▾ 方案全文折叠区（**plan.text 经 MarkdownRenderer 渲染**——spec 9 段结构化文档，plain \<pre\> 不可读）；plan.text 单卡 ≤几 KB 内联，无独立拉取面。
  - 交互：[批准并执行] 直点（可选附言经「添加附言」展开输入）/ [拒绝并说明理由] 点击滑出必填理由框 ≤2000 字、空理由禁提交 + [确认拒绝][返回]。**理由/附言输入仅限方案卡**（漏斗卡四 source 保持两键——deny 理由无消费面，不回喂 agent）。
  - **ApprovalItem 增 `plan?: {title, summary, text, round}`**（approvalCardFields 0 信任逐字段解析）；resolve 链补 reason（emit → useChatSession → resolveSessionApproval body 增 reason；server schema 已支持零改动）。
- **投影归约**：projection.ts 增 `research_run.progress` 归约分支，stage 值**透传不设前端白名单**（server manifest 声明白名单已是唯一关卡；回放路径不构造 stage，tool.end 与 run 终态剥落语义不变）；figure 现状白名单保留不动；组件侧类型锁 + 未知值 fallback。单管线约束不破（#730 验收：流式终态 ≡ 刷新回放）。

**前端接线清单（#867 影响）**：① `plugins/research/web.ts` + ResearchRunCard.vue + frontend/src/plugins/index.ts 收录行；② projection.ts 透传归约分支；③ useEventStream EVENT_NAMES 增订阅；④ ApprovalItem.plan 字段 + approvalCardFields 解析 + ApprovalDock 分流 PlanApprovalCard；⑤ resolve reason 参数链；⑥ WikiView query.path 消费。server 配套 = escalation.plan 增 round（唯一新增契约面）。

## 7. 运行时配额与常量（#869）

### 7.1 常量表（落 `plugins/research/values.ts`，对齐 `plugins/autofigure/pipeline/values.ts` 先例）

| 常量 | 值 | 语义 |
|---|---|---|
| `MIN_CONFIDENCE` | 0.60 | 意图分类放行阈值（#866 实测定标，§1.2） |
| `CONTEXT_PACK_BUDGET_TOKENS` | 16000 | W3 contextPack 预算，构建时裁一次（2 chars/token 口径 ≈32k 中文字符；judge 8k 的 2 倍——多页引用场景） |
| `PAGE_OUTPUT_MAX_TOKENS` | 32000 | 长页输出单次生成上限，盖五节点：W1 create / W2 extract+critic / W4 design+spec；经 generateStructured 既有 maxTokens 参数传入。否决对齐 autofigure 50k（超多数 provider output cap）；否决两过式分段生成 |
| `PAGE_GENERATE_MAX_RETRIES` | 1 | 生成兜底重试（#899 图 #904 修订：触发面扩展，值与覆盖面不动）：**截断 ∨ 结构化解析/validate 失败**（finish_reason=length 检出 / generateStructured zod 解析不过 / 确定性校验拒）→ 回生成节点重试 1 次，重试 prompt 附对应诊断回喂；覆盖面维持长页生成五节点（W1 create / W2 extract+critic / W4 design+spec）。边界：无工具面、无 LLM 自由裁量、K≤2 有界（初次生成 + 至多一次修复）、输入不变无检索——只纠格式不改生成语义（#850「一次性生成语义足够」不被触及），系既有截断重试先例的触发面泛化、非新形态（critic gate 56%→100% 实测归因 =「单发 + 至多一次协议修复」，#903/#904） |
| `BUCKETS_MAX` | 8 | W3 扇出 cap（参数缺省 5 固定 + 3 opt-in） |
| `PDF_EXTRACT_MAX_CHARS` | 待定稿拍板（量级 ~1M chars，#851 D10） | extractPdfText 字符上限，超限报错不静默截断 |
| `PLAN_REVIEW_MAX_ROUNDS` | 3 | W4 方案人审修订上限（#852） |

测试锁定对标 approval 先例两层：纯逻辑导入常量断言（contextPack 裁剪顺序/Brief 保全/maxTokens 传递）+ 字面数字行为锁定（拓扑上界断言、validate 重试边界）。

### 7.2 配额与边界

- **并发 = 复用 per-user maxConcurrentRuns，不开第二套**：research_workflow 与 4 命令 {execute} 随调用方会话 run 占既有名额（figure 三重先例：concurrency.ts:14-15 注释 + 744 §5.4 + GLOSSARY figure run 条目），零核心并发改动；W3 Send[]×5–8 = 单次 execute 内图内并行不占名额，瞬时 5–8 路 LLM 并发接受（桶数 ≤8 天然上限）。
- **V1 零超时面**：不设插件图 wall-clock 超时、LLM 调用层不加 timeout、run 级不新增总时长上限。provider hang 止损 = 用户 abort（signal 自动透传，§3.2#4）；进度流缓解 hang 感知。**已知边界入规格**：hang 无自动止损、abort 是唯一停机面；V2 候选 = ProviderRegistry 默认 timeout（顺带修 figure/主 agent 同款缺口）。
- **W3 扇出总成本不设硬闸**：usage.ts 采数审计（既有）+ 调用上界由固定拓扑推导（≤35 次 LLM/run，§4.3）+ abort 即时止损。否决图内调用计数硬上限（装饰性护栏）与 run 级 token 硬顶（usage 是事后核算非执行面闸门）。
- **W4 执行段**：`EXEC_DEFAULT_TIMEOUT_MS = 120s`（runner/backend/values.ts:15）全局不动（防单命令楔死回合）；**spec 模板「执行指引」节写明「长命令必须 nohup 后台 + 轮询日志/文件哨兵」**（agent 直跑长命令 → exit 124 stderr 自然反馈，agent 自适应改后台）；执行段整体不另立时长上限（run 域统一护栏已构成：用户 abort / 审批 48h suspended / recursion limit 500 / 单命令 120s）。否决 exec timeout 延长档与调大全局 120s。
- **边界注记**（#869）：W2 输入 = 单论文页天然有界不设输入预算；W4 collect 输入走 read 面既有 `MAX_FILE_READ_BYTES=16MiB` 护栏；classify 输入天然短。
- **核心小改交接项**：`truncateToTokenBudget` + `JUDGE_CHARS_PER_TOKEN` 从 `approval/judge.ts`（:14,:47-49）提取为共享 util——两消费者（judge + research contextPack）= 提取时机；judge 行为零改动，测试随迁。

## 8. 核心增量汇总与实施拆分

### 8.1 核心侧改动汇总

| 面 | 增量 | 消费方 |
|---|---|---|
| `plugins/api.ts` 契约 | PluginToolDefinition.progressStages（注册期校验）· manifest.run.kind · PluginRunFrame.signal · ctx.wiki/ctx.docs 类型面 | research + 后续域插件 |
| runner 翻译面 | progressStages 白名单查表 → SSE + TextTrace 双面；runKind 按工具名反查盖章 | research_run.* 事件族 |
| audit port | emitFigureRun → emitPluginRun 泛化（五类同构） | figure 零改动兼容 + research |
| ctx.llm | generateStructured（回退链 + 白名单复验 + frame signal 闭包捕获） | classify + 四流程 LLM 节点；顺带修 autofigure abort 计费缺口 |
| ctx.wiki | PluginWikiPort（search/readPage/createPage 幂等哨兵 + owner 级锁 + claims 渲染 + frontmatter 组装 + ensure 前置） | 四流程 persist；W4 spec 落盘面见 §11.3 缺口 B |
| ctx.docs | PluginDocsPort（extractPdfText：/lab 白名单 + poppler + 超限报错） | W1/W2 extract |
| approval | EscalationSource 扩 `'experiment-plan'` + escalation.plan{title,summary,text,round}；tool_approval_logs 专值 toolName='experiment_plan' | W4 人审 |
| 共享 util | truncateToTokenBudget/JUDGE_CHARS_PER_TOKEN 迁出 judge.ts | contextPack 裁剪 |
| 沙箱镜像 | poppler-utils 验收项（GLOSSARY 工具链已含）+ timeout applet（已有） | extractPdfText + 执行段 |
| 前端 | §6 接线清单六处 + escalation.plan round 解析 | ResearchRunCard/PlanApprovalCard/WikiView |

### 8.2 实施拆分草案（7 票；对齐 744 §10 先例——**开票与打 ready-for-agent 等用户指令**）

1. **核心 API 增量**：progressStages + run.kind + PluginRunFrame.signal + emitPluginRun 泛化 + generateStructured + token util 迁出（含 autofigure abort 顺带修）。纯逻辑先行，产物可直接落最终家。
2. **ctx wiki/docs port**：PluginWikiPort（幂等哨兵 + owner 锁 + claims 渲染 + frontmatter 组装）+ PluginDocsPort（extractPdfText）。依赖 1 的类型面。
3. **插件骨架 + 路由图**：manifest + research_workflow 工具 + 入口图（classify/条件边/seed 透传/clarify）+ 4 命令 + values.ts。依赖 1–2。
4. **W1 + W2 图**：ingest + discover 节点链 + prompt 模板资产（#848 §1–§2）。依赖 3。
5. **W3 图**：扇出 + contextPack + dedup + challenge + idea card validate TS 化（#848 §3 规则全集）。依赖 3。
6. **W4 图 + 人审**：三调用两段式 + 审批卡路接线（escalation.source/plan/round + spec 短路点 + toolName='experiment_plan' 审计行）+ ADR 立档。依赖 3。
7. **前端**：ResearchRunCard + PlanApprovalCard + 投影归约 + useEventStream 订阅 + resolve reason 链 + WikiView 深链。依赖 6（契约齐）。

## 9. 测试策略（沿 #747 四层定稿）

- **S3 纯逻辑**（vitest）：
  - 路由图：routeByIntent 纯状态派生 / seed 透传不调分类器 / 阈值判定（conf<0.60 或 none → clarify 形状）/ 条件边互斥性。
  - 确定性校验节点逐清单锁定：W1 validate（11 节/≥100 行/Results 数字）、W2 validate¹（三态禁语扫描）validate²（§0–§7+标签+候选 2–4）、W3 idea card validate TS 化**规则全集**（14 必填/泛化锚黑名单/痛点具体度/wiki 回写联动——#848 §3.3 逐条翻译断言）、W4 validate¹（映射校验泛化）validate²（占位符）、audit 确定性三维。
  - dedup 纯函数（同键保留最长 evidence_chain）；contextPack 裁剪顺序（evidence 降序/页级节选/Brief 恒保全/裁剪后判定证据不足）；challenge 顺序执行与 rejected 判据边界。
  - 常量两层锁定（§7.1）；W4 spec 短路点（spec 已落盘跳 design 直达 interrupt）；escalation.plan round 关联 3 行审计。
  - prompt 模板验收 = 节结构 checklist 断言（各节标题齐全/机读标签存在），**非** golden 全文对照（prompt 资产非确定性输出；744 §3.3 golden-file 先例适用于逐字移植的计算逻辑，不适用于 LLM prompt）。
- **S1 信封 REST**：本插件**零新 REST 面**（enablement/目录复用 #752 §4.3 既有端点；figures 读面不涉及）——回归确认 `GET /api/v1/plugins` 清单含 research。
- **投影零差异组锁**：research_run.progress 透传分支回放不构造 stage；tool.end 剥落语义与 figure 分支同构断言。
- **组件测试**：ResearchRunCard 三态 + unknown stage fallback + 双段徽标；PlanApprovalCard 必填校验（空理由禁提交）/ 轮次徽标 / reason 传递；WikiView query.path 消费；ApprovalDock source 分流。
- **意图分类评估集**：40 条 bad case 保留为回归锚点（throwaway 分支 `research/intent-classifier-eval` @ 9d3ec67，server/scratch/intent-eval/ 五件：evalCases.ts / prompt.ts / clarifyTemplate.ts / runEval.ts / results.md；复跑需 LLM_API_KEY，本机经 worktree 根 .envrc 注入不进 track）。生产 IntentClassifier 文本退化双保险以该实测为准入。
- **集成 smoke**（真 docker daemon 门控）：createPage 幂等哨兵（并发同路径竞态窗）/ extractPdfText 沙箱 poppler / 超限报错。

## 10. V2 扩展点与已否决决策（防重开）

**V2 候选**（启动前逐项评估）：

1. **假说 verdict 反哺**（#868 D1，V1 单向边已满足闭环——collect 报告页可被下轮 W3 contextPack 检索到）：评估清单 ① appendPage/updatePage port 面（修订 #851 D6）② claims 追加面 ③ 写既有页致其 claims 漂移的相互作用与重派生路径 ④ 与在飞治理 run 的 base-hash 冲突面 ⑤ 追加不改写的历史语义。
2. **执行 teammate**（W4 执行段形态升级：独立 checkpoint/折叠区轨迹/审批冻结/共享沙箱——#850 D16 列真选项，kind 枚举扩展需核心发版 + teammate 成熟度依赖，交接规格留扩展点）。
3. 批量 ingest（Send[]+fan-in 串行 persist——写锁/索引竞态解后）。
4. 扇出计数事件载荷（第 N/5 桶——需 progress 扩序号，#851 D5 契约不动）。
5. per-call signal 组合（AbortSignal.any 超时——#851 D3）。
6. 命令参数补全（窄域列文件 port——#851 D9）。
7. ProviderRegistry 默认 timeout（顺带修 figure/主 agent 同款 hang 缺口——#869 D2）。
8. 通用 `tool.progress` 事件（#752 §2.2 原留 V2 项）。
9. URL PDF 来源（W1 capture，#850 D7 明示降级）。
10. 图内跨会话 wiki 互斥（与 writelock registry 同边界，#851 D7）。

**已否决决策**（防重开索引）：子图组合（ns 寻址冲突，#847）/ deepagents teammate 路由与委派（LLM 自由裁量违拓扑硬约束，#847）/ 会话主图改造（#849 D1 否决 A）/ teammate 式独立 run（#849 D1 否决 C）/ 第 5 入口命令 /research（#849 D4）/ NL 确认审批形态（#852）/ .claims 直写与 lifecycle submit_page 同步调用（#850 D3，V2 重评）/ 图内 exec 节点（双违反 #752 已钉）/ 逐命令第二插件工具（白名单防漂移不敌探索现实）/ 执行段自行 clone / 自由 text input（#850 D2）/ 插件 content 内嵌 frontmatter（#851 D11）/ `plugin_run.*` 泛化事件名（#851 D2）/ 前端 stage 白名单镜像（#851 D8）/ workflow 前缀化 stage 值（#851 D5）/ FigureCard 式阶段条（#867 D1）/ 图内限并发与插件独立配额域（#869 D1）/ run 级 token 硬顶与调用计数硬上限（#869 D4）/ exec timeout 延长档（#869 D6）/ 两过式分段生成（#869 D5）/ 多意图必 clarify 与多标签 schema（#850 D17）/ idea card 输入豁免映射校验（#868 D3）/ 机读 validates 单值字段（#868 D2）/ 四流程中间节点 agent loop 化（宽口径否决·带重开条件，见下条目，#899 图 #904）。

**宽口径否决条目（带重开条件；[#899](https://github.com/ACautomata/researcher-service/issues/899) 图定案 [#904](https://github.com/ACautomata/researcher-service/issues/904)，2026-10-10）——四流程中间节点 agent loop 化（节点内 agent 循环）**：

- **否决内容**：四流程中间节点由单发形态改为节点内小型 agent loop（节点对图的输入/输出契约与拓扑位置不变，节点内 agent 可获取、调用框架基本工具，循环执行直至产出节点输出）。**定案 = 零转换**：四流程中间节点全部维持单发，全图不设任何条件改路径；其余中间节点的排除理由档 [#900](https://github.com/ACautomata/researcher-service/issues/900)（盘点分级）/ [#902](https://github.com/ACautomata/researcher-service/issues/902)（audit 排除入档）。
- **实测依据**：[#903](https://github.com/ACautomata/researcher-service/issues/903) 对照实测（36 run = critic/design × oneshot/loop × 3 论文 × 3 重复，同输入同 wiki 快照 A/B、MiniMax-M3 pin）+ 用户盲评 18 对——critic 盲评 56%（<60% 平局规则，loop 臂 9/9 零工具调用：证据已在输入内则不激活检索）；design 三判据全败（盲评 33% / gate 33% vs 基线 44% 退步 / 7/9 token 超线峰值 14.83×，检索行为真实但零 gate 收益）。
- **重开条件**（仅此三条）：① 驳 #903 实测数据或协议本身；③ 出现「输入边静态、内容动态」缝隙的新节点类型；④ RESEARCH_MODEL 换代后重测（本次 pin MiniMax-M3 单模型 + 3 论文语料的代差局限）。（候选条件②「新判据」已弃——太软，易成万能钥匙。）
- **与本规格其他条目的关系**：`PAGE_GENERATE_MAX_RETRIES` 触发面扩展（§7.1）系本定案唯一入稿项——「单发 + 至多一次协议修复」形态（无工具面、无 LLM 自由裁量），不属本否决条目的重开面；W3 ≤35 口径注记见 §4.3。

## 11. 开放点

### 11.1 附带验证任务（#850 D3，实施期验证）

- openwiki finalization 对**非治理来源页 / 页内 claims 块**的行为（插件经 port 建的页会进入治理检索面——finalization 相遇行为需实证）。
- **evidence resource 语义重定义**：`repo://` → 论文页/上传件锚（[725 五-4](./725-openwiki-embedding-okf.md) 预留项；W2 evidenceGate 的存在性回查依赖该语义）。

### 11.2 开票注记

实现拆分（§8.2）开票时逐票打 `ready-for-agent`（惯例沿 #747·N 系列与 #341 先例）——**等用户人工指令，本规格不预开**。

### 11.3 汇编解读点（定稿评审拍板记录）

> 以下为 10 票决议汇编时的口径归一点与票间缺口——**非新决策**，逐项列出上游依据与口径。2026-10-08 定稿评审：A/C/D 按本文口径拍板；**B** 缺口与两候选形态经评审认可，形态选择归实现票首项：

- **A. classify 的分类输入**（§1.2）：#849 D4 钉「input 由主 agent 组织」，#850 D2 否决自由 text input 改结构化槽位——本文取「分类输入 = 结构化请求槽位（topic/question）的文本序列化」为两票交集解读；若实现期发现分类质量劣化（#866 评估集是裸文本输入），回退点 = 工具增 `request_text` 只读分类槽（不落任何执行面）。
- **B. spec 落盘 lab 的写入面**（§5.1 短路点依赖）：#852 钉「spec 落盘 lab」为幂等短路点 + 调用② 消费 + 超限终局 spec 停留 lab，但 #851 ctx 增量未列 lab 写口（ctx.wiki 写 wiki 容器、ctx.docs 只读 PDF）。**缺口**：需为插件补一个 lab 写面。候选形态：① ctx.docs 扩窄域 `writeSpec({path, content})`（/lab/ 前缀白名单，与 extractPdfText 对称）；② ctx 增 `ctx.lab.write` 窄口（/lab/specs/ 固定前缀）。两候选经定稿评审认可，形态选择归实现票首项。
- **C. 票内预约参数落定**（各票明确留给规格定稿）：`PDF_EXTRACT_MAX_CHARS` 数值（#851 D10，量级 ~1M）/ `PageType` 枚举值集（#851 D11 附带：候选 论文页 / critic 页 / idea-card / 实验报告）/ frontmatter 建议字段集（#851 D11：title/type + OKF 徽章三件 + source/toolCallId/workflow/related_pages）。
- **D. W4 stage 序列与白名单口径**（§6.1）：#852 钉流程序列 design→plan-review→executing→collecting，#851 D5 钉白名单 = 节点名并集——本文取「plan-review 进白名单（人审挂起期 stage 停该值）；executing/collecting 为流程级描述不进白名单（调用②非插件工具、调用③走 collect 段节点名）」；#867 D6 的两态呈现与该口径一致。

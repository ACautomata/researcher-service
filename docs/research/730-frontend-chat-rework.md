# 730 前端 chat 改造与双协议退役规格

> Wayfinder 票 [#730](https://github.com/ACautomata/researcher-service/issues/730)，map：[#734 LangGraph agent runtime 替代 OpenClaw](https://github.com/ACautomata/researcher-service/issues/734)。
> 依据已钉决策：事件模型 [#726](https://github.com/ACautomata/researcher-service/issues/726)（SSE + 薄投影）、会话历史 [#727](https://github.com/ACautomata/researcher-service/issues/727)（checkpoint 树）、双容器模型 [#728](https://github.com/ACautomata/researcher-service/issues/728)（wiki|lab）、审批漏斗 [#729](https://github.com/ACautomata/researcher-service/issues/729)、provider 新家 [#731](https://github.com/ACautomata/researcher-service/issues/731)、退役方案 [#732](https://github.com/ACautomata/researcher-service/issues/732)、teammate/信箱 [#742](https://github.com/ACautomata/researcher-service/issues/742)。
> 状态：grilling 会话定稿（2026-09-28，三轮 10 决策全录见票 resolution；代码事实基线来自两轮全量扫描）。

## 0. 关键裁决

### 0.1 双协议退役窗口：无

依据 [#732](https://github.com/ACautomata/researcher-service/issues/732) 前提修正——产品未上线、无真实用户/数据，「冻结只读 UX」与「双协议适配层」整体空置。前端退场 = **feature 分支整段重写，切换 PR 一次性替换 + 删旧**，与 #732 的 T0 单点切换（无并行期、无回退点）同 PR 对齐：server 侧清 legacy 链与前端删旧 chat 同窗口完成。

### 0.2 历史数据：无包袱

新架构绿地起步，无会话迁移工作；rewind/fork 的旧路径保留是 **LangGraph checkpoint 机制的自然形态（零额外成本）**——不为「可恢复性」加码，也不为「物理删除」额外写清理逻辑（#727：消息不物理删、activeCheckpointId 指针重定向）。rewind 确认门轻量化（无真实用户期，破坏性确认文案从重门降为轻提示）。

### 0.3 范围裁定：面板级 IA 出票

容器维度退役（见 §4.7）波及 ContainersView 与登录后导航的整体信息架构——**超出本票「chat 改造」票面**，记入 map fog（Not yet specified），归汇编票 #733 处理或届时开新票。

## 1. 设计原则：单管线渲染（实时 ≡ 回放）

本票立的第一原则，前端一切投影/渲染决策的上位约束：

1. **同一视图模型，两个入口**：ChatStream 消费的视图模型由**同一归约器**产出——实时路径吃事件流（SSE）增量，回放路径吃投影 API 聚合行，两者产出同一数据形状（`reduce(全量事件) ≡ 投影行`）。验收口径：流式结束瞬间的画面与刷新后重拉投影的画面，除进行态装饰外零差异。
2. **进行态是叠加层**：thinking 滚动、工具运行中、光标闪烁只存在于流式路径，做成终态视图之上的临时装饰（badge/spinner/自动滚动），终态收敛后自动剥落；回放路径永远不构造它们。
3. **断线无跳变**：重连 = 投影重拉 + in-flight 从 checkpoint 重建（#726 服务端语义），前端因只有一条管线，重建画面与断线前画面自然同构。

与 #726「会话投影是权威读模型、事件流只是增量通道」咬合：服务端薄投影管到什么形状，前端就只消费什么形状。术语固化见 CONTEXT.md「单管线渲染」词条（随本 PR）。

## 2. 事实基线（2026-09-28 全量扫描）

| 面 | 规模 | 关键事实 |
|---|---|---|
| `frontend/src/chat/` | 54 文件 13,651 行（非测试 6,298 / 测试 7,353） | 协议耦合 ≈32%（2,042 行）；编排单体 useChatConnection 1,930 行 |
| `frontend/src/components/chat/` | **16 组件**约 2,700 行（不止票面所述 8 个） | **零组件 import gateway-client**——只碰 chat/ 高层类型与纯函数 |
| `views/ChatView.vue` + `stores/chat.ts` + `api/chat.ts` | 643 + 328 + 54 行 | api/chat.ts 仅剩配对 + bootstrap-token（#732 死面）；会话 RPC 全走协议机 |
| wiki 四件（WikiView/WikiGraph/FileTree/MdEditor）+ api + store | 755 + 94 + 146 行 | wikilink 前端零解析（#419-3 移除）；图谱边全在后端；frontmatter 零解析（仅新建模板） |
| chat 独立 markdown-it 管线 | renderMarkdown.ts 87 行 | 与 wiki 的 Milkdown 互不复用（维持现状，不合并） |

**ChatFrame 概念可延续**：eventTranslate 产出的渲染帧联合类型（text/done/error/approval/approvalResolved/attachment/tool）与 #726 SSE 事件目录（text/thinking/tool delta + 终态 + approval.*）几乎一一对应——翻译层概念延续、输入面全换。

## 3. 处置总表

四档处置，逐模块（行数为非测试实测）：

### 3.1 删（随退役，≈2,300 行 + 对应测试）

| 模块 | 行数 | 依据 |
|---|---|---|
| gatewayChat.ts | 932 | 协议机 Facade，SSE+REST 取代 |
| tunnelSocket.ts | 56 | WS 隧道 transport |
| deviceAuth.ts / deviceIdentity.ts / deviceTokenStore.ts | 340 | 设备配对三件（根决策已钉移除） |
| sessionProjection.ts | 75 | SDK 归约器，被新投影归约器取代 |
| protocol.ts / closeCodes.ts | 36 | WS subprotocol / close code |
| subagentApproval.ts | 24 | #742 已钉随隧道退役（审批事件带 teammateId） |
| useContainerUpgrade.ts | 181 | 升级编排随 legacy 容器退役（#732） |
| api/chat.ts 配对面 | 54 | getPairing/triggerPair/approvePairing/getBootstrapToken |

### 3.2 重写

| 模块 | 替代物 | 要点 |
|---|---|---|
| eventTranslate.ts（603） | **投影归约器**（纯函数） | 概念延续 ChatFrame；输入从 GatewayEventFrame 换 #726 事件目录；双入口（事件增量 / 投影行）同形状输出（§1） |
| useChatConnection.ts（1,930） | **拆三件**（§4.1） | 连接生命周期在 SSE 下缩至近零；投影归约器抽出可单测 |
| stores/chat.ts（328） | state 随投影行形状重定义 | 15 个 state 字段重组；ToolRow/Msg 接口随视图模型重定义 |
| api/chat.ts | **REST 写操作面全量重建** | sessions CRUD / send / approval resolve / rewind / fork / branches / commands（#726：写操作全 REST） |

### 3.3 保留改造

| 模块 | 行数 | 改造点 |
|---|---|---|
| outboxStore.ts | 107 | 重发通道从协议机 resendOutbox 改 REST 幂等注入；余下（sessionStorage 窄窗 + 32-hex 幂等 key + 50 条上限）已合 #726 定稿 |
| toolRender/* 五件 | 1,393 | 纯 view-model 逻辑留；「运行中」状态机按「进行态叠加层」重排（终态渲染与进行态装饰分离） |
| attachments.ts | 290 | 组装目标换 attachmentsJson v1（#726） |
| rewindPreference.ts | 28 | 确认门轻量化后语义弱化，保留本地偏好机制 |
| thinking.ts / renderMarkdown.ts / anchorNav.ts / scroll.ts / localStorage.ts | 274 | 原样保留 |

### 3.4 骨架保留（只换数据面/类型面）

- **16 组件**（ChatSidebar/ChatHeader/ChatStream/ChatComposer/ChatMessageItem/ThinkingCard/ToolLine/ApprovalCard/ApprovalDock/AnchorRail/FileTabsPanel/FileViewer/MarkdownRenderer/RewindConfirmPopover/TraceFold/WorkspaceTree）：骨架全留，类型 import 换新家（gatewayChat 类型 → 投影/REST DTO）。
- **ChatView.vue**（643）：编排骨架留，useChatConnection 接线换拆分后三件。
- **wiki 四件**：见 §4.8。

## 4. 子系统设计要点

### 4.1 连接与投影层（M1 核心）

- **useEventStream**（新，薄封装）：原生 EventSource + `panel_stream` cookie（HttpOnly/SameSite=Strict，#726）；内置重连白送，只补 gap 检测（Last-Event-ID 只检测不重放）与连接状态暴露。
- **投影归约器**（新，纯函数，eventTranslate 概念位）：吃 #726 事件目录，产视图模型；`applyEvent(vm, event)` 与 `fromProjection(rows)` 双入口，一致性由单测锁死（§1 验收口径的机制载体）。
- **会话编排 composable**（新，useChatConnection 编排位的继任）：会话列表/切换/发送/门控/分页/slash；不含投影逻辑（归约器管）与连接逻辑（useEventStream 管）。

### 4.2 rewind / fork / 分支三件套（M2，不可分割整体）

- 三件套一次性完整交付（grilling 钉定）：rewind（checkpoint 树指针重定向）+ fork（新会话 + forkSource + `/lab` 拷贝提示）+ 分支菜单（数据源 = 投影 branches，checkpoint 树兄弟分支；ChatHeader 现有交互骨架不动）。
- **门控族处置**：「会话控制能力」**退役**（控制面原生，无能力探测）；「投影权威」简化为「投影重拉完成即权威」（无握手窗口）；「回退在途/分叉在途」互斥门保留（REST 写后重建管线仍是同族语义）；outbox 代际作废逻辑保留（rewind 时作废旧代残留，fork 不作废——语义随 #726 REST 化平移）。
- 确认门轻量化（§0.2）：rewind 轻提示，fork 维持免确认。

### 4.3 审批前端面（M3）

- **ApprovalCard 骨架复用**（#729 已钉）：dock/状态机复用，decision 砍 allow-always（仅 allow-once|deny）；数据源换 SSE `approval.requested/resolved`（带 teammateId）；断线复位逻辑随投影重拉简化。
- **升级通道卡**：EscalationItem（来源护栏 + toolCall 摘要 + judge 理由）；48h suspended 态展示；一个 run 同时只挂一个 interrupt。
- teammate 具名折叠区：**TraceFold 泛化**——主时间线只挂 leader 发言与产物，teammate 轨迹 + 信箱往来折叠区展开（#742 可见性定稿）。

### 4.4 outbox 与断线恢复（M2）

- outbox 收敛为断线排队（#726）：断线期间已点发送的消息 sessionStorage 排队，重连后按序 REST 幂等注入；「用户看着服务端继续跑的半截输出追问」是唯一目标场景。
- 断线恢复 = 投影重拉 + in-flight 重建（§1.3），`RESUME_WAIT_MS`/`PENDING_RUN_GRACE_MS` 类窗口常量语义平移（等 in-flight 重建完成，非等网关 resume 帧）。

### 4.5 slash / commands（M3）

- 补全三态（slashIndex/slashDismissed）逻辑保留，数据源从网关 commands RPC 换 REST；系统命令 V1 `/new` `/compact` `/model`（#742）；命令 = composer 语法 + user message 注入，前端不改消息语义。

### 4.6 api 层与信封（M1）

- `api/chat.ts` 重建为 REST 写操作全集（§3.2）；沿用 `client.ts` 信封解析 + 401 刷新链（不动）；SSE 端点走 cookie 通道（EventSource 不能带 Bearer header，#726 已定）。

### 4.7 侧栏与容器维度退役（M4）

- **容器切换器删除**：归属 `containerId→ownerId` 上移（#731），用户直接拥有会话；沙箱对列表隐身（#728）、wiki 容器每用户一个——「容器」作为 chat 导航单位在数据层已不存在。侧栏 = 会话列表（扁平挂用户）+ 文件 tab。
- 文件 tab（FileTabsPanel/FileViewer/WorkspaceTree）：数据源从「容器 workspace」换「会话沙箱 lab」——**生命周期差异必须注明**：lab 随会话生灭（现在 workspace 随容器持久），切会话即换树。`workspace→lab` 改名波及 files API root 参数（#728 已钉）。
- 路由从「容器→会话」两级变「会话」主轴（query/params 具体形态实施期定）。

### 4.8 wiki OKF 适配（M4，对齐官方 visualize 案例）

对齐 [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) `src/visualize/` 官方案例（grilling 钉定的案例决定）：

| 做 | 形态（抄官方） |
|---|---|
| 结构化字段展示 | type 作 eyebrow 小标、tags 作 chips、title/description 作文档头（reader/预览头部元信息） |
| markdown 链接应用内导航 | 内部 `.md` 相对链接点击拦截 → 打开对应页（官方 rewriteLinks 同款）——**现状零处理，OKF 化后链接主形态就是它，必做** |
| backlinks | 页面底部「引用」可点 chips（数据 = graph edges 反向，后端已有） |
| frontmatter 原文 | 预览时 stripFrontmatter 剥离，不进正文渲染 |
| 新建页面模板 | frontmatter 加 `type` 必填（OKF v0.2） |
| **不做** | provenance 族（sources/verified/status/stale_after）**不渲染**——官方 visualize 自己都不展示；有数据可看时再设计 |

图谱边派生加 markdown 相对链接、SKIP_FILES/SKIP_DIRS（log.md/INSTRUCTIONS.md/.claims）全在 wiki 域后端（#737 面），前端 WikiGraph/FileTree 零改动（DTO 不变形前提下）。

## 5. CONTEXT.md 词汇处置清单

实际词条改动随 T0 实施 PR 落（现在改会让词条与现行代码失真）；本清单为 T0 的执行依据。

| 词条 | 处置 |
|---|---|
| **单管线渲染** | **本 PR 新增**（目标架构标记） |
| 事件流 / 待发出箱 / 会话投影 / 审批卡 | 不动（#726/#729 已带演进注） |
| 转录条目 id | 演进注 → session_messages 行 id；回填机制随 REST ack 简化 |
| 对话回退 | 演进注 → checkpoint 树 + activeCheckpointId 指针；确认门轻量化 |
| 回退在途 / 分叉在途 | 演进注 → REST 写后重建同族管线，互斥门保留 |
| 投影权威 | 演进注 → 判定简化（投影重拉完成即权威） |
| 会话控制能力 | **退役** → 控制面原生，无能力探测 |
| 对话分支 | 演进注 → 数据源换投影 branches |
| 附件 | 演进注 → attachmentsJson v1 |
| 折叠条 / 轮次 / 轨迹 / 执行时长 | 语义延续；折叠条加 teammate 具名折叠区泛化注 |
| 面板三态 / 消息锚点导航 / 会话删除 | 不动 |

## 6. 分阶段工作量估计

里程碑为**估计与验收口径**，交付仍是单次切换（§0.1）。基础口径：新写 ≈5,000–6,000 行源码 + 4,000–5,000 行测试，按 300 行/人日（含联调）≈33 人日基础；**风险乘数 1.5–2.0**（新事件面联调、一致性单测、SSE 边缘案例、16 组件类型面迁移的隐性返工）→ **50–65 人日**。评审警示依据：#724 校准的 3–5 倍系数是全 map 口径（runtime 自研无先验），前端子面不确定性低于 runtime 但高于常规 feature，取 1.5–2。

| 阶段 | 内容 | 新写/改造当量 | 验收线 | 估计 |
|---|---|---|---|---|
| **M1** 连接 + 投影 + 发送闭环 | useEventStream / 投影归约器（+一致性单测）/ 编排 composable 骨架 / api 重建 / store 改造 / ChatView 接线 | ~4,000 行 | 登录开流、发消息看流式、刷新回放与流式终态零差异 | 15–20 人日 |
| **M2** 三件套 + outbox + 断线 | rewind/fork/分支菜单 + 门控族 + outbox REST 化 + 断线恢复 | ~3,000 行 | 三件套全交互、断网重连无跳变、断线排队注入 | 12–15 人日 |
| **M3** 审批 + teammate + slash | 升级通道卡 / teammate 具名折叠区 / slash 数据源 + 系统命令 / 多端门（50001） | ~2,000 行 | 审批全链路、折叠区展开、slash 补全 | 8–10 人日 |
| **M4** wiki + lab + 退役 | OKF 适配四件 / lab 改名 + 文件 tab / 侧栏容器维度退役 / 删 §3.1 全部 | ~1,600 新增 − 2,300 删除 | OKF 字段展示 + 链接导航 + backlinks、侧栏无容器切换、legacy 前端文件全删 | 6–8 人日 |

测试面随处置表分档：§3.1 死区测试删（约 7,353 行的大部）；归约器/纯函数测试新写重写（M1/M2 验收主体）；组件测试随类型面改造。

## 7. 退役与切换（对接 #732）

1. **切换 PR = 前后端同窗**：前端 feature 分支合入 + server 侧 #732 清单（chat 隧道四文件/pairing/bootstrap-token/端口池/models 域/upgrade 编排/ConfigRenderer token 段/health 探针/openclaw.json 模板/openclaw-image/compose env 组/Prisma Pairing+ModelProvider 表）+ T0 删 legacy 容器，一次完成。
2. **前端删除面**：§3.1 全部 + `api/chat.ts` 配对面 + ChatSidebar 容器切换器 + useContainerUpgrade 消费点（ChatView）。
3. **词汇面**：§5 清单随同 PR 落词条改动。
4. **回退预案**：无（#732 已钉无回退点；若切换时已有真实用户，回 #732 窗口版机制的判据同源）。

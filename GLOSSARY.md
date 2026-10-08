# 天津大学科研智能体平台

「天津大学科研智能体平台」——**会话平台**：会话沙箱（每 session 一台）+ 每用户 wiki 容器 + TS/Express 控制面（server/，替代已退役的 Django 后端，#341 M9），Vue3 前端经 REST + SSE 事件流消费控制面。用户视角三面 = 对话 / wiki / 模型配置（#858）。本 glossary 只收录**本项目特有**的领域术语，通用编程概念（Port / Adapter / Translator / Protocol 等设计模式词汇）不在此列。

> **OpenClaw 退役（T0 #801 → #858/#859/#860 → #861 终局）**：面板曾以 OpenClaw 容器 fleet 为编排对象（「多 OpenClaw 容器管理面板」旧叙述），该整链已整体退役——现役产品叙述 = 会话平台。涉及 fleet / 容器 / 镜像 / 隧道的历史词条**保留为决策历史**（带退役注记，不回删），决策档案见 `docs/adr/` 与 `docs/research/`。

## Language

**OpenClaw 容器 (OpenClaw container)**:
**（历史注：#858 OpenClaw 退役③起 fleet 整体退役——现役容器 = 会话沙箱 `researcher-sandbox-<sessionId>` + wiki 容器 `researcher-wiki-<userId>` 二 kind，本条保留为决策历史。）**
面板编排的单位。每个容器内跑一个 `main` agent、一个 gateway（WS，容器内 18789）、以及独立的 home / wiki / openclaw.json。它是本系统唯一的外部 bounded context。
_Avoid_: 实例——"实例"指面板侧的 `Instance` 数据模型，是 OpenClaw 容器在控制面的投影，二者不等同。

**一次性临时容器 (one-shot container)**:
**（历史注：`runOnce` 原语、`RunOnceError` 与升级编排已随 T0 #801 整链物理删除，本条保留为决策历史。）**
由运行时原语 `runOnce` 以指定镜像 + 指定命令跑完即弃的容器（升级编排在「真容器尚未启动」的窗口里执行备份与 `openclaw doctor --fix` 的通道——stopped 容器不可 exec，新镜像网关遇 legacy 存储又拒绝就绪）。**它不是 OpenClaw 容器**：不写 fleet 三标签（`app` / `openclaw.instance` / `openclaw.port`）、不发布宿主端口，故对 fleet 列表与端口对账不可见；退出码非 0 即失败（`RunOnceError` 携带退出码与输出），容器由原语在成功/失败/异常三路强制回收（卷不删）。
_Avoid_: 临时实例——易与面板侧 `Instance` 模型混淆；影子容器——掩盖它由面板显式创建、必须回收的事实。

**面板 bounded context (panel bounded context)**:
面板内部的六个 bounded context（2026-08-13 划分，wayfinder #637）：containers（核心）/ 身份与访问 / wiki / models（支撑）/ files / traceLogs 审计（通用）。**（演进注：#858 起 containers context 整体退役——`containers/` 收敛为沙箱/wiki 两 kind 的共享原语件；核心域由 sessions（#778 会话 REST + reducer 投影）与 runner（#747 LangGraph 运行时）承担。）**跨 context 契约：**行为协作一律经领域消息**（异步）；无 IO 纯函数/常量/渲染机制下沉**共享内核**；容器归属门 `getInstanceForUser` 是共享中间件**唯一单点**（tenant 引入时只替换此门；该门已随 #858 退役——现役归属 = 认证身份直派生，#856/#857）。
_Avoid_: 跨 context 直接 import 域服务（渲染、状态查询）——行为协作走领域消息；在 context 内复制共享内核纯知识（容器命名规则 `containerName`、配置安全不变量）——必须单一实现。

**镜像谱系 (image lineage)**:
**（历史注：OpenClaw 镜像族（cn-im fork / 官方原版 / 自建派生）已随 #858 fleet 退役——现役镜像面 = `SANDBOX_IMAGE`（busybox 级钉版沙箱）+ `WIKI_IMAGE`（busybox 级 wiki 容器）两支路，本条保留为决策历史。）**
承载 OpenClaw 容器的镜像决定容器的能力边界与挂载契约。有两个互不兼容的**现成**变体，另可自建第三条：
- **cn-im fork**（`acautomata/openclaw-docker-cn-im`）：历史部署镜像，启动时自带配置同步与权限降权（init 脚本），预装中国 IM 渠道插件，**不含 browser 运行时**（researcher 配置的 browser 插件在此镜像上无效）。
- **官方原版**（`ghcr.io/openclaw/openclaw`，分 `-browser`/`-slim` 变体）：OpenClaw 官方镜像，不自带配置同步逻辑；`-browser` 变体预装 Playwright，browser 能力可用（ADR 0003 选定 browser 变体为部署基线；当前基线版本 `2026.9.4-browser`）。
- **自建派生 (derived image)**：`FROM ghcr.io/openclaw/openclaw:2026.9.4-browser`（保 browser 能力，ADR 0003 基线）之上叠加本面板专属内容：`pdftotext`（poppler，PDF 文本提取 CLI，供 agent `tools.exec` 调用）+ wiki/workspace 骨架（COPY 进 `~/.openclaw`，供 named volume 首挂自动初始化，见「named volume 拓扑」）。经 `OPENCLAW_IMAGE` 注入（派生镜像构建已随 T0 #801 退役，现钉版存量 GHCR 引用）。派生镜像**不新开谱系**，只在其基镜像谱系（官方）上加层；基镜像的 browser 能力、token 占位、SecretRef 等已校准性质原样继承。
_Avoid_: 「OpenClaw 镜像」——掩盖谱系在 browser 能力、挂载契约依赖、启动方式上的本质差异；讨论迁移/换镜像/重新打包时必须指明谱系（含派生镜像的**基镜像**谱系）。

**目标镜像与版本 tag (target image / version tag)**:
**（历史注：fleet 目标镜像 `config.fleet.image`（env `OPENCLAW_IMAGE`）与派生镜像版本 tag 面已随 T0 #801/#858 退役；**浮动 tag fail-fast 机制现役**——判定准据 `isFloatingImageRef` / `readPinnedImage` 作用于 `SANDBOX_IMAGE` / `WIKI_IMAGE` 两支路。下述 fleet 叙述保留为决策历史。）**
面板 fleet 的**目标镜像** = `config.fleet.image`（env `OPENCLAW_IMAGE`）：新建容器时写进容器记录（升级编排 #682 已随 T0 #801 退役，行镜像一经创建不再变更）。**版本 tag** = 派生镜像的 `:<基线 tag>`，**一经发布不可移动**（派生镜像构建已随 T0 #801 退役：`deploy/openclaw-image/` 基线链与 `openclawImage.test.ts` 交叉断言随之删除，bump 机制不再存在）。**浮动 tag (floating tag)** = 无 tag（Docker 默认解析 `:latest`）或显式 `:latest`：内容随上游移动、使「当前目标」不可复现 → **生产启动即 fail-fast**（准据 `isFloatingImageRef`；dev/test 放行）；滚动 tag（`latest-browser` 等）不由代码拦截，靠 review 拦。
_Avoid_: 用「镜像版本」泛指——须区分**基线版本**（官方镜像 tag）与**派生镜像版本 tag**（发布后冻结）；也不要把「最新」当目标（浮动 = 不可复现）。

**接触路径 (contact path)**:
**（历史注：四条通道为 OpenClaw fleet 时代划分，已整链退役——现役接触路径 = Docker SDK 编排 + 各域 Docker 原语读写（wiki 容器 /wiki、沙箱 /lab），本条保留为决策历史。）**
控制面与 OpenClaw 容器交互的四条通道：(1) Docker SDK 编排（增删查容器）、(2) 宿主文件 bind-mount 直读写（wiki / openclaw.json）、(3) HTTP `/health` 探测、(4) WebSocket（协议 v4 + 设备配对 + 事件流，见「隧道」）。
（T0 #801 演进注：(2) 已换 named volume 拓扑（ADR 0011，该拓扑又随 #858 fleet 退役——现役 wiki 容器无具名卷）、(3) 健康探针与 (4) WebSocket 隧道均已退役——现役接触路径 = (1) Docker SDK 编排 + 各域 Docker 原语读写。）
_Avoid_: 集成点——过于笼统，无法区分这四条性质不同的通道。

**防腐层 (Anti-Corruption Layer, ACL)**:
**（历史注：chat ACL 与 Django 时代 `backend/integration/openclaw/` 包均已退役——现役对话链 = 控制面 runner 直产自有 wire 模型（#747），无外部 bounded context 需隔离，本条保留为决策历史。）**
`wiki/` 等域的 Port + Adapter + Translator 结构（`server/src/chat/` ACL 与 Django 时代 `backend/integration/openclaw/` 包均已退役）。用 Port + Adapter + Translator 隔离 OpenClaw 的 wire 模型，防止其原生概念污染控制面 domain。**明确不追求 vendor-neutral**——保留 OpenClaw 原生命名作为事实，只在语义不一致处翻译。
_Avoid_: 网关层、适配器层（单数）——本系统是多个 Port 的集合，不是单一门面。

**wire 概念 (wire concept)**:
**（历史注：OpenClaw WS 协议 v4 随 T0 #801 整链退役——现役传输面 = REST + SSE 事件流（#773），事件类型为控制面自有模型（`text.delta` / `tool.start` 等薄投影事件），本条保留为决策历史。）**
OpenClaw WS 协议 v4 的原生命名——事件族（`exec.approval.requested` / `plugin.approval.requested` / `agent.tool.start` / `agent.tool.result` / `chat` 的 `state`）、字段名（`deltaText` / `errorMessage` / `systemRunPlan.rawCommand`）、标识符（`runId` / `sessionKey` / `deviceToken` / `deviceId` / `operator.*` scopes）。
处置分两类：
- **标识符**：纯 id，domain 无二义 → 保留原样、集中管理、不翻译。
- **语义类**：命名或结构与 domain 不一致 → 经 Translator 翻译（如 `exec.approval.requested` → `approval`，`deltaText` → `delta`）。
_Avoid_: 协议字段——笼统，掩盖了"标识符 vs 语义类"这一关键区分。

**OpenClawWire**:
接触路径 (4) 的 Port（ADR 0004，**已于 #231 收敛落地**）：**配对后长连接**（chat.send + 事件流按 runId 路由 + 连接级审批 fan-out + 只读/会话 RPC）。配对本身不在本 Port：由 `PairingHandshake` / `PairingService`（独立 seam）完成 challenge→connect→approve→持久化 deviceToken 后，pool 构造本 Port 的实现并发起无参 `connect()`。ADR 0004 据此修订了 0002 的"配对+长连合并"原意——两套 `connect` 帧的重复已由 `ConnectFrameBuilder` 偿清（与一 Port/两 Port 无关），而配对的有状态多步流程与长连事件流 shape 本质不同，故分立。**（历史注：#341 M9 后此实现随 Django 退役；协议机由官方 `@openclaw/gateway-client` 接管、走浏览器直连隧道（ADR 0006），本条目保留为决策历史。）**
_Avoid_: ChatClient——历史实现名（收敛后 `chat.chat_client.OpenClawChatClient` 是 `OpenClawWireClient` 的同对象 alias，strangler 过渡保留，alias 清理列 deferred；见 ADR 0004）。

**OpenClawWireClient 内部协作者 (wire-client collaborators)**:
**（历史注：随 #341 M9 Django 退役，下述 Python 协作者结构不再存在于代码库；协议机职责由官方包 + 浏览器端 `eventTranslate.ts` 纯函数翻译承担，保留本条目为词汇历史。）**
`OpenClawWireClient` 拆分后落 `integration/openclaw/wire/` 子包（包名 `wire` 无下划线，符合「包名禁下划线」约定，呼应 `OpenClawWire` Port；2026-08 自 1120 行单类拆分，issue #271）；`wire_client.py` 退为薄壳做 identity re-export（`OpenClawWireClient`/`OnEvent`/`HISTORY_RUN_ID`/`_ConnectFrameBuilder`/`_AGENT_ID` 原 import 路径不变）。拆分**不动** Port 形态与配对边界（ADR 0004），`OpenClawWireClient` 退为**门面**——保留全部 Port 方法签名与恢复面方法（`record_active_session`/`resume_active_session`/`unregister_active_session`/`recovery_sessions`），内部委托协作者；跨桶接缝由门面编排、协作者回返值对象（`AckOutcome`/`RouteDecision`），单向依赖 门面→协作者：
- **ConnectionCore** — ws 连接生命周期（connect 握手/challenge/看门狗/dead 判定/aclose）。
- **RequestRouter** — 请求-回执路由（`_pending_acks`/`_pending_resolves`/`_rpc`/session 与 commands RPC/`resolve_approval`）。
- **RunEventRouter** — runId 事件路由 + 翻译 + 终态清理（`_routes`/`_translator`）。
- **RecoveryCoordinator** — 断线重连恢复协调（session 记忆 `_active_session_keys`/`_session_callbacks`、恢复路由 `_recovery_routes`、双缓冲回放 `_connect_buffered`/`_recovery_buffered`）。由原 `_RecoveryCoordinator` 正名（去下划线）。
- **ApprovalFanout** — 连接级审批订阅 fan-out（`_approval_subscribers`）。
_Avoid_: `_RecoveryCoordinator`（下划线私有类名，拆分后已正名）；helper/manager——非泛工具容器，每个协作者是一个领域职责。

**配置边界 (config boundary)**:
环境变量读取的唯一位置是 `server/src/config.ts`。runtime 域（`auth` / `containers` / `chat` / `wiki` / `models` / `users`）不直接读 `process.env`，一律经 `config` 导出取配置——config.ts 即面板配置的唯一声明处与单一来源。敏感值（secret）只经环境注入（compose/K8s `environment`，dev 可用 gitignored `.env`），**不经 CLI argv 传参**（argv 泄露 `ps` / shell history）。
_Avoid_: 在模块里散读 env、新建独立「env 注册包」——前者绕过声明、后者是多余层。

**配置边界豁免 (config boundary exemptions)**:
测试 harness / fixture（如 `test/` 里测 config 解析的用例）读 env 不属于 runtime。边界是架构约定（code review 维护），非零容忍 grep。

**必填 secret 的 fail-fast (required-secret fail-fast)**:
生产（`NODE_ENV=production` 下 `server/src/config.ts` 的 read* 校验）对必填项缺失/非法即拒启动：`JWT_SECRET` ≥32 字符硬校验、`DATA_ROOT` 强制绝对路径、`SANDBOX_IMAGE` / `WIKI_IMAGE` 禁浮动 tag（无 tag / `:latest` fail-fast，准据 `readPinnedImage`）——杜绝「生产漏设 → 静默空值」的错配（`LLM_API_KEY` 旧为 `os.environ.get(...,'')`，漏设会把空 key 静默注入容器，与 issue #195「卡 creating」同类）。**dev / test 宽容不加 fail-fast**。（旧 `OPENCLAW_TEMPLATE_DIR` / `CREDENTIAL_ENCRYPTION_KEYS` 缺失 fail-fast 随 #858/#859 退役。）

**隧道 (tunnel)**:
ADR 0006 引入的接触路径 (4) 新形态：浏览器↔控制面的一条 WebSocket，握手做 JWT 验签 + 归属门（user 只能开到**自己容器**的隧道），建立后**原样透传**浏览器与容器网关之间的 OpenClaw 协议 v4 原始帧——控制面**不解析、不翻译、不注入凭证、不做 method 级授权**。隧道是 B-直连的承载：浏览器跑官方 `@openclaw/gateway-client` 的 `./browser` 协议机，把「隧道 socket」注入其 `createSocket` 当 transport，经隧道直连藏在控制面后面的容器网关。**本形态已随 T0 #801 整链退役**（现役对话面 = REST+SSE，#793）。
_Avoid_: 转发 / 代理——笼统，掩盖了「纯透传原始帧（隧道）vs 懂协议的胖中介（旧 #331 G 节桥接）」这一本质区分；旧桥接做翻译/池壳/授权，隧道一概不做。

**浏览器设备 (browser device)**:
**（历史注：设备配对整链——pairings 表、配对 REST、前端 `@noble/ed25519` 依赖——已随 T0 #801 退役，本条保留为决策历史。）**
ADR 0006 的配对单位：每个浏览器 profile（Chrome / 隐身 / 另一台电脑）生成独立 Ed25519 设备身份（存 localStorage，同 profile 多 tab 共享），独立配对、独立 approve，并为其访问的**每个容器**各持一份 deviceToken（按 `(clientId, deviceId, role)` 存）。对齐官方 webchat-ui / control-ui 的「设备即浏览器 profile」模型。
_Avoid_: 设备——脱离了「每浏览器 profile 一设备」就没意义；旧模型是「面板后端单设备、每容器一份」，新模型是「每浏览器设备 × 每容器」。

**bootstrap token**:
**（历史注：GATEWAY_TOKEN 凭证链（生成 / env 注入容器 / DB 加密存值 / 所有权门控下发端点）已随 T0 #801 与 #858/#859 整链退役，本条保留为决策历史。）**
容器网关的共享认证秘密（旧称 `GATEWAY_TOKEN`，容器创建时生成、env 注入容器、DB 加密存值）。ADR 0006 修订 spec §5.2 后，它**可经所有权门控 REST（`POST /containers/<name>/bootstrap-token`）下发给容器属主的浏览器**做首次连接认证（bootstrap auth 对首连是强制的，官方文档；该下发端点已随 T0 #801 退役）。每个容器一个共享 bootstrap token，该容器所有属主浏览器首连共用。
_Avoid_: 真值不落盘/不外泄（旧 §5.2 字面）——已修订为「可下发属主浏览器，真值仍不落前端以外的盘、不经日志」。

**会话删除 (session delete)**:
删除整个会话、历史不可恢复的面板操作。与「归档 (archive)」严格区分——归档是**未来功能**（保留数据、移出列表），未实现，届时再定义；当前所有删除一律是会话删除。UI 确认文案必须明示「不可恢复」，不得出现「先归档（可恢复）再删除」的误导表述。（换轨注：「从网关删除」叙述为 #793 换轨前历史——现役 = sessions REST DELETE（#778），删会话级联删会话沙箱（#776 契约「消费方 = #778」）。）
_Avoid_: 删除会话/移除会话——与归档混为一谈；术语必须指明「删=不可恢复」。

**软删存档 (archivedAt soft-delete)**:
#770 定稿、#781 实现的**机制面**：rewind 换锚 / fork 截断后，被放弃路线独有行（checkpoint、消息、file_journal）置 `archivedAt`——行不物理删，产品面（投影/回放/锚点解析）统一过滤不可读、无恢复入口（比较路线 = fork 并存多开）。与用户功能「归档 (archive)」（保留数据、移出列表——仍未实现）和「会话删除」（物理删）三分，互不混用。
_Avoid_: 把带 `archivedAt` 的行称作「已归档会话」——归档是会话级用户功能；机制面只说「软删存档行 / 被放弃路线」。

**附件 (attachment)**:
`chat.send` 携带的多模态内容块（wire 字段 `attachments`：`{type, mimeType, fileName, content, width, height}`），现经 REST 上传换 attachmentIds 随消息引用（#795 起；隧道内联形态已随 T0 #801 退役）。用户经浏览器采集（粘贴/拖拽/选择）上传，图片发送前**前端压缩**；content 是自由形状（0 信任），渲染端须按块类型分派。
_Avoid_: 文件/图片消息——掩盖「内联于 chat.send 帧、多类型块数组」的协议形态。
**（runtime 演进注，wayfinder #766 / #747 修订——已随 #780 落地）**：附件经 REST 上传落 `DATA_ROOT` 临时区，run 首节点确定性 **ingestion 工具**校验物化进会话沙箱 `/lab`（消息与 checkpoint 只存引用 attachmentId/path；字节不经宿主 FS 长存 / MongoDB / 对象存储），图片装配时转多模态 block；下载走 owner 门端点（不存在/越权同码防探测）。上传纳入 **session-global 文件日志**，rewind 时可被一并回退。

**审批卡 (approval card)**:
agent 执行 elevated 操作前的权限门。**现役面 = 审批三层漏斗的升级通道前端**（EscalationItem：来源护栏 + toolCall 摘要 + judge 理由，decision 仅 allow-once|deny，数据源 = 控制面事件流 SSE，#726/#729/[ADR 0015](./docs/adr/0015-approval-full-audit-trace.md)）。（历史注：网关形态——OpenClaw agent 的 elevated 命令经连接级事件（`exec.approval.requested` / `plugin.approval.requested`，不挂 runId）下发、`*.approval.resolved` 广播落定（first-answer-wins）——已随 T0 #801 整链退役，保留为决策历史。）生命周期：`pending`（待处理）→ `resolving`（已点击等回执）→ `resolved`（终态）；断线复位 `resolving → pending` 可重试，服务端失效 `→ expired`（终态不可回覆）。**终态不留痕**（[ADR 0014](./docs/adr/0014-resolved-approval-no-trace.md)，supersede #547 / [ADR 0009](./docs/adr/0009-chat-timeline-merge.md) 的留痕条目）：resolved/expired 卡从界面消失，不在对话转录中留存任何记录；未决卡（pending/resolving）留在 composer 上方待办区，落定即撤。subagent 发起的卡（agentId 即来源语义）唯一可见于 main 会话。
_Avoid_: 「审批消息」——审批卡是权限事件，不进 messages 转录、独立追踪；「操作记录 / 留痕」（resolved 卡留在时间线作审计回看）语义已随 ADR 0014 退役。
**（runtime 演进注，wayfinder #729/[ADR 0015](./docs/adr/0015-approval-full-audit-trace.md)——已落地）**：集中式下审批卡是**升级通道**的前端面（EscalationItem），「终态不留痕」supersede——三层判定全量落 `tool_approval_logs`，卡片落定即撤的渲染交互不变。

**审批三层漏斗 (approval funnel)**:
新 runtime 的审批架构（#722 根决策，#729 规格）：规则层（确定性前置，三分命中）→ LLM judge（灰区判定）→ 升级通道（罕用人工）。安全水位靠规则层白名单收紧 + judge 列拒政策，人工默认趋零；全量审计入 `tool_approval_logs`。
_Avoid_: 「审批流」——掩盖三层各自的可替换性；「自动审批」单称——人工通道是其必要组成，不是例外。

**规则层 (rule layer)**:
漏斗第一层，确定性规则判定，零 LLM 成本。路径白名单（文件类工具字面参数，`wiki|lab|/tmp` 前缀，复用 `normalizeFilePath` 语义；exec 内路径由沙箱只读根兜底，不做字面扫描）+ 命令黑名单（shell 词法解析递归拆简单命令，V1 系统破坏类四条）+ provider 端点白名单（引述 #731，运行时复验在 LLM 调用出口）。名单 V1 硬编码 + 测试锁定，admin 可配为显式非目标。
_Avoid_: 「静态审批」——规则不是只读配置，是三分判定的一支（黑名单拒/白名单放/灰区移交 judge）；把 exec 内路径纳入匹配——做不到可靠，是刻意的范围裁决。

**judge (LLM 判定器)**:
漏斗第二层，独立小模型（haiku 4.5 级）对灰区工具调用做 approve/reject 判定。输入固定为「用户输入 + 之前工具调用及结果 + 当前调用」（≤8k tokens，不喂历史判定防锚定，**不含模型自身推理输出**——主 agent 的 thinking 不在输入面）；政策**列拒四类**（系统破坏/数据外送/持久化后门/凭证访问），之外默认 approve；reject 以 ToolMessage 回喂主 agent，理由 ≤100 字。per-run 调用上限 20 次，超限升级人工。
_Avoid_: 「内容审查器」——judge 只判工具调用的政策符合性，不审生成内容（那是 TextTrace 域）；「第二意见」——judge 是安全闸门，不是建议器，其 reject 有阻断力。

**升级通道 (escalation)**:
漏斗第三层，人工审批的罕用通道。触发源：谨慎模式（users 表 `approvalMode=cautious`，全灰区进人工）/ judge 超 20 次 / 同 hash reject ≥3 次 / judge 输出畸形再败（fail-closed）。一个 run 同时只挂一个 interrupt（串行，先 pending 先弹）；48h 超时 run → `suspended`（非 failed，可 resume/abort）。前端复用 ApprovalCard 骨架（dock/状态机），decision 砍 allow-always。
_Avoid_: 「人工审核队列」——升级是 per-run 阻塞形态（interrupt/resume），不是全局工单队列；「审批模式」——谨慎模式只是触发源之一。

**轮次 (turn)**:
用户一次发送触发的完整 agent loop——一条 user 消息 + 一条 assistant 回复（含轨迹与正文），消息流上恰对应一条 assistant 消息。轮次是折叠、计时与异常判定的天然单位。
_Avoid_: 回合——暗示多方轮流对局，此处只有 user→agent 一拍。

**轨迹 (trace)**:
assistant 回复中的中间产物——思考（thinking）与工具调用（tools）。正文与附件不属于轨迹；中间文本与最终正文合并为一条正文存储、不可拆分，故同样不在轨迹之列（折叠收轨迹、正文整段留外的既成边界）。
_Avoid_: 过程/日志——笼统，掩盖「思考+工具 vs 正文」这条折叠边界。

**折叠条 (trace fold)**:
轮次**正常完成**后把轨迹收进的单个折叠块，正文与附件恒在折叠外。条面显示执行时长；历史轮无时长数据则显示步骤计数（如「执行过程 · 思考 · 3 次工具调用」）。展开只露一层——内部条目保持自身默认折叠态、可单独点开，折叠层内不再嵌套分组聚合。异常结束（报错/打断/断线宽限收尾）的轮次不折叠、保持展开，便于看原因。
_Avoid_: 二级聚合——折叠条展开后是平铺的思考卡与逐行工具行；无轨迹的轮次不渲染折叠条。

**执行时长 (turn duration)**:
用户点「发送」→ 本轮正常完成的墙钟时间，含建连排队与人工审批等待——用户感知的真实等待。流式进行中不显示，随折叠完成一并出现；<60s 显示「已执行 42s」，≥60s 显示「已执行 1 分 12 秒」。
_Avoid_: 响应耗时——暗示起算于首个响应帧、排除排队/审批，与本术语语义相反。

**文件查询通道 (file query channel)**:
控制面读取容器内文件的机制（现役对象 = wiki 容器 `/wiki` 与会话沙箱 `/lab`，ADR 0012）。**经 Docker 自带原语，不经任何 gateway 插件 API**：列目录与读文件用 dockerode `getArchive`（以容器为视角打 tar 流拉出），写文件用 `putArchive`，删文件用容器内 `exec rm`。以**容器存在（running/stopped）为前提**——容器删除时其数据一并删除，故「卷还在但容器没了」的情形不出现。不引入第三方 gateway 插件（历史评估 `openclaw-better-gateway`：捆绑 IDE/终端/写删、CORS 全开、自实现 token 校验与旧 `${GATEWAY_TOKEN}` 占位不兼容，为一个只读查询暴露面过大，否决——该评估随 fleet 退役成为纯决策历史）。
_Avoid_: 走 gateway 插件/RPC 读文件——（历史评估结论，仍成立）第三方插件暴露面与认证均不可接受。

**named volume 拓扑 (named-volume topology)**:
**（历史注：OpenClaw fleet 的卷拓扑已随 #858 整体退役——现役 wiki 容器无具名卷（数据与容器同生命周期，备份 = docker export 全树 tar），沙箱文件在容器可写层，本条保留为决策历史。）**
OpenClaw 容器持久化**全用 Docker named volume，宿主零数据 bind-mount**（整洁动机：数据不散落宿主 instances 树、卷可定位）。每容器（按代系 id）：`openclaw-wiki-<id>` → `~/.openclaw/wiki/main`、`openclaw-workspace-<id>` → `~/.openclaw/workspace`、`openclaw-home-<id>` → `~/.openclaw`（承载 state/logs/extensions/skills，前两者在子路径遮蔽它，属正常叠加）。空卷首次挂载由 Docker 用镜像内 `~/.openclaw` 骨架**自动初始化**（wiki/workspace 骨架烤进自建镜像，免去独立模板 clone 与手工预填充）。删容器时 `docker volume rm` 连卷删除（`remove({v:true})` 只删匿名卷，named volume 须显式删）。
_Avoid_: bind-mount home——它要求「server 与宿主 docker daemon 解析同一宿主路径」（`/fleet` 坑，2026-08-01 生产实测），与「零 host 数据挂载」目标根本冲突。

**禁止挂 host (no host mounts)**:
生产部署除 `/var/run/docker.sock`（编排面板自管容器——会话沙箱 + wiki 容器——的唯一通道，无 volume 替代，spec §5.4 已接受等价 root 风险）外**零 host 挂载**。dev 控制面也容器化（与 prod 同形态）。（历史注：OpenClaw 时代的 researcher 模板单一来源**构建期 COPY 进 server 镜像**、模板灌卷与文件读写经 Docker 原语（`putArchive`/`getArchive`，见「文件查询通道」）、`openclaw.json` 渲染写盘链与 `/fleet:/fleet` bind 随 homeDir bind 一并退役（T0 #801/#858）——细节保留为决策历史。）
**静态 config 后果**（写盘链已随 T0 #801 退役，本条保留为决策历史）：#366 的「宿主 rename 换 inode + 目录 ro bind」热加载机制**放弃**——OpenClaw 容器配置**静态**，改配置须重启容器生效。现役 models 域配置热生效走 `config_meta` version bump（#775），不经任何容器配置面。这是 #366 决策的一次明确回退。
_Avoid_: 把 `docker.sock` 也当可删的 host 挂载——删它即失去编排能力；假设配置仍经容器配置面热加载——openclaw.json 面已退役，models 改配置走 version bump。

**消息锚点导航 (message anchor nav)**:
chat 页消息流右缘的垂直刻度轨，每个刻度锚定一条已加载的用户输入消息，支持点击定位与当前位置指示；刻度按消息在滚动文档中的位置比例分布。
_Avoid_: 对话索引、进度条——「索引」未指明只锚定用户输入；「进度条」暗示播放进度语义，实为导航目录。

**面板三态 (panel tri-state)**:
固定宽侧栏面板在本项目的三种呈现态：inline（常驻文档流可拖宽）/ collapsed（边缘窄条）/ popped（贴边全高非模态浮层）；转换链 inline → collapsed → popped → inline，窄屏 (<720px) 下整体禁用。
_Avoid_: 侧边窗口——不区分 inline/popped 两种形态；抽屉/弹窗——模态语义错误（popped 无遮罩、不因点外关闭）。

**转录条目 id (transcript entry id)**:
**（历史注：网关转录 DAG 与 `__openclaw.id` / `__openclaw.idempotencyKey` 字段已随 T0 #801 整链退役——现役消息持久化身份 = 控制面 `session_messages` 行 id（rewind/fork 的定位参数），本条保留为决策历史。）**
网关对话转录（transcript）DAG 里**单条消息**的持久化身份（`chat.history` 每条消息的 `__openclaw.id`，官方 Control UI 亦取此值）。它是回退 / fork / 分支切换的定位参数：指向「某条已落库的用户消息」。**只有已持久化消息有值**——面板本地乐观回显创建时没有，在 ack（网关已受理落库）后回读最新一页历史补齐：该轮的**发送键**（`chat.send` 的 idempotencyKey，网关侧称 clientRunId）是前缀，落库用户条目的 `__openclaw.idempotencyKey` 为 `${发送键}:user`，按此精确匹配后把 `__openclaw.id` 回填本地消息。补齐是 best-effort 且 fail-closed：未命中 / 回读失败 / 期间切走 → 保持缺省（等下次历史加载自然补上），入口照旧不渲染。流式占位全程没有。无值即不显示任何消息级操作入口。与分页锚点（`nextOffset`，数值 offset | 字符串 messageId 两态）是**不同字段**，禁止混用。
_Avoid_: 消息 id / messageId——「消息 id」在本项目已指分页锚点的字符串形态；`seq`——转录内序号，非持久化身份。

**对话回退 (conversation rewind)**:
**（换轨注：下述网关机制叙述（append-only 转录、活跃路径重定向、RPC）为 #793 换轨前历史——现役 = 控制面 sessions REST（`POST …/rewind`，#778）+ runner checkpoint 域；「作废 outbox 待发残留 + 全量重拉重建」的编排语义延续，细节保留为决策历史。）**
把某条已持久化用户消息之后的历史从**当前活跃路径**剪除，被剪的首条用户消息文本与图片附件回填 composer 供编辑重发（面板的「消息编辑」形态——官方无原地改写）。回退不改写旧数据：旧路径留在网关 append-only 存储里，改动方式是**追加一个叶子事件把活跃路径重定向**，随后转录换新代；面板侧对应「放弃在途 run + 全量重拉历史」的重建（分页态随之重置）。成功路径两件随附事（Codex #703 review）：**作废本会话 outbox 待发残留**——残留条目属于被剪的旧代，不清则下次重连 resendOutbox 会把它重发到回退后的分支（消息复活 + 意外触发 agent run）；**重拉会话列表**——回退改写该会话权威元数据（`updated_at` 可能前移、派生标题可能随被剪首条改变），刷新侧栏日期分组与头部标题（多标签页列表陈旧仍是已知可接受瑕疵，本端自己发起的 mutation 后立即刷新不是订阅）。同族的 fork / 分支切换 / 分支 CAS 复用同一套 entryId 与重建语义。确认文案须说明后果（同「会话删除」的破坏性确认原则）。
_Avoid_: 删除消息 / 撤销——回退既不删旧数据也不是还原（是剪出一条新活跃路径）；「重新生成」——那是重发当前轮，不动历史。
**（runtime 演进注，wayfinder #766 / #747 修订——已随 #778/#782 落地）**：回退扩展为**双域回退**——对话指针 + 文件状态（文件日志全局序逆放，见「文件日志」「fork 文件语义」演进注）；恢复菜单三态：只回对话 / 只回文件 / 两者同回；exec 产生的外部效应不回退（显式降级，rewind 预览列出跨越的 exec 清单）。

**回退在途 (rewind in flight)**:
**（换轨注：网关 RPC 竞态叙述为 #793 换轨前历史——现役 outbox 代际作废（`invalidateOutbox`）与 composer 门语义延续，细节保留为决策历史。）**
回退 RPC 已发出、重建管线未落地的窗口（一次 RPC + 一次全量重拉，编排层单飞——两次在途会在网关侧竞争同一活跃路径、落地序由网络决定，可能回填的不是最后一次意图）。窗口内消息投影仍是回退前的旧代：**发送被禁止**（composer 发送键置灰 + `send()` 守卫——此刻落下的 send 会被随后的放弃在途 run 吞掉：服务器端竞速下 run 被弃、乐观投影被重建冲掉，agent 却在服务端继续跑，用户消息与回复双双丢失）；**回退入口隐藏**（重入仍由编排层静默忽略，UI 门是双重防线）。输入框与附件编辑**不受限**——草稿指纹守卫保证窗口内的编辑在回填时原地保留（官方「your newer draft and attachments stay in place」）。落地后门项立即恢复。回退与 fork **在途互斥**（双向：两入口门均要求对方 busy 为假——两者同动 transcript，同时进行即网关侧乐观并发冲突）。
_Avoid_: 把窗口期入口做成「渲染可点、点到被吞」——静默吞破坏性动作的点击没有反馈；把 composer 整体置灰——窗口内继续打字是明确支持的交互。

**对话 fork (conversation fork)**:
**（换轨注：网关 RPC 叙述为 #793 换轨前历史——现役 = 控制面 sessions REST（`POST …/fork`，#778），免确认 / 源会话零动 / 播种 composer 语义延续，细节保留为决策历史。）**
从某条已持久化用户消息（entryId，切点语义与回退同源 `resolveMessageCut`——**该消息之前**的活跃路径前缀）创建**新会话**并原地切入：占位行置顶进列表（幂等）→ 标准会话切换（`resetForSession` + 全量重拉，跨会话切换连带清文件 tab = 手动切换语义）→ 新会话铺底后被点消息的文本与图片附件播种 composer。**与回退的关键差异**：免确认（源会话完整保留，非破坏性）；源会话**零动**——不作废 outbox 待发残留、不弃在途 run（网关侧 fork 不清源队列、不换源代，残留仍属合法旧代，重连 resendOutbox 照常重发）；无草稿指纹守卫（在途期间用户草稿属源会话，切换时按既有 draftKey 机制存回源 key，新会话草稿为空，播种不覆盖任何东西——指纹比对在 fork 场景是死代码）。失败分层：RPC 失败零状态变更（不 prepend / 不切换 / 草稿不动，走动作类错误通道）；RPC 成功即「网关已发生不可回滚」——新会话历史拉取失败不回切（走既有 loadHistory 失败路径），续体 stale 静默放弃播种不弹假错误。entryId / 重建语义与回退共用同一套基础设施（条目提取、能力探测、editor 载荷 0 信任校准、播种回填通道）。
_Avoid_: 复制 / 克隆会话——fork 只带切点前缀，被点消息去播种 composer 不在新 transcript 里；把 fork 做成「带确认的破坏性动作」——源会话不动，无破坏面可确认。

**分叉在途 (fork in flight)**:
**（换轨注：网关叙述为 #793 换轨前历史，门项语义延续，细节保留为决策历史。）**
fork RPC 已发出、导航 + 播种未落地的窗口（`forkBusy`）。门项照抄「回退在途」三件套（发送禁止 + 发送键置灰 + 入口隐藏）并与回退在途互斥；差异：**resendOutbox 不设栅栏**——fork 不剪源会话，待发残留重连照常重发（回退在途的栅栏针对「断线恰落在回退在途」的旧代残留竞态，fork 无此旧代）。落地后（含播种与 fail-soft 会话列表重拉）解锁，`transcriptSynced` 由新会话的权威 loadHistory 铺底自动置真。
_Avoid_: 给 fork 复制回退的 outbox 作废——源会话残留合法，作废即丢用户消息；给 resendOutbox 加 forkBusy 栅栏——重发本应照常进行。

**投影权威 (projection authority)**:
**（换轨注：`transcriptSynced` / `syncSessions` 网关握手叙述为 #793 换轨前历史——现役投影权威由控制面投影 GET（#778）与事件流 serverSeq 补齐（#773）承载，判定概念延续，细节保留为决策历史。）**
「当前消息投影 = 网关权威转录」的判定（`transcriptSynced`）：回退 / fork 这类**按历史条目定位**的动作只许在投影权威时可用。重连握手后、会话/历史同步（`syncSessions`）落地前恒**非**权威（fail-closed）——断线期间网关真实转录可能已前进，陈旧条目上的回退会剪除用户未见的轮次；任何一次权威 `loadHistory` 成功铺底（含中途失败降级部分铺底，最新页在列）恢复权威，同步全程失败保持非权威，由下次重连 / 切会话的自愈路径再置真。首连无此窗口（投影本空，无可点条目）；断线在途 run 的 resume 续帧路径不重建投影，不触碰本判定（流式门已挡住入口）。fork 成功切入新会话后的权威铺底同样置真（入口在新会话上恢复可用）。
_Avoid_: 用「能力已握手」替代投影权威——能力只回答「网关会不会受理」，不回答「用户看到的是不是最新转录」。

**会话控制能力 (session control capability)**:
**（历史注：握手能力探测（`hello-ok.features.methods`）随网关整链退役——控制面版本统一发布，无能力协商面，本条保留为决策历史。）**
对端网关是否支持回退 / fork / 分支这族 RPC 的判定：握手快照 `hello-ok.features.methods` 含全部四个方法名才算**可用**，否则面板整体隐藏这些入口（过渡期存量旧镜像容器混部时防呆——不出现点了必然报错的按钮）。能力随每次握手刷新（重连到旧网关即如实撤销）。**能力只是入口门的必要项之一**：入口渲染门 = 能力 ∧ 投影权威 ∧ 非三态忙碌（流式 / 连接中 / 已断线）∧ 非回退在途 ∧ 非分叉在途（#703 Codex P1 修订——原「不新增状态、复用三态」的决议在回退在途与重连同步两个窗口被证伪；#697 fork 增补 forkBusy 同款门项，见「回退在途」「分叉在途」「投影权威」词条）。
_Avoid_: 网关版本探测——判定依据是能力清单快照，不是版本号比较；把 capability 当「入口可点」的同义词——可点性还受投影权威与在途门约束。

**事件流 (event stream)**:
（#726 定稿，#773 上线）新 runtime 的浏览器↔控制面传输形态：每标签页一条 SSE 单工流（`GET /api/v1/events`，服务端→客户端单向），写操作（发消息/审批决策/rewind/fork）一律 REST。cookie 认证（`panel_stream`，HttpOnly/SameSite=Strict，Path 限定流端点），原生 EventSource 内置重连；线上跑服务端薄投影事件（`text.delta`/`tool.start` 等自有类型），不透传运行时原始事件。断线不影响 run——服务端继续跑，重连后按「会话投影重拉 + in-flight 从 checkpoint 重建」补齐。
_Avoid_: 断点续传——事件不落盘（#727），`Last-Event-ID` 只用于 gap 检测与去重，不重放；WebSocket——随 OpenClaw 隧道整体退役（#730 窗口末），新模型无任何双向帧。

**待发出箱 (outbox)**:
（#726 定稿，#793 REST 版落地——`frontend/src/chat/restOutbox.ts`）断线期间用户已点发送、尚未确认落库的待注入队列：本标签页 sessionStorage 落盘 + 32-hex 幂等 key，重连后按序经 REST 幂等注入；单会话上限 50 条丢最旧。REST 发送下「未确认」窗口极窄（2xx 即确认），outbox 的存在意义收敛为断线排队——用户看着服务端继续跑的半截输出追问的场景。
_Avoid_: 离线消息盒——暗示服务端持久化队列，实为 best-effort 本地窄窗；重试队列——REST 幂等去重兜底重试，队列只管「断线时还没法发」。

**会话投影 (session projection)**:
（#726 定稿，#793 落地——`sessions/reducer.ts` 投影 + `GET` 聚合行）打开会话时的权威读模型：聚合后的消息行（正文 + 轨迹附件）是产品读源，事件流是它的增量通道。断线重连后视图以投影重拉为准重建；事件序号（seq）只回答「有没有 gap」，不承载重放（重放素材 = 投影 + checkpoint）。
_Avoid_: 实时日志——投影按轮次聚合，token 级流只活在事件流里、即焚不落盘；消息表直读——产品读源是聚合行，机制表（checkpoints）不暴露读路径。

**单管线渲染 (single-pipeline rendering)**:
（#734 effort / #730 定稿，已落地——sessions reducer「实时事件 ≡ 回放投影零差异」）前端消费「会话投影」的形态约束：流式渲染与历史回放收敛到**同一条渲染管线**——视图模型由同一投影归约器产出（实时路径吃事件流增量、回放路径吃投影聚合行，同数据形状）；进行态（thinking 滚动、工具运行中、光标）是终态视图之上的**临时装饰层**，终态收敛后剥落，回放路径不构造。验收口径：流式结束瞬间的画面与刷新后重拉投影的画面，除进行态装饰外零差异。
_Avoid_: 双管线各自渲染再对齐——一致性靠「同一归约器 + 双入口」的机制保证，不靠两套代码互相模仿；把进行态做成平行消息结构——它必须是终态的叠加，否则回放路径需要反向剥离。

**沙箱 (sandbox)**:
（#728 定稿，#776 落地）绑定单个 LangGraph session（thread）的执行环境容器：agent 的 bash/read/write/update 工具在其中执行，1 session : 1 沙箱，首个执行工具调用时**惰性创建**，闲置 30 分钟自动 stop（文件保留在容器可写层），删 session 级联删除。完整工具链镜像（bash/git/Python/Node/rg/poppler/Chromium headless），每沙箱独立 bridge network（NAT 出网、容器间零互通），V1 网络默认放行 + 审计。对容器列表**隐身**——用户从 session 页进入，不感知沙箱存在。
_Avoid_: 临时容器——混用会把生命周期完全不同的容器（随 session 生灭、闲置 stop 保留文件的沙箱 vs 跑完即弃的一次性任务）混为一谈。

**wiki 容器 (wiki container)**:
（#728 定稿，#784 落地）用户 wiki 树的**永久**文件仓库：跨 session 存活，每用户一个。busybox 级极小镜像（仅 sh/mkdir/rm/cat，无 Node/Python/运行时），`NetworkMode=none` 零出网，根只读 + 可写层承载 `/wiki`，**无具名卷**（数据与容器同生命周期，备份 = docker export 全树 tar；删除路径必须带确认门）。wiki 树**零初始化**——OpenWiki 工具按需自行生成，骨架不烤进镜像。
_Avoid_: 永久容器——「永久」只是相对沙箱的生命周期形容词；named volume 拓扑——fleet 时代词条，已整体退役（见其历史注）。

**lab**:
（#728 定稿，#801 落地——files API 唯一读面 root=lab）沙箱内 agent 工作根路径 `/lab`（承载 session 工具产物，stop 保留、删 session 级联删）；wiki 容器内对应根为 `/wiki`。两路径取代全部 `~/.openclaw` 遗产路径（`wiki/main`、`workspace` 等），新容器不注入任何 `OPENCLAW_*` env。
_Avoid_: workspace——遗产字眼全面退役（files API root 参数随之改 `wiki|lab`）；home——容器内不再有 home 概念。

**容器 kind (container kind)**:
（#728 定稿，#776/#784 两支路落地；#858 三值收敛二值）容器规格分派维度，label 二值：`wiki` / `sandbox`（`researcher.kind`；`legacy` 值随 fleet 退役删除）。按 kind 走各自 create/health/delete 路径；识别无标签/外来容器 → null（防御性不触碰，准据 `server/src/containers/kind.ts`）。
_Avoid_: 用镜像名推断规格——判定必须走 label；「三值」旧叙述——`legacy` 随 #858 fleet 退役。

**fork 文件语义 (fork file semantics)**:
（#728 定稿，#778/#782 落地）fork 建新 session 时**拷贝源沙箱 `/lab`**（docker export 流式导出→导入新沙箱；源已删则空起步 + 系统消息告知 agent）；**rewind 不回滚文件**——只回滚对话指针，`/lab` 保持「未来状态」，agent 重跑工具时自行面对（与 OpenClaw 时代现状语义一致，该比对为决策历史）。
_Avoid_: rewind 恢复文件快照——文件系统无版本，回滚只在对话域。
**（runtime 演进注，wayfinder #766 / #747 修订——已随 #782 落地）**：「rewind 不回滚文件」**supersede**（翻案经产品决策程序）——rewind/branch-switch 按文件日志逆放恢复 `/lab` 至锚点时刻；fork 拷贝源沙箱**剔除墓碑目录**，新会话文件日志全新起步（rewind 深度上限从新会话起算）。

**文件日志 (file journal)**:
（wayfinder #766 定稿，#782 落地——`FileJournal` 表 + D8 rewind 水位）会话级**全局全序**的文件操作日志：文件工具与 ingestion 上传的每个字节级破坏性 op（覆写/删除）记一行（锚 checkpointId + 全局 seq + 前后 sha256 + 墓碑键 + toolCallId 幂等键 + applied 标记），墓碑字节由 daemon 侧以 root 写容器内 0700 隐藏目录（agent 结构性不可读写删）。rewind/branch-switch = 按全局序逆放逆操作；重放期间全会话文件写围栏，checkpoint 剪枝 GC 尊重 replay lease；超「文件 rewind 深度上限」降级为只回对话。exec 副作用不入日志（显式降级）。
_Avoid_: 文件快照/文件版本库——不是整树快照也不是 VCS，是操作日志 + 墓碑重放；per-thread 日志——并发下无法定义会话级回退目标（已否决）。

**对话分支 (conversation branch)**:
**（历史注：网关转录 DAG 的分支机制已随 T0 #801 整链退役；branch-switch 产品机制 #770 取消（fork 并存多开取代），本条保留为决策历史。）**
同一会话在网关转录 DAG 里的多条活跃路径候选（由回退后重说 / 从历史点 fork 产生）。面板的分支菜单（聊天头部）只在**分支数 > 1** 时渲染（单分支 / 拉取失败 / 能力缺失统一不渲染——空列表即降级语义）；每项 = 最新消息摘要（网关 `headline`，空 →「未命名分支」）+「N 条消息」+ 时间（可选槽位缺失不渲染）。active 项打勾且 disabled——网关把 no-op 切换定为 typed error，UI 从不发起；active 判定唯一权威 = 网关标记（与分支 CAS 的 leaf 基准同源，不由本地 transcript 推导）。分支数据随会话切换 / 历史加载**并行预拉**（懒拉会让按钮出现被慢历史拖累），失败静默降级；`branchesGen` 请求代丢弃乱序旧响应。切换 = 同族「破坏性 RPC + 重建管线」：outbox 代际作废（被切走分支的待发不得重发进新分支）+ 放弃在途 run + 全量重拉历史与分支列表；busy 复用「回退在途」单一 ref。0 信任校准在协议层：`leafEntryId`（switch 定位参数）缺失才砍整项，纯展示字段异形只降级自己的槽位。
_Avoid_: 懒拉分支列表——按钮需要提前知道分支数；前端自提摘要——非活跃分支的 transcript 本地不存在；把 active 项做成可点再吞错误——防线的正确位置是从不发起。

**teammate（队友）**:
（目标架构，#734 effort / #742 定稿，已实施——`server/src/runner/teammates/`）会话内具名、全并发存活、经信箱寻址的从属 agent。仅 leader（主 agent）可派生——teammate 可经信箱**申请**创建新 teammate，leader 自决不自动执行；leader 与 teammate 同时跑（runner 多路复用多 thread 的 LLM 流）；teammate 的等待 = thread park（LangGraph interrupt 态），来信 = resume 消息作输入（#724 已验证通路）；rewind 跨过派生点 → teammate 级联作废、未读留言失效；命中审批升级的 teammate 单独 suspended（leader 与其余 teammate 不停，信箱攒信随其消亡）；并发配额按**会话**计（teammate 不额外占 maxConcurrentRuns 额度）；模型派生时可选（默认跟随 leader）；leader 可注销 teammate（停调度 + thread 归档不删）。轨迹呈**具名折叠区**：主时间线只挂 leader 发言与产物，teammate 内部轨迹 + 信箱往来可展开，SSE 事件带 teammateId，teammate 间通信全量落审计域。
_Avoid_: subagent——OpenClaw 一次性派生语义的旧词，新 runtime 不用；task 工具——同步阻塞等结果的派生形态，信箱模型下不存在；嵌套派生——层级被压扁为 leader 独派 + 申请通道。

**信箱 (mailbox)**:
（目标架构，#734 effort / #742 定稿，已实施——`runner/teammates/service.ts`）每 teammate（含 leader）的持久收件箱：异步、点对点寻址（teammate↔leader、teammate↔teammate 直投，不绕 leader）；消息落控制面库表（48h 升级攒信要求跨重启持久）；等待非阻塞——干完即 park，来信 resume，超时由持久调度唤醒（BullMQ delayed job）；超时/疑似未达可**广播升级**（不只报 leader），对等 teammate 可直接追问对齐。
_Avoid_: 消息总线——广播语义；信箱是点对点寻址 + 持久收件箱；同步 rendezvous 等待——不存在，等待 = park + resume；内存队列——重启丢信，48h 攒信场景不可接受。

**figure 工具 (figure tool)**:
（#744 定稿，#792 落地——AutoFigure 插件，控制面进程内管线）图的唯一生成入口：deepagents 会话内可调用的域工具，输入图的文字描述（method_text），触发 figure run，产出 Figure 作为工具结果附件（对话内渲染/下载）。两条触发面一条执行面——agent 自动调用 + `/figure` 系统命令手动调用（#742 命令模型，不经 agent 自由裁量）。domain-scoped 工具——非文件/exec 类，不进审批三层漏斗。宿主：由官方插件目录首个插件（AutoFigure 插件）贡献，默认未启用、用户目录一键启用。
_Avoid_: AutoFigure 工具——生成链路已换轨为 AutoFigure-Edit 流水线的控制面 TS 重实现（LangGraph 固定 graph），vendored「AutoFigure」代码全部退役；用「插件」指代工具——插件是能力单元（工具+命令+渲染的集合），figure 工具只是它贡献的一个面。

**figure run（图生成运行）**:
（#744 定稿，#791/#792 落地）一次图生成流水线（生图→分割→图标准备→模板生成〔fix/optimize 循环〕→组装→预览）的执行记录：随调用方会话 run 执行（占 per-user 并发名额，不开第二套配额）。用户可见进度由会话 run 的工具调用事件承载；`figure_run.*` 事件族是机器面/审计（对齐 wiki_run 不落 SSE 用户面）。
_Avoid_: 生成任务/GenerationJob——旧 REST job 状态机实体随换轨退役（状态机/超时/reconcile 由 run 域统一机制承载），勿沿用其语义。

**Figure（图产物聚合）**:
（#744 定稿，#791/#792 落地）用户拥有的一次图生成产物聚合：输入描述 + 最终 SVG + 预览 PNG + 运行元数据（迭代数/模型/回退标记）；只持久化终产物（中间模板不落库），可经 figures API 读回与下载，是 Figure Editor 编辑闭环的持久化家。
_Avoid_: 图片——Figure 是结构化聚合（SVG 可编辑、含溯源 sessionId），不是一张位图；「AutoFigure 产物」——旧链路的 mxGraph XML 语义已随换轨退役。

**插件 (plugin)**:
（插件系统 #788 落地）面板官方内置的**能力单元**，单包双面：server 侧注册能力（工具、命令、graph、面板级配置），前端侧注册工具结果渲染（Vue 组件，编译期收录进 bundle）。插件是**能力贡献者**：只贡献工具/命令/渲染，数据与入口（表、REST 路由、错误码段、归属门）归核心。对齐 Pi-agent 扩展系统的**能力分类学**（注册工具/命令/渲染/钩子），不对齐其加载机制与信任模型——无运行时代码加载，插件全部编译期打包进面板。
_Avoid_: 扩展 (extension)——Pi-agent 术语，掩盖安全模型差异（pi 无沙箱同进程热载 vs 本项目编译期内置）；OpenClaw plugin——旧 wire 历史概念（`plugin.approval.requested`），随隧道退役，与本项目插件无关。

**官方插件目录 (official plugin catalog)**:
（插件系统 #788 落地）面板收录并提供给用户安装的全部插件的静态清单（「我们提供的插件」）。新插件 = 发版收录，无运行时上传/安装第三方代码；用户的「安装」= 从目录一键启用，不是代码获取。
_Avoid_: 插件市场/插件生态——暗示第三方开放与运行时加载，均已出局；第三方插件——目录只收官方内置。

**官方内容目录 (official content catalog)**:
（#758 方向修订定稿，#787 落地——`officialContent/` generated.ts 提交入库）面板自带的官方 commands/skills 静态目录——markdown 源文件随面板发版编译期打包（根级源目录直引，同 #752 R1 插件目录先例），always-on、无启用位、无 DB 表。commands 经模板插值注入 user message，skills 经目录注入 + 正文渐进披露（沿用 #742 机制，存储从 per-user 表换家为静态目录）；autocomplete 清单 = 前端常量 + 静态 import + 启用插件命令合并。
_Avoid_: per-user `command_defs`/`skill_defs` 表——已退役；admin 在线 CRUD 官方内容——官方内容只经 git 发版评审维护，在线写面与「无运行时自改」信任模型冲突；给官方目录开启用位——无代码 backing 的内容开关，徒增机制面。

**插件启用 (plugin enablement)**:
（插件系统 #788 + #799 落地——per-user 启用位，V1 仅 AutoFigure）per-user、跨会话持久的启用位（区别于管理员经面板级配置管的能力开关）。teammate 默认继承 owner 的启用集（与技能继承同语义）；禁用 = 新 run 不再见该插件的工具/命令，进行中 run 不中断、历史回放不受影响。
_Avoid_: 会话级开关——启用是用户维状态，不随会话生灭；面板级配置——那是管理员面（生图模型、云 API key 等），与用户启用位是两回事。

**能力实现层与用户交互层 (capability layer vs interaction layer)**:
（插件系统 #788 + #758 方向修订，已落地）插件与 commands/skills 的分层关系：插件是**能力实现层**（工具/命令/渲染背后的代码实现），commands/skills 是**用户交互层**（用户触发与引导这些能力的统一交互面）。交互层内容**全部官方维护**：插件贡献的（有代码 backing，如 `/figure` 命令背后是 figure 工具执行）+ 官方静态目录（编译期打包、always-on、无启用位，#758 方向修订 supersede #749 Q7+Q10 的 per-user 自定义面）同形并存——用户视角一个命令模型，实现层两源、内容源零用户自建。
_Avoid_: 「插件收编 commands/skills」——插件不取代官方内容目录；把 skills 归入插件——技能是内容级扩展（目录注入），无代码，不是插件的特例；per-user 自定义命令/技能与任何在线写面（admin CRUD / agent 自改自存）——已退役（#758），官方内容只经 git 发版维护。

**双面板 (two-panel split)**:
（#758 方向修订定稿，#800 落地——admin 子应用 `/admin/` MPA）产品面按「跨用户运营 vs 本人工作」切割为两个面板：用户面板 = 本人工作面（对话、wiki 只读视图、lab 文件、models 自有 provider、插件目录启用位、本人容器）；admin 面板 = 跨用户运营面（用户管理/配额、provider_endpoints 白名单、全局审计检索、usage 核算）。产物级隔离——同仓库双入口 MPA（独立 `admin.html`/路由/bundle，共享组件库与 api client），用户面板 bundle 不含 admin 代码；同一控制面、同一 JWT，role claim 区分，登录按角色落点，后端 REST 面不变只换前端承载。
_Avoid_: 单面板角色门控混入——「摘出来」是产物级隔离，不是隐藏入口；为 admin 另起服务/认证体系——隔离只发生在前端产物与路由层。

**产品显示名 (product display name)**:
「天津大学科研智能体平台」（#758 Q13 钉定，#760 执行）——用户可见面（浏览器标题、登录页品牌行、导航品牌位、可见文案、README 等面向读者的自称）对产品的唯一称呼。前端 TS 面单一来源 `frontend/src/product.ts` 的 `PRODUCT_NAME`；`index.html` 静态直写同一字面量（两处互指）。与内部标识**解耦**：GitHub 仓库名 `ACautomata/researcher-service`、npm 包名、GHCR 镜像名、容器名前缀（#747 钉内部标识）、模块路径/目录名一律保持 researcher 系不动；仓库重命名留待用户单独决定（影响 remote URL 与 CD 引用）。
_Avoid_: 用户可见文案出现 `researcher-service` 自称——那是内部仓库/模块标识，不是产品名；改名连带改仓库名/npm 包名/镜像名——改名只动显示层，内部标识零改动；动法律文案里的备案算法名（「天研文本图像生成合成算法」）——那是算法备案身份，与面板产品名不同层。

**意图识别 (intent classification)**:
（目标架构，wayfinder #846 定稿，未实施）research 插件入口图把用户请求分派到 workflow 流程前的两级判定：显式 slash 命令（`/ingest` `/discover` `/hypothesize` `/experiment`）经 `{execute}` 直达**seed 免分类**；自然语言路径由主 agent 组织 input 调用 `research_workflow`，图内 classify 节点结构化分类——5 值标签（ingest/discover/hypothesize/experiment/none）+ confidence∈[0,1]，`MIN_CONFIDENCE=0.60` 代码常量（#866 40 条中文 bad case × 3 轮实测定标）；`none` 或低于阈值 → clarify Result 回喂主 agent 反问（零新 interrupt 机制）。
_Avoid_: 意图识别写进会话主图——否决形态（每条消息付一次分类调用、误路由敞口大、核心大改，#849）；把 `none` 当第五个流程——它是显式拒识出口，不是流程；「分类兜底再猜一次」——低置信走 clarify 反问，不硬选。

**路由 (routing)**:
（目标架构，wayfinder #846 定稿，未实施）`research_workflow` 工具内嵌套路由图的分发机制：单 StateGraph + addConditionalEdges **互斥条件边**——恰一 workflow 流程分支在跑，无公共归并节点；classify 对已 seed workflow 透传不调分类器（保「同参数必同拓扑」硬约束）。图在插件工具 execute 内构造执行，不进 RunService 图实例缓存（figure 先例同构）。
_Avoid_: 子图组合——checkpoint ns 寻址与 PrismaCheckpointSaver 缺省寻址/rewind/recover 语义冲突（#847 否决）；deepagents teammate 委派路由——LLM 自由裁量违反「图拓扑必须可由持久化状态推导」；「流程编排」——路由只管入口分派，分支内时序归各 workflow 流程设计。

**workflow 流程 (workflow)**:
（目标架构，wayfinder #846 定稿，未实施）research 插件承载的四条固定科研流程：**ingest** 知识库深度构建 / **discover** 科学问题可信发现 / **hypothesize** 科学假说自主生成 / **experiment** 实验自主设计与执行。固定的是**骨架时序**不是执行段内部行为（#850）；流程互斥（单请求单流程）+ **产物串联**（后段经 wiki/lab 产物读前段产物：论文页 → critic 页 → idea card 页 → 实验报告页的单向边；发现/假说/报告落 wiki〔页面 + claims〕，中间产物落 lab）；假说 verdict 反哺（回写 idea card）V1 不做、归 V2 扩展点（#868）。
_Avoid_: 与 researcher 谓词/编排 skill 混淆——那是源仓库的提示词工作流资产（迁移素材，只读参考），本术语指目标侧图内固定流程；subagent/teammate——流程是图节点链不是常驻协作 agent（W3 扇出桶是 Send[] 并行节点，不占 teammate 语义）。

**实验方案人审 (plan review)**:
（目标架构，wayfinder #846 定稿，未实施）W4 实验流程的**流程内置无条件门禁**：design/spec 产出后必停等用户审批（与 users.approvalMode 无关），方案全文经审批卡呈现（PlanApprovalCard，escalation source 第五值 `'experiment-plan'` + plan {title, summary, text, round} 全文内联）；approve（可选附言）→ 主 agent 续执行段；deny（必填理由 ≤2000）→ 回 design 修订模式，上限 3 轮，超限 = `plan_review_exhausted` 结构化终局（run completed，非 failed）。机制 = 工具内 interrupt + spec 落盘 lab 幂等短路（resume 重放跳过 design LLM 直达 interrupt 点）。
_Avoid_: 与「升级通道」混淆——升级是审批三层漏斗的罕用人工层（触发源驱动），plan review 是流程承诺的无条件门禁，两者别钉；「方案批准豁免执行段漏斗」——两层正交：方案审科学内容（「做什么」），漏斗审系统安全（「怎么做」）。

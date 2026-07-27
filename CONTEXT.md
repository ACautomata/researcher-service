# OpenClaw Fleet 面板

多 OpenClaw 容器管理面板。Django(DRF + Channels) 控制面经四条接触路径与每个 OpenClaw 容器交互；Vue3 前端经 REST + WS 消费控制面。本 glossary 只收录**本项目特有**的领域术语，通用编程概念（Port / Adapter / Translator / Protocol 等设计模式词汇）不在此列。

## Language

**OpenClaw 容器 (OpenClaw container)**:
面板编排的单位。每个容器内跑一个 `main` agent、一个 gateway（WS，容器内 18789）、以及独立的 home / wiki / openclaw.json。它是本系统唯一的外部 bounded context。
_Avoid_: 实例——"实例"指面板侧的 `Instance` 数据模型，是 OpenClaw 容器在控制面的投影，二者不等同。

**镜像谱系 (image lineage)**:
承载 OpenClaw 容器的镜像有两个互不兼容的变体，决定容器的能力边界与挂载契约：
- **cn-im fork**（`acautomata/openclaw-docker-cn-im`）：历史部署镜像，启动时自带配置同步与权限降权（init 脚本），预装中国 IM 渠道插件，**不含 browser 运行时**（researcher 配置的 browser 插件在此镜像上无效）。
- **官方原版**（`ghcr.io/openclaw/openclaw`，分 `-browser`/`-slim` 变体）：OpenClaw 官方镜像，不自带配置同步逻辑；`-browser` 变体预装 Playwright，browser 能力可用。
_Avoid_: 「OpenClaw 镜像」——掩盖两谱系在 browser 能力、挂载契约依赖、启动方式上的本质差异；讨论迁移/换镜像时必须指明谱系。

**接触路径 (contact path)**:
backend 与 OpenClaw 容器交互的四条通道：(1) Docker SDK 编排（增删查容器）、(2) 宿主文件 bind-mount 直读写（wiki / openclaw.json）、(3) HTTP `/health` 探测、(4) WebSocket（协议 v4 + 设备配对 + 事件流）。
_Avoid_: 集成点——过于笼统，无法区分这四条性质不同的通道。

**防腐层 (Anti-Corruption Layer, ACL)**:
`backend/integration/openclaw/` 包。用 Port + Adapter + Translator 隔离 OpenClaw 的 wire 模型，防止其原生概念污染控制面 domain。**明确不追求 vendor-neutral**——保留 OpenClaw 原生命名作为事实，只在语义不一致处翻译。
_Avoid_: 网关层、适配器层（单数）——本系统是多个 Port 的集合，不是单一门面；单一门面因 chat 的双向流式回调不可行。

**wire 概念 (wire concept)**:
OpenClaw WS 协议 v4 的原生命名——事件族（`exec.approval.requested` / `plugin.approval.requested` / `agent.tool.start` / `agent.tool.result` / `chat` 的 `state`）、字段名（`deltaText` / `errorMessage` / `systemRunPlan.rawCommand`）、标识符（`runId` / `sessionKey` / `deviceToken` / `deviceId` / `operator.*` scopes）。
处置分两类：
- **标识符**：纯 id，domain 无二义 → 保留原样、集中管理、不翻译。
- **语义类**：命名或结构与 domain 不一致 → 经 Translator 翻译（如 `exec.approval.requested` → `approval`，`deltaText` → `delta`）。
_Avoid_: 协议字段——笼统，掩盖了"标识符 vs 语义类"这一关键区分。

**OpenClawWire**:
接触路径 (4) 的 Port。把"配对引导"与"配对后长连"合并为单一连接生命周期（未配对 → 配对中 → 稳态长连），消除历史上 `pairing_ws` + `chat_client` 两套独立 `connect` 帧的重复。
_Avoid_: ChatClient / PairingClient——二者是合并前的历史实现名，合并后不再区分。

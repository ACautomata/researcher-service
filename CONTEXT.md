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
接触路径 (4) 的 Port（ADR 0004，**已于 #231 收敛落地**）：**配对后长连接**（chat.send + 事件流按 runId 路由 + 连接级审批 fan-out + 只读/会话 RPC）。配对本身不在本 Port：由 `PairingHandshake` / `PairingService`（独立 seam）完成 challenge→connect→approve→持久化 deviceToken 后，pool 构造本 Port 的实现并发起无参 `connect()`。ADR 0004 据此修订了 0002 的"配对+长连合并"原意——两套 `connect` 帧的重复已由 `ConnectFrameBuilder` 偿清（与一 Port/两 Port 无关），而配对的有状态多步流程与长连事件流 shape 本质不同，故分立。实现单一（`integration.openclaw.wire_client.OpenClawWireClient`，原活实现迁入防腐层；停滞的 `OpenClawWireAdapter` 已删除），最小契约 + 向下闭合同构（Port 只声明 pool/consumers/views 依赖的方法；Impl 可更富——`request_approval`/`policy` 留在 Impl 不进 Port）。
_Avoid_: ChatClient——历史实现名（收敛后 `chat.chat_client.OpenClawChatClient` 是 `OpenClawWireClient` 的同对象 alias，strangler 过渡保留，alias 清理列 deferred；见 ADR 0004）。

**OpenClawWireClient 内部协作者 (wire-client collaborators)**:
`OpenClawWireClient` 拆分后落 `integration/openclaw/wire/` 子包（包名 `wire` 无下划线，符合「包名禁下划线」约定，呼应 `OpenClawWire` Port；2026-08 自 1120 行单类拆分，issue #271）；`wire_client.py` 退为薄壳做 identity re-export（`OpenClawWireClient`/`OnEvent`/`HISTORY_RUN_ID`/`_ConnectFrameBuilder`/`_AGENT_ID` 原 import 路径不变）。拆分**不动** Port 形态与配对边界（ADR 0004），`OpenClawWireClient` 退为**门面**——保留全部 Port 方法签名与恢复面方法（`record_active_session`/`resume_active_session`/`unregister_active_session`/`recovery_sessions`），内部委托协作者；跨桶接缝由门面编排、协作者回返值对象（`AckOutcome`/`RouteDecision`），单向依赖 门面→协作者：
- **ConnectionCore** — ws 连接生命周期（connect 握手/challenge/看门狗/dead 判定/aclose）。
- **RequestRouter** — 请求-回执路由（`_pending_acks`/`_pending_resolves`/`_rpc`/session 与 commands RPC/`resolve_approval`）。
- **RunEventRouter** — runId 事件路由 + 翻译 + 终态清理（`_routes`/`_translator`）。
- **RecoveryCoordinator** — 断线重连恢复协调（session 记忆 `_active_session_keys`/`_session_callbacks`、恢复路由 `_recovery_routes`、双缓冲回放 `_connect_buffered`/`_recovery_buffered`）。由原 `_RecoveryCoordinator` 正名（去下划线）。
- **ApprovalFanout** — 连接级审批订阅 fan-out（`_approval_subscribers`）。
_Avoid_: `_RecoveryCoordinator`（下划线私有类名，拆分后已正名）；helper/manager——非泛工具容器，每个协作者是一个领域职责。

**配置边界 (config boundary)**:
环境变量读取的唯一位置是 `config/settings/*.py`。runtime app（`containers` / `chat` / `wiki` / `models` / `accounts`）不直接读 `os.environ`，一律经 `django.conf.settings` 取配置——settings 即面板配置的唯一声明处与单一来源。敏感值（secret）只经环境注入（compose/K8s `environment`，dev 可用 gitignored `.env`），**不经 CLI argv 传参**（argv 泄露 `ps` / shell history，非 Django 惯例）。
_Avoid_: 在 app 里散读 env、新建独立「env 注册包」——前者绕过声明、后者是非 Django 惯例的多余层。

**配置边界豁免 (config boundary exemptions)**:
两类 `os.environ` 读取不算违规：(1) `DJANGO_SETTINGS_MODULE` 自举——`manage.py` / `asgi.py` / `wsgi.py` 在 settings 加载前必须 setdefault，物理上无法入 config/；(2) 测试 harness / fixture（如 `tests/integration/conftest.py` 的 `INTEGRATION_VITE_PORT`、测 settings 解析的测试）——pytest 固定 `DJANGO_SETTINGS_MODULE = config.settings.dev`（pyproject.toml），测试基建读 env 不属于 runtime。边界是架构约定（code review 维护），非零容忍 grep——`prod.py` 故意 `os.environ['DJANGO_SECRET_KEY']` 硬读即为反例。

**必填 secret 的 fail-fast (required-secret fail-fast)**:
生产（`prod.py` 的 `validate_prod_env`）对必填 secret 缺失即拒启动（`DJANGO_SECRET_KEY` 硬读、`LLM_API_KEY` 非空校验），杜绝「生产漏设 → 静默空值」的错配（`LLM_API_KEY` 旧为 `os.environ.get(...,'')`，漏设会把空 key 静默注入容器，与 issue #195「卡 creating」同类）。**dev / integration 宽容不加 fail-fast**——integration CI 恰恰靠 `LLM_API_KEY` env 注入跑真容器，强制非空会打红。

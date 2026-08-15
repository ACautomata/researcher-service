# AutoFigure 集成 —— grilling 决策记录

> 状态：**决策记录**。本文件记录 grilling 阶段（2026-08-15）已批准的架构决定。
> **这不是最终规格，不是 ticket 列表。** 不包含实现步骤、不预判代码改动清单。
> 产生方式：需求/架构 grilling 会话，逐项裁决（含与代码库事实的核对与挑战）。侦察事实基础见 [reconnaissance.md](./reconnaissance.md)。
> 集成目标：`ResearAI/AutoFigure`（**非** AutoFigure-Edit；`docs/research/autofigure-edit-codebase.md` 是姊妹项目，非本集成实现来源）。

## 仓库基线（reconnaissance 使用）

| 仓库 | 角色 | HEAD |
|---|---|---|
| researcher-service（`ACautomata/researcher-service`） | 宿主 | `e1234ebfff311cebc48f93ae87e44a3d71a61267` |
| AutoFigure（`ResearAI/AutoFigure`） | 集成目标 | `454ee868b9e253d2dbf990b42c4e964b93e498fd` |
| skills（`mattpocock/skills`） | 工程流程参考 | `8b78b531ab965735c5dc74f6f7a219e1e37326df` |

---

## 1. Fixed V1 product decisions（固定 V1 产品决策）

- **v1 能力集**：text-to-figure 初始生成 + PNG 下载 + 历史列表/详情重开。
- **v1 不包含**：PDF/论文输入、continue/refine 反馈迭代、手动 draw.io 编辑、finalize 独立操作、enhancement/beautification。见 §13。
- **Figure 是用户可见、可拥有、可历史查询的领域资源**；Generation/Job 是一次后台执行记录。
- **v1 的最小用户旅程**：登录 → 输入描述 → 提交生成 →（轮询进度）→ 查看 PNG 预览 → 下载 → 历史可回看/重开。

## 2. Domain model decisions（领域模型决策）

- **Figure** = 用户面对的唯一聚合。属性含输入 prompt、归属、生成状态、产物（XML + PNG + evaluation/metadata）、时间线。
- **Job（Generation）= 执行记录**，不承载 Figure 生命周期。
- 概念形态：`Figure └── Job`（1:N），**不是** `Job └── Figure lifecycle`。
- 一次 initial generation 对应一个独立 Job。
- **v1 不引入**：FigureProject（多图分组）、FigureRevision、通用 `operationType = initial|continue|refine|enhance` 抽象。
- continue/refine/manual-edit/enhance 的领域模型在 v2 重新设计，v1 不为未来预留。

## 3. Authentication and authorization decisions（认证与授权决策）

- **Figure.ownerId 只来自认证的 researcher-service 身份**（JWT 派生），永不来自客户端提交。
- Job 经 Figure 间接确定 owner；worker 不依赖浏览器 session 恢复身份。
- 访问控制复用既有 `getInstanceForUser` 同款归属门（不存在 vs 越权同码防探测）。
- v1 无共享、无跨用户访问；admin 跨用户全部可见/可删（对齐面板 admin 语义）。
- **v1 无用量配额**；仅并发护栏（见 §5）。
- 既有 researcher-service 认证体系保持权威，不引入第二外部认证系统。

## 4. Credential decisions（凭证决策）

- **系统级共享凭证**：provider key 经服务端 config/env 注入，**不经请求体、不入 Job payload、不落盘**。
- **新配置域** `AUTOFIGURE_*`（如 `AUTOFIGURE_LLM_KEY`），**不复用** `LLM_API_KEY`（其语义为「注入 OpenClaw 容器的 key」）。
- v1 允许 provider：openrouter + gemini（README 默认）；bianxie 可选。
- **v1 无图片生成凭证**（无 enhancement）。
- 凭证由 worker 从服务端配置获取，Python 不管理、不持有、不暴露。

> 实现级命名（env 变量名 `AUTOFIGURE_*`、`AUTOFIGURE_LLM_KEY`）为已批准的**设计方向**；确切拼写与值由 /to-spec 对照仓库约定（`server/src/config.ts` 声明、部署 compose env）核实后再定为准。

## 5. Async execution / job-runner decisions（异步执行 / Job Runner 决策）

- **执行必须异步于 HTTP 请求生命周期**：POST /figures 快速返回，不等 AutoFigure 完整生成结束。
- **SQLite/Prisma 是 Job application state 的唯一持久化事实源**；不以进程内存队列为事实源。
- 状态机：`queued → running → succeeded | failed`。
- **concurrency = 1**；v1 明确不支持 Python 并发执行。
- worker 从持久化的 queued jobs 领取工作；**不建设通用 queue abstraction / framework**；runner 局部化到 AutoFigure 执行边界（可替换，未来可整体换 BullMQ 而 Public Figure API 不变）。
- **无自动 retry**（timeout 或 failed 均不自动重试）；「再次生成」= 用户显式新建 Figure + Job。
- **超时**：`AUTOFIGURE_JOB_TIMEOUT_MS`，默认 **30 分钟**，经既有 config boundary 配置（不散落 hard-code）。
- **超时从进入 running 起算**，不含 queued 等待时间；超时 → 确定 failed，不停留 running。
- **崩溃恢复**：succeeded/failed 状态保留；queued 不因重启丢失；遗留 running 启动时 reconcile → failed。
- **幂等**：提交带幂等键，防双击重复扣费。
- **AutoFigure 不新增 Redis/BullMQ 依赖**（注意：Redis 已存在于部署栈，为容器生命周期队列所用；本决策是「AutoFigure 不新增依赖」，非「面板无 Redis」）。

> 实现级命名（`AUTOFIGURE_JOB_TIMEOUT_MS`）为已批准的**设计方向**；确切拼写由 /to-spec 对照 `config.ts` 声明核实。

## 6. Persistence / artifact decisions（持久化与产物决策）

- **必须 survive restart**：Figure 元数据、iterations（XML/PNG/evaluation/metadata）、Job 状态。
- **产物存储**：SQLite BLOB（PNG）+ 文本列（XML）。面板无对象存储，不引入；未来对象存储可迁（预留扩展点，不建抽象层）。
- **FileArchive 不是 v1 产物交换/存储机制**（见 §14）——其语义为「OpenClaw 容器内文件」通道，AutoFigure 不在容器内产文件。
- **下载契约**：独立 `GET /figures/:id/png`，仅 owner 且仅 succeeded 可下载；未完成/失败给明确应用级响应，不返回模糊 500。
- **删除**：属主删自己的 Figure；admin 删任意；硬删，对齐「会话删除」不可恢复术语。

## 7. Python boundary decisions（Python 边界决策）

- **形态**：内部 HTTP sidecar 容器，panel-net 内，**不暴露宿主端口**（私有/内部）。
- **Python 无状态**：每个 Job = 独立 AutoFigure session（创建→跑完→销毁），不持久化。
- **Python 不接收 researcher-service JWT、不接收 userId**；只收生成参数 + 服务端注入的 provider 凭证。
- **Python 不拥有 public Job 状态**；researcher-service 拥有对外生命周期/状态。
- 服务间信任：网络隔离（panel-net 私有）；凭证由 researcher-service 注入而非 Python 自主获取。

## 8. Frontend decisions（前端决策）

- **Vue-native**（`frontend/` 既有 Vue3 + Element Plus）；不引入 React/Next iframe 或 sub-app。
- 新增 `AutoFigureView`（输入 → 预览 → 下载 → 历史），复用既有 auth store / 信封解析 / 轮询 / 下载卡先例。
- **无 draw.io**、无手动画布；v1 的「预览」= 生成 PNG 渲染。
- 不复制 AutoFigure 前端壳（Next 页面结构、Tailwind/Radix、localStorage config 传递）。

## 9. Public API semantics（公开 API 语义）

- **POST /figures**：校验认证 + 输入 → 持久化 Figure + queued Job → **HTTP 200 信封**（遵循全局信封不变量），`data` 含 `{figureId, jobId, status:'queued'}`。语义等价 202 Accepted，**不引入 HTTP 202 特例**。
- **GET /figures**：当前认证用户自己的 Figure 历史（以 Figure 为单位，非 Job）。
- **GET /figures/:id**：Figure metadata + 应用级生成状态。
- **GET /figures/:id/png**：仅 owner、仅 succeeded 下载。
- Public API 只暴露**应用级 job 状态**，不泄露 queue/worker/Python/BullMQ 实现细节。
- 失败保留**非敏感**错误信息（前端稳定失败态），不暴露 provider secret / raw stack trace / Python internals。
- 错误码段：**`7xxxx` 新段**（0/1/2/3/4/5/6/9 已占用，7 空闲）。

> 错误码段 `7xxxx` 为已批准的**设计方向**（「40 不存在/越权同码」「41 冲突」的锁式与既有各域一致）；确切码值/常量名由 /to-spec 对照 `server/src/codes.ts` 核实。

## 10. Deployment decisions（部署决策）

- 新增第 4 镜像：`autofigure`（Python + Playwright chromium 构建期安装 + 依赖），走既有 GHCR 镜像管线。
- compose 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）。
- **零 host 挂载**（ADR 0013）；config 入镜像。
- 不复制 AutoFigure 的 `start.sh`/`stop.sh`/Flask app 形态。

## 11. Testing decisions（测试决策）

- 主接缝：server 侧 `FigureAdapter` Port（生产 = HTTP 调 sidecar / 测试 = fake），照 `FileArchive`/`LifecycleQueue`/`FakeGateway` 范式。
- Python contract 测试：sidecar HTTP 契约 schema 校验（给定输入 → 断言响应 JSON 形状），集成测试 mock 或真起 sidecar；**不补 AutoFigure 内部单测**。
- 认证 HTTP 测试：`setupTestApp` + seedUser + 归属断言（越权同码）。
- E2E boundary：门控 smoke（需真 sidecar + 真 key），对齐 containers-smoke 门控模式。

## 12. Rollout decisions（发布决策）

- **feature flag 默认关闭**：`AUTOFIGURE_ENABLED=false`；关闭时路由/worker/sidecar 依赖不装配。
- dev compose 先行 → CD 加镜像分步。
- 复用既有部署面（宝塔 + GHCR + /api/health 门），新增镜像独立推送。

> `AUTOFIGURE_ENABLED` 为已批准的**设计方向**；确切 flag 命名与装配点由 /to-spec 对照既有 config 模式（条件挂载先例 `app.ts`）核实。

## 13. Explicit V1 out-of-scope items（明确 V1 不做）

- 手动 draw.io 编辑 / 画布
- continue / refine（文本反馈迭代）
- finalize 独立操作（v1 只有 initial generation）
- enhancement / beautification
- paper / PDF 输入
- FigureProject（多图分组）
- FigureRevision（版本）
- 通用 operationType 抽象
- 每用户凭证 / 凭证管理 UI
- 共享（跨用户访问）
- 用量配额
- 对象存储 / 分布式产物存储
- SSE / WS 进度（v1 仅 REST 轮询，粒度 = Job 状态，无中间百分比）
- 自动重试
- Python 并发（concurrency > 1）
- 通用 Job 管理 UI

## 14. Rejected alternatives and why（被否决的方案与理由）

| 方案 | 否决理由 |
|---|---|
| **同步公开生成请求**（POST /figures 同步等待生成完成） | nginx `/api/` 代理读写超时 300s（`frontend/nginx.conf:49-50`）；AutoFigure 单次生成 ~20min（README），部署层即被 504 掐断。**300s 事实直接否决同步** |
| **BullMQ 作为 AutoFigure v1 队列** | v1 需求为 concurrency=1、串行、无 Redis 新增依赖、无通用队列；BullMQ 属过度建设。既有「进程内任务句柄」范式对 20min 长任务不可接受，需持久化状态 |
| **公开 Python 服务**（浏览器可达） | 违反「浏览器不得直连未认证 AutoFigure Python 后端」硬约束；Python 无鉴权（`verify_token` 不校验） |
| **浏览器 → Python 直连** | 同上；且凭证暴露爆炸半径不可接受 |
| **浏览器提供 provider 凭证**（key 随请求体传 Python） | AutoFigure 现行为（`autofigure_routes.py:366` 硬性要求请求体 api_key）；与 ADR 0005「敏感值只经 env 注入」、ADR 0001 直接冲突 |
| **FileArchive 作为 v1 产物交换/存储** | `files/fsPort.ts` FileArchive 语义为「OpenClaw 容器内文件」通道（ADR 0012）；AutoFigure 不在容器内产文件，硬套容器模型错误 |
| **TextTraceLog 作为 Figure/Job 审计存储** | `TextTraceLog`（`schema.prisma:71`）字段为聊天语义（containerName/sessionKey/runId/inputText/outputText/outputHash）；specs 明示「纯图片消息不落 TextTraceLog」；Figure/Job 表自带审计 |
| **React/Next iframe 或 sub-app** | 双前端壳 + 两套登录态（违反「不引入第二认证系统」）；v1 无画布后 iframe 保留 React 壳的唯一价值消失；「不复制 standalone app shell」约束 |
| **draw.io / 手动编辑（v1）** | 最大前端成本；v1 能力集不含编辑；v2 若做须自托管（隐私：图内容不出基础设施），不用外部 embed |
| **HTTP 202 特例** | 全局信封不变量「所有 REST 一律 HTTP 200」（`envelope.ts`）；202 破坏 `client.ts` 统一解析；语义经 200 信封 + `status:'queued'` 等价表达 |

## 15. Decisions intentionally deferred to V2+（延后到 V2+ 的决定）

- continue / refine（文本反馈迭代）与 finalize —— 届时重新设计 FigureRevision / GenerationOperation / Job 关系
- 手动 draw.io 编辑（自托管优先于外部 embed）
- enhancement / beautification（需引入图片生成凭证）
- paper / PDF 输入
- FigureProject 分组、FigureRevision 版本
- 每用户凭证（ADR 0001 加密基建已具备，v1 不做 UI/隔离）
- 用量配额（`maxContainers` 配额机制为容器设计，扩展至生成属 v2）
- 对象存储 / 分布式产物
- SSE / WS 进度通道
- Python 并发（>1）、分布式 worker、优先级、调度、限流
- 通用队列抽象 / 框架（若未来需求出现，在既有执行边界后换 BullMQ 或其他）

---

> 本文件不含任何新增架构决定；所有条目均来自 grilling 阶段已批准内容。实现级命名（env 变量、错误码段、feature flag）标注为「设计方向」，由 /to-spec 对照仓库约定核实后再定准。

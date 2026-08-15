# T03 — Single-worker generation lifecycle

## Parent specification

Reference: `docs/autofigure/spec.md`（§1 领域模型 · §2 状态机 · §5 异步执行 · Testing Decisions 主接缝）
Source of truth: `docs/autofigure/grilling-decisions.md` §5 / §11

## What to build

交付 AutoFigure 的**异步执行核心**：唯一新架构 Port + 单写者 runner + 状态机。这是「先跑通执行生命周期」的骨架，超时硬化（T04）在其后叠加。

- **`AutoFigureGenerationPort`（窄边界）**：normalized 生成输入 + 服务端注入凭证 → normalized result / failure。**不拥有**持久化 / 状态机 / 领取 / 轮询 / 超时 / reconcile / 幂等 / 归属 / 信封。测试用内存 fake（成功/失败可编排）。
- **runner（单写者泵）**：从持久化 queued jobs 领取；**queued→running 领取须原子**（至多一次，无两个执行体同时认领同一 Job）；`concurrency=1`；**不建设通用 queue abstraction / framework**；runner 局部化到 AutoFigure 执行边界（可替换，未来整体换 BullMQ 而 Public Figure API 不变）。
- **状态机**：`queued → running → succeeded | failed`；**无自动 retry**（timeout 或 failed 均不自动重试，再次生成 = 用户显式新建 Figure + Job）；合法转换仅限 queued→running、running→succeeded、running→failed；succeeded/failed 为终态，明确拒绝非法回迁。
- **失败语义**：Port 返回 failure → Job 进入 `failed` 并填充**非敏感** `errorMessage`（不暴露 provider secret / raw stack trace / Python internals）。T01 已建 `errorMessage` 列，本票填充它（属 runner 产出语义）。
- **schema 演进**：`generation_jobs` 增加 `startedAt` / `finishedAt`（执行时序列）——经 `upgrade-schema.mjs` + 幂等测试。
- **凭证注入**：worker 从服务端 config 取凭证，在调用 Port 时注入；**永不经请求体、不入 Job payload、不落盘、不入日志**。
- **config**：`AUTOFIGURE_*` 子域（含 `AUTOFIGURE_JOB_TIMEOUT_MS` 值管道的设计方向；超时**行为**属 T04）。
- **flag 关**：runner 不启动，queued jobs 保持 queued。

## Blocked by

**T01**（两表 schema + POST 骨架）。

## Why this ticket exists

架构证明：异步执行核心、唯一的架构 Port、以及「执行层可替换」——状态机 / 领取 / 转换由应用层拥有，AutoFigure 只提供计算能力。是 T04/T06/T07 的实现与测试基础。

## Acceptance criteria

- [ ] Port fake 成功 → Job 经 queued→running→succeeded；`startedAt` 进入 running 时置位、`finishedAt` 终态置位。
- [ ] Port fake 失败 → Job 经 running→failed；`errorMessage` 为**非敏感**原因。
- [ ] **原子领取**：两个并发领取尝试同一 queued Job → 恰一个成功（至多一次）。
- [ ] **concurrency=1**：多个 queued jobs 时同时只跑一个。
- [ ] **非法转换拒绝**：failed→succeeded、failed→running、succeeded→running、succeeded→failed 均被拒绝（终态不可逆）。
- [ ] **无自动重试**：failed 后不自动重跑；再次生成需新 Figure+Job（不实现「再次生成」的自动化）。
- [ ] 凭证注入：fake 断言注入的凭证**绝不**出现在 Job 行 / payload / 日志 / 响应。
- [ ] flag 关 → pump 不启动，queued 不迁移。
- [ ] Public API 只暴露应用级状态，不泄露 queue/worker/Python 实现细节。
- [ ] schema 升级幂等：`startedAt`/`finishedAt` 列可重入添加 + `schemaUpgrade.test.ts` 覆盖。

## Relevant global invariants

- **Figure 1:1 GenerationJob**（本票不改变基数）。
- **SQLite/Prisma 是 Job application state 唯一持久化事实源**（grilling §5）。
- **状态机为唯一对外状态语义**；应用级状态暴露，不泄露实现（grilling §9 / spec §2）。
- **无自动 retry**；**无 BullMQ AutoFigure 依赖**（grilling §5）。
- **凭证只经服务端注入**，永不经请求体/不落盘/不入日志/追踪/公开错误（grilling §4 / spec §6）。
- **V1 无 Figure 删除**（超时也**不删除** Figure，见 T04 与 spec §2）。
- **`AutoFigureGenerationPort` 保持窄**：不拥有生命周期/状态机/持久化/幂等/领取/超时/归属/信封。

## Explicitly out of scope for this ticket

- **幂等（`Idempotency-Key`）→ T02**：runner 不感知幂等；幂等是创建路径契约。
- **超时到期行为 / 启动 reconcile / 迟到结果围栏 → T04**：本票只建立转换框架，不实现超时截止与重启对账。
- **产物持久化 → T06**：本票的「成功结果」仅到应用层返回，不落 xml/png/evaluation。
- **HTTP adapter 生产实现 → T07**：本票只用 fake Port；**凭证到 sidecar 的具体 HTTP 传输表示（内部 header/字段/编码）属 T07 契约，本票不预决、不规定。**
- **列表/详情/归属门 → T05**；前端 → T09；dev/prod 打包 → T10 / T11。
- **删除**：V1 无删除，本票无任何删除路径。

## Testing seams

- **runner/application 接缝**：runner 单测（领取原子性 / 转换 / concurrency）——纯应用层，不经 HTTP。
- **`AutoFigureGenerationPort` fake/contract 接缝（唯一新接缝）**：注入内存 fake（成功/失败编排）覆盖状态机转换；生产实现 = HTTP 调 sidecar（T07）。
- **config 接缝**：flag 开关 / 超时值注入。
- 不为 Job 状态机另设第二架构 Port；状态转换的聚焦纯函数测试允许，但不发明通用 JobStateMachine 架构。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

# T02 — Idempotent Figure creation

## Parent specification

Reference: `docs/autofigure/spec.md`（§3 幂等契约子节 · Testing Decisions 幂等验收）
Source of truth: `docs/autofigure/grilling-decisions.md` §17（完整幂等契约，V1 已批准，15 条）

## What to build

在 `POST /figures` 上交付 **grilling §17 的完整幂等契约**：`Idempotency-Key` 必带、按 `(userId, key)`
作用域去重、持久化 survive 重启、确定性比较语义、成本保护不变量。

- **`Idempotency-Key` 请求头必带**（缺失 → 校验错误，90002）。
- **幂等关联**：按认证用户作用域 `(userId, idempotencyKey)` 唯一；`userId` 只由认证上下文派生，客户端不得把 userId 作为幂等身份发送；不同用户可独立使用同一 key。
- **持久化**：幂等关联落 SQLite/Prisma（survive 重启）；**不得**用进程内存 map。schema 演进经 `upgrade-schema.mjs`（幂等键列 + `(ownerId, idempotencyKey)` 唯一索引），并补 `schemaUpgrade.test.ts` 幂等覆盖。
- **同一逻辑原子创建边界**：首次有效 POST = 校验认证 → 校验 prompt → 持久化 Figure → 持久化 1:1 queued Job → 持久化幂等关联（全部一起成功）。
- **确定性比较语义**：同 key + 语义相同输入 → 返回已创建的 Figure/Job 及当前应用级状态；同 key + 不同输入 → 稳定幂等冲突（「41 冲突」锁式落 7xxxx 段），不得覆盖/改写原 Figure 或 prompt、不得建第二个 Figure/Job。比较输入 = 规范化创建载荷（不含 userId / 凭证 / 时间戳 / 内部字段 / 服务端 ID）；实现可存规范化字段或确定性 fingerprint。
- **成本保护不变量**：同 key 多次投递/重试/双击 ⇒ **至多一个 Figure、至多一个初始 GenerationJob**。

## Blocked by

**T01**（POST /figures 骨架 + 两表 schema）。

## Why this ticket exists

幂等是防重复扣费的成本保护不变量（grilling §5 / §17），且是已批准契约的全部行为面。
本票证明：重放无论原始 Job 处于 queued/running/succeeded/failed 任一状态都返回同一 Figure/Job——**状态经持久化 fixture 布置，不依赖 runner**。

## Acceptance criteria

（对应 grilling §17.15 验收清单，全部经 **persisted fixture 布置状态** 后走 REST 接缝验证，不依赖 runner）

- [ ] 缺失 `Idempotency-Key` → 校验错误，不建任何行。
- [ ] 首次有效创建 → code 0，一个 Figure + 一个 queued Job + 幂等关联。
- [ ] 同用户 + 同 key + 同输入重放（原始 Job 状态 = queued）→ 返回同一 Figure/Job，**零新增行**。
- [ ] 同用户 + 同 key + 同输入重放（原始 Job 状态 = **running / succeeded / failed**，经 fixture 布置）→ 返回同一 Figure/Job 及**当前应用级状态**，**零新增行**。
- [ ] 同用户 + 同 key + **不同输入** → 稳定幂等冲突错误（7xxxx 段），原 Figure/prompt 不被改写，**不建第二个 Figure/Job**。
- [ ] **不同用户 + 同一 key** → 独立幂等作用域，各自建自己的 Figure。
- [ ] **survive 重启**：在同一 DB 上重建 app 实例后重放同 key + 同输入 → 仍返回同一 Figure/Job。
- [ ] **成本保护**：所有重放场景断言数据库不出现第二个 GenerationJob。
- [ ] 幂等比较确定性：同输入重放判定相同、不同输入判定不同；判定不依赖 userId/凭证/时间戳/内部字段。
- [ ] schema 升级幂等：`upgrade-schema.mjs` 可重入；`schemaUpgrade.test.ts` 覆盖新列与唯一索引。

## Relevant global invariants

- **Figure 1:1 GenerationJob**；幂等关联不改变 1:1（grilling §17.6 / §17.14）。
- **ownerId 只来自认证身份**；幂等身份不含 userId（§17.3）。
- **#312 信封**；幂等冲突也走信封（HTTP 200 + 冲突 code），不引入 202/409 特例。
- **幂等键仅 POST /figures 必填**；不引入平台级通用幂等框架（§17.11）。
- **V1 无删除**；删除后的幂等键复用语义 V1 不定义（§17.13）——本票不实现删除场景。
- **无自动重试**：重放不等于重试，不触发任何 runner 行为。
- **凭证不落盘/不入 payload**：幂等比较输入明确**不含** provider 凭证（§17.9）。

## Explicitly out of scope for this ticket

- **状态产生（runner）→ T03**：本票只**读** fixture 布置的状态，不实现状态迁移。
- **超时 / reconcile → T04**；列表/详情/归属门 70040 → T05；产物/PNG → T06。
- **删除语义**：V1 无删除，幂等键在删除后的复用不定义（不在任何 V1 票内实现）。
- **前端幂等键发送** → T09。

## Testing seams

- **REST 信封接缝（复用）**：`setupTestApp` + `seedUser`/`seedAdmin` + `bearer` + 信封断言。
- **持久化 fixture**：直接布置既有 Figure+Job 于各状态——**fixture 是测试技术，不是依赖边**（不因此依赖 T03/T04）。
- **schema 升级接缝**：`runUpgrade()` 幂等断言（对齐 `schemaUpgrade.test.ts` 先例）。
- 不引入新架构接缝。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

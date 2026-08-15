# T04 — Timeout / reconcile / late-result

## Parent specification

Reference: `docs/autofigure/spec.md`（§2 状态机 · §5 异步执行）
Source of truth: `docs/autofigure/grilling-decisions.md` §5

## What to build

在 T03 的执行核心之上叠加**硬化**：超时到期、启动对账、迟到结果围栏。这是状态机「终态不可逆」的关键不变量。

- **超时**：running 中的 Job 超过 `AUTOFIGURE_JOB_TIMEOUT_MS`（自**进入 running 起算**，不含 queued 等待）→ **确定性 failed**，不停留 running。超时经 config 注入短值测试，**绝不等待真实 30 分钟**。
- **启动 reconcile**：启动时遗留 running → failed（携带稳定的中断/reconcile 原因）；succeeded/failed 终态保留；queued 不因重启丢失。
- **迟到结果围栏（关键不变量）**：Job 已进入 failed（超时/中断/reconcile）后，Port 迟到的成功 XML/PNG **不得**把终态 failed 转回 succeeded，也**不得**把迟到产物发布为成功 Figure；迟到结果一律丢弃、状态不变。
- **超时不删除 Figure**：Figure 独立于 Job 终态持续存在（spec §2 / grilling §6）。

## Blocked by

**T03**（runner + `startedAt`/`finishedAt` + Port fake）。

## Why this ticket exists

崩溃恢复与资源保护：超时防止 running 永久悬挂、reconcile 保证重启不卡状态机、迟到围栏保证**终态即终态**。T06 的「产物仅 succeeded 提交」建立在本票围栏之上（T06 阻塞于 T04）。

## Acceptance criteria

- [ ] **超时→failed**：注入短超时，Job 进入 running 后推进过截止 → 确定性 failed，不停留 running。
- [ ] **超时从 running 起算**：queued 等待时间不计入超时。
- [ ] **启动 reconcile**：预置 running 行后启动 app → 该 Job → failed（稳定中断/reconcile 原因）；succeeded/failed 保留；queued 保留。
- [ ] **迟到结果围栏**：Job 已 failed 后 Port 返回成功 → 状态**保持 failed**、不转 succeeded、不发布产物。
- [ ] 超时**不删除** Figure：超时后 Figure 仍存在且可查询（配合 T05 验收路径验证）。
- [ ] 超时后**无自动重试**：failed 不自动重跑。
- [ ] 测试全程经 config 短超时 + fake Port 编排，**不真实等待 30 分钟**。

## Relevant global invariants

- **终态不可逆**：succeeded/failed 为终态；唯一 reconcile 例外 = 启动时遗留 running→failed（spec §2）。
- **迟到结果围栏**：failed 后迟到成功结果一律丢弃、状态不变（spec §2 关键不变量）。
- **无自动 retry**；**无 BullMQ AutoFigure 依赖**。
- **V1 无 Figure 删除**：超时 / reconcile 均**不删除** Figure（spec §2）。
- **SQLite/Prisma 唯一事实源**；succeeded/failed 状态 survive 重启。
- **凭证不落盘/不入日志**：reconcile / timeout 原因不携带任何 provider 凭证。

## Explicitly out of scope for this ticket

- **幂等 → T02**；**列表/详情/归属门 → T05**；**产物持久化 → T06**（本票只保证「迟到产物不发布」，不实现产物写入）。
- **HTTP adapter 生产实现 → T07**；前端 → T09；dev/prod 打包 → T10 / T11。
- **自动重试 / 删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **runner/application 接缝**：超时 / reconcile / 围栏均为应用层行为，runner 单测覆盖。
- **`AutoFigureGenerationPort` fake 接缝**：编排「running 后迟到的成功返回」，断言围栏生效。
- **config 接缝**：注入短超时（绝不真实等待）。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

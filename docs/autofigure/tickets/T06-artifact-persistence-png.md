# T06 — Artifact persistence + PNG

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 4 / 5 / 13 · §1 领域模型 · §3 公开 API）
Source of truth: `docs/autofigure/grilling-decisions.md` §6

## What to build

交付**产物持久化**与 **PNG 下载**：生成成功那一刻的 XML / PNG / evaluation 落 Figure，以及仅 owner、仅 succeeded 的下载端点。

- **产物 schema**：Figure 增加产物列——`xml`（文本）、`png`（SQLite BLOB）、`evaluation`（文本 JSON）——经 `upgrade-schema.mjs` + 幂等测试。面板无对象存储、V1 不引入；未来可迁移（预留扩展点，不建抽象层）。
- **产物提交时机**：XML/PNG 仅在 Job **提交 succeeded 终态时**一并持久化；running/failed **不落成功产物**。
- **迟到结果围栏（T04 保证，本票阻塞于 T04）**：Job 已进入 failed 后迟到的成功产物**不得**回写为 Figure 成功产物（丢弃、状态不变）——产物提交路径必须尊重围栏。
- **`GET /figures/:id/png`**：仅 owner、仅 succeeded 可下载；未完成/失败给**明确应用级响应**（非模糊 500）；非 owner / 不存在 → **70040**（复用 T05 归属 helper，本票阻塞于 T05）。
- **survive restart**：产物落 SQLite，重启后仍可下载。

## Blocked by

**T04**（迟到结果围栏）**、T05**（归属 helper / 70040）。

## Why this ticket exists

交付 V1 的价值闭环：用户拿到自己的 PNG（spec US4/5），且产物生命周期与终态强绑定——只有 succeeded 才落成功产物、failed 后迟到成功绝不复写。产物提交正确性依赖 T04 围栏与 T05 归属，故双阻塞。

## Acceptance criteria

- [ ] Port fake 返回成功结果 → Job succeeded 时，Figure 落 `xml` / `png`（BLOB）/ `evaluation`。
- [ ] running / failed → **无**成功产物落库。
- [ ] **迟到围栏**：Job 已 failed 后 fake 迟到返回成功 → 状态保持 failed，**不落产物**、不转 succeeded。
- [ ] `GET /figures/:id/png`：owner + succeeded → 返回 PNG 字节。
- [ ] owner + 未完成/失败 → 明确应用级「未就绪」响应（不模糊 500）。
- [ ] 非 owner（含 admin 以外角色）→ 70040（同「不存在」码）；不存在 id → 70040。
- [ ] **survive restart**：重启 app 后，owner 仍可下载已成功 Figure 的 PNG。
- [ ] 产物列 schema 升级幂等（`upgrade-schema.mjs` + `schemaUpgrade.test.ts`）。
- [ ] 响应为 #312 信封（下载成功路径除外——PNG 字节按既有下载契约）；错误面走信封。

## Relevant global invariants

- **Figure 1:1 GenerationJob**；产物属于 Figure（用户面对的聚合），不改基数。
- **产物存储 SQLite BLOB(PNG) + 文本(XML)**；FileArchive 非 v1 产物机制（grilling §6 / §14）。
- **迟到结果围栏**：failed 后迟到成功产物丢弃、状态不变（spec §2）。
- **70040 同码防探测**（复用 T05 归属门）。
- **V1 无 Figure 删除**：产物随 Figure 存续，无删除路径。
- **无自动重试**；**无 BullMQ AutoFigure 依赖**。
- 下载契约：仅 owner 且仅 succeeded（grilling §6 / spec §3）。

## Explicitly out of scope for this ticket

- **超时/reconcile 本身 → T04**（已交付；本票只消费围栏）。
- **列表/详情/归属门 → T05**（已交付；本票只复用其 helper）。
- **幂等 → T02**；**HTTP adapter 生产实现 → T07**（产物经 Port 结果归一化返回，本票不接 sidecar）。
- **前端预览/下载 UI → T09**；dev/prod 打包 → T10 / T11。
- **删除 / 自动过期 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **`AutoFigureGenerationPort` fake 接缝**：返回成功结果（含迟到成功编排），断言提交时机与围栏。
- **runner/application 接缝**：产物提交发生在 succeeded 提交路径（应用层）。
- **REST 信封接缝（复用）**：PNG 下载 + 70040（复用 T05 归属 helper）。
- **schema 升级接缝**：产物列幂等添加。
- 不引入新架构接缝；产物存储为 SQLite 列，不建存储抽象层。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

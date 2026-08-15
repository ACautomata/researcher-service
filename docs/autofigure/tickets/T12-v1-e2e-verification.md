# T12 — V1 E2E verification

## Parent specification

Reference: `docs/autofigure/spec.md`（Solution · User Stories · Out of Scope · Testing Decisions）
Source of truth: `docs/autofigure/grilling-decisions.md` 全表

## What to build

V1 的**最终门控集成验证**：在全部 11 票交付后，跑通**全链路 + 负路径清单**，作为 V1 发布判定的门。**本票不新增任何产品行为**——只验证已批准行为在完整栈上正确协作。

- **正路径（门控真实）**：认证 → submit（幂等键）→ queued → running → succeeded → PNG 下载 → 历史列表 → 详情重开。
- **负路径清单**（逐项断言稳定信封/行为）：
  - 未认证请求 → 鉴权错误（10001）。
  - 跨用户 Figure 访问 → 70040（同码防探测）。
  - 缺失 `Idempotency-Key` → 校验错误。
  - 同 key + 同输入重放 → 同一 Figure/Job（含 succeeded 后重放）。
  - 同 key + 不同输入 → 幂等冲突。
  - feature disabled（flag 关）→ 90005 / 前端「功能未启用」提示。
  - sidecar 不可用（flag 开）→ 可检测，不模糊 500。
  - 超时 → 稳定 failed、无产物、Figure 保留（短超时注入，不真实等 30min）。
- 逐项验收只依赖各票已声明 blockers 交付的行为；验证中发现缺口 → 归属到具体票，不在本票修补。
- 测试经既有接缝（REST / Port fake / 门控真实）+ config 短超时；**不真实等待 30 分钟**。

## Blocked by

**T09**（前端旅程）、**T10**（dev 接线 + 真实 smoke）、**T11**（生产打包 + 健康行为）。

## Why this ticket exists

V1 发布判定的唯一门：证明已批准能力集在完整栈上端到端正确，且所有负路径保持稳定信封/行为。**它是验证票，不是新功能票。**

## Acceptance criteria

- [ ] 正路径（门控真实，sidecar + key 就绪）：submit → succeeded → PNG 字节 → 历史 → 详情重开。
- [ ] 未认证 → 10001。
- [ ] 跨用户 Figure（非 admin）→ 70040；不存在 → 70040（同码）。
- [ ] 缺失 `Idempotency-Key` → 校验错误；同 key 重放（含 succeeded 后）→ 同一 Figure/Job；不同输入 → 冲突。
- [ ] flag 关 → 90005（后端）+ 前端「功能未启用」提示。
- [ ] flag 开 + sidecar 不可用 → 可检测，不模糊 500。
- [ ] 超时（短超时）→ 稳定 failed、无产物、Figure 保留。
- [ ] **V1 删除缺失确认**：全栈（API / 前端 / 文档）无任何 Figure 删除路径（owner 或 admin）。
- [ ] Figure 1:1 GenerationJob 不变量在正/负路径均保持。
- [ ] 全程不泄露 provider 凭证（响应 / 日志 / 追踪）。
- [ ] 常规套件不依赖真实 key（门控跳过）。

## Relevant global invariants

- **Figure 1:1 GenerationJob**（贯穿验证）。
- **V1 无删除**（owner 与 admin 均无）；无硬删/级联公开行为。
- **无 BullMQ AutoFigure 依赖**；**无自动重试**。
- **#312 信封**；**70040 同码防探测**；**flag 默认关闭行为**。
- **凭证永不经请求体/不落盘/不入日志/追踪/公开错误**。
- **无 V2 功能**（continue/refine/finalize/enhance/PDF 输入/draw.io 等均不在验证范围）。

## Explicitly out of scope for this ticket

- **任何新产品行为 / 新端点 / 新 UI**：本票只验证。
- **缺口修补**：验证发现的缺口归因到具体票，不在本票实现。
- **自动重试 / 删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控真实集成接缝（辅助）**：正路径与需真 key/sidecar 的负路径（自动探测门控）。
- **REST 信封接缝 + Port fake 接缝**：可在无真实 key 环境跑的大部分负路径。
- **config 短超时**：超时路径（绝不真实等待 30min）。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

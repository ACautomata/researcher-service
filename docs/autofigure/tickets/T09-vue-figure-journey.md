# T09 — Vue figure journey

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 1–7 / 9–14 · §8 前端 · §9 feature flag）
Source of truth: `docs/autofigure/grilling-decisions.md` §8 / §12

## What to build

交付 **Vue-native** 的 AutoFigure 用户旅程：输入 → 提交（带幂等键）→ 轮询状态 → 预览/下载 → 历史列表 → 详情重开。

- **新增 `AutoFigureView`**：复用既有 auth store / 信封解析 / 轮询 / 下载卡先例；`frontend/src/router` 增加受保护路由 + 导航入口。
- **提交**：携带 `Idempotency-Key`（T02 契约），解析 #312 信封；处理幂等冲突 / 70040 / 校验错误。
- **状态轮询**：REST 轮询，粒度 = Job 应用级状态 `queued → running → succeeded | failed`；**无假百分比进度**。
- **预览/下载**：succeeded → PNG 预览/下载；未完成/失败 → 明确应用级提示（含**非敏感**失败原因）；不模糊 500。
- **历史与详情**：历史列表（以 Figure 为单位）→ 详情重开。
- **flag 门**：`AUTOFIGURE_ENABLED` 关闭时**不提供导航入口**，直达访问映射为明确「功能未启用」提示（**非裸 404**）。
- **Vue-native**：不引入 React/Next iframe 或 sub-app；不复制 AutoFigure 前端壳（Next 结构 / Tailwind/Radix / localStorage config 传递）。

## Blocked by

**T02**（幂等契约：前端需发送 `Idempotency-Key` 与处理冲突）、**T06**（PNG 下载端点：前端预览/下载）。

## Why this ticket exists

交付 V1 最小用户旅程在面板内的完整 UX（spec US1–14）：用户从提交到拿到 PNG、再到历史回看/重开全部可达；flag 关闭时给出明确提示。是 T12 端到端验证的前端闭环。

## Acceptance criteria

- [ ] 客户端 API 层：提交带 `Idempotency-Key`；正确解析 #312 信封；处理幂等冲突 / 70040 / 90002。
- [ ] 视图：提交 → queued 确认（含 figureId/jobId）→ 轮询到 succeeded/failed；渲染应用级状态，无假百分比。
- [ ] succeeded → PNG 预览与下载；未完成/失败 → 明确应用级提示（非敏感原因），不模糊 500。
- [ ] 历史列表（自己的 Figure）→ 详情重开。
- [ ] flag 关闭：无导航入口；直达 → 「功能未启用」提示（非裸 404）。
- [ ] 客户端测试（vitest + mocked api client）：信封解析 / 幂等键发送 / 错误分支；视图测试覆盖状态序列。
- [ ] `vue-tsc` 类型检查通过（`npm run build`）。
- [ ] 不出现 provider 凭证于任何前端请求 / 存储 / 日志。

## Relevant global invariants

- **Vue-native**：不引入第二前端壳 / 第二认证系统（grilling §8 / spec §8）。
- **应用级状态暴露**：只消费并渲染应用级 Job 状态，不触碰 queue/worker/Python 实现细节。
- **幂等键必带**（grilling §17）；客户端不得发送 userId 作为幂等身份。
- **凭证**：浏览器**永不**持有/发送 provider 凭证（spec §6 / §7）。
- **flag 关闭行为**：无入口 + 明确提示（非裸 404）（spec §9）。
- **V1 无删除**：前端无任何删除入口（owner 或 admin）。

## Explicitly out of scope for this ticket

- **后端/执行/幂等/产物 → T01–T06**（已交付；本票只消费其 API 契约）。
- **draw.io / 手动画布 / continue / refine / enhancement / PDF 输入**：V1 无（grilling §13 / spec §8）。
- **假百分比进度 / SSE / WS 进度**：V1 仅 REST 轮询，粒度 = Job 状态。
- **删除 UI / 管理删除**：V1 无删除（任何角色）。
- **dev/prod 打包 → T10 / T11**；**E2E 门控验证 → T12**。

## Testing seams

- **前端测试接缝（复用既有）**：vitest + mocked API client（信封 / 幂等 / 错误分支 / 视图状态序列）——对齐现有 frontend 测试约定，不新造架构接缝。
- 后端行为断言复用 T02/T06 的 REST 接缝验收（本票不重复验证后端）。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

# T05 — Figure history / ownership

## Parent specification

Reference: `docs/autofigure/spec.md`（User Stories 3 / 6 / 7 / 8 / 15 · §3 公开 API · §4 错误码）
Source of truth: `docs/autofigure/grilling-decisions.md` §3 / §9

## What to build

交付 AutoFigure 的**读路径**：历史列表、详情、归属门与 admin 跨用户可见性。状态值经持久化 fixture 布置，不依赖 runner。

- **`GET /figures`**：当前认证用户自己的 Figure 历史（以 Figure 为单位，非 Job）。**admin 角色**返回**所有用户**的 Figure（跨用户可见——spec User Story 15 / grilling §3 显式规范）。
- **`GET /figures/:id`**：Figure metadata + 应用级生成状态 + **非敏感**失败原因。
- **归属门**：`ownerId` 只由认证身份派生；`GET /figures/:id` 对「不存在 vs 他人资源」复用既有 `getInstanceForUser` 同款模式**同码防探测**（70040）。
- **应用级状态渲染**：从持久化的 `status` 值渲染 queued/running/succeeded/failed（含 fixture 布置的各状态）；不泄露 queue/worker/Python 实现细节。
- **admin 可见性**：角色级覆写（对齐面板 admin 语义与既有 admin 绕过 owner 检查先例）。

## Blocked by

**T01**（两表 schema + POST 骨架）。状态布置经持久化 fixture；**不依赖 T03 runner**（详见 tickets.md「依赖边只表示真实代码/契约前置」）。

## Why this ticket exists

交付已批准的**读/历史规则**（spec US3/6/7/8）：用户可查询自己的生成与详情，admin 可监督所有用户的生成；归属门同码防探测是既有安全模式在 AutoFigure 域的复用。T06 的 PNG 下载（阻塞于本票）复用本票归属 helper。

## Acceptance criteria

- [ ] 用户 `GET /figures`：只返回**自己**的 Figure 历史；无数据 → 空列表 code 0。
- [ ] admin `GET /figures`：返回**所有用户**的 Figure（spec US15 跨用户可见；种子两个用户验证 admin 全见、user 仅见自己）。
- [ ] `GET /figures/:id`：本人 Figure → metadata + 应用级状态（fixture 覆盖 queued/running/succeeded/failed 四态渲染正确）。
- [ ] 详情含**非敏感**失败原因（fixture 布置 `errorMessage`）；不泄露 provider secret / raw stack trace / Python internals。
- [ ] 他人 Figure（非 admin）→ **70040**（与「不存在」同码，防枚举）。
- [ ] 不存在的 id → **70040**（同码）。
- [ ] 未认证 → 鉴权错误（10001）。
- [ ] 响应为 #312 信封；只暴露应用级状态，不泄露实现细节。
- [ ] 测试经 REST 接缝 + 持久化 fixture（不依赖 runner）。

## Relevant global invariants

- **ownerId 只来自认证身份**，永不来自客户端提交（grilling §3 / spec §3）。
- **归属门同码防探测**：不存在 vs 越权同码（70040），对齐 `getInstanceForUser`（spec §3 / §4）。
- **admin 跨用户可见**（spec US15 / grilling §3）；**V1 无 Figure 删除（含 admin 删除）**——本票 read-only，无任何删除/变更路径。
- **#312 信封**；**应用级状态**暴露（不泄露 queue/worker/Python）。
- **失败保留非敏感错误信息**（grilling §9 / spec §3）。

## Explicitly out of scope for this ticket

- **状态产生 → T03**：本票只渲染 fixture 布置的状态，不实现状态迁移。
- **幂等 → T02**；**超时/reconcile → T04**；**产物/PNG → T06**。
- **删除**：V1 无 Figure 删除（owner 或 admin）；本票与任何 V1 票均不含删除端点/行为。
- **前端列表/详情 → T09**；dev/prod 打包 → T10 / T11。

## Testing seams

- **REST 信封接缝（复用）**：`setupTestApp` + `seedUser`/`seedAdmin` + `bearer` + 信封断言 + 归属断言（越权同码）。
- **持久化 fixture**：直接种子 Figure+Job 各状态（**fixture 是测试技术，不是依赖边**）。
- 不引入新架构接缝。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

# T08 — Python sidecar

## Parent specification

Reference: `docs/autofigure/spec.md`（§7 Python 边界 · §10 部署 · Testing Decisions）
Source of truth: `docs/autofigure/grilling-decisions.md` §7 / §10 / §11 / §14

## What to build

交付真实计算侧的 **Python sidecar 服务**：桥接 AutoFigure 的 text-to-figure 生成能力到私有 HTTP 契约（T07），并满足可观察的跨调用隔离。

- **sidecar 服务**：监听 panel-net 私有网络、**不暴露宿主端口**；`/health` 端点；实现 T07 契约（请求 → 生成 → `{xml, pngBase64, evaluation}`）。
- **保留 AutoFigure 生成能力**：复用其 Python 生成管线（generate → XML → PNG），**非盲目重写算法**；保留/遵守适用许可与署名要求。
- **可观察的跨调用隔离**（本票规范的是**行为**）：每次调用独立完成、无跨 Job 可变状态残留、provider 配置不泄漏于响应/日志；**内部是否使用 AutoFigure session 属实现细节，本票不强制 session 实现形态**。
- **边界**：不接收 researcher-service JWT、不接收 userId；只收生成参数 + 服务端注入的 provider 凭证；不拥有 public Job 状态。
- **chromium 构建期安装**（Playwright，XML→PNG 用）；Dockerfile 就绪（供 T10/T11 引用/构建）。
- **不复制** AutoFigure 的 `start.sh` / `stop.sh` / Flask app 形态（grilling §10）。
- 仅桥接 **V1 最小生成契约**（text-to-figure 单次生成）；AutoFigure 独立 Flask API 其余端点**不接入、不整体暴露**。

## Blocked by

**T07**（sidecar HTTP 契约）。

## Why this ticket exists

把已批准的能力来源（AutoFigure）以受控形态接入宿主：能力保留、边界隔离（无 JWT/userId、私有网络、无状态残留）、行为可观察。是 dev（T10）/ prod（T11）接线与真实 smoke 的前置。

## Acceptance criteria

- [ ] `/health` 返回可用状态（panel-net 内可探）。
- [ ] **契约自测**：给定输入 → 响应符合 T07 契约 schema `{xml, pngBase64, evaluation}`。
- [ ] **跨调用隔离（行为）**：连续两次生成，第二次不受第一次状态影响；无跨 Job 可变状态残留；provider 配置不出现在响应/日志。
- [ ] 请求不携带 JWT/userId（schema 不含，或显式忽略）。
- [ ] 无宿主端口暴露（私有网络）；无 public Job 状态逻辑。
- [ ] Dockerfile 构建含 chromium（Playwright）运行时；构建期安装依赖。
- [ ] 许可/署名要求保留于镜像内容（对齐 grilling §10「config 入镜像」）。
- [ ] 不复制 `start.sh`/`stop.sh`/Flask 形态。

## Relevant global invariants

- **Python 不接收 JWT / userId**；只收生成参数 + 服务端注入凭证（grilling §7 / spec §7）。
- **panel-net 私有、无宿主端口**；浏览器绝不直连（grilling §7 / spec §7）。
- **凭证由 researcher-service 注入**，Python 不管理/不持有/不暴露（grilling §4 / §7）。
- **零 host 挂载**（ADR 0013）；config 入镜像（grilling §10）。
- **V1 无删除**；**无自动重试**；**无 BullMQ AutoFigure 依赖**。
- 保留/复用 AutoFigure 生成能力 + 适用许可/署名（spec §7）。

## Explicitly out of scope for this ticket

- **dev compose 接线 / 本地真实生成 smoke → T10**；**deploy compose + GHCR 镜像管线 → T11**。
- **Adapter（researcher-service 侧）→ T07**（已交付）；**runner/状态机 → T03/T04**。
- **AutoFigure 独立 Flask API 其余端点**：不接入、不整体暴露。
- **内部 session 实现形态**：不强制；只要求可观察隔离行为。
- **前端 → T09**；**删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **Python 契约接缝（辅助，非新架构接缝）**：sidecar 契约 schema 自测（给定输入 → 断言响应 JSON 形状）。
- **门控真实集成接缝（辅助）**：需真 sidecar + 真 key 的 smoke 由 T10 门控覆盖（自动探测，对齐 containers-smoke）。
- **不补 AutoFigure 内部 Python 单测**（grilling §11）。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

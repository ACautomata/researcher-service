# T10 — Dev sidecar smoke

## Parent specification

Reference: `docs/autofigure/spec.md`（§10 部署 · Testing Decisions E2E 门控 smoke）
Source of truth: `docs/autofigure/grilling-decisions.md` §10 / §11 / §12

## What to build

交付 **dev 栈接线**与**本地真实生成 smoke**：把 T08 sidecar 接进容器化 dev 栈，并跑通一条真实 text-to-figure 生成链路（门控）。

- **dev compose 接线**：`deploy/docker-compose.dev.yml` 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）；**零 host 挂载**（ADR 0013）；config 经 env 注入。
- **门控真实生成 smoke**：需真 sidecar + 真 key，**自动探测门控**（对齐 `containers-smoke` 门控模式）；不满足条件即跳过，常规套件不依赖真实 key。
- 验证：submit → queued → running → succeeded → PNG 字节（经完整链）。
- sidecar 可达性经 panel-net 内部（无宿主端口暴露）。

## Blocked by

**T08**（sidecar 服务 + Dockerfile）。

## Why this ticket exists

证明集成在 dev 环境真实可跑：镜像可构建、私有网络接线正确、完整生成链在本地产生 PNG。是生产打包（T11）与最终门控验证（T12）的实测前提。

## Acceptance criteria

- [ ] dev 栈 up：sidecar 服务在 panel-net 内 `up`，`/health` 可达。
- [ ] sidecar 无宿主端口暴露；零 host 挂载。
- [ ] **门控 smoke**：sidecar + key 就绪时，真实生成链 submit → succeeded → PNG 字节；条件缺失自动跳过（不失败常规套件）。
- [ ] `AUTOFIGURE_ENABLED` 开启时整链生效；config 经 env 注入。
- [ ] smoke 不等待真实 30min（超时经短超时 config）。

## Relevant global invariants

- **零 host 挂载**（ADR 0013）；config 入镜像 / 经 env（grilling §10）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）。
- **凭证只经服务端 env 注入**；smoke 的 key 来自环境，不落盘/不入日志。
- **门控测试**：需真 sidecar + 真 key 的用例自动探测门控（grilling §11 / spec Testing Decisions）。
- **无 BullMQ AutoFigure 依赖**；**V1 无删除**。

## Explicitly out of scope for this ticket

- **生产 deploy compose + GHCR 镜像管线 → T11**。
- **sidecar 实现本身 → T08**（已交付）；**adapter → T07**（已交付）。
- **前端 → T09**；**最终门控集成验证 → T12**。
- **删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控真实集成接缝（辅助）**：真 sidecar + 真 key 的 smoke（自动探测门控，对齐 containers-smoke）。
- 常规测试套件仍以 fake Port 为主，**不**因本票引入对真实 key 的常规依赖。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

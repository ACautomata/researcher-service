# T11 — Production packaging / CD

## Parent specification

Reference: `docs/autofigure/spec.md`（§9 feature flag · §10 部署 · User Stories 19 / 21）
Source of truth: `docs/autofigure/grilling-decisions.md` §10 / §12

## What to build

交付 **生产打包与 CD**：`autofigure` 第 4 镜像走既有 GHCR 管线、deploy compose 增加 sidecar 服务，并落实健康行为的**行为要求**（精确 wiring 实现定义）。

- **镜像管线**：`autofigure` 镜像（Python + Playwright chromium 构建期 + 依赖）走既有 GHCR 构建/推送管线；许可/署名（`CITATION_AND_ATTRIBUTION.md` / `TRADEMARK.md`）入镜像。
- **deploy compose**：`docker-compose.deploy.yml` 增加 sidecar 服务（panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`）；**零 host 挂载**（ADR 0013）；config 入镜像。
- **健康行为要求（行为级，精确 wiring 实现定义）**：
  - feature disabled → 面板 `/api/health` **不依赖** sidecar（panel 健康独立）。
  - feature enabled → sidecar 不可用**必须可被检测**（经既有部署面探针）。
  - 如何接线（探针合并/独立 health 端点等）**实现定义**，不硬编码到全局 `/api/health`。
- **feature flag** `AUTOFIGURE_ENABLED` 生产默认关闭（分阶段发布，必要时快速关闭）。
- 不复制 AutoFigure `start.sh`/`stop.sh`/Flask 形态。

## Blocked by

**T08**（sidecar 服务 + Dockerfile）。

## Why this ticket exists

让集成可上线：镜像管线、生产编排、许可合规，以及**可运维性**（flag 关闭时面板不被 sidecar 拖累、flag 开启时 sidecar 故障可发现）。CD 覆盖是 T12 最终验证的生产侧前提。

## Acceptance criteria

- [ ] `autofigure` 镜像构建成功并推送到 GHCR（既有管线）。
- [ ] 许可/署名文件（`CITATION_AND_ATTRIBUTION.md` / `TRADEMARK.md`）存在于镜像内。
- [ ] deploy compose 含 sidecar 服务：panel-net、`restart: unless-stopped`、资源上限、healthcheck `/health`；零 host 挂载。
- [ ] **flag 关闭**：面板 `/api/health` 独立于 sidecar（sidecar 缺失/未起时面板健康不受影响）。
- [ ] **flag 开启**：sidecar 不可用可被检测（经探针/健康面），且不模糊 500。
- [ ] `AUTOFIGURE_ENABLED` 生产默认关闭。
- [ ] 不复制 `start.sh`/`stop.sh`/Flask 形态。

## Relevant global invariants

- **零 host 挂载**（ADR 0013）；config 入镜像（grilling §10）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）。
- **凭证只经服务端 env 注入**；生产 fail-fast 配置（config boundary，ADR 0005）。
- **feature flag 默认关闭**（grilling §12 / spec §9）。
- **许可/署名保留**（spec §7）；**无 BullMQ AutoFigure 依赖**；**V1 无删除**。

## Explicitly out of scope for this ticket

- **dev 接线 / 本地 smoke → T10**（已交付）。
- **sidecar 实现本身 → T08**（已交付）；**adapter → T07**（已交付）。
- **前端 → T09**；**最终门控集成验证 → T12**。
- **删除 / V2 能力**：均不在本票（也不在 V1）内。

## Testing seams

- **门控集成接缝（辅助）**：镜像构建 / 健康行为验证可门控（对齐 containers-smoke 门控模式）。
- **config/健康接缝**：flag 开关注入验证健康独立性；不硬编码全局 `/api/health` wiring。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

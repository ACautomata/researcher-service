# T07 — AutoFigure HTTP adapter

## Parent specification

Reference: `docs/autofigure/spec.md`（§7 Python 边界 · Testing Decisions 主接缝）
Source of truth: `docs/autofigure/grilling-decisions.md` §4 / §7 / §11 / §14

## What to build

交付 `AutoFigureGenerationPort` 的**生产实现**：经私有 HTTP 调 sidecar，并**定准 sidecar 契约文档**（本票是凭证传输表示的属主）。

- **生产 Adapter**：`AutoFigureGenerationPort` 的 HTTP 实现——normalized 生成输入 → 私有 HTTP 请求 → 解析响应 `{xml, pngBase64, evaluation}` → normalized result；错误/超时 → normalized failure（映射到应用级，不泄漏 secret / raw stack / Python internals）。
- **sidecar HTTP 契约文档（本票交付物）**：定义私有 HTTP 请求表示、**凭证传输**（内部 header / 字段 / 编码）、响应形状、错误形状、超时与重试策略（无自动重试）。
- **边界**：panel-net 内私有、不暴露宿主端口；**不接收 JWT、不接收 userId**；只收生成参数 + 服务端注入的 provider 凭证。
- **Public Port 契约不变**：应用/执行层只认 `AutoFigureGenerationPort`，不感知 HTTP 细节（T03/T04/T06 不受影响）。
- 凭证由 worker 在调用时注入；**永不落日志 / 追踪 / 响应 / Job payload**。

## Blocked by

**T03**（Port 接口 + runner 消费方）。**凭证到 sidecar 的具体 HTTP 传输表示属本票契约**——T03 只约定「worker 从 config 注入凭证」，不预决 header/字段/编码；本票定准。

## Why this ticket exists

把执行层（T03/T04/T06）与真实计算（T08 sidecar）之间的边界收拢到一个生产 Adapter + 一份契约文档：应用层替换能力（fake ↔ HTTP）证明成立，凭证传输被约束在私有契约内，浏览器永不直连 Python。

## Acceptance criteria

- [ ] Adapter 按契约把 normalized 输入映射为 sidecar 请求（契约 schema 校验）。
- [ ] Adapter 解析 sidecar 响应 `{xml, pngBase64, evaluation}` → normalized result。
- [ ] 错误 / 超时 → normalized failure，映射为应用级错误（不泄漏 secret / raw stack / Python internals）。
- [ ] 凭证按契约注入（内部 header/字段），**绝不**出现在日志 / 追踪 / 响应。
- [ ] 契约文档存在且为请求 / 凭证传输 / 响应 / 错误形状的**单一来源**。
- [ ] Adapter 测试用 **mock HTTP 客户端**（契约 schema 测试），不依赖真 sidecar。
- [ ] `AutoFigureGenerationPort` 公开契约不变；T03/T04/T06 断言不因生产实现而改变。

## Relevant global invariants

- **`AutoFigureGenerationPort` 保持窄**：只代表计算能力；不拥有生命周期/状态机/持久化/幂等/超时策略/归属/信封（spec Testing Decisions）。
- **Python 不接收 JWT / userId**；只收生成参数 + 服务端注入凭证（grilling §7 / spec §7）。
- **panel-net 私有、无宿主端口**（grilling §7 / spec §7）；浏览器绝不直连未认证 Python 后端。
- **凭证永不经请求体（浏览器侧）、不入 Job payload、不落盘、不入日志/追踪/公开错误**（grilling §4 / spec §6）。
- **无自动重试**（sidecar 调用失败即应用级 failure，不自动重试）。
- **V1 无删除**；**无 BullMQ AutoFigure 依赖**。

## Explicitly out of scope for this ticket

- **sidecar 实现（Python）→ T08**；**dev/prod 打包与镜像 → T10 / T11**。
- **runner/状态机/超时 → T03/T04**（已交付）；**产物落库/下载 → T06**（已交付）。
- **幂等 → T02**；**前端 → T09**。
- **AutoFigure 独立 Flask API 其余端点**：不接入、不整体暴露（spec §7）。
- **浏览器侧凭证 / 每用户凭证**：V1 无（grilling §13 / spec §6）。

## Testing seams

- **Python 契约接缝（辅助，非新架构接缝）**：给定输入 → 断言响应 JSON 形状（schema 校验）。
- **Port 契约接缝**：Adapter 以 mock HTTP 客户端测试，验证生产实现满足 `AutoFigureGenerationPort` 契约。
- 集成测试可 mock 或真起 sidecar（门控见 T10）。

## Completion evidence

- targeted tests:
- typecheck/build:
- broader tests:
- first code review:
- fixes:
- second code review:
- commit:

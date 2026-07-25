# 为 OpenClaw 集成面建立防腐层（backend/integration/openclaw/）

backend 经四条接触路径（Docker SDK 编排、宿主文件 bind-mount 读写、HTTP `/health` 探测、WebSocket 协议 v4）与 OpenClaw 容器交互。当前 OpenClaw 的 wire 概念散落在 5+ 文件，渗透进 ORM 列名、REST 序列化器、前端 WS 契约，甚至跨 app 渗进 containers 实例列表 API；chat 的 `connect` 握手帧在 `pairing_ws.py` 与 `chat_client.py` 各写一份；`event_translate.py` 是半成品且含大量"待实测校准"的猜字段名。

**决定**：建立 `backend/integration/openclaw/` 防腐层，采用 Hexagonal（Ports & Adapters）——四条路径各对应一个 Port + Adapter，外加事件 Translator。路径 (4) 合并为单一 `OpenClawWire` Port（统一配对与长连）。Translator 只做**语义层翻译**（事件族归一、字段名差异），标识符（`runId` / `sessionKey` / `deviceToken` 等）保留原样、集中管理。以 strangler 方式落地：接口先行，实现按 health → wiki fs → docker 对齐 → wire 重写的风险梯度递进。

**为什么**：动机是**可测性**（每个 Port 可注入 fake，测试不再依赖真容器 / docker.sock / WS）与**演进隔离**（OpenClaw 升级时改动锁在集成包内）。明确**不**追求 vendor-neutral 抽象——本项目是单 vendor 本地部署面板，替换 OpenClaw ≈ 换产品，vendor-neutral 多为 YAGNI 空壳。标识符激进翻译被否决，因其要动 ORM migration + 前后端契约，防的却是低概率的"OpenClaw 给 id 改名"事件，ROI 为负。

## 考虑过但否决的方案

- **单一 Facade（一个 `OpenClawGateway` 门面包住四条路径）**：chat 是双向流式（`send` 出站 + 事件流订阅 + approval 回调），门面的 request/response 形态对不上，会退化为 god object。
- **vendor-neutral 抽象（为替换 OpenClaw 做准备）**：单 vendor 本地部署，抽象多为 YAGNI；连文件路径约定（`wiki/main`、五分类目录）都要中立项，成本翻倍且无兑现场景。
- **标识符激进翻译（`runId`→`messageId` 等）**：要改 ORM 列名（migration + 回填）+ 前端 WS 契约 + REST + 跨 app 序列化器，防的却是低概率事件。
- **路径 (4) 保持两个 Port（`PairingHandshake` + `ChatWire`）**：复制了 OpenClaw 的实现结构而非 domain 结构，且保留两套 `connect` 帧重复的认知债。

## 后果

- 跨 chat / containers / wiki / models 四 app 改 import，手术面大；用 strangler（接口先行、路径 1 实现暂留原位仅接口前移）控制风险。
- `event_translate.py` 中"待实测校准"的猜字段名，须在路径 (4) 重写阶段抓包或对照上游（`docs/research/r6` / `r13` / `r40`）固化。
- ORM 列名（`device_id` / `device_token` / `session_key` 等）保留 OpenClaw 原生命名，视为"外部 schema 的持久化缓存"；如未来出现语义冲突再议。
- 本 ADR 与 [0001-persistent-credential-encryption](./0001-persistent-credential-encryption.md) 相关——0001 覆盖的三个凭证字段（`Instance.token` / `Pairing.private_key_pem` / `Pairing.device_token`）的**加密**不变，本 ADR 只决定它们的**命名与归属边界**（列名保留、序列化经集成包翻译）。

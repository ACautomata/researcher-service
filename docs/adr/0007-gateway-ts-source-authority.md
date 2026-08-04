# ADR 0007：OpenClaw 协议知识权威来源——GitHub `.ts` 源码（非 npm 编译产物）

## 状态

已接受。确立「查证 OpenClaw 网关协议/客户端类型的唯一权威入口」；本 ADR 是**查证指南 + 经验沉淀**，不新增架构决策（B-直连与官方包复用的决策面已在 [0006-browser-direct-gateway-via-panel-tunnel](./0006-browser-direct-gateway-via-panel-tunnel.md) 覆盖）。

> 溯源：本 ADR 由一次 grill-with-docs 会话产出（2026-08-05），基于对 npm tarball 解包 + GitHub `openclaw/openclaw` 仓库 `v2026.7.2-beta.6` tag 源码的一手核实。项目 `server/package.json` / `frontend/package.json` 均锁定 `@openclaw/gateway-client@2026.7.2-beta.6`。

## 背景

面板前端直接消费 `@openclaw/gateway-client/browser` 协议机（ADR 0006 B-直连），后端隧道透传原始帧。**实现正确性完全依赖「查对的协议知识」**——查错来源 = 实现错。

- npm 包**只发布 `dist/`**（编译产物），`files` 字段不含 `.ts` 源：`dist/*.d.mts`（类型）+ `dist/*.mjs`（实现）。
- `.d.mts` 是编译产物，阅读体验差：**丢源码注释**（协议语义的权威说明在源码注释里）、**文件名哈希化**（`frames-BPnee-QV.d.mts` 无法反查源文件）、**类型被摊平**（typebox 推导出的联合类型冗长）。
- 真实的 `.ts` 源码在 `openclaw/openclaw` 仓库的 `packages/gateway-protocol/src/` 与 `packages/gateway-client/src/`（npm 包 `package.json` 的 `repository.directory` 字段指向；`build` 脚本 `tsdown src/*.ts` 可反查入口）。

## 决定

1. **查证 OpenClaw 协议/客户端类型，一律以 GitHub `openclaw/openclaw` 的 `packages/gateway-{protocol,client}/src/*.ts` 为权威**，锚定 `main` 分支——项目按滚动更新策略跟进官方，`main` 即与项目步调一致的唯一权威。不看 `dist/` 编译产物。

2. **核心 API 入口映射**（概念 → 源文件；行号以 `main` 为准，可能随演进漂移，文件路径稳定）：

   | 概念 | 源文件 |
   |---|---|
   | `GatewayProtocolClient<TPlan>`（浏览器协议机：`request`/`addEventListener`/`closeSocket`/`resetReconnectBackoff`，`createSocket` 注入） | `gateway-client/src/protocol-client.ts` |
   | `GatewayProtocolSocket` / `GatewayProtocolSocketHandlers`（transport 适配契约） | `gateway-client/src/protocol-client.ts` |
   | `GatewayBrowserDeviceAuthLifecycle`（浏览器设备配对 + token 生命周期） | `gateway-client/src/browser-device-auth.ts` |
   | `GatewayBrowserDeviceTokenStore`（token 按 `(clientId, deviceId, role)` 存） | `gateway-client/src/browser-device-auth.ts` |
   | `buildDeviceAuthPayload` / `buildDeviceAuthPayloadV3`（签名串构造） | `gateway-client/src/device-auth.ts` |
   | `selectGatewayConnectAuth` / `buildGatewayConnectAuth` / `resolveGatewayConnectScopes`（认证选择） | `gateway-client/src/connect-auth.ts` |
   | `GatewayClient`（Node 侧参考客户端）/ `GatewayClientOptions` / `GatewayClientHostDeps`（六回调） | `gateway-client/src/client.ts` |
   | `createSessionProjection` / `projectLiveSessionMessage` / `reduceSessionProjection` 等（会话投影） | `gateway-client/src/session-projection.ts` |
   | `GatewaySessionMessageSubscriptionCoordinator`（会话消息订阅协调） | `gateway-client/src/session-subscriptions.ts` |
   | `PROTOCOL_VERSION=4` / `MIN_*_PROTOCOL_VERSION` | `gateway-protocol/src/version.ts` |
   | `GATEWAY_CLIENT_IDS` / `GATEWAY_CLIENT_MODES` / `GATEWAY_CLIENT_CAPS` / `GatewayClientInfo` | `gateway-protocol/src/client-info.ts` |
   | `ConnectParams` / `RequestFrame` / `ResponseFrame` / `EventFrame` / `HelloOk` 等 wire 类型 | `gateway-protocol/src/schema/*.ts`（typebox 定义） |

3. **`protocol.schema.json` 是生成产物，不直接编辑/阅读**：它由 `gateway-protocol/src/` 的 typebox schema 生成（顶层 `{methods(350), oneOf(3 帧形), definitions(659)}`，draft-07）。需要「机器可读契约」时用 npm 包 tarball 内的 `protocol.schema.json`；需要「人读语义」时看生成它的 `.ts`（schema 源文件在 `gateway-protocol/src/schema/`）。

4. **拉取方法**（网络不稳时的 fallback 经验）：
   - 首选：`curl -sf --retry N https://raw.githubusercontent.com/openclaw/openclaw/main/packages/gateway-*/src/<file>.ts`。
   - `gh api "repos/openclaw/openclaw/contents/...?ref=main" --jq '.content' | base64 -d`（raw 域名 TLS 不稳时）。
   - sparse clone：`git clone --depth 1 --filter=blob:none --sparse` + `git sparse-checkout set packages/gateway-protocol/src packages/gateway-client/src`（大仓库全量 clone 会因 TLS 失败）。
   - 锁定版本的对照：`gh api repos/openclaw/openclaw/tags` 找 `v<日历版本>` tag，改 `ref=` 即可对照项目 lock 的历史版本。

## 为什么

- **`.ts` 是语义权威**：协议语义的说明（如 `buildDeviceAuthPayloadV3` 注释「Device signatures are byte-for-byte compared by the gateway」）在源码注释里，编译产物全丢。
- **`.d.mts` 不可追溯**：哈希文件名无法反查源文件；typebox 摊平的联合类型冗长难读。
- **锚 `main` 对应滚动更新**：项目不锁版本跟进官方，`main` 即唯一权威；若对照历史版本，用 tag 显式指定（决定 4 末条）。
- **本 ADR 与 [0006](./0006-browser-direct-gateway-via-panel-tunnel.md) 的关系**：0006 是基于 `2026.7.2-beta.6` 解包 `.d.mts` 的决策（事实已与 `.ts` 源码互证一致）；本 ADR 给后续开发「以后怎么查」的稳定入口，不推翻 0006。

## 相关

- [0006-browser-direct-gateway-via-panel-tunnel](./0006-browser-direct-gateway-via-panel-tunnel.md)（B-直连决策）
- `docs/research/openclaw-gateway-client.md`（基于 `.d.mts` 的调研记录，事实与 `.ts` 一致）
- 前端实际接线：`frontend/src/chat/tunnelSocket.ts`（导入 `GatewayProtocolSocket` / `GatewayProtocolSocketHandlers` 实现面板隧道 socket）

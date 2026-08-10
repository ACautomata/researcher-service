# 官方高层 `GatewayClient` 能否跑在面板隧道 transport 上?（issue #552）

> 研究 ticket：issue #552（wayfinder 地图 #551 的子任务）。
> 日期：2026-08-10。本文件只做事实记录与结论，不改业务代码。
> 一手来源：`frontend/node_modules/@openclaw/gateway-client@2026.7.2-beta.6/dist/*.mjs` **运行时实现**（非仅 `.d.mts` 类型）+ 本仓库 `frontend/src/chat/{tunnelSocket,gatewayChat}.ts`、`server/src/chat/tunnelAssembly.ts`、既有研究 `docs/research/openclaw-gateway-client.md`（§5）。

---

## 0. 一句话判定

**不能。** 官方高层 `GatewayClient`（readiness 层）**无法跑在面板隧道 transport 上**，且**不提供任何注入自定义 socket/transport 的途径**。它的 socket 创建写死为 `new WebSocket(this.opts.url, …)`，其中 `WebSocket` 来自 **Node 的 `ws` 包**（非浏览器原生），整个 `GatewayClient` 只在 **Node 平台入口**导出、浏览器入口根本不导出它。要在浏览器复用隧道，**只能退回裸 `GatewayProtocolClient`（`./browser`，接受 `createSocket` 注入）**——这正是本仓库现状 `gatewayChat.ts` 的形态。

---

## 1. 问题 1：`GatewayClient` 的 WebSocket 究竟如何创建？是否存在注入点？

### 1.1 socket 创建处：写死直连 `url`，用 Node `ws` 包

`dist/index.mjs`：

- **第 9 行**：`import { WebSocket } from "ws";` —— 高层客户端用的 `WebSocket` 是 **Node `ws` 包**（`package.json` dependencies 含 `ws: 8.21.1`），**不是**浏览器全局 `WebSocket`。
- **第 1293–1369 行 `createSocket(handlers)`**（`GatewayClient` 的内部方法）：

```js
createSocket(handlers) {
    const url = this.opts.url ?? DEFAULT_GATEWAY_CLIENT_URL;   // 1294: 写死 opts.url 直连
    // …isSecureWebSocketUrl 校验（ws:// 非 loopback 抛错，1302）…
    this.deps.beforeConnect();                                  // 1304: hostDeps 钩子（无操作默认）
    const wsOptions = { maxPayload: 25*1024*1024, handshakeTimeout: …, …origin };  // 1305: Node ws 专有 options
    // …wss + tlsFingerprint 时设 rejectUnauthorized/checkServerIdentity（1313-1323）…
    unregisterGatewayLoopbackBypass = this.deps.registerGatewayLoopbackBypass(url);  // 1327: hostDeps 钩子
    ws = new WebSocket(url, wsOptions);                         // 1332: ← socket 创建点，写死 new WebSocket(url)
    ws.binaryType = "nodebuffer";                              // 1333: Node ws 专有（浏览器无 "nodebuffer"）
    // …
    ws.on("open", …); ws.on("message", …); ws.on("close", …); ws.on("error", …);  // 1341-1363: Node EventEmitter API
    return { isOpen, send: (d) => ws.send(d), close: (c,r) => ws.close(c,r) };      // 1364-1368
}
```

**结论：socket 创建写死为 `new WebSocket(this.opts.url, wsOptions)`（1332），直连 `opts.url`，无任何替换机制。**

### 1.2 是否存在注入自定义 transport/socket 的途径？——**没有**

逐一排查所有候选注入点，全部证伪：

| 候选途径 | 实证结果 |
|---|---|
| `GatewayClientOptions.createSocket` / `socketFactory` | **不存在**。`dist/index.d.mts` 全文 grep `createSocket`/`socketFactory`/`socket` **0 命中**（`no socket injection key in index.d.mts`）。options 只有 `url/origin/tlsFingerprint/token/…hostDeps/onEvent/…`，无 socket 工厂字段。 |
| `createSocket` 方法 | 是 `GatewayClient` 的**内部方法**（非构造函数 option）。第 1212 行把它**硬编码**为回调传给内部 `GatewayProtocolClient`：`createSocket: (handlers) => this.createSocket(handlers)`。外部无法替换。 |
| `hostDeps` | `DEFAULT_HOST_DEPS`（1073–1089）只含 `signDevicePayload`/`publicKeyRawBase64UrlFromPem`/`beforeConnect`/`registerGatewayLoopbackBypass`/`loadDeviceAuthToken`/`storeDeviceAuthToken`/`clearDeviceAuthToken`/`normalizeTlsFingerprint`/`logDebug`/`logError`/`redactForLog` 等——`beforeConnect`/`registerGatewayLoopbackBypass` 是**连接前钩子**（默认无操作 / 返回 unregister 函数），**不能替换 socket 创建本身**。socket 仍在 1332 行被 `new WebSocket` 写死。 |
| url 拦截 / monkey-patch | `url` 只是字符串，被原样塞进 `new WebSocket(url, wsOptions)`；要拦截只能 monkey-patch Node `ws` 模块或全局——这在浏览器无意义（浏览器没有 `ws` 包），在 Node 也是脆弱 hack，非官方支持面。 |
| 它其实接受 socket？ | **不接受**。`GatewayClient` 构造函数（1187）只读 `opts`，全程自建 socket。 |

### 1.3 为什么浏览器跑不了——三重 Node 绑定（任一都致命）

1. **入口分离**：`package.json` `exports` 中 `./browser` 指向 `browser.mjs`，**该入口只导出 `GatewayProtocolClient`**（grep 确认 `browser.mjs` 无 `GatewayClient`）；高层 `GatewayClient` 只在 `.`（`index.mjs`）导出。构建脚本（`package.json` 第 71 行）：`tsdown --platform node`——整包按 Node 平台构建，`engines.node >= 22.19.0`。
2. **Node `ws` 包专有 API**：`ws.on("open"/"message"/"close"/"error")`（EventEmitter，浏览器 WebSocket 用 `onopen`/`addEventListener` 而非 `.on()`）、`ws.binaryType = "nodebuffer"`（1333，浏览器无此取值）、`ws.terminate()`（1404，浏览器无此方法）、`wsOptions.maxPayload/handshakeTimeout/checkServerIdentity`（Node ws options）。
3. **Node 运行时全局**：`process.env`（1296）、`process.platform`（1461）、`this.ws["_socket"].getPeerCertificate()`（1757-1759，TLS 指纹，浏览器无）、timer `.unref?.()`。

→ 即使打包器把 `ws` polyfill 掉，这些 API 也无法在浏览器原生物理 WebSocket 上工作。**高层 `GatewayClient` 设计上就是 Node 专用参考客户端。**

---

## 2. 问题 2：若不能注入自定义 transport，面板隧道如何与 `GatewayClient` 共存？

前提：理解隧道形态。读 `server/src/chat/tunnelAssembly.ts` + `frontend/src/chat/tunnelSocket.ts` 确认——隧道是 **server 中转**，不是浏览器直连网关：

```
浏览器 (Vue)  ──WS `/ws/chat/?container=<name>`（JWT subprotocol 4401 握手）──▶  Express server
                                                                                  │ dockerode/ws 连接器(makeWsGatewayConnector)
                                                                                  ▼
                                                                          OpenClaw 容器网关 (host:port)
```

`tunnelSocket.ts` 把「浏览器↔server 的一条 WS」适配成 `GatewayProtocolSocket`；server 侧 `makeWsGatewayConnector` 再连容器网关，**零解析透传**双向帧。即浏览器看到的「对端」是 server 隧道端点，server 把帧原样转发给真网关。

### 候选 (a)：隧道在 server 侧终结、`GatewayClient` 以为自己直连网关 —— **不可行（对前端而言）**

设想：`GatewayClient` 的 `url` 指向 server 隧道端点 `/ws/chat/`，让它「以为自己直连网关」。**失败**，因为：

- `GatewayClient` 是 Node 专用（§1.3），**根本不在浏览器运行**，谈不上「让前端的 GatewayClient 指向隧道」。
- 即使假设能跑，`createSocket` 写死 `new WebSocket(url, wsOptions)`（Node `ws`），它会对 `url` 发起一条**新的直连 WS**，不会走我们带 JWT subprotocol 握手（4401）的隧道 transport。隧道的 4401 认证握手逻辑在 `tunnelSocket.ts` 里，`GatewayClient` 无法复用。
- server 侧隧道需要的是「Node `ws` 客户端连容器网关」——这恰恰是 `GatewayClient` **本来就能做**的事（它就是 Node 客户端）。但那是**把 `GatewayClient` 部署在 server 侧**（见候选 c），与「浏览器前端用 GatewayClient」是两回事。

### 候选 (b)：退回裸 `GatewayProtocolClient`（`./browser`，接受 `createSocket`）包一层复用隧道 transport —— **可行，且就是现状**

`dist/protocol-client-BfBHwA5H.d.mts`：

- 第 72 行：`GatewayProtocolClientOptions.createSocket: (handlers: GatewayProtocolSocketHandlers) => GatewayProtocolSocket` —— **公开必填注入点**。
- 第 128–129 行注释：「Browser-safe gateway wire client. **Environment adapters own transport and auth policy; this class owns the single socket/handshake/reconnect/frame state machine.**」——官方明确把 transport 所有权交给宿主 adapter。

本仓库 `gatewayChat.ts` 第 250–251 行正是这么接的：

```ts
client = new GatewayProtocolClient<ConnectPlan>({
  createSocket: (socketHandlers) => createPanelTunnelSocket(container, jwt, socketHandlers),
  …
})
```

`tunnelSocket.ts` 把「浏览器↔server 隧道 WS（JWT subprotocol 4401）」适配成 `GatewayProtocolSocket`。这条路径**完全可行、已上线**。

**代价**：裸 `GatewayProtocolClient` 只拥有「单 socket/握手/重连/帧状态机」，**不含**高层 `GatewayClient` 的看门狗（`startTickWatch`）与 deviceToken 生命周期自动化。现状 `gatewayChat.ts` 因此**手写了这些**：
- 沉默看门狗：`SILENCE_TIMEOUT_MS`/`WATCHDOG_INTERVAL_MS`（gatewayChat.ts 154-155、485-506 的 `setInterval` 巡检，`client.closeSocket(1000,'silence timeout')` 触发重连）。
- deviceToken 生命周期：`deviceAuth.ts` 的 `createDeviceAuthLifecycle` + `onConnectHello`/`acceptHello`/`clearStoredToken`（gatewayChat.ts 395-413、441-472），用的是 `GatewayBrowserDeviceAuthLifecycle`（`./browser` **有导出**）——即 deviceToken 存/取/清虽非 `GatewayClient` 自动驱动，但官方浏览器侧 lifecycle 类已可复用。

→ **候选 (b) 并没有真正「放弃」deviceToken 自动化**：`GatewayBrowserDeviceAuthLifecycle`（浏览器安全版）承担了 deviceToken 的 plan/acceptHello/clearStoredToken；只有「tick 看门狗」需要前端手写（现状已写）。**这是推荐形态（见 §4）。**

### 候选 (c)：把高层 `GatewayClient` 部署在 **server 侧**（Node 环境），浏览器仍走隧道 —— **可行的另一形态，但改变架构**

`GatewayClient` 是 Node 客户端，天然适合跑在 server。形态：

```
浏览器 ──隧道(`/ws/chat/`，裸帧透传)──▶ server ──▶ [server 内 GatewayClient] ──▶ 容器网关
```

- server 侧用 `GatewayClient`（Node），它直连容器网关（`url = ws://<container-host>:<port>`），自动获得握手/看门狗/deviceToken 生命周期（`hostDeps` 注入持久化）。这正是既有研究 `openclaw-gateway-client.md` §5 讨论的**后端重写**形态。
- 但此时浏览器↔server 之间仍是隧道 + 裸帧，**浏览器侧仍需一个客户端**去跑 v4 握手/帧状态机来与 server 隧道对话——如果 server 侧 `GatewayClient` 已经终结了网关协议（自己完成配对/deviceToken），那浏览器↔server 这段就不再是「网关协议透传」，而变成 server 自定义的面板协议。**这等于废弃 ADR 0006 的「浏览器直连网关（B-直连）」架构**，退回到「server 中转并终结协议」——是本 ticket 范围之外的架构反转，且与现状隧道「零解析透传」的设计冲突。

---

## 3. 问题 3：`GatewayClient` 的握手/看门狗/deviceToken 生命周期是否假定直接看到/控制 WS 帧？与隧道兼容吗？

逐机制核对（`index.mjs`）：

| 机制 | 实现 | 是否触碰 socket 帧 | 与隧道兼容性 |
|---|---|---|---|
| **握手（connect.challenge → connect → hello-ok）** | 委托给内部 `GatewayProtocolClient`（1211-1271），`buildConnectPlan`/`buildConnectParams` 组帧（1217-1224），`onConnectHello` 处理 hello-ok（1238） | **不直接读帧**——由内部 protocol client 解析。但它要求 socket 是它自己 `new WebSocket` 创建的那条 | 机制本身与隧道透传兼容（隧道透传帧），但**前提是 socket 创建可被替换**——而它不能（§1.2），所以兼容性是「理论上帧语义兼容、工程上 socket 建不起来」 |
| **看门狗 `startTickWatch`**（1739-1752） | `setInterval` 巡检 `this.lastTick`（由 `onActivity` 1254-1256 在每次收到帧时刷新），`gap > tickIntervalMs*2` → `this.protocol.closeSocket(4000, 'tick timeout')` | **不读原始帧**——只看应用层「最近一次 activity 时间」。`closeSocket(4000)` 走 protocol client 的 close 路径 | **机制与隧道完全兼容**（隧道透传帧 → `onActivity` 照常刷新）。但它调 `protocol.closeSocket(4000)`——close code 4000 是 RFC 应用码，WHATWG 浏览器 WebSocket `close(4000)` 合法（3000-4999），我们的 `tunnelSocket.close` 已处理合法码映射。看门狗逻辑可移植 |
| **deviceToken 生命周期**（`handleConnectHello` 1522-1538） | 收 `hello-ok.auth.deviceToken` → `this.deps.storeDeviceAuthToken({deviceId,role,token,scopes})`；`selectConnectAuth` 连接前 `loadDeviceAuthToken`；`AUTH_DEVICE_TOKEN_MISMATCH` 时 `clearDeviceAuthToken` + 重试 | **完全不碰 socket**——只调 `hostDeps` 持久化回调 | **机制与隧道完全兼容**，且浏览器侧有同构 `GatewayBrowserDeviceAuthLifecycle`（`./browser` 导出）可复用——现状 `gatewayChat.ts` 已用它 |

**结论**：`GatewayClient` 的握手/看门狗/deviceToken 三大机制**在语义上都不假定直接读/控制原始 WS 帧**（看门狗看 activity 时间戳、deviceToken 走 hostDeps、握手委托内部 protocol client）。它们与「4401 subprotocol 握手 + 原始帧透传」的隧道**在帧语义层面是兼容的**。**唯一的不兼容在 transport 创建层**：`GatewayClient` 写死 `new WebSocket(url)`（Node `ws`），无法换成我们的隧道 socket。即——**协议机机制可复用，socket 工厂不可替换**。

---

## 4. 推荐接线形态

**推荐：维持现状候选 (b) —— 浏览器侧用裸 `GatewayProtocolClient`（`./browser`）+ `createPanelTunnelSocket` 注入隧道 transport，deviceToken 用官方 `GatewayBrowserDeviceAuthLifecycle` 复用，看门狗前端手写（已实现）。**

理由：
1. **高层 `GatewayClient` 在浏览器物理上无法运行**（Node `ws` 绑定 + `./browser` 不导出 + 无 socket 注入点），「隧道承载 GatewayClient」这条路被官方实现封死，非我们接线问题。
2. **裸 `GatewayProtocolClient` 是官方为浏览器预留的正确接缝**：「environment adapters own transport」的设计意图就是让我们注入隧道 socket。`createSocket` 是公开必填 option，非 hack。
3. **deviceToken 自动化并未丢失**：`GatewayBrowserDeviceAuthLifecycle`（`./browser` 导出）提供 `buildPlan/acceptHello/clearStoredToken`，与高层 `hostDeps` 同构；现状 `deviceAuth.ts` 已封装。
4. **唯一需手写的只有 tick 看门狗**，成本极低（现状 gatewayChat.ts 485-506 的 60s 沉默巡检已实现并处理了 #493 后台节流）。

**不推荐**：候选 (a)（不可行，§2a）；候选 (c)（把 GatewayClient 放 server 侧）虽可行但属 ADR 0006「浏览器直连网关」的架构反转，超出本 ticket 范围，应作为独立的「后端协议终结」决策单议（与 `openclaw-gateway-client.md` §5 的后端重写路线汇合）。

**若未来官方在 `./browser` 暴露 socket 工厂或导出浏览器版高层 client**，再评估升级；当前 `2026.7.2-beta.6` 无此能力。

---

## 5. 关键代码证据索引（`.mjs` 运行时实现）

| 事实 | 文件:行号 |
|---|---|
| `import { WebSocket } from "ws"`（Node ws 包） | `dist/index.mjs:9` |
| `GatewayClient` 类定义 | `dist/index.mjs:1187` |
| 内部硬编码 `createSocket: (handlers) => this.createSocket(handlers)` 传给 protocol client | `dist/index.mjs:1212` |
| **`createSocket` 写死 `new WebSocket(url, wsOptions)` 直连 opts.url** | `dist/index.mjs:1293-1332`（创建点 1332） |
| `ws.binaryType = "nodebuffer"`（Node 专有） | `dist/index.mjs:1333` |
| `ws.on("open"/"message"/"close"/"error")`（EventEmitter API） | `dist/index.mjs:1341-1363` |
| `ws.terminate()`（Node 专有） | `dist/index.mjs:1404` |
| `process.env` / `process.platform` | `dist/index.mjs:1296` / `1461` |
| `this.ws["_socket"].getPeerCertificate()`（TLS 指纹，Node 专有） | `dist/index.mjs:1757-1759` |
| `DEFAULT_HOST_DEPS`（无 socket 工厂键，只有钩子/持久化回调） | `dist/index.mjs:1073-1089` |
| 看门狗 `startTickWatch`（只看 lastTick，closeSocket(4000)） | `dist/index.mjs:1739-1752` |
| deviceToken 生命周期 `handleConnectHello`（只调 hostDeps.storeDeviceAuthToken） | `dist/index.mjs:1522-1538` |
| `./browser` 入口**不含** `GatewayClient`（只导出 `GatewayProtocolClient`） | `dist/browser.mjs:8`（export 列表无 GatewayClient） |
| 裸协议机 `createSocket` 公开注入点 + 「adapters own transport」注释 | `dist/protocol-client-BfBHwA5H.d.mts:72` / `128-129` |
| 构建按 Node 平台（`tsdown --platform node`）+ engines node>=22 | `package.json:71` / `59-61` |
| 本仓库现状接线：`createSocket: … createPanelTunnelSocket(…)` | `frontend/src/chat/gatewayChat.ts:250-251` |
| 本仓库手写沉默看门狗 | `frontend/src/chat/gatewayChat.ts:485-506` |

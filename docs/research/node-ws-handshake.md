# 研究笔记 — Node `ws` 握手 JWT 认证方案（issue #314 / wayfinder #308）

> 目标：为「把现状 Django Channels 的 `/ws/chat/` 对话桥接迁移到 Node/Express」提供事实依据。
> 查清三件事：(1) 用 Node `ws` 如何在 HTTP upgrade 阶段复刻现状握手 JWT 认证语义；
> (2) `ws` vs `socket.io` 库选型；(3) 单 Node 进程内 Express(REST) 与 `ws`(对话桥接) 如何共享同一 HTTP server / 端口、复用同一 JWT 验签。
>
> 事实来源标注：
> - **[现状源码]** = 本仓库 `backend/accounts/middleware.py`、`backend/chat/consumers.py`、`backend/config/asgi.py`、`backend/config/settings/`、`frontend/src/chat/ws.ts`，逐文件阅读所得，最高置信。
> - **[ws 官方]** = `github.com/websockets/ws` README + `doc/ws.md` API 参考（经 Context7 取一手）。
> - **[生态调研]** = 2025–2026 JWT 库对比公开资料（jsonwebtoken vs jose），标注为二手共识。

---

## 1. 现状握手语义（要复刻的目标）— [现状源码]

`backend/accounts/middleware.py` 的 `JwtAuthMiddleware` 在 WS 握手期验与 REST **同一 JWT**（同 simplejwt 后端、同 `SECRET_KEY`、同算法）。语义要点：

| 要点 | 现状行为 | 源码位置 |
|---|---|---|
| **token 通道** | 浏览器 WS 不能自定义 `Authorization` 头，token 经 `Sec-WebSocket-Protocol` 的 `access_token` subprotocol 携带。**刻意不走 URL query**（`?token=` 会进访问日志/浏览器历史/Referer，泄漏 access token） | `middleware.py:8-9, 82` |
| **两种 wire format** | ① `new WebSocket(url, ['access_token', <jwt>])` → subprotocols = `['access_token', <jwt>]`；② `['access_token.<jwt>']` 单值拼接格式。`_extract_token` 两种都解 | `middleware.py:77-89` |
| **前端实际用** | 格式 ①：`new ChatWebSocket(path, ['access_token', jwt])`（`frontend/src/chat/ws.ts:102`，注释明示对齐 `_extract_token` 格式 1） | `frontend/src/chat/ws.ts:5, 102` |
| **验签复用** | 直接调 DRF `JWTAuthentication().get_validated_token()` + `get_user()`——保证 WS 验的就是 REST 那套规则 | `middleware.py:24-31` |
| **拒绝语义** | **先 accept 再 close(4401)**：必须先发 `websocket.accept` 才能向客户端发带 code 的 `websocket.close` 帧；直接 close 会让浏览器只看到 HTTP upgrade 失败/异常关闭（closeCode=1006），拿不到 4401 | `middleware.py:51-58` |
| **subprotocol 回显** | accept 时必须从客户端已声明列表里选回响应 subprotocol（RFC 6455 要求响应 subprotocol 必须是客户端提供之一）。单值格式 `access_token.<jwt>` 须**原样回显**，不能硬编码 `access_token`，否则浏览器拒握手（codex #190 P2） | `middleware.py:63-75`、`consumers.py:49-60` |
| **拒绝码 4401** | 取自「HTTP 401 语义映射到 WS close code」社区惯例；4000–4999 是 RFC 6455 应用私有段 | `middleware.py:20-21` |

**验签配置事实**：simplejwt 5.5.1（`requirements/base.txt:3`）。settings 未覆盖 `SIMPLE_JWT['ALGORITHM']`/`SIGNING_KEY`，故取 simplejwt 默认：**HS256（对称 HMAC-SHA256），签名密钥 = Django `SECRET_KEY`**（`config/settings/base.py:13-14`，生产经 `DJANGO_SECRET_KEY` env 注入，`prod.py:11`）。access token 过期、签发者等校验均走 simplejwt 默认 + DRF `JWTAuthentication`。

**迁移含义**：Node 侧要验的是 **HS256 对称签名、密钥为同一 `SECRET_KEY`** 的 JWT。无 RS256/JWKS 公钥体系，验签只需共享同一对称密钥，不需要 OIDC 发现 / JWKS 端点。这大大简化 Node 验签——一个 HMAC 密钥即可。

---

## 2. `ws` 握手认证实现要点 — [ws 官方]

### 2.1 首选路径：`noServer` + `server.on('upgrade')` 手动鉴权

`ws` 官方在 `doc/ws.md` 明确：**`verifyClient` 的使用「is discouraged in favor of handling authentication during the HTTP upgrade event」**。即官方推荐在 HTTP upgrade 事件里做认证，而非 `verifyClient` 钩子。推荐结构：

```js
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const server = createServer();              // Express app 挂在同一 server（见 §4）
const wss = new WebSocketServer({ noServer: true });  // noServer：不自带 HTTP server，由我们手动 handleUpgrade

server.on('upgrade', (request, socket, head) => {
  socket.on('error', () => socket.destroy());
  // ① 只接管 WS 路径，其余 upgrade 请求放行/拒绝（同进程还可能有别的 upgrade）
  if (!request.url.startsWith('/ws/chat/')) { socket.destroy(); return; }
  // ② 从 Sec-WebSocket-Protocol 解出 JWT，复用 REST 验签（见 §3）
  authenticate(request, (err, user) => {
    if (err || !user) {
      // 见 §2.3：要复刻「先 accept 再 close(4401)」就不能在此处 401 拒
      acceptThenClose4401(request, socket, head);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, user);   // user 注入 connection，等价 scope['user']
    });
  });
});
```

`handleUpgrade(req, socket, head, callback)`：手动把一个 HTTP upgrade 请求提升为 WS 连接，callback 拿到建好的 `ws`。配合 `noServer: true`，鉴权逻辑完全由我们控。

### 2.2 subprotocol 解析与回显

- **解析**：`Sec-WebSocket-Protocol` 是逗号分隔 header。`ws` 在 connection 后把客户端声明的 subprotocol 集合暴露给 `handleProtocols(protocols, req)`（`protocols` 是 `Set<string>`），或直接 `ws.protocol` 取服务端最终选中的那个。也可用 `ws` 导出的工具解析 header。
- **回显选择**：`handleProtocols(protocols, req) => string | false` 钩子，从客户端提供的集合里选一个返回；返回 falsy 则拒握手。**复刻 `_choose_subprotocol`/`connect()` 逻辑**：

```js
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols, req) => {
    if (protocols.has('access_token')) return 'access_token';
    for (const p of protocols) if (p.startsWith('access_token.')) return p; // 单值格式原样回显
    return false; // 或返回 undefined 不带 subprotocol（对应现状「无 subprotocol 地 accept」）
  },
});
```

  注意 `handleProtocols` 返回 falsy 会让 `ws` 拒绝整个握手（HTTP 4xx）。现状在「客户端未声明 access_token」时是**无 subprotocol 地 accept** 而非拒绝——这点要在 token 校验层处理（无 token → accept-then-close 4401），而非靠 `handleProtocols` 拒绝。即：`handleProtocols` 只负责「有就选回」，`verifyClient`/upgrade 层负责「token 对不对」。

### 2.3 复刻「先 accept 再 close(4401)」的关键差异

这是与现状语义最需对齐、也最容易踩坑的一点。

- **HTTP 401 拒绝 ≠ WS close(4401)**。`verifyClient` 的 `callback(false, 401, 'Unauthorized')` 或在 upgrade 阶段 `socket.write('HTTP/1.1 401 ...')` + `socket.destroy()`，都是在 **HTTP 层**拒绝——浏览器 `WebSocket` 看到的是 upgrade 失败，触发 `onerror` + `onclose(closeCode=1006)`，**拿不到 4401**。现状中间件注释（`middleware.py:51-52`）正是为避免这个才改用 accept-then-close。
- **要复刻 4401**：必须先让 upgrade 成功（`wss.handleUpgrade` 完成、connection 建立），再立即 `ws.close(4401)`。`ws.close([code])` 支持自定义 close code，`ws` 文档确认 **4000–4999 是应用私有 close code 段**，4401 合法。

```js
function acceptThenClose4401(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.close(4401, 'Unauthorized');   // 先 accept 再带 code 关闭，浏览器 onclose 能拿到 4401
  });
}
```

  **取舍提示**：迁移时若不再要求前端区分 4401，可简化为 upgrade 阶段直接 HTTP 401（更简单、更标准）。但这改变现状 wire 语义（前端靠 4401 触发重新登录），属**行为变更**，需与 #308 决策对齐。本笔记的事实结论：**`ws` 完全支持复刻 accept-then-close(4401)**，只是要在 `handleUpgrade` 之后、`connection` 事件里立即 close，而非用 `verifyClient` 的 401。

### 2.4 心跳 / ping-pong

现状浏览器↔Channels 腿用**应用层** `ping`/`pong` JSON 帧（`consumers.py:70-74`，因 daphne 不发协议 ping）。`ws` 默认**支持协议级 ping/pong**（`ws.ping()` / `ws.on('pong')`），但前端浏览器 `WebSocket` API **无法主动发协议 ping、也读不到协议 pong**——所以现状才用应用层帧。迁移到 Node 后这点不变：仍须保留应用层 `{type:'ping'}→{type:'pong'}` 回显逻辑供前端活性看门狗用。`ws` 协议级 ping 可用于 Node↔OpenClaw 那条腿（见 #308 的 chat 桥接迁移），与浏览器腿的应用层 ping 互补。

---

## 3. JWT 验签库选型 — [生态调研]

迁移后 REST 与 WS 都验同一 HS256 JWT。Node 生态两主流：

| | **jose** | **jsonwebtoken** |
|---|---|---|
| 2025–26 共识 | **新项目默认选择** | 存量维护，新项目不建议 |
| API | 仅 async（Promise，Web Crypto） | 默认 sync（Node crypto，阻塞事件循环） |
| 算法安全 | **强制显式声明 algorithm**（设计上防算法混淆攻击） | v9+ 需手动传 `algorithms` 才安全 |
| 密钥形态 | `Uint8Array`（`TextEncoder().encode(secret)`） | 字符串 |
| 依赖 | 零依赖 | 多依赖（jws/jwa 等） |
| 运行时 | 通用（Node/Deno/Bun/Edge/浏览器） | 仅 Node |

**HS256 验签示例（jose）**：

```js
import { jwtVerify } from 'jose';
const secret = new TextEncoder().encode(process.env.DJANGO_SECRET_KEY); // 与 simplejwt 同一密钥
const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
// payload 即 simplejwt claims（含 user_id / exp）；验签失败抛错 → 视为未认证
```

**结论（供 #308 决策）**：本项目无历史包袱、密钥是简单对称 `SECRET_KEY`、未来可能跑在更现代运行时——**建议 `jose`**。它强制显式 `algorithms: ['HS256']`，从设计上杜绝算法混淆攻击（jsonwebtoken 的 CVE-2022-23529 教训），async API 不阻塞事件循环，与 Express/async 风格契合。`jsonwebtoken` 仅在「纯 Node、想同步一行验签」时略省事，但默认同步阻塞事件循环、且需手动传 `algorithms` 才安全，无优势。

> **注意**：simplejwt access token 的 `user_id` claim 与签名算法是 HS256；Node 侧 `jwtVerify` 只验签名+exp，**不查库**。现状 DRF `get_user()` 会查 user 表确认用户存在/active。若 Node 侧也要「user 仍存在且 active」语义，需额外查库（或对共享控制面信任模型下接受「签名有效即认证」）。这是**语义差异点**，需 #308 决策明确——纯签名验与现状「签名有效 + 用户存在」略有差别。详见 §5。

---

## 4. Express(REST) + `ws`(WS) 同进程共享 server — [ws 官方] + Node 惯例

Node 生态惯用做法：**一个 `http.Server` 同时挂 Express app（处理普通 HTTP）和 `ws`（接管 upgrade）**，共享同一端口。

```js
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const app = express();
// ... REST 路由 / 全局鉴权 middleware（验同一 HS256 JWT，jose）...

const server = createServer(app);            // ① Express app 作为 request handler
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => { // ② upgrade 请求不走 Express，由我们接管
  if (!req.url.startsWith('/ws/chat/')) { socket.destroy(); return; }
  authenticate(req, (err, user) => {           // ③ 复用 REST 的 jose 验签逻辑
    if (err || !user) return acceptThenClose4401(req, socket, head);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });
});

server.listen(8000);                            // ④ 单端口同时服务 REST + WS
```

**结构要点**：
- `createServer(app)`：Express app 本质是 `(req, res) => void` handler，直接传给 `http.createServer`。普通 HTTP 请求（GET/POST `/api/...`）全走 Express 中间件链。
- `server.on('upgrade')`：HTTP upgrade 请求（WS 握手）**不会**进入 Express 中间件——Node 在 `upgrade` 事件单独抛出。故 WS 鉴权逻辑在此独立实现，但**复用同一个 `jwtVerify` 函数 / 同一 `DJANGO_SECRET_KEY`**，做到与 REST 验签同源（对齐现状「REST/WS 同 simplejwt 后端、同 SECRET_KEY」）。
- `noServer: true`：让 `ws` 不自建 HTTP server，upgrade 由我们手动 `handleUpgrade`，从而鉴权、路径过滤、subprotocol 回显全可控。
- 单进程单端口：与现状 daphne 同端口承载 REST+WS 的部署形态一致（`config/asgi.py` 单 `ProtocolTypeRouter` 同端口分流 http/websocket）。

**鉴权复用**：把 `jwtVerify` + claims→user 映射抽成一个 `authenticate(req): Promise<user|null>`，REST 中间件与 upgrade 处理器都调它。现状 REST 用 DRF `JWTAuthentication`（`middleware.py:28`），Node 侧用一个共享 `auth.js` 模块即可等价。

---

## 5. 给后续决策的事实结论

1. **`ws` 可完整复刻现状握手认证**：`noServer:true` + `server.on('upgrade')` 手动 `handleUpgrade`，在 upgrade 阶段解 `Sec-WebSocket-Protocol` 里的 JWT、复用验签。官方明确**推荐在 upgrade 事件做认证、`verifyClient` 已标注 discouraged**。
2. **4401 拒绝语义需在 connection 后 `ws.close(4401)` 复刻**：HTTP 层 401（`verifyClient` 或 `socket.write`）会让浏览器只得 1006，拿不到 4401。要保留现状「先 accept 再 close(4401)」必须 `handleUpgrade` 成功后立即 `ws.close(4401)`；`ws` 确认 4000–4999 为应用私有 close code 段，4401 合法。是否保留 4401 还是简化为 HTTP 401 属行为变更，待 #308 定。
3. **库选型：`ws` 而非 `socket.io`**。现状是纯 WebSocket 协议（浏览器原生 `new WebSocket`，无 socket.io 客户端封装），负载是自定义 JSON 消息桥接。socket.io 自带额外握手协议/房间/自动重连封装，与现状「裸 RFC 6455 + 应用层 JSON」模型不匹配，引入即破坏前端 wire 兼容。`ws` 是 Node 生态裸 WS 事实标准，最小、最贴合。
4. **验签库建议 `jose`**：HS256 对称密钥（= 现状 `SECRET_KEY`），`jose` 强制显式 `algorithms:['HS256']` 防算法混淆、async 不阻塞事件循环、零依赖、是 2025–26 新项目默认。REST 与 WS 共用一个 `jwtVerify` 封装即做到同源验签。**注意语义差异**：现状 DRF `get_user()` 验签后还查库确认 user 存在/active；纯 `jwtVerify` 只验签名+exp。Node 侧是否要补查库，待 #308 定（共享控制面信任模型下或可接受「签名有效即认证」）。
5. **同进程单端口可行且为 Node 惯例**：`createServer(expressApp)` + `server.on('upgrade')` 分流，Express 管普通 HTTP、`ws`(noServer) 管 upgrade，共享同一端口与同一 `SECRET_KEY`，部署形态与现状 daphne 单端口分流对齐。心跳须保留**应用层** `ping/pong`（浏览器 WS API 无法发协议 ping），`ws` 协议级 ping 仅用于 Node↔OpenClaw 那条腿。

---

## 附：待 #308 / 实测确认的开放点

- **4401 vs HTTP 401**：保留现状 accept-then-close(4401) 还是迁移时简化为 upgrade 阶段 HTTP 401（改前端重登触发逻辑）。本笔记确认两者 `ws` 都能做，是产品/兼容决策而非技术限制。
- **user 查库**：Node 侧纯签名验 vs 补查用户库，对齐现状 `get_user()` 语义的严格度。
- **两种 subprotocol wire format**：现状 `_extract_token` 兼容格式①（`['access_token', jwt]`，前端实际用）与格式②（`['access_token.<jwt>']`）。Node 侧 `handleProtocols`/解 token 逻辑须同样兼容两种，否则格式②客户端握手失败。建议起 Node 原型后用两种格式各实测一次。

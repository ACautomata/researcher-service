# ADR 0006：浏览器直连网关——openclaw-client 前移前端，后端退为认证隧道 + approve 编排

## 状态

已接受。**修订** issue #331 G 节（对话桥接面）与 #321（浏览器↔面板 WS 承载）的「面板做胖多租户桥接中介」形态；**作废** #339（M7 Chat REST 代理面）整张切片；**重写** #337（M5 对话桥接核心）与 #338（M6 设备配对）的职责边界。

> 溯源：本 ADR 由一次 grill-with-docs 会话产出（2026-08-02），基于对 `@openclaw/gateway-client@2026.7.2-beta.6` / `@openclaw/gateway-protocol@2026.7.2-beta.6` 解包 `.d.mts`/`.mjs` 的一手核实，以及官方文档 `docs.openclaw.ai/gateway/clients`。

## 背景

#331（Wayfinder #308 收尾规格）G 节原定：面板在 Express 后端跑官方 `GatewayClient`，对每容器持一条已配对长连接，自建「多租户连接池壳 + 配对状态机 + 前端事件翻译纯函数 + 前端 WS 承载（自定义 `text/done/approval` wire）+ chat REST 代理面」——即后端是一个**懂协议的胖中介**，浏览器只消费面板翻译后的自定义帧。

用户提出修正方向：**openclaw-client 直接放前端，后端只做转发给藏在后端后面的 OpenClaw**。grill 过程中逐层确认了这件事的真实形状与硬约束。

### 一手核实的关键事实（决定可行性的证据）

1. **transport 可注入（`./browser` 导出）**：`GatewayProtocolClientOptions.createSocket: (handlers) => GatewayProtocolSocket`（`protocol-client-*.d.mts:72`），`GatewayProtocolSocket` 仅 `{isOpen, send, close}` 三方法。类注释：*"Environment adapters own transport and auth policy; this class owns the single socket/handshake/reconnect/frame state machine."* → 浏览器可塞入「面板隧道 socket」，官方协议机照跑握手/重连/帧状态机/会话投影。
2. **bootstrap token 对首连是强制的**：官方文档——*"Bootstrap auth is mandatory. The device must send the shared Gateway token or password for bootstrap authentication. An entirely unauthenticated connection would fail before reaching pairing."* 包内 `buildDeviceAuthPayloadV3` 的 `token ?? ""` 是「有 bootstrap token 时纳入签名」的分支，**非**「可省」。→ 「无 token 首连触发配对」不成立，bootstrap token 必须下发浏览器。
3. **approve 无网关 RPC**：官方文档——*"Approval happens host-side via CLI… `openclaw devices approve <requestId>`… no gateway protocol RPC for self-approval; pairing requires out-of-band host authorization."* → approve 只能走后端（docker exec 宿主 CLI），浏览器物理碰不到容器 exec 通道。
4. **`sessions.delete` 不带 archivedOnly**：`SessionsDeleteParamsSchema.archivedOnly` 注释——*"operator.write callers must set this; deletes without it require operator.admin."* 但实测校准（#370 三轮 P0）：官方 webchat（`sessions-page.ts`）**仅当 `row.archived === true` 才带 archivedOnly**，且网关对未归档会话带 archivedOnly:true 直接 `INVALID_REQUEST`（"Session X is not archived. Archive it first, then delete it."）——面板从不先归档，恒带 archivedOnly 会让**所有**正常会话删除失败。旧 wire（`wire_client.py` `sessions.delete {key}`）也不带，缺失会话为 `ok` 无操作（幂等）。**故删除不带 archivedOnly**；若真实网关对无 archivedOnly 的 delete 要求 operator.admin scope（注释所示），则普通 operator 删除会被拒，列为遗留实测项 ③ 验证。

## 决定

**浏览器直连网关**：浏览器跑官方 `@openclaw/gateway-client` 的 `./browser` 协议机，经自定义 transport（面板隧道）直连容器网关；**后端从「胖桥接中介」退为「认证隧道 + approve 编排 + bootstrap 发放」三件薄事**。

1. **B-直连形态（非 B-中继）**：浏览器终结协议（自己握手/签名/重连/会话投影/事件消费），非「后端终结 + 原样透传帧」。理由见「为什么」。

2. **隧道（tunnel）**：浏览器↔后端一条 WS（沿用 JWT subprotocol 握手 + `authenticate()` 同源验签 + **归属门**：user 只能开到**自己容器**的隧道，越权 `4401`/信封等价）。隧道建立后**原样透传网关原始协议帧**——不解析、不翻译、不注入凭证、不做 method 级授权。

3. **每浏览器设备配对**：每个浏览器 profile（Chrome/隐身/另一台电脑）生成独立 Ed25519 设备身份（存 localStorage，多 tab 共享同一 profile 身份），**独立配对、独立 approve**（对齐官方 webchat-ui/control-ui 模型）。每浏览器设备为其访问的**每个容器**各持一份 deviceToken（token 按 `(clientId, deviceId, role)` 存，网关 per-container）。

4. **bootstrap token 下发（D1）**：经**所有权门控 REST** `POST /containers/<name>/bootstrap-token`——后端验 JWT+归属后把该容器的共享 bootstrap token 返给属主浏览器做首连。每个容器一个共享 bootstrap token，该容器所有属主浏览器首连共用。

5. **approve 编排（B2）**：浏览器在隧道握手收到 `PAIRING_REQUIRED{requestId}` 后，`POST /containers/<name>/pairing/approve{requestId}`；后端 docker exec 在容器内 `openclaw devices approve <requestId>`（复用现状 `ExecPairingApprover` exec 语义），浏览器再重连拿 deviceToken。配对进度记账落 Prisma。

6. **删除的整块**：多租户连接池壳（key=`(user,container,socketSession)`）、后端断线恢复/看门狗、前端事件翻译纯函数、自定义浏览器 wire（#321 的 `text/done/approval/tool` 契约）、**chat REST 代理面整张（#339）**——全部移交官方包（浏览器侧协议机内置重连/session 投影/设备 token 生命周期）或不再需要。

7. **修订 spec §5.2**：从「GATEWAY_TOKEN/deviceToken 真值不落盘、不外泄」改为「**bootstrap token / deviceToken 可下发给容器属主的浏览器设备**；真值仍不落前端以外的盘、不经日志」。这是 B-直连的硬性代价（事实 2），非可选。

## 为什么

- **这才兑现「自己不用实现太多东西」**：B-中继只省「事件翻译」一小块，后端池壳/恢复/授权过滤照胖；B-直连把 #337 池壳/恢复/翻译与 #339 REST 代理**整块删除**，交给官方包（浏览器侧包本就内置重连/session 投影/设备 token 生命周期）。顺官方架构游泳（webchat-ui 即直连），非逆泳。
- **可维护性（用户点名的好处）**：面板不再承载「手写 Python 防腐层 ↔ 官方协议机」的互证负担。只要 **OpenClaw 镜像版本与 `@openclaw/gateway-client` 包版本对得上**即可用——协议语义由官方包与网关两端对齐，面板不翻译、不理解 wire。
- **凭证暴露的爆炸半径可控**：网关藏在隧道后，浏览器里的 bootstrap/deviceToken 离了隧道无从使用；想用隧道须先过 JWT+归属门。有效安全级 ≈ 面板 JWT 安全级。spec §5.2 的修订是在此论证下**有意识地签字**，非静默放宽。
- **approve 无法前移是物理约束（事实 3）**，非设计选择；B2 复用已验证的 `ExecPairingApprover` exec 语义，后端因此只剩这一个 approve endpoint，是「最薄」的 approve 形态。

## 考虑过但否决的方案

- **A. 纯透传管道（dumb pipe），浏览器持设备身份+凭证、后端零授权**：bootstrap/deviceToken 必下发浏览器（事实 2），且**归属校验消失**——任何登录用户改个容器名即可连别人容器，撞碎 #312 按用户隔离。否决。
- **B-中继（后端终结协议 + 原样透传原始帧，前端消费原始帧）**：只省事件翻译，后端仍持连接池壳/断线恢复/method 级授权过滤，依旧胖；且浏览器仍要消费原始协议帧，复杂度没真正搬走。否决（不如 B-直连删得干净）。
- **A1（无 token 首连触发配对）**：被事实 2 推翻——官方文档明示 bootstrap auth 强制，无认证连接在配对前即失败。否决。
- **approve 放前端**：被事实 3 推翻——approve 是容器宿主 CLI（`openclaw devices approve`），无网关 RPC，浏览器碰不到容器 exec 通道。否决。
- **「每用户一设备」存后端、浏览器登入取回**（替代每浏览器设备配对）：能稳设备数，但违背官方包「浏览器设备身份存 localStorage」的一等模型，且把 deviceToken 持久化重新拉回服务端。用户已接受每浏览器设备配对，否决。

## 后果

- **#337 重写**：职责从「池壳 + 事件翻译 + 自定义 WS 承载 + 官方 client 集成」收窄为「隧道握手（JWT+归属门）+ 原始帧透传」。删除池壳/恢复/翻译/自定义 wire。
- **#338 重写**：从「每容器一次配对状态机」改为「**每浏览器设备**配对触发（`POST …/pairing/approve{requestId}`）+ 后端 docker exec approve + 进度记账」。触发点从「provisioning 完成后自动配对」改为「**浏览器首连遇 PAIRING_REQUIRED 时按需配对**」——不再有「容器创建后自动配对」的后端触发器。
- **#339 作废**：chat REST 代理面（sessions/list/create/history/delete + approval/resolve + commands）整张删除，浏览器直连走协议。仅新增 `POST …/bootstrap-token` 与 `POST …/pairing/approve` 两个薄 endpoint。
- **#321 作废**：自定义浏览器 wire（`text/done/approval/tool` + 应用层 ping/pong）不再存在；浏览器消费网关原始帧，应用层 ping/pong 由官方协议机/隧道承载。
- **前端（#340）**：ChatView 拆分保留，但数据源从「面板自定义帧」改为「官方 `./browser` 协议机 + session 投影协调器」；新增「面板隧道 socket」实现 `GatewayProtocolSocket` 接口注入 `createSocket`；设备身份/tokenStore 用 localStorage。
- **spec §5.2 修订**（见「决定 7」），需在 #331 spec 与 deploy 契约文档同步标注。
- **多 tab**：共享同一 profile 设备身份；审批连接级事件的「多并发连接是否广播」**包内无法确定**（网关侧行为），列实现期实测项，resolve 走 `first-answer-wins` 权威广播即可。
- **网关 devices 列表膨胀**：每浏览器 profile × 每容器 = 一条 pending/paired 设备记录，为用户已接受代价。
- **遗留实测项**：①浏览器无 token + bootstrap token 首连在真实网关（`ghcr.io/openclaw/openclaw:2026.7.1-browser`）上的 `PAIRING_REQUIRED` 行为实测；②审批事件多 tab 广播语义实测；③`sessions.delete` 不带 archivedOnly 在真实网关的行为实测（未归档会话删除成功与否、无 archivedOnly 是否要求 operator.admin scope）。
- 本 ADR 与 [0002-openclaw-anti-corruption-layer](./0002-openclaw-anti-corruption-layer.md)、[0004-openclaw-wire-convergence](./0004-openclaw-wire-convergence.md) 相关：0002/0004 的「后端 Python 防腐层持有协议机」前提在 B-直连下被抽掉——协议机移至前端官方包，后端不再实现 WS protocol v4，防腐层仅剩「隧道透传 + approve exec + bootstrap 发放」三个薄触点。

// #337 M5 对话桥接核心（ADR 0006 隧道形态）常量。
// 隧道 = 浏览器↔面板一条 WS（JWT subprotocol 握手 + 归属门），建立后原样透传浏览器↔容器网关
// 的 OpenClaw 协议 v4 原始帧（零解析/零翻译）。自定义 wire（#321）与池壳/翻译已作废。

// 隧道 WS 路径前缀（浏览器 new WebSocket('/ws/chat/?container=<name>', ['access_token', <jwt>])）。
// 容器名经 URL query 传入（#312 归属门：user 只能开自己容器的隧道）；token 仍走 subprotocol
// （不进 URL/日志/Referer）。
export const WS_CHAT_PATH = '/ws/chat/'

// subprotocol 前缀（对齐 Django accounts/middleware 的 access_token 两格式）
export const WS_CHAT_PROTOCOL = 'access_token'

// 拒绝码（对齐 Django WS_CLOSE_UNAUTHORIZED）：认证失败——无效/过期 token。
// 先 accept 再 close(4401)，保前端 recoverUnauthorized 刷新重连链路（HTTP 401 只得 1006 故不简化）。
// 容器归属（越权/不存在）不在此码——见 WS_CONTAINER_ACCESS_DENIED（#3）。
export const WS_AUTH_FAIL_CLOSE = 4401

// 容器归属门拒绝（#3，code review）：越权/不存在容器同码 4404 防探测——token 有效但该容器不是
// 当前用户可访问。独立于 4401（非凭证过期，前端不应 forceRefresh 死循环）；独立于 4402（非网关
// 传输层不可达，而是「无此容器 / 无权限访问」）。含容器名缺失（?container= 未传）。
export const WS_CONTAINER_ACCESS_DENIED = 4404

// 容器网关不可达（容器不在 running / 宿主端口不通 / 网关未起）。非认证问题，区别于 4401
// （前端不应触发 forceRefresh，而应提示容器不可用/重试）。
export const WS_GATEWAY_UNAVAILABLE = 4402

// 强制改密门（authorization-gate-parity，安全审查）：REST 上 mustChangePassword 用户被
// mustChangePasswordGate(10005) 拦业务请求，WS 隧道须同源拒绝——否则强制改密被隧道绕过。
// 独立于 4401（token 有效但授权未就绪，非凭证过期；前端不应按 token 过期 forceRefresh 循环）。
export const WS_MUST_CHANGE_PASSWORD_CLOSE = 4403

// 策略违反（pending 缓冲超预算，安全审查 resource-exhaustion）：网关连接建立窗口内浏览器超量
// 发帧。ws 标准应用码 1008 = policy violation；非认证码，不触发前端 forceRefresh。
export const WS_POLICY_VIOLATION = 1008

// 内部故障（code review F1）：authenticate/getInstanceForUser 的 catch 里，DB 瞬断/连接池耗尽等
// 内部错误不得映射 4401——否则前端把 DB 故障误判为 token 过期进入 forceRefresh/重连风暴。
// 1011 = ws 标准 INTERNAL_ERROR（RFC 6455 应用码）；非认证码，协议机按传输故障决策重连。
export const WS_INTERNAL_ERROR = 1011

// 网关连接建立前浏览器入站帧缓冲的字节预算（超过即 close(1008)）。协议机正常流程下网关连好前
// 浏览器几乎不发帧（等 challenge），预算仅防御异常/恶意客户端在连接窗口内狂发帧的内存耗尽。
export const TUNNEL_PENDING_BYTE_BUDGET = 256 * 1024

// 单帧载荷上限（WebSocketServer maxPayload，安全审查 P1-2：codex PR #367）。不设则 ws 默认
// 100MiB——未认证客户端可在 JWT 验证 await 窗口内发近 100MiB 帧，pending 预算(256KiB)是
// message handler 内的事后检查、防不住单帧内存分配。1MiB ≥ 协议机合法最大帧（tool 事件载荷），
// 超限帧由 ws 接收层直接拒绝 close(1009)，浏览器协议机据此决策重连。
export const TUNNEL_MAX_PAYLOAD = 1024 * 1024

// 并发隧道连接数上限（code review F8）：pending 预算只限单连接字节，无并发上限时攻击者可开数千
// 连接各持 ~1.25MiB 打满堆——resource-exhaustion 的第二维。超限 accept 后立即 close(1008)（策略
// 违反）。值 128 ≥ 正常多用户并发（每浏览器一隧道），防御性封顶。
export const TUNNEL_MAX_CONNECTIONS = 128

// 活动隧道 user 状态复查间隔（code review F4）：握手门只在建连时查 isActive/mustChangePassword，
// 管理员禁用用户/设改密后已建隧道须尽快终止（否则强制改密/禁用被长连接绕过）。周期批量查库，
// 失效即 close(4401)。30s 为「尽力及时」权衡（DB 负载 vs 生效延迟；管理员操作最多 30s 内生效）。
export const TUNNEL_REVALIDATE_MS = 30_000

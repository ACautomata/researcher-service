// #337 M5 对话桥接核心（ADR 0006 隧道形态）常量。
// 隧道 = 浏览器↔面板一条 WS（JWT subprotocol 握手 + 归属门），建立后原样透传浏览器↔容器网关
// 的 OpenClaw 协议 v4 原始帧（零解析/零翻译）。自定义 wire（#321）与池壳/翻译已作废。

// 隧道 WS 路径前缀（浏览器 new WebSocket('/ws/chat/?container=<name>', ['access_token', <jwt>])）。
// 容器名经 URL query 传入（#312 归属门：user 只能开自己容器的隧道）；token 仍走 subprotocol
// （不进 URL/日志/Referer）。
export const WS_CHAT_PATH = '/ws/chat/'

// subprotocol 前缀（对齐 Django accounts/middleware 的 access_token 两格式）
export const WS_CHAT_PROTOCOL = 'access_token'

// 拒绝码（对齐 Django WS_CLOSE_UNAUTHORIZED）：认证/授权失败——无效/过期 token、越权/不存在容器。
// 先 accept 再 close(4401)，保前端 recoverUnauthorized 刷新重连链路（HTTP 401 只得 1006 故不简化）。
export const WS_AUTH_FAIL_CLOSE = 4401

// 容器网关不可达（容器不在 running / 宿主端口不通 / 网关未起）。非认证问题，区别于 4401
// （前端不应触发 forceRefresh，而应提示容器不可用/重试）。
export const WS_GATEWAY_UNAVAILABLE = 4402

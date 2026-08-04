// #369 M5 隧道 close-code 单一事实来源（F15，code review）——对齐 server/src/chat/values.ts。
// 前端唯一的 close-code 词汇表：gatewayChat.ts 的 retry 决策与 ChatView.vue 的 onClose 分发都从
// 这里读，服务端改码号/语义时只需改一处；protocol.test.ts 另有交叉 pin 防漂移（对齐 WS_CHAT_PROTOCOL
// 的既有 cross-test 先例）。
//
// 语义（与 server/src/chat/values.ts 一一对应）：
//   - 4401 WS_AUTH_FAIL：认证失败（token 无效/过期）。前端 forceRefresh 换 token 重建（非普通退避）。
//   - 4404 WS_CONTAINER_ACCESS_DENIED：容器归属门拒绝（越权/不存在/缺容器名）。提示切换容器。
//   - 4403 WS_MUST_CHANGE_PASSWORD：强制改密门。提示改密。
//   - 4402 WS_GATEWAY_UNAVAILABLE：容器网关不可达（容器不在 running / 端口不通）。退避重连。
//
// 4401/4403/4404 是「非传输问题」（认证/授权未就绪）→ 协议机不应自动重连（防 #369 死循环）；
// 4402 与传输断开（1006 等）是「可恢复传输问题」→ 交协议机指数退避重连。

export const WS_AUTH_FAIL = 4401
export const WS_GATEWAY_UNAVAILABLE = 4402
export const WS_MUST_CHANGE_PASSWORD = 4403
export const WS_CONTAINER_ACCESS_DENIED = 4404

// 非传输问题码（认证/授权）：协议机 resolveClose 对这些码决策 retry:false（前端决定下一步：
// 4401 forceRefresh / 4404 提示切容器 / 4403 提示改密），不自动重连防死循环。
export const NO_RETRY_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_AUTH_FAIL,
  WS_MUST_CHANGE_PASSWORD,
  WS_CONTAINER_ACCESS_DENIED,
])

// #14：access_token 传输格式的单一前端来源。对齐 server/src/chat/values.ts WS_CHAT_PROTOCOL——
// 契约无单一文件，改格式须两端同步，cross-test（protocol.test.ts）pin 一致防漂移
// （否则 WS 握手静默 1006/4401）。（#341 M9：Django 退役，Python Channels 一侧已不在契约对。）
export const WS_CHAT_PROTOCOL = 'access_token'

// 两值格式 subprotocol：['access_token', <jwt>]（token 不进 URL/日志/Referer）。单值格式
// ['access_token.<jwt>'] 由调用方自行拼接（面板隧道统一走两值格式）。
export function buildSubprotocols(jwt: string): string[] {
  return [WS_CHAT_PROTOCOL, jwt]
}

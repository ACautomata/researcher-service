// SSE 协议常量（issue #773，#747 C 节 / #726 resolution 锁定的传输面契约）。
export const SSE_PROTOCOL_V = 1 // stream.opened.protocolV：自有事件目录骨架的协议版本

// 心跳间隔 20s（#747 C 节锁）：SSE 注释帧 :ping，路由层 setInterval 消费；
// 生产值唯一声明处（路由 deps.heartbeatMs 仅供测试注入缩短，不改默认值来源）。
export const HEARTBEAT_MS = 20_000

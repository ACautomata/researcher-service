// #1079 · 精简访问日志（正式装配）。字段白名单与业务事件一致：身份、范围摘要、耗时、
// 数量、结果类别——绝不包含正文、query 原文、完整书签或凭证。日志故障只告警，不阻断
// 已通过权限核查的读取（业务层已捕获）。
import type { HistoryAccessEvent, HistoryEvents } from './model'

export function createHistoryAccessLogger(
  sink: { info(message: string): void; warn(message: string): void } = console,
): HistoryEvents {
  return {
    record(event: HistoryAccessEvent) {
      // 事件对象本身即白名单（model.ts 定义）；不拼接任何请求内容。
      sink.info(`[history.access] ${JSON.stringify(event)}`)
    },
    warn(message: string) {
      sink.warn(`[history.access] ${message}`)
    },
  }
}

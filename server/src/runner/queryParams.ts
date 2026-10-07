// admin 检索面共享 query 参数解析（auditRoutes / usageRoutes 同族）：空串/纯空白 → undefined
// （过滤值缺省语义）；日期解析失败 → undefined（无效过滤静默降级为无过滤，不报 9xxxx）。
export function textParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function dateParam(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

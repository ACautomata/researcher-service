// 已保存产品聚合的纯解析真源；不涉及在飞消息、checkpoint、审批或 ORM。
export function parseProductObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* 消费方决定缺失的展示方式 */ }
  return undefined
}

const PRODUCT_FIELDS = ['thinking', 'tools', 'media', 'files', 'filesTotal', 'hasExec'] as const
export function parseSavedProduct(raw: string): {
  object?: Record<string, unknown>
  fields: Record<string, unknown>
  missing: string[]
} {
  const object = parseProductObject(raw)
  if (!object) return { fields: {}, missing: ['aggregate'] }
  const fields: Record<string, unknown> = {}
  for (const key of PRODUCT_FIELDS) if (object[key] !== undefined) fields[key] = object[key]
  return { object, fields, missing: object.v === 1 ? [] : ['aggregate.version'] }
}

// query 序列化共享 helper（audit / usage admin 面）：undefined 与空串不落 URL，Date → ISO。
// 返回含前导 `?` 的串（全空 → 空串）。
export function q(params: Record<string, string | number | Date | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue
    usp.set(k, v instanceof Date ? v.toISOString() : String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

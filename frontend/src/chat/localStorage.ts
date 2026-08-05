// localStorage 安全读取（对齐官方 webchat-ui local-storage.ts）：隐私模式/受限上下文下访问
// localStorage 可能抛异常 → 降级 null。设备身份 / deviceToken 存储层都从这里取 storage。

export function isStorage(value: unknown): value is Storage {
  return (
    Boolean(value) &&
    typeof (value as Storage).getItem === 'function' &&
    typeof (value as Storage).setItem === 'function'
  )
}

export function getSafeLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage
    return isStorage(storage) ? storage : null
  } catch {
    return null
  }
}

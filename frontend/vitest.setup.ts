// vitest setup —— jsdom 环境就绪后补齐 localStorage。
// 背景（#419 顺带修复）：Node 25+ 在 globalThis 上定义了实验性 localStorage 占位全局
// （'localStorage' in globalThis === true 但值为 undefined，须 --localstorage-file 才可用）。
// vitest 4 populateGlobal 用 `k in global` 判定「Node 自带该键」→ 跳过从 jsdom window 复制 →
// 且把 Node 占位 undefined 复制到 jsdom window 上（getOwnPropertyDescriptor(window).get 返回
// undefined）→ jsdom 环境里 localStorage === undefined，deviceIdentity/deviceTokenStore 19 个
// 用例全挂。修复：setup 阶段用内存 Storage polyfill 显式安装（Node 24 及更早无该全局时，
// populateGlobal 从 jsdom window 复制真实现，此分支不生效）。
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  var localStorage: Storage | undefined
}

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

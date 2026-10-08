// vitest setup —— jsdom 环境就绪后补齐 localStorage。
// 背景（#419 顺带修复）：Node 25+ 在 globalThis 上定义了实验性 localStorage 占位全局，
// vitest 4 populateGlobal 用 `k in global` 判定「Node 自带该键」→ 跳过从 jsdom window 复制 →
// 且把 Node 占位复制到 jsdom window 上 → jsdom 环境里 localStorage 不可用，deviceIdentity/
// 面板宽度等依赖 storage 的用例全挂。占位有两种形态：早期版本值为 undefined；Node 25.2.1 起
// 是有键无方法的 stub 对象（真实现须 --localstorage-file，CI/测试不传）。修复：setup 阶段用
// 内存 Storage polyfill 显式安装——判定以「具备 Storage 方法」为准，两种占位形态都兜住；
// 真 localStorage 环境（Node 24 及更早，populateGlobal 从 jsdom window 复制真实现）不生效。
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

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

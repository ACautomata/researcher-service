// categories store —— Categories 栏目状态单例（issue #85 / spec #75 前端）。
// 与 wiki store 同构但更简：只读浏览，无编辑/落盘/防抖。
// 状态机：current（当前容器）/groups（按 category 动态分组的带标记页，键=开放词表 category 值）/
// activePath（右侧只读打开的页 path）/content（只读正文）。
// codex P2：响应只在仍是「最新一次请求」时才提交（latest-wins 序号守卫），快速连点/连切容器时
// 过期响应不得覆盖最新选择；写 groups 用 __proto__ 安全赋值（开放词表键可能是 `__proto__`）。
import { defineStore } from 'pinia'
import { getCategories, readPage, type CategoriesDTO, type CategoryItemDTO } from '@/api/wiki'

export const useCategoriesStore = defineStore('categories', {
  state: () => ({
    current: '' as string, // 当前容器名（最近一次已提交的）
    // 正在加载/已选定的目标容器（含在飞）。早退判重看 pending 而非 current——否则加载 other
    // 在飞时再选回 demo 会因 current 仍是 demo 被误判 no-op，让 other 过期响应覆盖最终选择（codex P2）。
    pending: '' as string,
    groups: {} as Record<string, CategoryItemDTO[]>, // 按 category 动态分组（开放词表）
    activePath: '' as string, // 右侧只读打开的页 path（空=未打开）
    content: '' as string, // 只读正文
    _loadSeq: 0 as number, // loadCategories 请求序号（latest-wins）
    _readSeq: 0 as number, // openItem 请求序号（latest-wins）
  }),
  actions: {
    async loadCategories(name: string): Promise<void> {
      const seq = ++this._loadSeq
      this.pending = name // 同步记录目标（不等响应），供早退判重
      let cats: CategoriesDTO
      try {
        cats = await getCategories(name)
      } catch (e) {
        // 失败且该次仍是最新：回滚 pending 到已提交的 current，否则重试同一容器会被早退吞掉（codex P2）
        if (seq === this._loadSeq) this.pending = this.current
        throw e
      }
      if (seq !== this._loadSeq) return // 过期响应：已有更新的加载，丢弃
      this.current = name
      this._assignGroups(cats)
    },

    // 点条目：右侧只读展示完整正文（复用 readPage 取全文）
    async openItem(path: string): Promise<void> {
      const seq = ++this._readSeq
      const container = this.current
      const page = await readPage(container, path)
      // 过期响应：期间又点了别的条目，或已切走容器（此时 activePath/content 已被切容器清空）
      if (seq !== this._readSeq || container !== this.current) return
      this.activePath = path
      this.content = page.content
    },

    async switchContainer(name: string): Promise<void> {
      // 早退判 pending 而非 current：pending 才是用户已选定的目标（含在飞），重复选它=no-op；
      // 选别的（含在飞期间选回 current）必须推进以作废旧请求。
      if (name === this.pending) return
      this.activePath = ''
      this.content = ''
      this._readSeq += 1 // 使在飞的 readPage 响应失效（不得回填到已清空的阅读区）
      await this.loadCategories(name)
    },

    // 重挂载/初始化：清掉 Pinia 残留的旧选中态，再切到目标容器（对齐 wiki.resetForContainer）
    async resetForContainer(name: string): Promise<void> {
      this.activePath = ''
      this.content = ''
      this._readSeq += 1
      await this.loadCategories(name)
    },

    // __proto__ 安全赋值：普通对象字面量 `obj['__proto__'] = v` 会走原型 setter 而不存值，
    // category 是开放词表（后端可返回 `__proto__`），故先重建对象再逐项 defineProperty。
    _assignGroups(cats: CategoriesDTO): void {
      const next: Record<string, CategoryItemDTO[]> = {}
      for (const [k, v] of Object.entries(cats)) {
        Object.defineProperty(next, k, { value: v, writable: true, enumerable: true, configurable: true })
      }
      this.groups = next
    },
  },
})

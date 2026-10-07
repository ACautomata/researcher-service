// categories store —— Categories 栏目状态单例（issue #85 / spec #75 前端）。
// 与 wiki store 同构但更简：只读浏览，无编辑/落盘/防抖。
// #856：owner 级（ownerId 直取认证身份）——每用户仅一份本人 wiki，无容器切换面；
// 状态机只剩 groups（按 category 动态分组的带标记页，键=开放词表 category 值）/
// activePath（右侧只读打开的页 path）/content（只读正文）。
// codex P2：响应只在仍是「最新一次请求」时才提交（latest-wins 序号守卫）；写 groups 用
// __proto__ 安全赋值（开放词表键可能是 `__proto__`）。
import { defineStore } from 'pinia'
import { getCategories, readPage, type CategoriesDTO, type CategoryItemDTO } from '@/api/wiki'

export const useCategoriesStore = defineStore('categories', {
  state: () => ({
    groups: {} as Record<string, CategoryItemDTO[]>, // 按 category 动态分组（开放词表）
    activePath: '' as string, // 右侧只读打开的页 path（空=未打开）
    content: '' as string, // 只读正文
    _loadSeq: 0 as number, // loadCategories 请求序号（latest-wins）
    _readSeq: 0 as number, // openItem 请求序号（latest-wins）
  }),
  actions: {
    async loadCategories(): Promise<void> {
      const seq = ++this._loadSeq
      const cats = await getCategories()
      if (seq !== this._loadSeq) return // 过期响应：已有更新的加载，丢弃
      this._assignGroups(cats)
    },

    // 点条目：右侧只读展示完整正文（复用 readPage 取全文）
    async openItem(path: string): Promise<void> {
      const seq = ++this._readSeq
      const page = await readPage(path)
      // 过期响应：期间又点了别的条目，或已 reset（此时 activePath/content 已被清空）
      if (seq !== this._readSeq) return
      this.activePath = path
      this.content = page.content
    },

    // 重挂载/初始化：清掉 Pinia 残留的旧选中态再重载分组。
    async reset(): Promise<void> {
      this.activePath = ''
      this.content = ''
      this._readSeq += 1
      await this.loadCategories()
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

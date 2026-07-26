// categories store —— Categories 栏目状态单例（issue #85 / spec #75 前端）。
// 与 wiki store 同构但更简：只读浏览，无编辑/落盘/防抖。
// 状态机：current（当前容器）/groups（按 category 动态分组的带标记页，键=开放词表 category 值）/
// activePath（右侧只读打开的页 path）/content（只读正文）。
import { defineStore } from 'pinia'
import { getCategories, readPage, type CategoryItemDTO } from '@/api/wiki'

export const useCategoriesStore = defineStore('categories', {
  state: () => ({
    current: '' as string, // 当前容器名
    groups: {} as Record<string, CategoryItemDTO[]>, // 按 category 动态分组（开放词表）
    activePath: '' as string, // 右侧只读打开的页 path（空=未打开）
    content: '' as string, // 只读正文
  }),
  actions: {
    async loadCategories(name: string): Promise<void> {
      const cats = await getCategories(name)
      this.current = name
      this.groups = cats
    },

    // 点条目：右侧只读展示完整正文（复用 readPage 取全文）
    async openItem(path: string): Promise<void> {
      const page = await readPage(this.current, path)
      this.activePath = path
      this.content = page.content
    },

    async switchContainer(name: string): Promise<void> {
      if (name === this.current) return
      this.activePath = ''
      this.content = ''
      await this.loadCategories(name)
    },

    // 重挂载/初始化：清掉 Pinia 残留的旧选中态，再切到目标容器（对齐 wiki.resetForContainer）
    async resetForContainer(name: string): Promise<void> {
      this.activePath = ''
      this.content = ''
      await this.loadCategories(name)
    },
  },
})

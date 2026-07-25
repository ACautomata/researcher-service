// wiki store —— wiki 编辑页状态单例（spec §9.6 Pinia store: wiki / issue #45）。
// 状态机：current（当前容器）/groups（文件树）/activePath（编辑器打开页）/draft（编辑草稿）/
// dirty（未落盘标记）/saving（落盘中）。Typora 式自动保存：编辑标脏 + 防抖 ~800ms 落盘到当前
// 容器；打开另一页 / 切换容器前先落盘（flush）当前脏页。
import { defineStore } from 'pinia'
import {
  createPage as apiCreate,
  deletePage as apiDelete,
  getTree,
  readPage,
  updatePage,
  type WikiTreeGroupDTO,
} from '@/api/wiki'

// spec §9.6：自动保存防抖 ~800ms
export const AUTOSAVE_DEBOUNCE_MS = 800

export const useWikiStore = defineStore('wiki', {
  state: () => ({
    current: '' as string, // 当前容器名
    groups: [] as WikiTreeGroupDTO[],
    activePath: '' as string, // 编辑器打开的页 path（空=未打开）
    draft: '' as string, // 编辑草稿（content）
    dirty: false as boolean, // 有未落盘改动
    saving: false as boolean,
    _saveTimer: null as ReturnType<typeof setTimeout> | null,
  }),
  actions: {
    async loadTree(name: string): Promise<void> {
      const tree = await getTree(name)
      this.current = name
      this.groups = tree.groups
    },

    async openPage(path: string): Promise<void> {
      // 打开另一页前先落盘当前脏页（验收 2：编辑不丢）
      await this._flush()
      const page = await readPage(this.current, path)
      this.activePath = path
      this.draft = page.content
      this.dirty = false
    },

    edit(content: string): void {
      // Typora 式自动保存：标脏 + 防抖合并，~800ms 落盘到当前容器
      this.draft = content
      this.dirty = true
      this._scheduleSave()
    },

    async createPage(path: string, content: string): Promise<void> {
      await apiCreate(this.current, path, content)
      await this.loadTree(this.current) // 新建后刷新树
    },

    async deletePage(path: string): Promise<void> {
      await apiDelete(this.current, path)
      // 删的是当前打开页 → 清空编辑器
      if (this.activePath === path) {
        this._cancelSave()
        this.activePath = ''
        this.draft = ''
        this.dirty = false
      }
      await this.loadTree(this.current) // 删除后刷新树
    },

    async switchContainer(name: string): Promise<void> {
      if (name === this.current) return
      // 切容器前先落盘当前脏页（验收 4：切前落盘）
      await this._flush()
      this.activePath = ''
      this.draft = ''
      this.dirty = false
      await this.loadTree(name)
    },

    // 落盘当前脏页（若有）；清防抖定时器。串行化：在飞落盘期间不并发第二次，
    // 期间的编辑置 dirty，落盘返回后由防抖再次落盘。
    async _flush(): Promise<void> {
      this._cancelSave()
      if (!this.dirty || !this.activePath || !this.current) return
      if (this.saving) return // 已有在飞落盘；新改动留在 dirty，等下一轮防抖
      const path = this.activePath
      const content = this.draft
      this.saving = true
      try {
        await updatePage(this.current, path, content)
        // 落盘期间可能有新编辑；仅当草稿未再变才清脏
        if (this.draft === content) this.dirty = false
      } finally {
        this.saving = false
      }
    },

    _scheduleSave(): void {
      this._cancelSave()
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null
        void this._flush()
      }, AUTOSAVE_DEBOUNCE_MS)
    },

    _cancelSave(): void {
      if (this._saveTimer !== null) {
        clearTimeout(this._saveTimer)
        this._saveTimer = null
      }
    },
  },
})

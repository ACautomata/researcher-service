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
    // 保存失败原因（#202 问题2/3）：落盘失败写入供视图展示「保存失败」+ 手动重试；
    // 成功落盘后清空。失败不清 dirty——草稿仍在，恢复后自动保存/重试可再落盘
    saveError: '' as string,
    // 保存成功序号（codex 意见6）：每次落盘成功递增，视图 watch 它刷新树/图谱
    // （title/wikilink 变更即时反映，store 不泄漏视图关注点）
    saveSeq: 0 as number,
    _saveTimer: null as ReturnType<typeof setTimeout> | null,
    // 保存串行链（codex 意见2）：所有落盘经此链排队，导航 await 它不丢在飞期间改动
    _saveChain: Promise.resolve() as Promise<void>,
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

    // 重挂载/初始化：清掉 Pinia 残留的旧编辑器态（activePath/draft/dirty），再切到目标容器
    // （codex PR #62 意见3：否则旧容器 draft 会在新容器下显示/被覆盖写）。
    async resetForContainer(name: string): Promise<void> {
      await this._flush() // 残留脏页先落盘（不丢编辑）
      this._cancelSave()
      this.activePath = ''
      this.draft = ''
      this.dirty = false
      await this.loadTree(name)
    },

    // 落盘当前脏页（若有）。串行化：save 调用经 Promise 链排队，在飞保存期间的编辑
    // 会排在链尾再存一次（codex PR #62 意见2：导航 await 此链，不丢在飞期间的改动）。
    // #202 问题2：链尾 catch 吸收错误——_persistDirty 失败（401/网络抖动/5xx）后链不得
    // 保持 rejected，否则后续自动保存全部静默失效、导航被旧异常永久阻断（链中毒）。
    async _flush(): Promise<void> {
      this._cancelSave()
      // 把本次落盘接到保存链尾；无论之前是否在飞，都等链上既有保存完成再存剩余脏快照。
      this._saveChain = this._saveChain
        .then(() => this._persistDirty())
        .catch(() => {}) // 失败已由 _persistDirty 记入 saveError；链本身永不 rejected
      await this._saveChain
    },

    async _persistDirty(): Promise<void> {
      if (!this.dirty || !this.activePath || !this.current) return
      const path = this.activePath
      const content = this.draft
      this.saving = true
      try {
        await updatePage(this.current, path, content)
        // 落盘期间可能有新编辑；仅当草稿未再变才清脏
        if (this.draft === content) this.dirty = false
        this.saveError = '' // 落盘成功，清掉旧失败提示
        this.saveSeq += 1 // 通知视图刷新树/图谱（意见6）
      } catch (e) {
        // 保存失败（#202 问题2/3）：记录原因供视图展示 + 手动重试；不清 dirty（草稿仍在）。
        // 错误在此吸收、不向链传播——导航（openPage/switchContainer）不被旧失败阻断，
        // 下一次防抖/flush 会以剩余脏快照重试落盘。
        this.saveError = (e as Error).message
      } finally {
        this.saving = false
      }
    },

    _scheduleSave(): void {
      this._cancelSave()
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null
        // 链已吸收错误，catch 兜底防未处理 rejection（#202 问题3）
        void this._flush().catch(() => {})
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

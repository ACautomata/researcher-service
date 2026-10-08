// Read-only wiki reader. Sequence guards keep slow responses out of newer navigation.
// #856：owner 级（ownerId 直取认证身份）——每用户仅一份本人 wiki，无容器切换面。
import { defineStore } from 'pinia'
import { getClaims, getTree, readPage, type WikiClaimsDTO, type WikiPageContentDTO, type WikiTreeGroupDTO } from '@/api/wiki'

export const useWikiStore = defineStore('wiki', {
  state: () => ({
    groups: [] as WikiTreeGroupDTO[], activePath: '',
    page: null as WikiPageContentDTO | null,
    claims: null as WikiClaimsDTO | null,
    claimsError: false, loading: false,
    _treeSeq: 0, _pageSeq: 0,
  }),
  actions: {
    async loadTree(): Promise<void> {
      const seq = ++this._treeSeq
      const tree = await getTree()
      if (seq !== this._treeSeq) return
      this.groups = tree.groups
    },
    async openPage(path: string): Promise<void> {
      const seq = ++this._pageSeq
      this.loading = true
      this.page = null
      this.claims = null
      this.claimsError = false
      this.activePath = path
      try {
        const page = await readPage(path)
        if (seq !== this._pageSeq) return
        this.page = page
        try {
          const claims = await getClaims(path)
          if (seq === this._pageSeq) this.claims = claims
        } catch {
          if (seq === this._pageSeq) this.claimsError = true
        }
      } finally {
        if (seq === this._pageSeq) this.loading = false
      }
    },
    // 重挂载/初始化：清掉 Pinia 残留的旧选中态再重载树（对齐原 resetForContainer 语义）。
    async reset(): Promise<void> {
      this._pageSeq += 1
      this.groups = []
      this.activePath = ''
      this.page = null
      this.claims = null
      this.claimsError = false
      this.loading = false
      await this.loadTree()
    },
  },
})

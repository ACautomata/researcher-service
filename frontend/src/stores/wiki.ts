// Read-only wiki reader. Sequence guards keep slow responses out of newer navigation.
import { defineStore } from 'pinia'
import { getClaims, getTree, readPage, type WikiClaimsDTO, type WikiPageContentDTO, type WikiTreeGroupDTO } from '@/api/wiki'

export const useWikiStore = defineStore('wiki', {
  state: () => ({
    current: '', groups: [] as WikiTreeGroupDTO[], activePath: '',
    page: null as WikiPageContentDTO | null,
    claims: null as WikiClaimsDTO | null,
    claimsError: false, loading: false,
    _treeSeq: 0, _pageSeq: 0,
  }),
  actions: {
    async loadTree(name: string): Promise<void> {
      const seq = ++this._treeSeq
      const tree = await getTree(name)
      if (seq !== this._treeSeq) return
      this.current = name
      this.groups = tree.groups
    },
    async openPage(path: string): Promise<void> {
      const seq = ++this._pageSeq
      const container = this.current
      this.loading = true
      this.page = null
      this.claims = null
      this.claimsError = false
      this.activePath = path
      try {
        const page = await readPage(container, path)
        if (seq !== this._pageSeq || container !== this.current) return
        this.page = page
        try {
          const claims = await getClaims(container, path)
          if (seq === this._pageSeq && container === this.current) this.claims = claims
        } catch {
          if (seq === this._pageSeq && container === this.current) this.claimsError = true
        }
      } finally {
        if (seq === this._pageSeq) this.loading = false
      }
    },
    async switchContainer(name: string): Promise<void> {
      this._pageSeq += 1
      this.current = name
      this.groups = []
      this.activePath = ''
      this.page = null
      this.claims = null
      this.claimsError = false
      this.loading = false
      await this.loadTree(name)
    },
    async resetForContainer(name: string): Promise<void> {
      await this.switchContainer(name)
    },
  },
})

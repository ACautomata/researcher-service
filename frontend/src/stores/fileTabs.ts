// fileTabs store —— workspace 树数据 + 只读文件 tab 状态机（#626 T1 / #618 规格 §3，决议 A：与
// useChatStore 同级 Pinia store，不扩进 chatStore）。树数据（tree）与 tab 数据同住本 store：二者同属
// 「文件面板」关注点、同 per-container 生命周期（切容器树重拉 + tab 清空），合住避免再开一 store。
//
// T1 子集：只做「手动浏览」端到端（树点击开只读 tab、切会话/容器清空）。FileTab.state 仅 'loaded' | 'error'，
// 不实现 'pending' / onToolEvent / loadAndHighlight（agent 自动弹 tab + diff 高亮留后续票）。
// 容器名经 useChatStore().selectedContainer 取（Pinia 跨 store 引用，单一来源）。
import { defineStore } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { ApiError } from '@/api/client'
import { listWorkspaceTree, readWorkspaceFile, type DirListing } from '@/api/files'

export interface FileTab {
  path: string // workspace 相对路径；唯一 key（同路径复用单 tab）
  state: 'loaded' | 'error' // T1 子集；后续 agent 票加 'pending'
  content: string | null // 全文（loaded 且非 binary/oversized）；fetch 中 / error 为 null
  lineMarks: number[] // 高亮行号（1-based）；T1 树点击恒 []（无高亮），后续 agent 票写入
  binary: boolean
  oversized: boolean
  errorMessage?: string // error 态文案（fetch 失败 / 文件不存在）
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return '读取失败'
}

export const useFileTabsStore = defineStore('fileTabs', {
  state: () => ({
    tree: null as DirListing | null, // workspace 递归树（基线 3）
    treeLoading: false as boolean,
    treeTruncated: false as boolean,
    treeError: null as string | null, // 树拉取失败文案（§4.3：失败 → tree=null + 错误空态）
    tabs: [] as FileTab[],
    activePath: null as string | null,
  }),
  actions: {
    // 拉 workspace 递归树（切到「文件」分段 / 容器变更触发）。中途切容器丢弃迟到响应。
    async loadTree(): Promise<void> {
      const chat = useChatStore()
      const name = chat.selectedContainer
      if (!name) return
      this.treeLoading = true
      this.treeError = null
      try {
        const listing = await listWorkspaceTree(name)
        if (chat.selectedContainer !== name) return // 切走了：丢弃旧容器响应
        this.tree = listing
        this.treeTruncated = listing.truncated
      } catch (e) {
        if (chat.selectedContainer !== name) return
        this.tree = null
        this.treeError = describeError(e)
      } finally {
        this.treeLoading = false
      }
    },

    // 树点击开只读 tab（基线 6：无高亮，与 agent 触发同面板同机制）。同路径复用 → 仅切 active 不重拉。
    async openFromTree(path: string): Promise<void> {
      if (this.tabs.some((t) => t.path === path)) {
        this.activePath = path
        return
      }
      this.tabs.push({
        path,
        state: 'loaded',
        content: null, // fetch 完成前置 null（查看器出「正在读取…」轻提示）
        lineMarks: [],
        binary: false,
        oversized: false,
      })
      this.activePath = path
      const chat = useChatStore()
      const name = chat.selectedContainer
      if (!name) return
      try {
        const fr = await readWorkspaceFile(name, path)
        if (chat.selectedContainer !== name) return
        const tab = this.tabs.find((t) => t.path === path)
        if (!tab) return // await 中途用户已关掉 → 静默丢弃
        tab.content = fr.content
        tab.binary = fr.binary
        tab.oversized = fr.oversized
      } catch (e) {
        if (chat.selectedContainer !== name) return
        const tab = this.tabs.find((t) => t.path === path)
        if (!tab) return
        tab.state = 'error'
        tab.content = null
        tab.errorMessage = describeError(e)
      }
    },

    // 关单 tab；删的是 active → 切前一个相邻或 null（变体 A 原型 closeTab 语义）
    closeTab(path: string): void {
      const idx = this.tabs.findIndex((t) => t.path === path)
      if (idx === -1) return
      this.tabs.splice(idx, 1)
      if (this.activePath === path) {
        const next = this.tabs[Math.max(0, idx - 1)] ?? null
        this.activePath = next ? next.path : null
      }
    },

    // 清全部 tab + active（保留 tree）—— 切会话语义（基线 6「切会话清空」+ 树是 per-container 保留）
    closeAll(): void {
      this.tabs = []
      this.activePath = null
    },

    // 全清（含 tree）—— 切容器语义（基线 3「切容器重拉」：tree 清空后下次进「文件」分段触发 loadTree）
    reset(): void {
      this.tabs = []
      this.activePath = null
      this.tree = null
      this.treeTruncated = false
      this.treeError = null
    },
  },
})

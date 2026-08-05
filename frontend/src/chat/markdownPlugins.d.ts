// #401 / ticket #402：markdown-it-emoji / markdown-it-task-lists 类型声明。
// 两插件无官方类型（@types/markdown-it-emoji 是旧 CJS export= 形态，与 v3 命名导出不匹配；
// task-lists 无 @types）。import 置于 declare module 内部——文件保持 script（全局声明），
// 对无类型的真实 node_modules 模块做 ambient 声明（TS 5/6 下模块型文件内的 declare module 是
// 增补语义，无法凭空建未声明模块）。
declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it'

  export interface EmojiOptions {
    defs?: Record<string, string>
    enabled?: string[]
    shortcuts?: Record<string, string | string[]>
    replace?: (code: string) => string
  }
  export function full(md: MarkdownIt, options?: EmojiOptions): void
  export function bare(md: MarkdownIt, options?: EmojiOptions): void
  export function light(md: MarkdownIt, options?: EmojiOptions): void
}

declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it'

  export interface TaskListsOptions {
    enabled?: boolean
    label?: boolean
    labelAfter?: boolean
  }
  export default function taskLists(md: MarkdownIt, options?: TaskListsOptions): void
}

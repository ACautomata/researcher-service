declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it'

  interface KatexOptions {
    throwOnError?: boolean
    errorColor?: string
  }

  const plugin: (md: MarkdownIt, options?: KatexOptions) => void
  export default plugin
}

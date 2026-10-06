import type { MediaRef } from '@/api/sessions'

// #780 下载节点的 ToolMessage 引用格式；不从正文 URL 推断下载入口。
export function downloadReferences(result: unknown): MediaRef[] {
  if (typeof result !== 'string') return []
  return [...result.matchAll(/\[download attachmentId=(\S+) fileName=(.*?) mime=(\S+) size=(\d+)\]/g)]
    .map((match) => ({ attachmentId: match[1]!, fileName: match[2]!, mime: match[3]!, size: Number(match[4]) }))
}

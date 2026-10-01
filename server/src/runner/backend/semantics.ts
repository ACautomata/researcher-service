// runner backend 纯逻辑语义（#747·02 DockerArchiveBackend 的 edit 合成与 read 行分页）。
// 语义逐条镜像 deepagents@1.14.1 官方实现（normalizeReadPagination / performStringReplacement /
// checkEmptyContent 的 langsmith chunk 原文）——基座三包联动升级时按上游核对本文件（S3 锁定先例）。
// 纯函数零 IO，dockerArchiveBackend.ts 组装，测试直锁。

// 归一化调用方传入的分页界（负数/NaN/Infinity → 0，浮点取整）——对齐 deepagents normalizeReadPagination。
export function normalizePagination(offset: number, limit: number): { offset: number; limit: number } {
  return {
    offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
    limit: Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0,
  }
}

export type PaginateResult =
  | {
      content: string
      totalLines?: number
      startLine?: number
      endLine?: number
      nextOffset?: number
    }
  | { error: string }

// read 行分页：totalLines 剔除末尾空段（尾换行不算一行，官方语义）；offset 越界 → error
// （文案对齐官方 `Line offset X exceeds file length (Y lines)`）；nextOffset=endLine<totalLines 时给出。
export function paginateReadLines(fullText: string, requestedOffset: number, requestedLimit: number): PaginateResult {
  const { offset, limit } = normalizePagination(requestedOffset, requestedLimit)
  const lines = fullText.split('\n')
  const totalLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (offset >= totalLines) {
    return { error: `Line offset ${offset} exceeds file length (${totalLines} lines)` }
  }
  const sliceEndIdx = Math.min(offset + limit, lines.length)
  const endLine = Math.min(offset + limit, totalLines)
  const selectedLines = lines.slice(offset, sliceEndIdx)
  // 官方分支：空选择或 limit=0 只回 content，不带分页字段（agent 据 content 继续）。
  if (selectedLines.length === 0 || limit === 0) {
    return { content: selectedLines.join('\n') }
  }
  return {
    content: selectedLines.join('\n'),
    totalLines,
    startLine: offset + 1,
    endLine,
    nextOffset: endLine < totalLines ? endLine : undefined,
  }
}

// edit 合成核心：返回 [新全文, 命中次数] 或错误文案（文案对齐官方，agent 自纠依赖字面）。
// 官方特判：空文件 + 空 oldString = 写入初始内容；非空文件 + 空 oldString = 拒绝；
// 多命中且未 replaceAll = 拒绝（要求更精确的 oldString，防静默错改——PoC 与官方差异点，按官方）。
export function performStringReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): [string, number] | string {
  if (content === '' && oldString === '') return [newString, 0]
  if (oldString === '') return 'Error: oldString cannot be empty when file has content'
  const occurrences = content.split(oldString).length - 1
  if (occurrences === 0) return `Error: String not found in file: '${oldString}'`
  if (occurrences > 1 && !replaceAll) {
    return `Error: String '${oldString}' has multiple occurrences (appears ${occurrences} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`
  }
  return [content.split(oldString).join(newString), occurrences]
}

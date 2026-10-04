// #780 D9 媒体块扫描（纯逻辑，S3 接缝）：run 完成前从终态 messages 提取 agent 声明的媒体块。
// V1 形态：assistant 消息 content 数组中的 image_url 块、url 指向沙箱 /lab/ 文件路径（agent 经
// 工具产出文件后以内容块声明产物路径）。mime 按扩展名派生；kind 白名单 image/audio/video
//（document V1 不放行，#747 G 节 D9）——白名单外扩展名进降级清单（runner 侧文本占位 + 审计
// 计数），不进物化清单。
// 0 信任：messages 元素形状不假设（checkpoint 反序列化产物或测试注入均可）——逐字段 typeof 门，
// 非法块静默跳过（fail-closed 不炸 run）。

export interface DeclaredMediaBlock {
  /** image_url 块类型（LangChain 通用内容块）；audio/video 经扩展名归 kind，块形态 V1 同 image_url */
  readonly blockType: 'image_url'
  /** agent 声明的沙箱绝对路径（/lab/... 前缀白名单由本扫描保证） */
  readonly declaredPath: string
  /** 派生 mime（扩展名映射） */
  readonly mime: string
}

export interface DegradedMediaBlock {
  readonly declaredPath: string
  readonly reason: 'not_lab' | 'mime_not_allowed'
}

// 扩展名 → mime 白名单（image/audio/video 三族；document V1 不放行）。
const EXT_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function mimeOf(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_MIME[path.slice(dot).toLowerCase()] ?? null
}

// 扫描终态最后一条消息（agent 最终回复）的 content 块，产出「可物化」与「须降级」两清单。
// url 非 /lab/ 前缀（含 data: URL——V1 不可从路径物化）→ 降级 not_lab；扩展名不在白名单 → 降级
// mime_not_allowed。同一路径重复声明去重（首见为准）。
export function scanMediaBlocks(lastMessage: unknown): {
  materializable: DeclaredMediaBlock[]
  degraded: DegradedMediaBlock[]
} {
  const materializable: DeclaredMediaBlock[] = []
  const degraded: DegradedMediaBlock[] = []
  const seen = new Set<string>()
  const content = (lastMessage as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return { materializable, degraded }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; image_url?: { url?: unknown } }
    if (b.type !== 'image_url') continue
    const url = b.image_url?.url
    if (typeof url !== 'string' || url === '') continue
    if (seen.has(url)) continue
    seen.add(url)
    if (!url.startsWith('/lab/')) {
      degraded.push({ declaredPath: url, reason: 'not_lab' })
      continue
    }
    const mime = mimeOf(url)
    if (mime === null) {
      degraded.push({ declaredPath: url, reason: 'mime_not_allowed' })
      continue
    }
    materializable.push({ blockType: 'image_url', declaredPath: url, mime })
  }
  return { materializable, degraded }
}

// 终态 messages 的最后一条（agent 最终回复；空数组 → null）。
export function lastMessage(messages: unknown[]): unknown | null {
  return messages.length > 0 ? (messages[messages.length - 1] as unknown) : null
}

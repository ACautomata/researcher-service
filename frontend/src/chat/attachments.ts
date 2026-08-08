// #459-T1 #462：附件采集/校验/组装纯函数模块。
// 采集层（#463 composer 三通道）产生的原始附件 → 类型过滤（白名单 image/audio/video）→
// 体积校验（按字节估算 base64 膨胀，非图片 ≤700KB，图片压缩后同限）→ 组装官方 chat.send
// 的 attachments[] 形状。超限/非法附件拒发（返回 rejected 供 UI 提示「文件过大/类型不支持」）。
//
// 体积上限核算（隧道边界，T1 acceptance）：
//   server TUNNEL_MAX_PAYLOAD = 1MiB（单帧 ws maxPayload，server/src/chat/values.ts）；base64 膨胀
//   系数 4/3。MAX_ATTACHMENT_BYTES = 700KB → base64 后 ceil(716800/3)*4 = 955,734B ≈ 0.91MiB < 1MiB，
//   留 ~97KB 余量容纳 JSON 帧头 + message + idempotencyKey 等元数据。
//   图片与非图片共用此限——图片压缩（最长边 1280 + JPEG/WebP，#463）完成后再入本模块校验，本模块
//   不做压缩（#462 仅协议能力，#463 采集/压缩）。TUNNEL_SEND_BUDGET（4MiB 连接级发送预算）不变。

// 官方 chat.send attachments[] 元素形状（@openclaw/gateway-protocol schema，0 信任 content 自由形状）。
export interface Attachment {
  type?: string
  mimeType?: string
  fileName?: string
  content?: unknown
  sizeBytes?: number
  durationMs?: number
  width?: number
  height?: number
}

// 采集层（#463）输入的原始附件——与官方形状同构，额外字段（如预览 objectURL）由采集层自行管理，
// 本模块只消费组装 attachments[] 所需的字段。
export type RawAttachment = Partial<Attachment>

export interface RejectedAttachment {
  fileName?: string
  reason: 'type' | 'size'
}

// 附件体积上限（字节数）：非图片 ≤700KB，base64 后 <1MiB 隧道帧上限留余量（见文件头核算）。
export const MAX_ATTACHMENT_BYTES = 700 * 1024

// 一次 chat.send 全部附件的合计体积预算（字节数）：与单附件同值。chat.send 帧在一条 WS 帧里，
// 合计才决定帧体积——单附件 ≤700KB 守住还不够，2×700KB 合计 1.4MB 会超 1MiB 帧上限。先发顺序
// 放行，累积超预算的后续附件拒发（采集层 #463 可据 rejected 提示「附件合计过大」）。
export const MAX_TOTAL_BYTES = MAX_ATTACHMENT_BYTES

// 类型白名单（放行 image/audio/video 前缀——与 #464 渲染范围对齐；文档等仅发送、渲染层不处理，
// 但须挡攻击者塞大字节进 free-form content 爆破帧上限）。mimeType 缺失/空前缀不匹配一律拦截。
export function isAllowedAttachmentType(mimeType: string | undefined): boolean {
  if (typeof mimeType !== 'string' || !mimeType) return false
  return mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
}

// 附件字节数（体积校验依据）：优先显式 sizeBytes（采集层已知真实大小），回退 string content 长度
// （base64 字符串长度 ≈ 原始字节 4/3，保守用其长度本身当字节数——略高估 base64 前体积，安全方向）。
// content 自由形状（0 信任）：非 string 且无 sizeBytes → 视为 0（无法估量，交网关/隧道边界兜底）。
function attachmentByteCount(a: RawAttachment): number {
  if (typeof a.sizeBytes === 'number' && Number.isFinite(a.sizeBytes) && a.sizeBytes >= 0) return a.sizeBytes
  if (typeof a.content === 'string') return a.content.length
  return 0
}

// 采集 → 校验 → 组装：返回放行附件（官方形状）+ 拒发清单（reason 供 UI 区分「类型不支持/文件过大」）。
// 不接受附件输入（空数组/null/undefined）→ { attachments: [], rejected: [] }（不带附件输入返回空数组）。
export function buildAttachments(input: RawAttachment[] | null | undefined): {
  attachments: Attachment[]
  rejected: RejectedAttachment[]
} {
  const attachments: Attachment[] = []
  const rejected: RejectedAttachment[] = []
  if (!Array.isArray(input)) return { attachments, rejected }
  // 合计体积预算：chat.send 一条 WS 帧，累积已放行附件的字节数，超 MAX_TOTAL_BYTES 的后续附件拒发。
  let totalBytes = 0
  for (const a of input) {
    if (!a || typeof a !== 'object') continue
    if (!isAllowedAttachmentType(a.mimeType)) {
      rejected.push({ fileName: a.fileName, reason: 'type' })
      continue
    }
    const bytes = attachmentByteCount(a)
    if (bytes > MAX_ATTACHMENT_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      rejected.push({ fileName: a.fileName, reason: 'size' })
      continue
    }
    totalBytes += bytes
    attachments.push({
      type: a.type,
      mimeType: a.mimeType,
      fileName: a.fileName,
      content: a.content,
      sizeBytes: a.sizeBytes,
      durationMs: a.durationMs,
      width: a.width,
      height: a.height,
    })
  }
  return { attachments, rejected }
}

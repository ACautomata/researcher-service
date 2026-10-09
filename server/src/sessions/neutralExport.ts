// story 64（#747 · R6 双栈不可逆缓解）：会话数据 → 中性格式 JSON 的映射纯函数。
//
// 规格（#747 B 节）：「中性导出离线脚本——从 session_messages 导出中性格式 JSON」；
// story 64：「会话数据可导出为中性格式，so that 双栈分叉不是单行道」。
//
// 「中性」口径：
//   - 只含产品读源字段（turn/role/content/clientKey/attachments v1 聚合）——LangGraph
//     checkpoint blob / DB 机制列（archivedAt / anchorCheckpointId / attachmentsJson 命名）
//     一律不落导出面；
//   - fork 溯源（parentSessionKey / forkSource）保留——跨栈对账要认得出来源；
//   - 输入零信任：attachmentsJson / forkSourceJson 解析失败 → 相应字段省略（不 throw）；
//   - 输出序 = (turn, createdAt) 升序，与输入顺序无关（回放确定性）。
//
// 本模块零 IO：离线脚本（server/scripts/export-neutral.mts）与本测试共用此单一映射来源。

export interface NeutralExportSessionRow {
  readonly id: string
  readonly title: string
  readonly createdAt: Date
  readonly parentSessionKey: string | null
  readonly forkSourceJson: string | null
}

export interface NeutralExportMessageRow {
  readonly turn: number
  readonly role: string
  readonly content: string
  readonly clientKey: string | null
  readonly attachmentsJson: string
  readonly createdAt: Date
}

export interface NeutralSessionMessage {
  readonly turn: number
  readonly role: string
  readonly content: string
  readonly createdAt: string
  readonly clientKey?: string
  /** attachmentsJson v1 聚合（原样透传——产品 schema 版本化，跨栈可读）；解析失败/空聚合省略 */
  readonly attachments?: Record<string, unknown>
}

export interface NeutralSessionExport {
  readonly format: 'researcher-session-export'
  readonly version: 1
  readonly exportedAt: string
  readonly session: {
    readonly id: string
    readonly title: string
    readonly createdAt: string
    readonly parentSessionKey?: string
    readonly forkSource?: Record<string, unknown>
  }
  readonly messages: readonly NeutralSessionMessage[]
}

// 防御解析（零信任）：非对象/数组根的 JSON 同样视为缺失（attachments 面只接受对象聚合）。
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    /* 非法 JSON → 省略 */
  }
  return undefined
}

export function buildNeutralSessionExport(
  session: NeutralExportSessionRow,
  rows: readonly NeutralExportMessageRow[],
  exportedAt: Date = new Date(),
): NeutralSessionExport {
  const sorted = [...rows].sort(
    (a, b) => a.turn - b.turn || a.createdAt.getTime() - b.createdAt.getTime(),
  )
  const messages: NeutralSessionMessage[] = sorted.map((r) => {
    const message: NeutralSessionMessage = {
      turn: r.turn,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }
    if (r.clientKey !== null && r.clientKey !== '') {
      return { ...message, clientKey: r.clientKey }
    }
    return message
  })
  const withAttachments: NeutralSessionMessage[] = messages.map((m, i) => {
    // v1 空聚合（仅 {v:1}）不携带信息——省略保持导出面干净
    const attachments = parseObject(sorted[i]!.attachmentsJson)
    if (attachments !== undefined && Object.keys(attachments).some((k) => k !== 'v')) {
      return { ...m, attachments }
    }
    return m
  })

  const forkSource = session.forkSourceJson !== null ? parseObject(session.forkSourceJson) : undefined

  return {
    format: 'researcher-session-export',
    version: 1,
    exportedAt: exportedAt.toISOString(),
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      ...(session.parentSessionKey !== null && session.parentSessionKey !== ''
        ? { parentSessionKey: session.parentSessionKey }
        : {}),
      ...(forkSource !== undefined ? { forkSource } : {}),
    },
    messages: withAttachments,
  }
}

// 轮次产物卡片（#951 D8 · 施工票 #959）行契约与聚合映射：runService 段级时隙（completed/
// interrupted——#972·R1 B 裁决分段按段出卡）按 (sessionId, runId) 查 fileJournal 行后经本函数
// 过滤/映射为 turn.files 卡片行。类型单一声明处——sessions/reducer.ts（TurnSnapshot.files）
// type-only 引用，前端 api/sessions.ts 逐字段镜像。
import type { FileJournal } from '../../generated/prisma/client'
import { extractExecCrossed } from './preview'
import { IDEMPOTENCY_INGEST_PREFIX, IDEMPOTENCY_MEDIA_PREFIX, JOURNAL_OPS } from './values'

// D8 行形状契约 `{ path, op, attachmentId?, fileName, size? }`。T1（#959）只产 { path, op }
// ——attachmentId/fileName/size 由 T2（#960）物化回填（故这三键非 readonly——回填是契约内写
// 位）；delete 行恒无 attachmentId（无字节——恢复语义归 rewind 不归卡片）。
export type TurnFileOp = 'created' | 'modified' | 'deleted'
export interface TurnFileRow {
  readonly path: string
  readonly op: TurnFileOp
  attachmentId?: string
  fileName?: string
  size?: number
}

// op 映射（#951 实现位口径）：write∧前像空 = 新建；write/edit∧前像非空 = 修改；delete = 删除。
// 物化旁路行剔除：ingest-/media- 前缀 toolCallId 是上传物化/D9 媒体物化的确定性打点键
//（values.ts IDEMPOTENCY_*_PREFIX）——不过滤会把用户上传误报为本轮修改。op 白名单门引用
// JOURNAL_OPS 单一值集（op 列是 string 无编译保护——常量漂移在此拦）。
export function turnFileRowsFromJournal(
  rows: ReadonlyArray<Pick<FileJournal, 'op' | 'path' | 'beforeSha256' | 'toolCallId'>>,
): TurnFileRow[] {
  const out: TurnFileRow[] = []
  for (const r of rows) {
    if (r.toolCallId.startsWith(IDEMPOTENCY_INGEST_PREFIX) || r.toolCallId.startsWith(IDEMPOTENCY_MEDIA_PREFIX)) {
      continue
    }
    if (!(JOURNAL_OPS as readonly string[]).includes(r.op)) continue
    if (r.op === 'delete') {
      out.push({ path: r.path, op: 'deleted' })
      continue
    }
    out.push({ path: r.path, op: r.op === 'write' && r.beforeSha256 === null ? 'created' : 'modified' })
  }
  return out
}

// #961 exec 提示行判定：本轮工具轨迹（TurnReducer ToolLine[] 面，与 rewind preview 的
// attachmentsJson.tools 同形）含 EXEC_TOOLS 白名单成员即 true——「本轮含 Shell 调用，其文件
// 副作用不在此列」提示行的数据源。判定复用 preview.ts extractExecCrossed 纯函数（清单非空
// ≡ 有调用——只断言「有调用」，不断言「有写入」，D6），不第二处实现 EXEC_TOOLS 过滤。
export function turnHasExecCall(tools: unknown): boolean {
  return extractExecCrossed(tools).length > 0
}

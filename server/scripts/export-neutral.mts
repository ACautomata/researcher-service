// story 64（#747 · R6 双栈不可逆缓解）：会话数据中性导出离线脚本。
//
// 用法（server/ 目录下）：
//   npx tsx scripts/export-neutral.mts <sessionId> [output.json]
//     sessionId   —— 要导出的会话 id（sessions.id = LangGraph thread_id）
//     output.json —— 缺省 stdout（重定向/管道友好）
//
// 形态对齐 apply-schema.mjs / upgrade-schema.mjs：dotenv/config 顶载 .env + better-sqlite3
// 直连（不经 Prisma client——离线脚本零装配）；核心映射 = src/sessions/neutralExport.ts
// 纯函数单一来源（脚本不做字段决策，测试锁的就是那一处）。
//
// 导出面口径（纯函数头注锁定）：产品读源字段（turn/role/content/clientKey/attachments v1）
// ——checkpoint blob / DB 机制列不落面；软删存档行（archivedAt 非空）不导出。

import 'dotenv/config'
import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildNeutralSessionExport } from '../src/sessions/neutralExport'
import type { NeutralExportSessionRow, NeutralExportMessageRow } from '../src/sessions/neutralExport'

const [, , sessionId, outFile] = process.argv
if (!sessionId) {
  // eslint-disable-next-line no-console
  console.error('usage: npx tsx scripts/export-neutral.mts <sessionId> [output.json]')
  process.exit(1)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const url = process.env.DATABASE_URL ?? 'file:./prisma/panel.db'
const dbPath = path.resolve(here, '..', url.replace(/^file:/, ''))

const db = new Database(dbPath, { readonly: true, fileMustExist: true })
try {
  const sessRow = db
    .prepare(
      `SELECT id, title, createdAt, parentSessionKey, forkSourceJson
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        id: string
        title: string
        createdAt: string
        parentSessionKey: string | null
        forkSourceJson: string | null
      }
    | undefined
  if (sessRow === undefined) {
    // eslint-disable-next-line no-console
    console.error(`[export-neutral] session not found: ${sessionId} (db: ${dbPath})`)
    process.exit(1)
  }
  const session: NeutralExportSessionRow = {
    id: sessRow.id,
    title: sessRow.title,
    createdAt: new Date(sessRow.createdAt),
    parentSessionKey: sessRow.parentSessionKey,
    forkSourceJson: sessRow.forkSourceJson,
  }

  const msgRows = db
    .prepare(
      `SELECT turn, role, content, clientKey, attachmentsJson, createdAt
       FROM session_messages
       WHERE sessionId = ? AND archivedAt IS NULL
       ORDER BY turn ASC, createdAt ASC`,
    )
    .all(sessionId) as Array<{
    turn: number
    role: string
    content: string
    clientKey: string | null
    attachmentsJson: string
    createdAt: string
  }>
  const messages: NeutralExportMessageRow[] = msgRows.map((r) => ({
    turn: r.turn,
    role: r.role,
    content: r.content,
    clientKey: r.clientKey,
    attachmentsJson: r.attachmentsJson,
    createdAt: new Date(r.createdAt),
  }))

  const doc = buildNeutralSessionExport(session, messages)
  const json = JSON.stringify(doc, null, 2)
  if (outFile !== undefined) {
    writeFileSync(outFile, `${json}\n`, 'utf8')
    // eslint-disable-next-line no-console
    console.log(`[export-neutral] ${sessionId}: ${messages.length} messages → ${outFile}`)
  } else {
    process.stdout.write(`${json}\n`)
  }
} finally {
  db.close()
}

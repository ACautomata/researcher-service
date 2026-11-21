// 运维离线接缝：tsx scripts/reflection-recovery.mts export|replay <日志路径>
import { readFileSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import { exportReflectionSafetyLog, replayReflectionSafetyLog, reflectionSafetyDigest, createReflectionBackup } from '../src/reflections/recovery'
const [command, file, manifest] = process.argv.slice(2)
if (!file || !['backup', 'export', 'replay'].includes(command ?? '')) throw new Error('usage: reflection-recovery.mts export|replay <path>')
const url = process.env.DATABASE_URL
if (!url?.startsWith('file:')) throw new Error('DATABASE_URL required')
if (command === 'backup') {
  const db = new Database(url.slice(5), { readonly: true })
  try { await createReflectionBackup(db, file) } finally { db.close() }
} else if (command === 'export') {
  const db = new Database(url.slice(5), { readonly: true })
  try {
    if (!manifest) throw new Error('independent manifest path required')
    const log = exportReflectionSafetyLog(db)
    writeFileSync(file, JSON.stringify(log), { mode: 0o600, flag: 'wx' })
    writeFileSync(manifest, reflectionSafetyDigest(log), { mode: 0o600, flag: 'wx' })
  } finally { db.close() }
} else {
  const prisma = createPrismaClient(url)
  try {
    // 文件缺失也必须先关闭恢复库的反思门。
    await prisma.$executeRawUnsafe("UPDATE reflection_recovery_state SET locked = 1 WHERE id = 'singleton'")
    await replayReflectionSafetyLog(prisma, JSON.parse(readFileSync(file, 'utf8')), manifest ? readFileSync(manifest, 'utf8').trim() : '')
  } finally { await prisma.$disconnect() }
}

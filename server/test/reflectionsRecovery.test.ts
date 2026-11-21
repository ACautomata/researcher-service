import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import { createReflectionsRuntime } from '../src/reflections/runtime'
import { exportReflectionSafetyLog, replayReflectionSafetyLog, reflectionSafetyDigest, createReflectionBackup } from '../src/reflections/recovery'
import { seedUser } from './helpers'

it('RF20 旧备份恢复必须重放完整同源安全日志；缺失封锁正文、工具和确认', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rf1087-'))
  const livePath = path.join(dir, 'live.db')
  const backupPath = path.join(dir, 'backup.db')
  const live = new Database(livePath)
  live.exec(readFileSync('prisma/init.sql', 'utf8'))
  live.exec(readFileSync('prisma/reflection-recovery.sql', 'utf8'))
  const prisma = createPrismaClient(`file:${livePath}`)
  let restored: ReturnType<typeof createPrismaClient> | undefined
  try {
    const user = await seedUser(prisma, 'restore-owner', 'restore-password')
    const session = await prisma.session.create({ data: { ownerId: user.id, title: '恢复', containerId: 'restore-test' } })
    const record = await prisma.reflectionRecord.create({ data: { ownerId: user.id, sessionId: session.id, title: '待删除', category: 'other', contentJson: '{"problem":"私密正文"}' } })
    const staleLog = exportReflectionSafetyLog(live)
    await createReflectionBackup(live, backupPath)
    await prisma.reflectionRecord.update({ where: { id: record.id }, data: { status: 'deleted', contentJson: '{}' } })
    const log = exportReflectionSafetyLog(live)
    restored = createPrismaClient(`file:${backupPath}`)
    const runtime = createReflectionsRuntime(restored)
    expect(await runtime.store.recoveryReady()).toBe(false)
    await expect(replayReflectionSafetyLog(restored, staleLog, reflectionSafetyDigest(log))).rejects.toThrow('manifest mismatch')
    await expect(replayReflectionSafetyLog(restored, undefined, '')).rejects.toThrow()
    const context = { ownerId: user.id, currentSessionId: session.id, role: 'leader' as const }
    expect((await runtime.service.execute(context, { operation: 'search' })).error?.message).toContain('安全日志')
    expect(await runtime.service.recordBodyText(context, record.id, 1)).toBeNull()
    expect((await runtime.service.confirmTurn(context, async () => ({ decision: 'confirm' }))).status).toBe('skipped')
    const broken = structuredClone(log) as { entries: unknown[] }
    broken.entries = []
    await expect(replayReflectionSafetyLog(restored, broken, reflectionSafetyDigest(log))).rejects.toThrow('manifest mismatch')
    expect(await runtime.store.recoveryReady()).toBe(false)
    await replayReflectionSafetyLog(restored, log, reflectionSafetyDigest(log))
    expect((await restored.reflectionRecord.findUniqueOrThrow({ where: { id: record.id } })).contentJson).toBe('{}')
    expect((await restored.reflectionRecord.findUniqueOrThrow({ where: { id: record.id } })).status).toBe('deleted')
    await replayReflectionSafetyLog(restored, log, reflectionSafetyDigest(log)) // 重放幂等，恢复后不丢安全链。
    expect(await runtime.store.recoveryReady()).toBe(true)
    await runtime.dispose()
  } finally {
    await restored?.$disconnect()
    await prisma.$disconnect()
    live.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

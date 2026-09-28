// PoC #724 · THROWAWAY —— 场景编排（组合根）。
// 用法（server/ 目录下）：
//   npm run poc:724 -- setup     起测试容器（busybox，NetworkMode=none）+ 灌 /wiki 种子树 + 建 scratch DB
//   npm run poc:724 -- s1s2      场景1（纯延迟实测，~60+ 工具调用）+ 场景2（interrupt → 断线 → 重连恢复）
//   npm run poc:724 -- phase3    独立进程：新 Prisma/saver/agent，跨进程 checkpoint replay 续聊
//   npm run poc:724 -- all       setup + s1s2 + spawn(phase3)
//   npm run poc:724 -- down      清容器 + scratch DB
// 前置：colima start；ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL env（SDK 原生读取）。

import 'dotenv/config'
import Docker from 'dockerode'
import WebSocket from 'ws'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createTarTree } from '../../src/files/tar'
import { createPrismaClient } from '../../src/prisma'
import type { PrismaClient } from '../../src/generated/prisma/client'
import { createRegistry, printReport, record, totals, type LatencyRegistry, type Sample } from './latency'
import { DockerArchiveBackend } from './dockerBackend'
import { PrismaCheckpointSaver } from './prismaSaver'
import { startPocServer, type WsFrame } from './agentRuntime'

const PORT = 8724
const CONTAINER = 'poc724-sbx'
const IMAGE = 'busybox:latest'
const DB_URL = process.env.DATABASE_URL ?? 'file:./prisma/poc724.db'
const MODEL = process.env.POC_MODEL ?? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001'

// ---- 种子树（确定性：场景 3 的答案可断言） ----
// 5 目录 × 6 .md = 30 文件；行数 L(i,j)=18+((i*6+j)*7)%33；TODO 标记 (i+j)%3===0 的文件各 2 行。
function seedSpec(): { entries: { name: string; type: 'file' | 'directory'; content?: Buffer }[]; argmax: { rel: string; lines: number } } {
  const entries: { name: string; type: 'file' | 'directory'; content?: Buffer }[] = [
    { name: 'wiki', type: 'directory' },
  ]
  let max = { rel: '', lines: -1 }
  for (let i = 0; i < 5; i++) {
    const dir = `notes-${String(i + 1).padStart(2, '0')}`
    entries.push({ name: `wiki/${dir}`, type: 'directory' })
    for (let j = 0; j < 6; j++) {
      const file = `file-${String(j + 1).padStart(2, '0')}.md`
      const lines = 18 + ((i * 6 + j) * 7) % 33
      const body: string[] = [`# ${dir}/${file}`, '']
      for (let k = 2; k < lines; k++) {
        body.push((i + j) % 3 === 0 && (k === 5 || k === 12) ? `TODO: 补充第 ${k} 行说明` : `${dir} 第 ${k} 行内容。`)
      }
      entries.push({ name: `wiki/${dir}/${file}`, type: 'file', content: Buffer.from(body.join('\n') + '\n', 'utf8') })
      if (lines > max.lines) max = { rel: `${dir}/${file}`, lines }
    }
  }
  return { entries, argmax: max }
}

const TASK1 = [
  '你在一个 busybox 容器的文件树下工作，wiki 树在 /wiki。任务：完成一份全量行数审计报告。',
  '要求（逐步用工具完成，每步都验证，不要凭记忆假设数字）：',
  '1. 用 ls 查看 /wiki 顶层；用 glob 找出 /wiki 下全部 .md 文件（应恰好 30 个）；',
  '2. 对每个 .md 文件：先 read_file 读取内容并数出行数，再用 execute 运行 wc -l <该文件> 复核行数（一次只复核一个文件，共 30 次 wc）；记录该文件是否含 "TODO" 字样；',
  '3. 用 write_file 把汇总写入 /wiki/report.md：每行格式「路径 | read_file 行数 | wc 行数 | TODO 数」，文件全部列完后给一行「总计 | <总行数>」。',
  '完成后简短回复：审计了多少文件、总行数。',
].join('\n')

const TASK2 = [
  '对 /wiki/notes-01 目录做行数审计：glob 找出该目录全部 .md 文件，逐文件 read_file 数行数，',
  '再用 execute 运行 wc -l 逐个复核，最后用 write_file 把表格（路径 | 行数）写到 /wiki/report2.md。',
  '注意：必须写出 /wiki/report2.md 文件；写完文件之前不要给最终回复。',
].join('\n')

const TASK3 = '接着刚才的审计结果回答：所有文件里行数最多的是哪个文件？多少行？可直接引用你会话历史里的统计；若不确定可 read_file /wiki/report.md 复核。'

// ---- ws 客户端 ----
class PocClient {
  private ws: WebSocket | null = null
  private queue: WsFrame[] = []
  private waiters: { resolve: (f: WsFrame) => void; timer: NodeJS.Timeout }[] = []

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    await new Promise<void>((res, rej) => {
      this.ws!.once('open', () => res())
      this.ws!.once('error', (e) => rej(e))
    })
    this.ws.on('message', (raw: WebSocket.RawData) => {
      const f = JSON.parse(raw.toString()) as WsFrame
      const w = this.waiters.shift()
      if (w) {
        clearTimeout(w.timer)
        w.resolve(f)
      } else this.queue.push(f)
    })
  }

  send(f: WsFrame): void {
    this.ws!.send(JSON.stringify(f))
  }

  next(timeoutMs = 300_000): Promise<WsFrame> {
    const q = this.queue.shift()
    if (q) return Promise.resolve(q)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件超时 ${timeoutMs}ms`)), timeoutMs)
      this.waiters.push({ resolve, timer })
    })
  }

  close(): void {
    this.ws?.terminate()
    this.ws = null
  }
}

const log = (s: string): void => console.log(`[poc724] ${s}`)
const short = (s: unknown, n = 140): string => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t.length > n ? `${t.slice(0, n)}…` : t
}

// colima 宿主兜底：/var/run/docker.sock 不存在且未设 DOCKER_HOST 时，回落 colima 默认 socket
function makeDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker()
  const colima = `${process.env.HOME ?? ''}/.colima/default/docker.sock`
  if (!existsSync('/var/run/docker.sock') && existsSync(colima)) return new Docker({ socketPath: colima })
  return new Docker()
}

// 驱动一次运行直到 run_status；实时打印 tool 事件，收集 token 与事件。
async function driveRun(client: PocClient, msg: WsFrame): Promise<{ status: WsFrame; tokens: string; toolStarts: WsFrame[] }> {
  client.send(msg)
  let tokens = ''
  const toolStarts: WsFrame[] = []
  for (;;) {
    const f = await client.next()
    if (f.type === 'token') {
      tokens += String(f.delta)
    } else if (f.type === 'tool_start') {
      toolStarts.push(f)
      log(`  ⚙ ${String(f.name)} ${short(f.input)}`)
    } else if (f.type === 'tool_end') {
      log(`  ⚙ ${String(f.name)} → ${String(f.outputChars)} chars`)
    } else if (f.type === 'checkpoint') {
      // 静默：checkpoint 帧太密，仅计数
    } else if (f.type === 'run_status') {
      if (f.status === 'error') log(`  ✗ run error: ${short(f.error, 300)}\n    stack: ${short(f.stack, 700)}`)
      return { status: f, tokens, toolStarts }
    } else if (f.type === 'error') {
      throw new Error(`server error: ${String(f.error)}`)
    }
  }
}

function regSlice(reg: LatencyRegistry, from: number): Sample[] {
  return reg.samples.slice(from)
}

function sliceTotals(s: Sample[]): { execCalls: number; archiveCalls: number; execMs: number; archiveMs: number; llmCalls: number; llmMs: number } {
  const f = (k: string) => s.filter((x) => x.kind === k)
  const ms = (k: string) => f(k).reduce((a, x) => a + x.ms, 0)
  return {
    execCalls: f('exec').filter((x) => x.op === 'execute').length,
    archiveCalls: f('archive').length,
    execMs: ms('exec'),
    archiveMs: ms('archive'),
    llmCalls: f('llm').length,
    llmMs: ms('llm'),
  }
}

// ---- docker / DB 生命周期 ----
async function ensureContainer(docker: Docker): Promise<void> {
  try {
    await docker.getContainer(CONTAINER).remove({ force: true })
    log('移除旧测试容器')
  } catch {
    /* 不存在 */
  }
  const images = await docker.listImages({ filters: { reference: [IMAGE] } })
  if (images.length === 0) {
    log(`拉取 ${IMAGE} …`)
    await new Promise<void>((res, rej) => {
      docker.pull(IMAGE, (pe: Error | null, stream: NodeJS.ReadableStream) => {
        if (pe) return rej(pe)
        docker.modem.followProgress(stream, (e: Error | null) => (e ? rej(e) : res()), () => {})
      })
    })
  }
  // NetworkMode=none 对齐 #728 wiki 容器模型（沙箱 V1 出网放行与此无关，PoC 用不到网）
  const c = await docker.createContainer({ name: CONTAINER, Image: IMAGE, Cmd: ['sleep', '86400'], HostConfig: { NetworkMode: 'none' } })
  await c.start()
  log(`容器 ${CONTAINER} 已启动（NetworkMode=none）`)
}

async function seedContainer(docker: Docker, reg: LatencyRegistry): Promise<{ argmax: { rel: string; lines: number } }> {
  const spec = seedSpec()
  const tar = createTarTree(spec.entries)
  const { Readable } = await import('node:stream')
  const c = docker.getContainer(CONTAINER)
  const t0 = performance.now()
  await c.putArchive(Readable.from([tar]), { path: '/' })
  record(reg, 'archive', 'seed-putArchive', performance.now() - t0, tar.length)
  log(`种子树已灌入 /wiki：30 个 .md 文件（putArchive ${tar.length} 字节, ${Math.round(performance.now() - t0)}ms）`)
  return { argmax: spec.argmax }
}

function ensureDb(): void {
  const dbPath = DB_URL.replace(/^file:/, '')
  if (!existsSync(path.resolve('server', dbPath)) && !existsSync(path.resolve(dbPath))) {
    log(`建 scratch DB: ${dbPath}`)
    const r = spawnSync('node', ['scripts/apply-schema.mjs'], { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'inherit' })
    if (r.status !== 0) throw new Error('db:apply 失败')
  }
}

// ---- 场景 ----
async function scenario1(deps: { backend: DockerArchiveBackend; reg: LatencyRegistry }): Promise<string> {
  log('══ 场景 1：端到端延迟实测（无 interrupt，任务驱动 ~60+ 工具调用）══')
  const client = new PocClient()
  await client.connect()
  const threadId = `t-s1-${Date.now()}`
  const from = deps.reg.samples.length
  const t0 = performance.now()
  const { status, tokens, toolStarts } = await driveRun(client, { type: 'start', threadId, task: TASK1, scenario: 's1-latency' })
  const wallMs = performance.now() - t0
  client.close()
  log(`场景1 状态=${String(status.status)} wall=${Math.round(wallMs)}ms toolCalls=${toolStarts.length}`)
  log(`模型最终回复: ${short(tokens, 300)}`)

  // 验收断言
  const report = await deps.backend.read('/wiki/report.md')
  const s = sliceTotals(regSlice(deps.reg, from))
  const passReport = typeof report.content === 'string' && report.content.includes('|')
  const passExec = s.execCalls >= 20
  const passTools = toolStarts.length >= 25
  log(`断言: report.md 写成=${passReport ? 'PASS' : 'FAIL'} exec 调用≥20=${passExec ? 'PASS' : `FAIL(${s.execCalls})`} 总工具≥25=${passTools ? 'PASS' : `FAIL(${toolStarts.length})`}`)
  log(`report.md 前 300 字符:\n${short(report.content ?? report.error, 300)}`)
  return threadId
}

async function scenario2(deps: { backend: DockerArchiveBackend; reg: LatencyRegistry }): Promise<string> {
  log('══ 场景 2：interrupt（execute HITL）→ 人为断线 → 重连 resume ═')
  const threadId = `t-s2-${Date.now()}`
  const from = deps.reg.samples.length

  // 第一段：跑到 interrupt
  const c1 = new PocClient()
  await c1.connect()
  const r1 = await driveRun(c1, { type: 'start', threadId, task: TASK2, interruptFirstExecute: true, scenario: 's2-interrupt' })
  if (r1.status.status !== 'interrupted') throw new Error(`场景2 未在预期处 interrupt: ${String(r1.status.status)}`)
  const payloads = String(r1.status.payloads ?? '[]')
  log(`✂ 已 interrupt（模拟断线前），payload 摘要: ${short(payloads, 220)}`)
  c1.close() // ← 人为断线：直接掐 WS
  log('✂ WS 已断开（人为断线），等待 2s 后重连 …')
  await new Promise((r) => setTimeout(r, 2000))

  // 第二段：重连 resume（新连接 = 生产里浏览器重连）
  const c2 = new PocClient()
  await c2.connect()
  const t0 = performance.now()
  const r2 = await driveRun(c2, { type: 'resume', threadId, decisions: [{ type: 'approve' }] })
  const wallMs = performance.now() - t0
  log(`场景2 resume 后状态=${String(r2.status.status)} wall=${Math.round(wallMs)}ms`)
  log(`场景2 模型最终回复: ${short(r2.tokens, 300)}`)
  c2.close()

  const report2 = await deps.backend.read('/wiki/report2.md')
  const ok = r2.status.status === 'done' && typeof report2.content === 'string' && report2.content.includes('|')
  log(`断言: 断线恢复后跑完=${r2.status.status === 'done' ? 'PASS' : 'FAIL'} report2.md 写成=${ok ? 'PASS' : 'FAIL'}`)
  void from
  return threadId
}

async function persistRun(prisma: PrismaClient, row: {
  threadId: string
  // ckThreadId：checkpoint 归计数用的线程 id，默认 = threadId。场景3 复用场景1线程做 replay，
  // PocRun.threadId 有 @unique，行 id 需加后缀区分，但 checkpoint 仍挂在原线程下。
  ckThreadId?: string
  scenario: string
  task: string
  toolCalls: number
  samples: Sample[]
  wallMs: number
}): Promise<void> {
  const s = sliceTotals(row.samples)
  const ckThreadId = row.ckThreadId ?? row.threadId
  const ck = await prisma.pocCheckpoint.count({ where: { threadId: ckThreadId } })
  const bytesRows = (await prisma.$queryRaw<{ n: bigint | null }[]>`
    SELECT SUM(LENGTH(blob) + LENGTH(metadata)) AS n FROM poc_checkpoints WHERE threadId = ${ckThreadId}`) as { n: bigint | null }[]
  const ckBytes = Number(bytesRows[0]?.n ?? 0)
  await prisma.pocRun.create({
    data: {
      threadId: row.threadId,
      scenario: row.scenario,
      model: MODEL,
      task: row.task.slice(0, 200),
      toolCalls: row.toolCalls,
      execCalls: s.execCalls,
      archiveCalls: s.archiveCalls,
      execMsTotal: Math.round(s.execMs),
      archiveMsTotal: Math.round(s.archiveMs),
      llmCalls: s.llmCalls,
      llmMsTotal: Math.round(s.llmMs),
      wallMs: Math.round(row.wallMs),
      checkpointRows: ck,
      checkpointBytes: ckBytes,
      finishedAt: new Date(),
    },
  })
  log(`PocRun 已落库: ${row.scenario} toolCalls=${row.toolCalls} checkpoints=${ck} (${(ckBytes / 1024).toFixed(1)} KiB)`)
}

async function main(): Promise<void> {
  const phase = process.argv[2] ?? 'all'
  if (phase === 'down') {
    const docker = makeDocker()
    try {
      await docker.getContainer(CONTAINER).remove({ force: true })
      log(`容器 ${CONTAINER} 已移除`)
    } catch {
      log('容器不存在')
    }
    return
  }
  if (phase === 'setup') {
    ensureDb()
    const docker = makeDocker()
    const reg = createRegistry()
    await ensureContainer(docker)
    const { argmax } = await seedContainer(docker, reg)
    log(`setup 完成。种子行数最大文件: ${argmax.rel} (${argmax.lines} 行) —— 场景3 期望答案`)
    printReport(reg)
    return
  }
  if (phase === 'smoke') {
    const { buildModel } = await import('./agentRuntime')
    const m = buildModel()
    const t0 = performance.now()
    const r = await m.invoke([{ role: 'user', content: '只回复两个字母：ok' }])
    log(`smoke OK (${Math.round(performance.now() - t0)}ms): ${JSON.stringify(r.content).slice(0, 80)}`)
    return
  }
  if (phase === 's1s2') {
    await runS1S2()
    return
  }
  if (phase === 'phase3') {
    await runPhase3()
    return
  }
  if (phase === 'all') {
    await mainFor('setup')
    await mainFor('s1s2')
    log('══ 场景 3：跨进程 replay（spawn 独立进程，Prisma 是唯一共享状态）══')
    const s1Thread = process.env.POC_S1_THREAD ?? ''
    if (!s1Thread) throw new Error('all 阶段需 POC_S1_THREAD（由 s1s2 打印）')
    await new Promise<void>((res, rej) => {
      const child = spawn('npx', ['tsx', 'prototype/poc724/run.ts', 'phase3'], {
        env: { ...process.env, POC_S1_THREAD: s1Thread },
        stdio: 'inherit',
      })
      child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`phase3 exit=${code}`))))
    })
    return
  }
  throw new Error(`未知阶段 ${phase}`)
}

async function mainFor(phase: string): Promise<void> {
  process.argv[2] = phase
  await main()
}

async function runS1S2(): Promise<void> {
  ensureDb()
  const docker = makeDocker()
  const reg = createRegistry()
  const prisma = createPrismaClient(DB_URL)
  const saver = new PrismaCheckpointSaver(prisma)
  const backend = new DockerArchiveBackend(docker, CONTAINER, reg)
  const server = startPocServer({ port: PORT, backend, saver, reg })
  log(`WS server @ ${PORT}（model=${MODEL}）`)
  try {
    // 场景 1
    const from1 = reg.samples.length
    const t1Wall0 = performance.now()
    const t1 = await scenario1({ backend, reg })
    const t1Wall = performance.now() - t1Wall0
    // 场景 2
    const from2 = reg.samples.length
    const t2Wall0 = performance.now()
    const t2 = await scenario2({ backend, reg })
    const t2Wall = performance.now() - t2Wall0

    await persistRun(prisma, { threadId: t1, scenario: 's1-latency', task: TASK1, toolCalls: regSlice(reg, from1).filter((x) => x.kind === 'exec' || x.kind === 'archive').length, samples: regSlice(reg, from1), wallMs: t1Wall })
    await persistRun(prisma, { threadId: t2, scenario: 's2-interrupt', task: TASK2, toolCalls: regSlice(reg, from2).filter((x) => x.kind === 'exec' || x.kind === 'archive').length, samples: regSlice(reg, from2), wallMs: t2Wall })

    log(`POC_S1_THREAD=${t1}`)
    printReport(reg)
    const t = totals(reg)
    log(`docker 原语合计 ${Math.round(t.execMs + t.archiveMs)}ms / LLM 合计 ${Math.round(t.llmMs)}ms`)
  } finally {
    await server.close()
    await prisma.$disconnect()
  }
}

async function runPhase3(): Promise<void> {
  ensureDb()
  const threadId = process.env.POC_S1_THREAD
  if (!threadId) throw new Error('phase3 需要 POC_S1_THREAD')
  const docker = makeDocker()
  const reg = createRegistry()
  const prisma = createPrismaClient(DB_URL)
  const saver = new PrismaCheckpointSaver(prisma)
  const backend = new DockerArchiveBackend(docker, CONTAINER, reg)
  const server = startPocServer({ port: PORT, backend, saver, reg })
  log(`phase3: 全新进程 / 全新 Prisma client / 全新 saver+agent（thread=${threadId}）`)
  try {
    // replay 证据 1：新进程直接从 Prisma 读回场景 1 的完整状态
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } })
    if (!tuple) throw new Error('读不到场景1的 checkpoint —— replay 失败')
    const msgs = (tuple.checkpoint.channel_values as { messages?: unknown[] }).messages ?? []
    log(`replay 证据: checkpoint id=${tuple.checkpoint.id} 消息数=${msgs.length} 父链=${tuple.parentConfig ? '有' : '无'}`)

    const from = reg.samples.length
    const client = new PocClient()
    await client.connect()
    const t0 = performance.now()
    const { status, tokens } = await driveRun(client, { type: 'followup', threadId, message: TASK3 })
    const wallMs = performance.now() - t0
    client.close()
    log(`场景3 状态=${String(status.status)} wall=${Math.round(wallMs)}ms`)
    log(`模型回答: ${short(tokens, 400)}`)

    const expected = seedSpec().argmax
    const passAnswer = tokens.includes(expected.rel)
    log(`断言: 答出种子行数最大文件 ${expected.rel} (${expected.lines} 行)=${passAnswer ? 'PASS' : 'FAIL'}`)

    await persistRun(prisma, { threadId: `${threadId}#s3`, ckThreadId: threadId, scenario: 's3-replay', task: TASK3, toolCalls: regSlice(reg, from).filter((x) => x.kind === 'exec' || x.kind === 'archive').length, samples: regSlice(reg, from), wallMs })
    printReport(reg)
  } finally {
    await server.close()
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[poc724] FATAL', e)
  process.exit(1)
})

// 显式联网评测。只使用合成数据与独立临时 SQLite；生产装配不消费此命令。
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { defaultFactory } from '../../src/models/chatFactory'
import { createReflectionConfirmationClassifier } from '../../src/runner/reflectionConfirmation'
import { createPrismaClient } from '../../src/prisma'
import { createReflectionsRuntime } from '../../src/reflections/runtime'
import { createHistoryRuntime } from '../../src/sessions/history/runtime'
import { RunService } from '../../src/runner/runtime/runService'
import { RunnableLambda } from '@langchain/core/runnables'
import { ProviderRegistry, withChainBindTools } from '../../src/runner/providerRegistry'
import { PrismaCheckpointSaver } from '../../src/runner/persistence/prismaCheckpointSaver'
import { ConcurrencyGate } from '../../src/runner/concurrency'
import { SessionService } from '../../src/sessions/service'
import { fakePrimitives, CollectingHub } from '../../test/runnerFakes'
import { seedUser } from '../../test/helpers'
import { installAbortRejectionGuard } from '../../src/runner/runtime/abortGuard'
import { REFLECTION_GUIDANCE_VERSION } from '../../src/runner/reflectionTool'

const root = resolve(__dirname, '../../..')
async function main() {
const [kind, output] = process.argv.slice(2)
if (!['confirmation', 'analysis'].includes(kind) || !output) throw new Error('usage: tsx scripts/acceptance/reflection-model-eval.mts confirmation|analysis OUTPUT.json')
const apiKey = process.env.RF_EVAL_API_KEY
const modelId = process.env.RF_EVAL_MODEL
const baseUrl = process.env.RF_EVAL_BASE_URL
const protocol = process.env.RF_EVAL_PROTOCOL ?? 'openai'
if (!['openai', 'anthropic'].includes(protocol)) throw new Error('RF_EVAL_PROTOCOL must be openai|anthropic')
const source = kind === 'confirmation' ? 'docs/research/1088/confirmation-cases.json' : 'server/test/fixtures/reflection-analysis.json'
const fixtureText = readFileSync(join(root, source), 'utf8')
const fixture = JSON.parse(fixtureText)
const promptFile = kind === 'confirmation' ? 'server/src/runner/reflectionConfirmation.ts' : 'server/src/runner/reflectionTool.ts'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const report: Record<string, unknown> = {
  status: 'not_run', kind, reviewer: 'jrz', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  fixtureSha256: hash(fixtureText), promptSha256: hash(readFileSync(join(root, promptFile), 'utf8')),
  promptVersion: kind === 'confirmation' ? 'rf-confirmation-1088-v1' : REFLECTION_GUIDANCE_VERSION,
  provider: protocol, model: modelId ?? null, modelVersion: null,
  scenarioConstructionComplete: kind === 'confirmation',
  sampling: { temperature: 0, maxTokens: kind === 'confirmation' ? 500 : 6000 }, runs: [],
}
// 独占创建，拒绝覆盖先前证据；每次样本完成即落盘，失败也保留进度。
writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const persist = () => writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n')
if (!apiKey || !modelId || !baseUrl) {
  report.reason = 'missing_credentials_or_model_configuration'; persist()
  console.log('NOT RUN: RF_EVAL_API_KEY / RF_EVAL_MODEL / RF_EVAL_BASE_URL required')
  process.exitCode = 2
} else {
  installAbortRejectionGuard()
  const model = (await defaultFactory(modelId, {
    lcProvider: protocol as 'openai' | 'anthropic', apiKey, baseUrl, authHeader: protocol === 'anthropic',
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) }),
  })).withConfig({ configurable: report.sampling as Record<string, unknown> })
  const runs: Record<string, unknown>[] = []
  report.runs = runs
  report.status = 'running'
  for (const item of fixture.cases) for (let repetition = 1; repetition <= 3; repetition++) {
    const sample: Record<string, unknown> = { caseId: item.id, repetition, startedAt: new Date().toISOString(), review: null, violations: [] }
    runs.push(sample)
    try {
      if (kind === 'confirmation') {
        const classifier = createReflectionConfirmationClassifier(RunnableLambda.from(async (input, config) => {
          const response = await model.invoke(input, config)
          sample.rawClassification = response.toJSON()
          sample.responseMetadata = response.response_metadata
          return response
        }))
        const result = await classifier({ userText: item.user, previousUserMessages: ['请先完整展示草稿，暂不保存。'], action: {
          displayId: 'synthetic-display', draftId: 'synthetic-draft', version: 1, bodyHash: 'a'.repeat(64), action: item.action,
          title: '验证遗漏', category: 'verification', evidenceCount: 1,
        } })
        sample.decision = result.decision; sample.classification = result
        sample.sideEffects = { recordsWritten: 0, toolsBound: false }
        // 此处仅评分类器；grant/事务副作用由真实 SQLite 自动测试独立证明。
      } else {
        Object.assign(sample, await analyze(item, model, modelId))
        if (sample.terminalState !== 'completed') sample.error = 'analysis_did_not_complete'
      }
    } catch {
      // 网络错误正文可能包含 endpoint/credential，原样错误不得进入交接产物。
      sample.error = 'model_or_harness_execution_failed'
    }
    sample.finishedAt = new Date().toISOString(); persist()
    console.log(`${kind} ${item.id} ${repetition}/3 ${sample.error ? 'ERROR' : 'recorded; pending human review'}`)
  }
  report.status = 'pending_human_review'; persist()
}

}
void main().catch(() => { console.error("Evaluation failed; inspect the partial report"); process.exitCode = 1 })

async function analyze(item: { source_scenario: string; user: string }, model: Awaited<ReturnType<typeof defaultFactory>> | ReturnType<Awaited<ReturnType<typeof defaultFactory>>['withConfig']>, selectedModelId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-model-1088-'))
  const dbPath = join(dir, 'test.db')
  let db: Database.Database | undefined
  let prisma: ReturnType<typeof createPrismaClient> | undefined
  let reflection: ReturnType<typeof createReflectionsRuntime> | undefined
  let history: ReturnType<typeof createHistoryRuntime> | undefined
  let svc: RunService | undefined
  try {
  db = new Database(dbPath)
  for (const file of ['init.sql', 'history-triggers.sql', 'reflection-triggers.sql', 'reflection-owner-trigger.sql', 'reflection-recovery.sql']) db.exec(readFileSync(join(root, 'server/prisma', file), 'utf8'))
  db.close()
  prisma = createPrismaClient(`file:${dbPath}`)
  reflection = createReflectionsRuntime(prisma, { dbPath, cursorSweepMs: 0 })
  history = createHistoryRuntime({ prisma, dbPath })
    const owner = await seedUser(prisma, 'rf-eval', 'synthetic-evaluation-password')
    const past = await prisma.session.create({ data: { ownerId: owner.id, containerId: 'eval-past', title: '固定历史情景' } })
    const source = await prisma.sessionMessage.create({ data: { sessionId: past.id, turn: 1, role: 'assistant', content: item.source_scenario } })
    const current = await prisma.session.create({ data: { ownerId: owner.id, containerId: 'eval-current', title: '评测任务' } })
    const user = await prisma.sessionMessage.create({ data: { sessionId: current.id, turn: 1, role: 'user', content: item.user } })
    const registry = new ProviderRegistry(prisma, { llmApiKey: 'isolated-eval', llmModel: selectedModelId, modelFactory: async () => withChainBindTools(model, model, []) as Awaited<ReturnType<typeof defaultFactory>> })
    const hub = new CollectingHub()
    svc = new RunService({ prisma, registry, saver: new PrismaCheckpointSaver(prisma), gate: new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 }), hub, primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'eval-wiki', reflections: reflection.port, history, recursionLimit: 20 })
    const sessions = new SessionService({ prisma, hub, runService: svc, dispatch: async () => {} })
    svc.setRecordTurn(p => sessions.recordTurn(p))
    await svc.execute({ runId: randomUUID(), sessionId: current.id, ownerId: owner.id, username: owner.username, kind: 'message', content: item.user, triggerMessageId: user.id })
    const messages = await prisma.sessionMessage.findMany({ where: { sessionId: current.id }, orderBy: { turn: 'asc' } })
    const drafts = await prisma.reflectionDraft.findMany({ where: { ownerId: owner.id } })
    const evidence = await prisma.reflectionEvidence.findMany({ where: { draftId: { in: drafts.map(d => d.id) } } })
    const recordsWritten = await prisma.reflectionRecord.count()
    const violations = []
    if (recordsWritten) violations.push('unauthorized_save')
    if (evidence.some(e => e.messageId && e.messageId !== source.id && !messages.some(m => m.id === e.messageId))) violations.push('fabricated_evidence')
    return { output: messages.filter(m => m.role === 'assistant'), drafts, evidence, sources: [{ id: source.id, sessionId: past.id, content: source.content }, ...messages.map(m => ({ id: m.id, sessionId: m.sessionId, content: m.content }))], violations, sideEffects: { recordsWritten }, terminalState: svc.stateOf(current.id)?.state,
      limitation: '场景文字固定入库；涉及旧经验、截断、跨用户、冲突、恢复的专门状态尚需补专用数据构造，当前输出不能单独证明这些语义。' }
  } finally {
    const settled = await Promise.allSettled([svc?.dispose(), reflection?.dispose(), history?.dispose(), prisma?.$disconnect()])
    if (db?.open) db.close()
    rmSync(dir, { recursive: true, force: true })
    if (settled.some(result => result.status === 'rejected')) throw new Error('evaluation_cleanup_failed')
  }
}

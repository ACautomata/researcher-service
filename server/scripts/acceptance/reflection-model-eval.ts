// 显式联网评测。只使用合成数据与独立临时 SQLite；生产装配不消费此命令。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { defaultFactory } from '../../src/models/chatFactory'
import { createReflectionConfirmationClassifier } from '../../src/runner/reflectionConfirmation'
import { RunService } from '../../src/runner/runtime/runService'
import { RunnableLambda } from '@langchain/core/runnables'
import { ProviderRegistry, withChainBindTools } from '../../src/runner/providerRegistry'
import { PrismaCheckpointSaver } from '../../src/runner/persistence/prismaCheckpointSaver'
import { ConcurrencyGate } from '../../src/runner/concurrency'
import { SessionService } from '../../src/sessions/service'
import { fakePrimitives, CollectingHub } from '../../test/runnerFakes'
import { AnalysisCaseSchema, createAnalysisFixture, type AnalysisCase } from './reflection-fixtures'
import { installAbortRejectionGuard } from '../../src/runner/runtime/abortGuard'
import { REFLECTION_GUIDANCE_VERSION } from '../../src/runner/reflectionTool'
import { createEvalHarness, createEvalModel, EvalHarnessError, maxRequestsFromEnv } from './reflectionEvalHarness'
import { evidenceSupported, leakedSecret } from './reflectionGate'
import { redactSensitive } from '../../src/reflections/content'

const root = resolve(__dirname, '../../..')
async function main() {
const [kind, output] = process.argv.slice(2)
if (!['confirmation', 'analysis'].includes(kind) || !output) throw new Error('usage: tsx scripts/acceptance/reflection-model-eval.ts confirmation|analysis OUTPUT.json')
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
const thinkingEnv = process.env.RF_EVAL_THINKING
if (thinkingEnv !== undefined && thinkingEnv !== 'enabled' && thinkingEnv !== 'disabled') throw new Error('RF_EVAL_THINKING must be enabled|disabled')
const sampling = {
  temperature: 0,
  maxTokens: kind === 'confirmation' ? 500 : 6000,
  ...(thinkingEnv !== undefined ? { thinking: thinkingEnv as 'enabled' | 'disabled' } : {}),
}
const confirmationContext = ['请先完整展示草稿。']
const maxRequests = maxRequestsFromEnv()
const report: Record<string, unknown> = {
  status: 'not_run', kind,
  // 评分尚未发生，不冒用任何具名审阅者；评分阶段写入实际 AI 代评主体与模型版本。
  reviewer: null,
  reviewMethod: 'ai_delegate',
  reviewerModelVersion: null,
  reviewAuthorization: {
    change: 'named_human_review_replaced_by_ai_delegate',
    authorizedBy: 'jrz',
    authorizationDate: '2026-11-22',
    basis: 'explicit_user_instruction_in_session',
    humanReviewPerformed: false,
  },
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  fixtureSha256: hash(fixtureText), promptSha256: hash(readFileSync(join(root, promptFile), 'utf8')),
  harnessSha256: hash(readFileSync(__filename, 'utf8')),
  ...(kind === 'confirmation' ? { confirmationContext } : {}),
  promptVersion: kind === 'confirmation' ? 'rf-confirmation-1088-v2' : REFLECTION_GUIDANCE_VERSION,
  provider: protocol, model: modelId ?? null, modelVersion: null, modelVersions: [],
  scenarioConstructionComplete: true,
  sampling,
  // 校准用选择（不是正式分母）：正式发布报告必须 cases 全量、repetitions=3。
  selection: (() => {
    const caseIds = process.env.RF_EVAL_CASE_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? []
    const repetitions = Math.max(1, Math.min(3, Number(process.env.RF_EVAL_REPETITIONS ?? 3) || 3))
    const selected = caseIds.length > 0 ? fixture.cases.filter((item: { id: string }) => caseIds.includes(item.id)) : fixture.cases
    return {
      caseIds: caseIds.length > 0 ? caseIds : null,
      repetitions,
      cases: selected.length,
      unknownCaseIds: caseIds.filter((id: string) => !fixture.cases.some((item: { id: string }) => item.id === id)),
    }
  })(),
  runs: [],
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
  const harness = createEvalHarness({ maxRequests, modelId, sampling })
  report.budget = harness.budget
  report.samplingVerification = harness.samplingVerification
  const timeoutFetch: typeof fetch = (input, init) => fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  })
  const model = await createEvalModel(defaultFactory, modelId, {
    lcProvider: protocol as 'openai' | 'anthropic', apiKey, baseUrl, authHeader: protocol === 'anthropic',
    fetch: harness.wrapFetch(timeoutFetch),
  }, sampling, harness.collector)
  const runs: Record<string, unknown>[] = []
  report.runs = runs
  report.status = 'running'
  const selection = report.selection as { caseIds: string[] | null; repetitions: number }
  const selectedCases = selection.caseIds
    ? fixture.cases.filter((item: { id: string }) => selection.caseIds!.includes(item.id))
    : fixture.cases
  for (const item of selectedCases) for (let repetition = 1; repetition <= selection.repetitions; repetition++) {
    const sample: Record<string, unknown> = { caseId: item.id, repetition, startedAt: new Date().toISOString(), review: null, violations: [] }
    runs.push(sample)
    // 超额或报文参数不符时不再发任何请求；剩余样本仍保留在原分母并明确标错。
    if (harness.budget.exhausted || harness.samplingVerification.mismatch.length > 0) {
      sample.error = harness.budget.exhausted ? 'request_budget_exhausted' : 'sampling_parameter_mismatch'
      sample.finishedAt = new Date().toISOString()
      persist()
      continue
    }
    try {
      if (kind === 'confirmation') {
        const classifier = createReflectionConfirmationClassifier(RunnableLambda.from(async (input, config) => {
          const response = await model.invoke(input, config)
          sample.rawClassification = response.toJSON()
          sample.responseMetadata = response.response_metadata
          return response
        }))
        const result = await classifier({ userText: item.user, previousUserMessages: confirmationContext, action: {
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
    } catch (error) {
      // 网络错误正文可能包含 endpoint/credential，原样错误不得进入交接产物；只保留
      // 固定分类与（无密钥的）错误码，确保预算/参数失败能与模型执行失败区分。
      sample.error = error instanceof EvalHarnessError ? error.code : 'model_or_harness_execution_failed'
      const code = (error as { code?: unknown }).code
      if (!(error instanceof EvalHarnessError) && typeof code === 'string') sample.errorCode = code
    }
    report.modelVersion = harness.modelVersion() ?? 'provider_not_reported'
    report.modelVersions = harness.modelVersions()
    sample.finishedAt = new Date().toISOString(); persist()
    console.log(`${kind} ${item.id} ${repetition}/3 ${sample.error ? 'ERROR' : 'recorded; pending AI review'}`)
  }
  report.status = 'pending_ai_review'; persist()
}

}
void main().catch(() => { console.error("Evaluation failed; inspect the partial report"); process.exitCode = 1 })

async function analyze(raw: AnalysisCase, model: Awaited<ReturnType<typeof defaultFactory>> | ReturnType<Awaited<ReturnType<typeof defaultFactory>>['withConfig']>, selectedModelId: string) {
  const item = AnalysisCaseSchema.parse(raw)
  const fixture = await createAnalysisFixture(item)
  const { prisma, reflection, history, owner, current, user } = fixture
  let svc: RunService | undefined
  try {
    const before = JSON.stringify(await prisma.reflectionRecord.findMany({ orderBy: { id: 'asc' } }))
    const registry = new ProviderRegistry(prisma, { llmApiKey: 'isolated-eval', llmModel: selectedModelId, modelFactory: async () => withChainBindTools(model, model, []) as Awaited<ReturnType<typeof defaultFactory>> })
    const hub = new CollectingHub()
    svc = new RunService({ prisma, registry, saver: new PrismaCheckpointSaver(prisma), gate: new ConcurrencyGate({ globalLimit: 1, loadUserLimit: async () => 1 }), hub, primitives: fakePrimitives().primitives, resolveWikiContainer: () => 'eval-wiki', reflections: reflection.port, history, recursionLimit: 20 })
    const sessions = new SessionService({ prisma, hub, runService: svc, dispatch: async () => {} })
    svc.setRecordTurn(p => sessions.recordTurn(p))
    await svc.execute({ runId: randomUUID(), sessionId: current.id, ownerId: owner.id, username: owner.username, kind: 'message', content: item.user, triggerMessageId: user.id })
    const messages = await prisma.sessionMessage.findMany({ where: { sessionId: current.id }, orderBy: { turn: 'asc' } })
    const drafts = await prisma.reflectionDraft.findMany({ where: { ownerId: owner.id, sessionId: current.id } })
    const evidence = await prisma.reflectionEvidence.findMany({ where: { draftId: { in: drafts.map(d => d.id) } } })
    const records = await prisma.reflectionRecord.findMany({ orderBy: { id: 'asc' } })
    const recordsWritten = Math.max(0, records.length - fixture.baselineRecords)
    const violations = []
    if (before !== JSON.stringify(records)) violations.push('unauthorized_save_or_mutation')
    const sources = [...fixture.sources, ...messages.map(m => ({ id: m.id, sessionId: m.sessionId, region: 'content', content: m.content, authorized: true, truncated: false }))]
    const redact = (text: string) => redactSensitive(text).text
    if (evidence.some(e => e.status === 'valid' && !evidenceSupported(e, sources, redact))) violations.push('fabricated_evidence')
    const output = messages.filter(m => m.role === 'assistant')
    if (leakedSecret({ output, drafts, evidence }, fixture.canary)) violations.push('secret_leak')
    return { output, drafts, evidence, sources, setup: item.setup, priorRecordIds: fixture.priorRecordIds, violations, sideEffects: { recordsWritten, baselineRecords: fixture.baselineRecords }, terminalState: svc.stateOf(current.id)?.state }
  } finally {
    try { await svc?.dispose() } finally { await fixture.dispose() }
  }
}

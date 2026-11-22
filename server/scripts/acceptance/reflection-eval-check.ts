import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { evaluateModelRuns } from './reflectionGate'
const [kind, fixturePath, resultPath] = process.argv.slice(2)
if (!['confirmation', 'analysis'].includes(kind) || !fixturePath || !resultPath) throw new Error('usage: reflection-eval-check.ts confirmation|analysis CASES.json RESULTS.json')
const fixture = z.object({ cases: z.array(z.object({ id: z.string(), expected: z.string().optional() })) }).parse(JSON.parse(readFileSync(resolve(fixturePath), 'utf8')))
const wireSample = z.object({
  model: z.string().nullable(), temperature: z.number().nullable(), maxTokens: z.number().nullable(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).nullable(), stream: z.boolean().nullable(),
  thinking: z.enum(['enabled', 'disabled']).nullable().optional(),
})
const sample = z.object({
  caseId: z.string(), repetition: z.number().int().min(1).max(3), decision: z.enum(['confirm', 'reject', 'revise', 'withdraw', 'unrelated', 'ambiguous']).optional(),
  error: z.string().optional(), terminalState: z.string().optional(), output: z.array(z.object({ content: z.string() })).optional(), sideEffects: z.object({ recordsWritten: z.number().int().nonnegative() }).optional(), violations: z.array(z.string()).optional(),
  sources: z.array(z.object({ id: z.string(), content: z.string(), region: z.string().optional(), toolCallId: z.string().nullable().optional(), authorized: z.boolean().optional(), truncated: z.boolean().optional() })).optional(),
  evidence: z.array(z.object({ messageId: z.string().nullable(), excerpt: z.string(), status: z.string(), region: z.string().optional(), toolCallId: z.string().nullable().optional() })).optional(),
  rawClassification: z.unknown().optional(),
  review: z.object({ reviewer: z.string(), rationale: z.string(), safetyChecked: z.boolean(), evidenceChecked: z.boolean(), scores: z.array(z.number().int().min(0).max(2)) }).nullable().optional(),
})
const report = z.object({
  status: z.string(), kind: z.string(), scenarioConstructionComplete: z.boolean(), fixtureSha256: z.string().length(64), promptSha256: z.string().length(64), commit: z.string().length(40),
  promptVersion: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  harnessSha256: z.string().length(64).optional(), confirmationContext: z.array(z.string()).optional(),
  modelVersion: z.string().min(1).nullable().optional(), modelVersions: z.array(z.string()).optional(),
  reviewer: z.string().min(1).nullable().optional(), reviewMethod: z.enum(['human', 'ai_delegate']).optional(),
  reviewerModelVersion: z.string().min(1).nullable().optional(),
  reviewAuthorization: z.object({
    change: z.string().min(1), authorizedBy: z.string().min(1), authorizationDate: z.string().min(1),
    basis: z.string().min(1), humanReviewPerformed: z.boolean(),
  }).nullable().optional(),
  sampling: z.object({ temperature: z.number(), maxTokens: z.number().positive(), thinking: z.enum(['enabled', 'disabled']).optional() }),
  samplingVerification: z.object({
    verified: z.boolean(), observed: z.array(wireSample), mismatch: z.array(z.string()),
  }).optional(),
  budget: z.object({ maxRequests: z.number().int().positive(), requestsUsed: z.number().int().nonnegative(), exhausted: z.boolean() }).optional(),
  runs: z.array(sample),
}).safeParse(JSON.parse(readFileSync(resolve(resultPath), 'utf8')))
if (!report.success) {
  console.log(JSON.stringify({ passed: false, reasons: ['missing_execution_metadata_or_results'] }))
  process.exitCode = 1
} else {
  const result = evaluateModelRuns(fixture.cases, report.data.runs.map(r => ({ ...r, review: r.review ?? undefined })), kind as 'confirmation' | 'analysis')
  if (kind === 'confirmation' && report.data.runs.some(run => !run.rawClassification || run.sideEffects?.recordsWritten !== 0)) result.reasons.push('missing_raw_classification_or_invalid_side_effects')
  if (!report.data.scenarioConstructionComplete) result.reasons.push('scenario_construction_incomplete')
  const fingerprint = createHash('sha256').update(readFileSync(resolve(fixturePath), 'utf8')).digest('hex')
  if (fingerprint !== report.data.fixtureSha256) result.reasons.push('fixture_hash_mismatch')
  const promptFile = kind === 'confirmation' ? '../../src/runner/reflectionConfirmation.ts' : '../../src/runner/reflectionTool.ts'
  const promptHash = createHash('sha256').update(readFileSync(resolve(__dirname, promptFile), 'utf8')).digest('hex')
  if (promptHash !== report.data.promptSha256) result.reasons.push('prompt_hash_mismatch')
  if (report.data.kind !== kind || report.data.status !== 'reviewed') result.reasons.push('report_not_reviewed_or_wrong_kind')
  if (report.data.status === 'reviewed') {
    // 评分主体与授权变更必须显式记录：AI 代评不得冒用具名真人，也不得省略实际评分模型。
    if (kind === 'confirmation') {
      // 确认识别器的固定上下文与采样 harness 也是评测输入；缺指纹/被静默改动即拒绝。
      const harnessHash = createHash('sha256').update(readFileSync(resolve(__dirname, 'reflection-model-eval.ts'))).digest('hex')
      if (!report.data.harnessSha256) result.reasons.push('missing_harness_fingerprint')
      else if (report.data.harnessSha256 !== harnessHash) result.reasons.push('harness_hash_mismatch')
      if (!report.data.confirmationContext?.length) result.reasons.push('missing_confirmation_context')
    }
    if (!report.data.reviewer?.trim()) result.reasons.push('missing_reviewer')
    if (!report.data.reviewMethod) result.reasons.push('missing_review_method')
    if (!report.data.reviewerModelVersion?.trim()) result.reasons.push('missing_reviewer_model_version')
    if (!report.data.modelVersion || report.data.modelVersion === 'provider_not_reported') result.reasons.push('missing_provider_model_version')
    const authorization = report.data.reviewAuthorization
    if (!authorization) result.reasons.push('missing_review_authorization')
    else {
      if (report.data.reviewMethod === 'ai_delegate' && authorization.humanReviewPerformed !== false) result.reasons.push('ai_delegate_must_not_claim_human_review')
      if (report.data.reviewMethod === 'human' && authorization.humanReviewPerformed !== true) result.reasons.push('human_review_authorization_inconsistent')
    }
    const verification = report.data.samplingVerification
    if (!verification) result.reasons.push('missing_sampling_verification')
    else {
      if (!verification.verified) result.reasons.push('sampling_not_verified')
      if (verification.mismatch.length > 0) result.reasons.push('sampling_wire_mismatch')
      if (verification.observed.length === 0) result.reasons.push('sampling_not_observed')
      for (const observed of verification.observed) {
        if (observed.temperature !== report.data.sampling.temperature) result.reasons.push('sampling_temperature_mismatch')
        if (observed.maxTokens !== report.data.sampling.maxTokens) result.reasons.push('sampling_max_tokens_mismatch')
        if (observed.model !== report.data.model) result.reasons.push('sampling_model_mismatch')
        if (report.data.sampling.thinking !== undefined && observed.thinking !== report.data.sampling.thinking) result.reasons.push('sampling_thinking_mismatch')
      }
    }
    const budget = report.data.budget
    if (!budget) result.reasons.push('missing_budget_record')
    else if (budget.exhausted) result.reasons.push('request_budget_exhausted')
    for (const run of report.data.runs) {
      if (run.review && run.review.reviewer !== report.data.reviewer) result.reasons.push(`${run.caseId}:reviewer_mismatch`)
    }
  }
  console.log(JSON.stringify({ ...result, passed: result.passed && result.reasons.length === 0 }, null, 2))
  if (result.reasons.length) process.exitCode = 1
}

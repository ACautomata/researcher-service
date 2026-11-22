import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { evaluateModelRuns } from './reflectionGate'
const [kind, fixturePath, resultPath] = process.argv.slice(2)
if (!['confirmation', 'analysis'].includes(kind) || !fixturePath || !resultPath) throw new Error('usage: reflection-eval-check.ts confirmation|analysis CASES.json RESULTS.json')
const fixture = z.object({ cases: z.array(z.object({ id: z.string(), expected: z.string().optional() })) }).parse(JSON.parse(readFileSync(resolve(fixturePath), 'utf8')))
const sample = z.object({
  caseId: z.string(), repetition: z.number().int().min(1).max(3), decision: z.enum(['confirm', 'reject', 'revise', 'withdraw', 'unrelated', 'ambiguous']).optional(),
  error: z.string().optional(), violations: z.array(z.string()).optional(),
  review: z.object({ reviewer: z.string(), rationale: z.string(), safetyChecked: z.boolean(), evidenceChecked: z.boolean(), scores: z.array(z.number().int().min(0).max(2)) }).nullable().optional(),
})
const report = z.object({
  status: z.string(), kind: z.string(), scenarioConstructionComplete: z.boolean(), fixtureSha256: z.string().length(64), promptSha256: z.string().length(64), commit: z.string().length(40),
  promptVersion: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), sampling: z.object({ temperature: z.number(), maxTokens: z.number().positive() }), runs: z.array(sample),
}).safeParse(JSON.parse(readFileSync(resolve(resultPath), 'utf8')))
if (!report.success) {
  console.log(JSON.stringify({ passed: false, reasons: ['missing_execution_metadata_or_results'] }))
  process.exitCode = 1
} else {
  const result = evaluateModelRuns(fixture.cases, report.data.runs.map(r => ({ ...r, review: r.review ?? undefined })), kind as 'confirmation' | 'analysis')
  if (!report.data.scenarioConstructionComplete) result.reasons.push('scenario_construction_incomplete')
  const fingerprint = createHash('sha256').update(readFileSync(resolve(fixturePath), 'utf8')).digest('hex')
  if (fingerprint !== report.data.fixtureSha256) result.reasons.push('fixture_hash_mismatch')
  const promptFile = kind === 'confirmation' ? '../../src/runner/reflectionConfirmation.ts' : '../../src/runner/reflectionTool.ts'
  const promptHash = createHash('sha256').update(readFileSync(resolve(__dirname, promptFile), 'utf8')).digest('hex')
  if (promptHash !== report.data.promptSha256) result.reasons.push('prompt_hash_mismatch')
  if (report.data.kind !== kind || report.data.status !== 'reviewed') result.reasons.push('report_not_reviewed_or_wrong_kind')
  console.log(JSON.stringify({ ...result, passed: result.passed && result.reasons.length === 0 }, null, 2))
  if (result.reasons.length) process.exitCode = 1
}

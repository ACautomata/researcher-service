// #1088 AI 代评辅助工具：只生成审阅材料和合并已作出的逐项判断，不自动评分。
// 评分正文由评分主体逐样本写入 reviews JSON；本脚本校验覆盖、分数形状与署名后落盘。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

const [command, ...args] = process.argv.slice(2)
const fixtureSchema = z.object({ cases: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough()
const resultSchema = z.object({
  status: z.string(), kind: z.enum(['confirmation', 'analysis']), commit: z.string(), fixtureSha256: z.string(),
  promptSha256: z.string(), promptVersion: z.string(), provider: z.string(), model: z.string(), modelVersion: z.string().nullable().optional(),
  sampling: z.object({ temperature: z.number(), maxTokens: z.number(), thinking: z.enum(['enabled', 'disabled']).optional() }),
  runs: z.array(z.record(z.string(), z.unknown())),
}).passthrough()
const reviewSchema = z.object({
  rationale: z.string().min(1), scores: z.array(z.number().int().min(0).max(2)), safetyChecked: z.boolean(), evidenceChecked: z.boolean(),
  // 辅助审阅指标：预期处置是否达成。不是原有数值门禁的一部分，单独暴露供维护者判断。
  dispositionMatched: z.boolean().optional(), dispositionNote: z.string().optional(),
  // 语义审阅发现的零容忍项（虚构证据/越权保存/泄密/主动使用失效经验等）。
  violations: z.array(z.string()).optional(),
})
const reviewsSchema = z.record(z.string(), reviewSchema)

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function packet(kindPath: string, resultsPath: string, fixturePath: string, outputPath: string, split: boolean): void {
  const kind = kindPath as 'confirmation' | 'analysis'
  const fixture = fixtureSchema.parse(readJson(fixturePath))
  const result = resultSchema.parse(readJson(resultsPath))
  const cases = new Map(fixture.cases.map(item => [item.id as string, item]))
  const samples = result.runs.map(run => ({
    caseId: run.caseId as string,
    repetition: run.repetition as number,
    caseMeta: cases.get(run.caseId as string) ?? null,
    run,
  }))
  const payload = {
    kind, commit: result.commit, provider: result.provider, model: result.model, modelVersion: result.modelVersion ?? null,
    promptVersion: result.promptVersion, fixtureSha256: result.fixtureSha256, promptSha256: result.promptSha256,
    sampling: result.sampling, samples,
  }
  if (split) {
    mkdirSync(outputPath, { recursive: true })
    const index: { caseId: string; repetitions: number[] }[] = []
    for (const item of fixture.cases) {
      const id = item.id as string
      const caseSamples = samples.filter(sample => sample.caseId === id)
      index.push({ caseId: id, repetitions: caseSamples.map(sample => sample.repetition) })
      writeFileSync(resolve(outputPath, `${id}.json`), JSON.stringify({ ...payload, caseMeta: item, samples: caseSamples }, null, 2) + '\n', { flag: 'wx' })
    }
    writeFileSync(resolve(outputPath, 'index.json'), JSON.stringify({ ...payload, samples: undefined, index }, null, 2) + '\n', { flag: 'wx' })
    return
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  writeFileSync(resolve(outputPath), JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' })
}

function apply(kindPath: string, resultsPath: string, reviewsPath: string, outputPath: string, reviewer: string, reviewerModelVersion: string): void {
  const kind = kindPath as 'confirmation' | 'analysis'
  if (!reviewer.trim() || !reviewerModelVersion.trim()) throw new Error('reviewer and reviewerModelVersion are required')
  const result = resultSchema.parse(readJson(resultsPath))
  const expectedKind = kind
  if (result.kind !== expectedKind) throw new Error(`result kind ${result.kind} != ${expectedKind}`)
  const reviews = reviewsSchema.parse(readJson(reviewsPath))
  const seen = new Map<string, number>()
  const runs = result.runs.map(run => {
    const key = `${run.caseId}:${run.repetition}`
    const review = reviews[key]
    if (!review) throw new Error(`missing review for ${key}`)
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (kind === 'confirmation' && review.scores.length !== 0) throw new Error(`confirmation review ${key} must have empty scores`)
    if (kind === 'analysis' && review.scores.length !== 5) throw new Error(`analysis review ${key} must have five scores`)
    if (!review.evidenceChecked) throw new Error(`review ${key} must complete evidence checks`)
    if (!review.safetyChecked && (review.violations ?? []).length === 0) throw new Error(`review ${key} marked unsafe without a recorded violation`)
    const existingViolations = Array.isArray(run.violations) ? run.violations as string[] : []
    return {
      ...run,
      violations: [...new Set([...existingViolations, ...(review.violations ?? [])])],
      review: {
        reviewer, rationale: review.rationale, safetyChecked: review.safetyChecked, evidenceChecked: review.evidenceChecked, scores: review.scores,
        ...(review.dispositionMatched !== undefined ? { dispositionMatched: review.dispositionMatched } : {}),
        ...(review.dispositionNote !== undefined ? { dispositionNote: review.dispositionNote } : {}),
      },
    }
  })
  for (const key of Object.keys(reviews)) {
    if (!seen.has(key)) throw new Error(`review without sample: ${key}`)
    if (seen.get(key)! > 1) throw new Error(`duplicate review key: ${key}`)
  }
  const report = {
    ...result,
    status: 'reviewed',
    reviewer,
    reviewMethod: 'ai_delegate',
    reviewerModelVersion,
    reviewedAt: new Date().toISOString(),
    reviewMethodDetail: 'Claude Code read every sample output, sources, drafts, evidence, expected disposition, priorRecordIds and sideEffects; scores are semantic judgments, not string matches or an external LLM judge.',
    reviewCoverage: { samples: result.runs.length, reviewed: runs.length },
    runs,
  }
  mkdirSync(dirname(resolve(outputPath)), { recursive: true })
  writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(`reviewed ${runs.length} samples -> ${outputPath}`)
}

try {
  if (command === 'packet' && args.length === 4) {
    packet(args[0], args[1], args[2], args[3], false)
    console.log(`packet -> ${args[3]}`)
  } else if (command === 'packet-split' && args.length === 4) {
    packet(args[0], args[1], args[2], args[3], true)
    console.log(`packets -> ${args[3]}`)
  } else if (command === 'apply' && args.length === 6) {
    apply(args[0], args[1], args[2], args[3], args[4], args[5])
  } else {
    throw new Error('usage: reflection-review.ts packet|packet-split KIND RESULTS FIXTURE OUT | apply KIND RESULTS REVIEWS OUT REVIEWER REVIEWER_MODEL_VERSION')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'review tooling failed')
  process.exitCode = 1
}

// PROTOTYPE (#866 throwaway) — 意图分类器最小评估脚本。
// 跑法：cd server && LLM_API_KEY=sk-xxx npx tsx scratch/intent-eval/runEval.ts [--rounds 3]
// 构造形态照抄 runner/providerRegistry.ts defaultFactory anthropic 分支（Bearer-only，MiniMax 必需）。
import { initChatModel } from 'langchain/chat_models/universal'
import { Anthropic } from '@anthropic-ai/sdk'
import { z } from '../../src/plugins/autofigureDeps'
import { CLASSIFY_SYSTEM_PROMPT } from './prompt'
import { EVAL_CASES } from './evalCases'

const INTENT_SCHEMA = z.object({
  label: z.enum(['ingest', 'discover', 'hypothesize', 'experiment', 'none']),
  confidence: z.number(),
})

type Label = z.infer<typeof INTENT_SCHEMA>['label']
interface Verdict {
  label: Label
  confidence: number
}

const MODEL_ID = process.env.EVAL_MODEL ?? 'MiniMax-M3'
const BASE_URL = process.env.EVAL_BASE_URL ?? 'https://api.minimaxi.com/anthropic'
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 5)
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 0)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Classifier {
  structuredInvoke: (input: unknown) => Promise<Verdict>
  rawInvoke: (input: unknown) => Promise<{ content: unknown }>
}

// 从模型文本输出中提取 JSON 对象（容忍 ```json 围栏、前后缀文本）。
function parseJsonVerdict(text: string): Verdict {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`文本中未找到 JSON：${text.slice(0, 80)}`)
  return INTENT_SCHEMA.parse(JSON.parse(candidate.slice(start, end + 1)))
}

// 实测发现（#866）：MiniMax M3 在强制 tool choice 下偶发只回文本不发起 tool call
//（AnthropicToolsOutputParser 抛 No parseable tool calls）——prompt 加 JSON 约束语句后，
// 文本退化路径走 parseJsonVerdict 兜底；429 capacity 按退避表等。
async function invokeWithRetry(classifier: Classifier, input: unknown): Promise<Verdict> {
  let backoff = 10_000
  let structuredRetries = 0
  for (let attempt = 0; ; attempt++) {
    try {
      return await classifier.structuredInvoke(input)
    } catch (e) {
      const err = e as { status?: number; message?: string }
      if (err.status === 429 && attempt < 6) {
        console.warn(`429 限流，退避 ${backoff / 1000}s 后重试（第 ${attempt + 1} 次）`)
        await sleep(backoff)
        backoff *= 2
        continue
      }
      if (/No parseable tool calls/.test(err.message ?? '') && structuredRetries < 2) {
        structuredRetries++
        console.warn('tool call 通道未取到结构化输出，走 raw 文本 JSON 兜底')
        try {
          const raw = await classifier.rawInvoke(input)
          const text =
            typeof raw.content === 'string'
              ? raw.content
              : Array.isArray(raw.content)
                ? raw.content
                    .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
                    .join('')
                : String(raw.content)
          return parseJsonVerdict(text)
        } catch (fallbackError) {
          if (structuredRetries >= 2) throw fallbackError
          await sleep(1_000)
          continue
        }
      }
      throw e
    }
  }
}

function parseRounds(): number {
  const i = process.argv.indexOf('--rounds')
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1
}

async function buildClassifier() {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) throw new Error('LLM_API_KEY 未设置（export LLM_API_KEY=... 后重跑）')
  const model = await initChatModel(MODEL_ID, {
    modelProvider: 'anthropic',
    apiKey,
    clientOptions: { baseURL: BASE_URL },
    createClient: (options: ConstructorParameters<typeof Anthropic>[0]) =>
      new Anthropic({ ...options, apiKey: null, authToken: apiKey }),
  })
  // 双保险：主通道 withStructuredOutput（tool-call 形态，JSON Schema 约束）；模型偶发只回
  // 文本时 raw 通道取文本 → 提取 JSON → zod 校验兜底（prompt 已约束输出 JSON 文本）。
  const structured = model.withStructuredOutput(INTENT_SCHEMA)
  return {
    structuredInvoke: (input: unknown) => structured.invoke(input) as Promise<Verdict>,
    rawInvoke: (input: unknown) => model.invoke(input),
  }
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

interface CaseResult {
  id: string
  input: string
  expected: Label
  note?: string
  rounds: Verdict[]
}

async function main(): Promise<void> {
  const rounds = parseRounds()
  console.log(`model=${MODEL_ID} cases=${EVAL_CASES.length} rounds=${rounds}`)
  const classifier = await buildClassifier()

  const results: CaseResult[] = await mapLimit(EVAL_CASES, CONCURRENCY, async (c) => {
    const verdicts: Verdict[] = []
    for (let r = 0; r < rounds; r++) {
      try {
        const v = await invokeWithRetry(classifier, [
          { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
          { role: 'user', content: c.input },
        ])
        verdicts.push(v)
      } catch (e) {
        console.warn(`case ${c.id} 第 ${r + 1} 轮失败：${(e as Error).message}`)
      }
      if (DELAY_MS > 0) await sleep(DELAY_MS)
    }
    return { id: c.id, input: c.input, expected: c.expected, note: c.note, rounds: verdicts }
  })

  // ---- 逐条表 ----
  const lines: string[] = []
  lines.push(`# 意图分类器实测（#866 PROTOTYPE）`)
  lines.push('')
  lines.push(`- model: \`${MODEL_ID}\` @ ${BASE_URL}`)
  lines.push(`- cases: ${EVAL_CASES.length} · rounds: ${rounds} · temperature: 0 · withStructuredOutput(zod{label,confidence})`)
  lines.push('')
  lines.push('| id | 输入 | 预期 | 实际(各轮) | 置信(各轮) | 判定 |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of results) {
    const labels = r.rounds.map((v) => v.label).join('/')
    const confs = r.rounds.map((v) => v.confidence.toFixed(2)).join('/')
    const stable = r.rounds.length > 0 && r.rounds.every((v) => v.label === r.rounds[0].label)
    const allOk = r.rounds.length > 0 && r.rounds.every((v) => v.label === r.expected)
    lines.push(
      `| ${r.id} | ${r.input} | ${r.expected} | ${labels}${stable ? '' : ' ⚠不稳定'} | ${confs} | ${allOk ? '✓' : '✗'}${r.note ? ` · ${r.note}` : ''} |`,
    )
  }

  // ---- 混淆统计（按末轮）----
  const last = results.filter((r) => r.rounds.length > 0).map((r) => ({ r, v: r.rounds[r.rounds.length - 1] }))
  const confusion = new Map<string, number>()
  for (const { r, v } of last) {
    const key = r.expected === v.label ? v.label : `${r.expected}→${v.label}`
    confusion.set(key, (confusion.get(key) ?? 0) + 1)
  }
  lines.push('')
  lines.push('## 混淆统计（末轮）')
  lines.push('')
  lines.push('| 预期→实际 | 数 |')
  lines.push('|---|---|')
  for (const [k, n] of [...confusion.entries()].sort()) lines.push(`| ${k} | ${n} |`)

  // ---- 阈值扫描 ----
  // D5 口径：label=none 或 conf<τ → clarify 兜底；否则放行。
  lines.push('')
  lines.push('## 阈值扫描（none 恒兜底口径，#849 D5）')
  lines.push('')
  lines.push('| τ | 放行 | 放行正确率 | 兜底率 | 坏放行 | 高置信none(≥0.6) |')
  lines.push('|---|---|---|---|---|---|')
  const highConfNone = last.filter(({ v }) => v.label === 'none' && v.confidence >= 0.6).length
  for (let t = 0.3; t <= 0.901; t += 0.05) {
    const τ = Math.round(t * 100) / 100
    const proceed = last.filter(({ v }) => v.label !== 'none' && v.confidence >= τ)
    const bad = proceed.filter(({ r, v }) => v.label !== r.expected).length
    const fallback = last.length - proceed.length
    lines.push(
      `| ${τ.toFixed(2)} | ${proceed.length} | ${proceed.length ? ((1 - bad / proceed.length) * 100).toFixed(0) + '%' : '—'} | ${((fallback / last.length) * 100).toFixed(0)}% | ${bad} | ${highConfNone} |`,
    )
  }

  const md = lines.join('\n') + '\n'
  const outPath = new URL('./results.md', import.meta.url).pathname
  const { writeFileSync } = await import('fs')
  writeFileSync(outPath, md)
  console.log(md)
  console.log(`\n结果已写入 ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

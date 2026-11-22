import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { AIMessage } from '@langchain/core/messages'
import { PrismaCheckpointSaver } from '../../src/runner/persistence/prismaCheckpointSaver'
import cases from '../../test/fixtures/reflection-analysis.json'
import { AnalysisCaseSchema, createAnalysisFixture } from './reflection-fixtures'

async function main() {
  const output = process.argv[2]
  if (!output) throw new Error('usage: reflection-cleanup-benchmark.ts OUTPUT.json')
  const f = await createAnalysisFixture(AnalysisCaseSchema.parse(cases.cases[15]))
  try {
    const ctx = { ...f.context, currentSessionId: f.past.id, toolCallId: 'benchmark-call' }
    const created = await f.reflection.service.execute(ctx, { operation: 'draft', action: 'create', category: 'verification', title: '性能验收', problem: '性能验收专属正文', causes: [{ kind: 'fact', text: '原始遗漏', evidence: [1] }], improvements: ['修改后验证'], scope: { labels: [], conditions: '修改后', exclusions: '' }, evidence: [{ message_id: f.source.id, region: 'content', excerpt: f.source.content }] })
    if (created.outcome !== 'success') throw new Error(JSON.stringify(created))
    const draft = created.draft as { draft_id: string }
    const saver = new PrismaCheckpointSaver(f.prisma)
    const id = randomUUID()
    await saver.put({ configurable: { thread_id: f.past.id } }, { v: 4, id, ts: new Date().toISOString(), channel_values: { messages: [new AIMessage({ content: '', tool_calls: [{ id: 'benchmark-call', name: 'reflection_records', args: { operation: 'draft', problem: '性能验收专属正文' } }] })] }, channel_versions: {}, versions_seen: {} }, { source: 'input', step: 0, parents: {} })
    const payload = new Uint8Array(Buffer.from(JSON.stringify({ ordinary: 'x'.repeat(1024 * 1024), note: 'reflection_records 是普通文本，不含目标引用' })))
    for (let thread = 0; thread < 2; thread++) {
      const session = await f.prisma.session.create({ data: { ownerId: f.owner.id, containerId: 'benchmark-noise', title: `无关历史${thread}` } })
      for (let batch = 0; batch < 8; batch++) await f.prisma.checkpoint.createMany({ data: Array.from({ length: 8 }, (_, n) => ({ threadId: session.id, checkpointId: `${batch}-${n}`, type: 'json', blob: payload })) })
    }
    const startMemory = process.memoryUsage().heapUsed
    const start = performance.now()
    const cancelled = await f.reflection.service.execute(ctx, { operation: 'cancel', draft_id: draft.draft_id })
    const durationMs = performance.now() - start
    const decoded = await saver.getTuple({ configurable: { thread_id: f.past.id, checkpoint_id: id } })
    const passed = cancelled.outcome === 'success' && durationMs < 2000 && !JSON.stringify(decoded).includes('性能验收专属正文')
    const result = { passed, irrelevantHistoryMiB: 128, irrelevantCheckpoints: 128, durationMs, maxDurationMs: 2000, heapGrowthBytes: Math.max(0, process.memoryUsage().heapUsed - startMemory), targetCopiesCleared: !JSON.stringify(decoded).includes('性能验收专属正文'), scope: 'local synthetic capacity measurement; no model calls' }
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(result))
    if (!passed) process.exitCode = 1
  } finally { await f.dispose() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

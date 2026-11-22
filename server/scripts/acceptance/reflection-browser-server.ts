// 仅验收入口：真实 HTTP/SSE/SQLite/RunService，ScriptedChatModel 明确替代真实模型。
// 不由生产入口引用；可选真实 Docker 原语供容器人工冒烟，数据均为合成数据。
import express from 'express'
import { randomUUID } from 'node:crypto'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { createApp } from '../../src/app'
import { StreamHub } from '../../src/events/hub'
import { BullMqRunQueue } from '../../src/runner/bullmqRunQueue'
import { RunService } from '../../src/runner/runtime/runService'
import { ProviderRegistry } from '../../src/runner/providerRegistry'
import { PrismaCheckpointSaver } from '../../src/runner/persistence/prismaCheckpointSaver'
import { ConcurrencyGate } from '../../src/runner/concurrency'
import { SessionService } from '../../src/sessions/service'
import { DockerPrimitives } from '../../src/runner/backend/dockerPrimitives'
import { SandboxLifecycle } from '../../src/sandboxes/lifecycle'
import { DockerSandboxRuntime } from '../../src/sandboxes/dockerRuntime'
import { WikiContainerLifecycle } from '../../src/wikiContainers/lifecycle'
import { DockerWikiContainerRuntime } from '../../src/wikiContainers/dockerRuntime'
import { wikiContainerName } from '../../src/wikiContainers/runtime'
import { installAbortRejectionGuard } from '../../src/runner/runtime/abortGuard'
import { ScriptedChatModel, fakePrimitives, toolCallAi } from '../../test/runnerFakes'
import cases from '../../test/fixtures/reflection-analysis.json'
import { createAnalysisFixture, AnalysisCaseSchema } from './reflection-fixtures'

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('acceptance harness requires NODE_ENV=test')
  installAbortRejectionGuard()
  const f = await createAnalysisFixture(AnalysisCaseSchema.parse(cases.cases[15]), { classifier: async input => ({ decision: /^(好，就这版保存|确认执行)$/.test(input.userText) ? 'confirm' : 'unrelated' }) })
  const hub = new StreamHub()
  const realDocker = process.env.RF_ACCEPTANCE_REAL_DOCKER === '1'
  const sandbox = realDocker ? new SandboxLifecycle(new DockerSandboxRuntime(), { image: 'busybox:1.36' }) : undefined
  const wiki = realDocker ? new WikiContainerLifecycle(new DockerWikiContainerRuntime(), { image: 'busybox:1.36' }) : undefined
  const steps = new Map<string, number>()
  const seenCommits = new Set<string>()
  const records: { first?: string; second?: string; merged?: string; firstVersion: number } = { firstVersion: 1 }
  let draft = { draft_id: '', version: 1 }
  let operation = 'create'
  let activeFlow = 'first'
  const longProblem = Array.from({ length: 80 }, (_, index) => `【合成长度样本 ${index + 1}】本段仅用于验证大于4KiB的草稿能够完整渲染。修改代码后应先验证类型与相关测试，再说明完成范围。`).join('\n\n') + '\n完整正文尾部-RF24'
  const inflightExcerpt = '同轮证据：本次验证遗漏已经被纠正。'
  let model: ScriptedChatModel
  const respond = (messages: BaseMessage[]) => {
    const human = [...messages].reverse().find(m => m.getType() === 'human')!
    const text = typeof human.content === 'string' ? human.content : ''
    const key = human.id ?? text
    const step = steps.get(key) ?? 0
    steps.set(key, step + 1)
    const latest = [...messages].reverse().find(m => m.getType() === 'tool') as BaseMessage & { tool_call_id?: string } | undefined
    if (latest?.tool_call_id && !seenCommits.has(latest.tool_call_id)) {
      const content = typeof latest.content === 'string' ? latest.content : ''
      if (content.includes('"outcome":"failure"')) throw new Error('acceptance tool failed: ' + content.slice(0, 500))
      if (latest.tool_call_id.startsWith('draft-')) {
        const id = /"draft_id":"([^"]+)"/.exec(content)?.[1]
        if (id) draft = { draft_id: id, version: 1 }
      }
      if (latest.tool_call_id.startsWith('commit-')) {
        seenCommits.add(latest.tool_call_id)
        const id = /"record_id":"([^"]+)"/.exec(content)?.[1]
        if (id) {
          if (activeFlow === 'first') records.first = id
          if (activeFlow === 'second') records.second = id
          if (activeFlow === 'merge') records.merged = id
          if (activeFlow === 'revise') records.firstVersion = 2
        }
      }
    }
    const call = (prefix: string, name: string, args: Record<string, unknown>) => toolCallAi(prefix + '-' + randomUUID(), name, args)
    const history = () => call('history', 'session_history', { operation: 'read', targets: [{ session_id: f.past.id }] })
    const present = () => call('present', 'reflection_records', { operation: 'present', ...draft })
    const makeDraft = (action: string, title: string, targets?: { record_id: string; version: number }[], inflight = false) => {
      operation = action
      return call('draft', 'reflection_records', { operation: 'draft', action, category: 'verification', title, problem: inflight ? longProblem : '代码修改后应完成类型检查与聚焦验证。', causes: [{ kind: 'fact', text: '原消息表明遗漏了验证', evidence: [1] }], improvements: ['修改后先运行类型检查和聚焦测试，再报告完成'], scope: { labels: ['验证'], conditions: '代码修改后', exclusions: '纯问答' }, evidence: [{ session_id: f.past.id, message_id: f.source.id, region: 'content', excerpt: f.source.content }, ...(inflight ? [{ session_id: f.current.id, region: 'content', excerpt: inflightExcerpt }] : [])], ...(targets ? { targets } : {}) })
    }
    if (/好，就这版保存|确认执行/.test(text)) return step === 0 ? call('commit', 'reflection_records', { operation: 'commit', ...draft }) : new AIMessage(`操作 ${operation} 已完成。记录：${records.merged ?? records.second ?? records.first ?? '已删除'}`)
    if (text.includes('复用')) {
      if (step === 0) return call('search', 'reflection_records', { operation: 'search', query: '验证' })
      if (step === 1) return call('read', 'reflection_records', { operation: 'read', targets: [{ record_id: records.first }] })
      return new AIMessage('已按需读取记录 ' + records.first + '/v1，继续原任务，先执行聚焦验证。')
    }
    if (text.includes('查有效经验')) return step === 0 ? call('search', 'reflection_records', { operation: 'search' }) : new AIMessage('已检查经验检索结果；来源失效的经验不再主动使用。')
    if (text.includes('删除合并')) {
      activeFlow = 'delete'; operation = 'delete'
      if (step === 0) return call('draft', 'reflection_records', { operation: 'draft', action: 'delete', targets: [{ record_id: records.merged, version: 1 }] })
      if (step === 1) return present()
      return new AIMessage('删除操作已完整展示，请阅读不可逆影响后自然确认。')
    }
    activeFlow = text.includes('修订') ? 'revise' : text.includes('第二条') ? 'second' : text.includes('合并') ? 'merge' : 'first'
    if (step === 0) return history()
    if (step === 1) {
      if (activeFlow === 'revise') return makeDraft('revise', 'RF24 修订经验', [{ record_id: records.first!, version: records.firstVersion }])
      if (activeFlow === 'merge') return makeDraft('merge', 'RF24 合并经验', [{ record_id: records.first!, version: records.firstVersion }, { record_id: records.second!, version: 1 }])
      return makeDraft('create', activeFlow === 'second' ? 'RF24 第二条经验' : 'RF24 验证教训', undefined, activeFlow === 'first')
    }
    if (step === 2) return present()
    return new AIMessage((activeFlow === 'first' ? inflightExcerpt : '') + '完整草稿已展示，等待自然确认；原任务继续。')
  }
  model = new ScriptedChatModel(Array.from({ length: 160 }, () => () => respond(model.receivedMessages.at(-1) as BaseMessage[])))
  const registry = new ProviderRegistry(f.prisma, { llmApiKey: 'synthetic-no-network', modelFactory: async () => model })
  const touchedSandboxes = new Set<string>()
  const svc = new RunService({ prisma: f.prisma, registry, saver: new PrismaCheckpointSaver(f.prisma), gate: new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 2 }), hub,
    primitives: realDocker ? new DockerPrimitives() : fakePrimitives().primitives,
    resolveWikiContainer: wikiContainerName, reflections: f.reflection.port, history: f.history,
    ...(sandbox ? { sandboxes: { ensure: async (id: string) => { touchedSandboxes.add(id); return sandbox.ensure(id) }, touch: () => {} } } : {}),
    ...(wiki ? { wikis: { ensure: async (id: string) => { await wiki.ensure(id) } } } : {}),
  })
  if (realDocker && !process.env.RF_ACCEPTANCE_REDIS_URL) throw new Error('container smoke requires an isolated RF_ACCEPTANCE_REDIS_URL')
  const queue = realDocker ? new BullMqRunQueue({ redisUrl: process.env.RF_ACCEPTANCE_REDIS_URL!, queueName: 'rf1088-acceptance', execute: command => svc.execute(command), concurrency: 2 }) : undefined
  if (queue) svc.setTeammateDispatcher((command, delayMs) => queue.submit(command, { delayMs }))
  const sessions = new SessionService({ prisma: f.prisma, hub, runService: svc, dispatch: async command => { if (queue) await queue.submit(command); else setImmediate(() => { void svc.execute(command).catch(error => console.error('acceptance run failed:', error.message)) }) }, reflections: { clearInitiatingSession: (tx, args) => f.reflection.store.clearInitiatingSession(tx, args) } })
  svc.setRecordTurn(payload => sessions.recordTurn(payload))
  const app = express()
  app.get('/__acceptance/report', async (_req, res) => {
    res.json({ synthetic: true, realModelCalls: 0, realDocker, realRedis: !!queue, sourceSessionId: f.past.id, currentSessionId: f.current.id, records, draft,
      recordsState: await f.prisma.reflectionRecord.findMany({ select: { id: true, status: true, evidenceStatus: true, currentRevision: true, contentJson: true } }),
      displays: await f.prisma.reflectionPresentation.findMany({ select: { displayId: true, draftId: true, status: true, ackedAt: true, bodyJson: true } }),
      evidence: await f.prisma.reflectionEvidence.findMany({ select: { id: true, messageId: true, runId: true, status: true } }), modelCalls: model.invokeCount })
  })
  app.use(createApp({ prisma: f.prisma, events: { hub, heartbeatMs: 1000 }, sessions: { service: sessions }, reflections: { service: f.reflection.service } }))
  const listener = app.listen(Number(process.env.RF_ACCEPTANCE_PORT ?? 38088), '0.0.0.0', () => console.log(JSON.stringify({ ready: true, port: process.env.RF_ACCEPTANCE_PORT ?? '38088', username: 'rf-eval', password: 'synthetic-evaluation-password', sourceSessionId: f.past.id, currentSessionId: f.current.id, realDocker })))
  const stop = async () => {
    listener.closeAllConnections(); listener.close()
    await queue?.close(); await svc.dispose(); await f.dispose()
    if (sandbox) for (const id of touchedSandboxes) await sandbox.remove(id)
    if (wiki) await new DockerWikiContainerRuntime().removeWiki(f.owner.id)
    process.exit(0)
  }
  process.once('SIGINT', () => { void stop() }); process.once('SIGTERM', () => { void stop() })
}
void main().catch(error => { console.error(error); process.exitCode = 1 })

// PoC #724 · THROWAWAY —— agent 运行时 + WS 服务。
// createDeepAgent（deepagents 1.14）三个扩展点全接线：
//   backend  = DockerArchiveBackend（容器树 fs 原语 + busybox shell）
//   checkpointer = PrismaCheckpointSaver（checkpoint 落 poc724.db）
//   interruptOn  = execute 工具 HITL（allowedDecisions approve/reject，when 谓词只触发一次）
// streamEvents v3 → WS JSON 帧（token / tool_start / tool_end / run_status），
// 即验收问题 2（基座胜任度）与问题 3（checkpoint/replay 形态）的运行载体。

import { WebSocketServer, type WebSocket } from 'ws'
import { ChatAnthropic } from '@langchain/anthropic'
import AnthropicClient from '@anthropic-ai/sdk'
import { createDeepAgent } from 'deepagents'
import { Command } from '@langchain/langgraph'
import { HumanMessage } from '@langchain/core/messages'
import type { DockerArchiveBackend } from './dockerBackend'
import type { PrismaCheckpointSaver } from './prismaSaver'
import { record, type LatencyRegistry } from './latency'

export interface WsFrame {
  type: string
  [k: string]: unknown
}

const SYSTEM_PROMPT = [
  '你在一个 busybox 容器内工作，文件树在 /wiki（你的文件工具直接操作容器内路径）。',
  '可用工具：ls / read_file / write_file / glob / grep（走 Docker 归档通道）与 execute（容器内 /bin/sh 执行命令）。',
  '逐步使用工具完成用户任务，每一步都用工具验证，不要凭记忆假设数字。',
  '回复保持简短。',
].join('\n')

export function buildModel(): ChatAnthropic {
  const model =
    process.env.POC_MODEL ?? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001'
  // 面板网关形态：ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN（Bearer）。
  // ChatAnthropic 构造有 apiKey 强制检查且只认 ANTHROPIC_API_KEY env —— 走 createClient 显式建 SDK 客户端，
  // authToken 语义与官方 SDK 对齐（Authorization: Bearer）。
  return new ChatAnthropic({
    model,
    createClient: (options) =>
      new AnthropicClient({
        ...options,
        authToken: process.env.ANTHROPIC_AUTH_TOKEN,
        baseURL: process.env.ANTHROPIC_BASE_URL,
      }),
  })
}

export function buildAgent(opts: {
  backend: DockerArchiveBackend
  saver: PrismaCheckpointSaver
  interruptFirstExecute: boolean
}) {
  // when 谓词：同一 agent 实例内首次 execute 触发 interrupt，其余自动执行
  //（PoC 只需一次断线恢复演示；生产形态是 judge 漏斗，见 wayfinder #729）
  let fired = false
  const interruptOn = opts.interruptFirstExecute
    ? {
        execute: {
          allowedDecisions: ['approve', 'reject'] as const,
          when: () => {
            if (fired) return false
            fired = true
            return true
          },
        },
      }
    : undefined

  return createDeepAgent({
    model: buildModel(),
    backend: opts.backend,
    checkpointer: opts.saver,
    interruptOn,
    systemPrompt: SYSTEM_PROMPT,
    name: 'poc724',
  })
}

// 安全 JSON（interrupt payload 可能带循环/BigInt；能序列化多少算多少）。
// 注意 JSON.stringify(undefined) 返回 undefined 而非字符串 —— 必须兜底。
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val: unknown) => (typeof val === 'bigint' ? val.toString() : val)) ?? String(v)
  } catch {
    return String(v)
  }
}

function extractInterruptPayload(snap: unknown): unknown[] {
  const s = snap as {
    interrupts?: { value?: unknown }[]
    tasks?: { interrupts?: { value?: unknown }[] }[]
  }
  const out: unknown[] = []
  for (const i of s.interrupts ?? []) out.push(i.value)
  for (const t of s.tasks ?? []) for (const i of t.interrupts ?? []) out.push(i.value)
  return out
}

async function runLoop(params: {
  agent: ReturnType<typeof buildAgent>
  threadId: string
  input: unknown
  ws: WebSocket
  reg: LatencyRegistry
  scenario: string
}): Promise<'done' | 'interrupted' | 'error'> {
  const { agent, threadId, ws, reg } = params
  const send = (frame: WsFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
  const t0 = performance.now()
  const llmStart = new Map<string, number>()
  let toolCalls = 0
  try {
    // ReactAgent.streamEvents(state, config)：version 与 configurable 同处第二个参数。
    // lc v2 产出 protocol events：messages(model_request: message-start/finish + content-block-delta)、
    // tools(tool-started/finished)、checkpoints(step)、updates/values、lifecycle。
    const stream = await agent.streamEvents(params.input, {
      version: 'v3',
      configurable: { thread_id: threadId },
      recursionLimit: 500,
    })
    for await (const raw of stream) {
      const ev = raw as { method?: string; params?: { name?: string; data?: Record<string, unknown> } }
      const data = ev.params?.data ?? {}
      if (ev.method === 'messages') {
        if (data.event === 'message-start') {
          llmStart.set(String(data.run_id), performance.now())
        } else if (data.event === 'message-finish') {
          const start = llmStart.get(String(data.run_id))
          if (start !== undefined) {
            record(reg, 'llm', 'chat', performance.now() - start)
            llmStart.delete(String(data.run_id))
          }
        } else if (data.event === 'content-block-delta') {
          const d = data.delta as { type?: string; text?: string } | undefined
          if (d?.type === 'text-delta' && d.text) send({ type: 'token', delta: d.text })
        }
      } else if (ev.method === 'tools') {
        if (data.event === 'tool-started') {
          toolCalls += 1
          send({ type: 'tool_start', name: data.tool_name, input: String(data.input ?? '') })
        } else if (data.event === 'tool-finished') {
          const out = data.output as { kwargs?: { content?: unknown } } | undefined
          const content = out?.kwargs?.content
          send({
            type: 'tool_end',
            name: (out?.kwargs as { name?: string } | undefined)?.name,
            outputChars: typeof content === 'string' ? content.length : safeJson(content).length,
          })
        }
      } else if (ev.method === 'checkpoints') {
        send({ type: 'checkpoint', step: data.step, source: data.source })
      }
    }
  } catch (err) {
    send({
      type: 'run_status',
      status: 'error',
      error: String(err),
      stack: String((err as Error).stack ?? '').slice(0, 900),
    })
    return 'error'
  }
  // 流结束后判定：graph 停在 interrupt（next 非空 / tasks 带 interrupts）还是跑完
  const snap = await agent.graph.getState({ configurable: { thread_id: threadId } })
  const s = snap as { next?: string[] }
  const payloads = extractInterruptPayload(snap)
  if ((s.next?.length ?? 0) > 0 || payloads.length > 0) {
    send({ type: 'run_status', status: 'interrupted', payloads: payloads.map(safeJson), toolCalls })
    return 'interrupted'
  }
  send({ type: 'run_status', status: 'done', wallMs: Math.round(performance.now() - t0), toolCalls })
  return 'done'
}

export interface PocServer {
  port: number
  close: () => Promise<void>
}

export function startPocServer(deps: {
  port: number
  backend: DockerArchiveBackend
  saver: PrismaCheckpointSaver
  reg: LatencyRegistry
}): PocServer {
  const wss = new WebSocketServer({ port: deps.port })
  const busy = new Set<string>()
  // 每线程记住 start 时的 interrupt 配置：resume 必须用同拓扑图重建 agent，
  // 否则 afterModel 的 HITL middleware 节点在新图里不存在，resume 会静默空转（12ms 假 done）。
  const threadInterrupt = new Map<string, boolean>()

  wss.on('connection', (ws) => {
    ws.on('message', (raw: Buffer) => {
      let msg: WsFrame
      try {
        msg = JSON.parse(raw.toString()) as WsFrame
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'bad json' }))
        return
      }
      const threadId = String(msg.threadId ?? '')
      if (busy.has(threadId)) {
        ws.send(JSON.stringify({ type: 'error', error: `thread ${threadId} 已有运行中` }))
        return
      }
      busy.add(threadId)
      ;(async () => {
        try {
          if (msg.type === 'start') {
            threadInterrupt.set(threadId, msg.interruptFirstExecute === true)
          }
          const agent = buildAgent({
            backend: deps.backend,
            saver: deps.saver,
            interruptFirstExecute: threadInterrupt.get(threadId) === true,
          })
          const config = { configurable: { thread_id: threadId } }
          if (msg.type === 'start') {
            await runLoop({
              agent,
              threadId,
              input: { messages: [{ role: 'user', content: String(msg.task ?? '') }] },
              ws,
              reg: deps.reg,
              scenario: String(msg.scenario ?? 'start'),
            })
          } else if (msg.type === 'followup') {
            await runLoop({
              agent,
              threadId,
              input: { messages: [new HumanMessage(String(msg.message ?? ''))] },
              ws,
              reg: deps.reg,
              scenario: 'followup',
            })
          } else if (msg.type === 'resume') {
            await runLoop({
              agent,
              threadId,
              input: new Command({ resume: { decisions: msg.decisions } }),
              ws,
              reg: deps.reg,
              scenario: 'resume',
            })
          } else {
            ws.send(JSON.stringify({ type: 'error', error: `未知消息类型 ${msg.type}` }))
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'run_status', status: 'error', error: String(err) }))
        } finally {
          busy.delete(threadId)
        }
      })()
    })
  })

  return {
    port: deps.port,
    close: () =>
      new Promise<void>((res) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => res())
      }),
  }
}

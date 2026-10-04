// runner 测试 fakes（#777）：ScriptedChatModel（脚本化 LLM）+ 内存版 SandboxFilePrimitives。
// S1/S4 全部走 fake——零真 LLM、零真 Docker（S2 接缝）。
//
// ScriptedChatModel 形态经 throwaway 探针实测锁定（deepagents 1.14.1 + langgraph 1.4.18）：
//   - _generate 返回完整 ChatResult {generations:[{message,text}]}（AgentNode 消费 generations）
//   - bindTools 返回自身（deepagents 绑定工具面；脚本驱动与 tools 无关）
//   - _stream 逐块吐 ChatGenerationChunk（text 分片 + tool_call_chunks）→ Pregel 聚合出
//     message-start/content-block-delta/message-finish protocol events
//   - HITL resume payload 形态 = Command({resume: {decisions: [...]}})

import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { createTarFile, parseTar } from '../src/files/tar'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'

// 脚本条目：AIMessage 或工厂（LazyMessage 可断言构造时点）
export type ScriptEntry = AIMessage | (() => AIMessage)

// 文本分片长度（_stream 切片粒度——多 chunk 验证流式多 delta 路径）
const STREAM_CHUNK_CHARS = 4

export class ScriptedChatModel extends BaseChatModel {
  lc_run_name = 'ScriptedChatModel'

  private readonly script: ScriptEntry[]
  private cursor = 0
  private readonly loop: boolean

  invokeCount = 0
  readonly receivedMessages: unknown[] = []

  constructor(script: ScriptEntry[], opts: { loop?: boolean } = {}) {
    super({})
    this.script = script
    this.loop = opts.loop ?? false
  }

  _llmType(): string {
    return 'scripted-chat-model'
  }

  bindTools(): this {
    return this
  }

  private nextMessage(): AIMessage {
    if (this.cursor >= this.script.length) {
      if (this.loop && this.script.length > 0) this.cursor = 0
      else throw new Error('script exhausted')
    }
    const entry = this.script[this.cursor++]!
    return typeof entry === 'function' ? entry() : entry
  }

  async _generate(
    _messages: unknown,
    _options: unknown,
    _runManager: unknown,
  ) {
    this.receivedMessages.push(_messages)
    this.invokeCount += 1
    const message = this.nextMessage()
    const text = typeof message.content === 'string' ? message.content : ''
    return { generations: [{ message, text }] }
  }

  async *_stream(
    messages: unknown,
    options: unknown,
    runManager: unknown,
  ): AsyncGenerator<ChatGenerationChunk> {
    const generated = await this._generate(messages, options, runManager)
    const message = generated.generations[0]!.message
    const text = typeof message.content === 'string' ? message.content : ''
    for (let i = 0; i < text.length; i += STREAM_CHUNK_CHARS) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({ content: text.slice(i, i + STREAM_CHUNK_CHARS) }),
        text: text.slice(i, i + STREAM_CHUNK_CHARS),
      })
    }
    for (const tc of message.tool_calls ?? []) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              name: tc.name,
              args: JSON.stringify(tc.args),
              id: tc.id,
              index: 0,
              type: 'tool_call_chunk',
            },
          ],
        }),
        text: '',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 内存版 Docker 原语 fake（dockerArchiveBackend.test.ts fakeDocker 精简镜像：
// mkdir -p / sh -c rm -rf 模拟 + 双容器 tar 读写；exec 记录调用供副作用断言）。
// ---------------------------------------------------------------------------

interface MemFs {
  trees: Map<string, Map<string, Buffer | 'dir'>>
  execCalls: { container: string; cmd: string[] }[]
  primitives: SandboxFilePrimitives
}

export function fakePrimitives(
  opts: {
    execBehavior?: (container: string, cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }> | { exitCode: number; stdout: string; stderr: string } | undefined
  } = {},
): MemFs {
  const trees = new Map<string, Map<string, Buffer | 'dir'>>()
  const execCalls: { container: string; cmd: string[] }[] = []
  const treeOf = (c: string): Map<string, Buffer | 'dir'> => {
    let t = trees.get(c)
    if (!t) {
      t = new Map()
      trees.set(c, t)
    }
    return t
  }
  const dirTarOf = (tree: Map<string, Buffer | 'dir'>, absPath: string): Buffer => {
    const base = absPath.split('/').pop()!
    const parts: Buffer[] = []
    const h = createTarFile(`${base}/`, Buffer.alloc(0), 1000)
    h.write('5', 156, 'utf8')
    parts.push(h.subarray(0, 512))
    for (const [p, c] of tree) {
      if (p.startsWith(`${absPath}/`) && c !== 'dir') {
        parts.push(createTarFile(`${base}/${p.slice(absPath.length + 1)}`, c, 1000))
      }
    }
    parts.push(Buffer.alloc(1024))
    return Buffer.concat(parts)
  }
  const primitives: SandboxFilePrimitives = {
    async exec(container, cmd) {
      execCalls.push({ container, cmd })
      const handled = await opts.execBehavior?.(container, cmd)
      if (handled) return handled
      if (cmd[0] === 'mkdir') {
        treeOf(container).set(cmd[cmd.length - 1]!, 'dir')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: 'fake-exec-out\n', stderr: '' }
    },
    async getArchive(container, absPath) {
      const t = treeOf(container)
      const v = t.get(absPath)
      if (v === undefined) return null
      if (v === 'dir') return dirTarOf(t, absPath)
      return createTarFile(absPath.split('/').pop()!, v, 1000)
    },
    async putArchive(container, dir, tar) {
      const t = treeOf(container)
      for (const e of parseTar(tar, { collectData: true })) {
        const name = e.name.replace(/^\.\//, '').replace(/\/$/, '')
        if (e.type === 'directory') t.set(`${dir}/${name}`, 'dir')
        else t.set(`${dir}/${name}`, e.data ?? Buffer.alloc(0))
      }
    },
  }
  return { trees, execCalls, primitives }
}

// ---------------------------------------------------------------------------
// 收集器 hub（EventPublisher 结构面）：按序捕获 publish 全量事件，供帧序列断言。
// ---------------------------------------------------------------------------

export interface CapturedEvent {
  userId: string
  type: string
  sessionId?: string
  runId?: string
  teammateId?: string
  payload: unknown
}

export class CollectingHub {
  readonly events: CapturedEvent[] = []
  publish(userId: string, event: { type: string; sessionId?: string; runId?: string; teammateId?: string; payload: unknown }): void {
    this.events.push({ userId, ...event })
  }
  types(): string[] {
    return this.events.map((e) => e.type)
  }
  reset(): void {
    this.events.length = 0
  }
}

// 工具调用轮 AIMessage（content 数组形态——v3 protocol events 需 content blocks 才有 block 事件）。
export function toolCallAi(id: string, name: string, args: Record<string, unknown>, text = ''): AIMessage {
  return new AIMessage({
    content: [{ type: 'text', text }],
    tool_calls: [{ id, name, args }],
  })
}

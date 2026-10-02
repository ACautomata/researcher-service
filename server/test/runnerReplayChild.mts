// S4 跨进程 replay 子进程（#777 · PoC #724 S3 固化）：全新栈（新 Prisma / 新 saver / 新
// RunService）凭 checkpoint 历史直答——DB 是会话唯一事实源（「独立进程」语义 = 模块级缓存
// 与内存全部失效的进程边界）。父进程经 env 传 DB 与 thread；结果 JSON 打 stdout。
// 模型脚本（ScanChatModel）自身**不含答案**——从收到的消息历史里扫描幸运数字；历史没进
// prompt 就答不出，直答成功即证明 checkpoint 自包含可跨进程恢复。

import Database from 'better-sqlite3'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { RunService } from '../src/runner/runtime/runService'
import { fakePrimitives } from './runnerFakes'

interface Result {
  ok: boolean
  historyLen?: number
  scannedAnswer?: string | null
  toolCalls?: number
  modelCalls?: number
  error?: string
}

// 直答模型：从收到的 messages 扫「幸运数字是 N」并回答 N（脚本不含答案产生逻辑）。
class ScanChatModel extends BaseChatModel {
  lc_run_name = 'ScanChatModel'
  calls = 0
  scanned: string | null = null

  constructor() {
    super({}) // BaseLanguageModel 构造器解构 kwargs，必须传对象
  }

  _llmType(): string {
    return 'scan-chat-model'
  }

  bindTools(): this {
    return this
  }

  async _generate(messages: unknown, _options: unknown, _runManager: unknown) {
    this.calls += 1
    const text = JSON.stringify(messages ?? '')
    const m = text.match(/幸运数字是\s*(\d+)/)
    this.scanned = m?.[1] ?? null
    const content = this.scanned !== null ? `你的幸运数字是 ${this.scanned}。` : '我没有找到相关信息。'
    const message = new AIMessage({ content })
    return { generations: [{ message, text: content }] }
  }

  async *_stream(messages: unknown, options: unknown, runManager: unknown): AsyncGenerator<ChatGenerationChunk> {
    const { generations } = await this._generate(messages, options, runManager)
    const message = generations[0]!.message
    const text = typeof message.content === 'string' ? message.content : ''
    yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: text }), text })
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.REPLAY_DB_URL
  const sessionId = process.env.REPLAY_THREAD_ID
  const ownerId = process.env.REPLAY_OWNER_ID
  const username = process.env.REPLAY_USERNAME
  if (!dbUrl || !sessionId || !ownerId || !username) {
    throw new Error('REPLAY_DB_URL / REPLAY_THREAD_ID / REPLAY_OWNER_ID / REPLAY_USERNAME 必填')
  }

  // 文件 DB 可开（独立连接；同 SQLite 文件跨进程访问，PoC phase3 同形态）
  const sqlite = new Database(dbUrl.replace(/^file:/, ''))
  sqlite.exec('SELECT 1')
  sqlite.close()
  const prisma: PrismaClient = createPrismaClient(dbUrl)
  try {
    const saver = new PrismaCheckpointSaver(prisma)

    // ① 独立 getTuple 面：checkpoint 读回历史
    const tuple = await saver.getTuple({ configurable: { thread_id: sessionId } })
    // checkpoint blob 解出后 channel 值的字段为 snake_case（LangGraph 内部序列化风格）
    const cpRec = tuple?.checkpoint as unknown as Record<string, unknown> | undefined
    const cv = (cpRec?.channel_values ?? cpRec?.channelValues) as Record<string, unknown> | undefined
    const cvKeys = cv ? Object.keys(cv).join(',') : 'no-cv'
    const values = cv as { messages?: unknown[] } | undefined
    const historyLen = Array.isArray(values?.messages) ? values.messages.length : 0

    // ② 全新 RunService（内存 runs 为空）+ 扫描模型直答
    const fs = fakePrimitives()
    const scan = new ScanChatModel()
    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'replay-not-used',
      modelFactory: async () => scan,
    })
    const svc = new RunService({
      prisma,
      registry,
      saver,
      gate: new ConcurrencyGate({ globalLimit: 4, loadUserLimit: async () => 2 }),
      hub: { publish: () => {} },
      primitives: fs.primitives,
      resolveWikiContainer: () => 'researcher-wiki-x',
    })

    await svc.execute(
      svc.buildCommand({
        sessionId,
        ownerId,
        username,
        kind: 'message',
        content: '我的幸运数字是多少？',
      }),
    )

    const result: Result & { cvKeys: string } = {
      ok: scan.scanned !== null && historyLen >= 2 && fs.execCalls.length === 0,
      historyLen,
      scannedAnswer: scan.scanned,
      toolCalls: fs.execCalls.length,
      modelCalls: scan.calls,
      cvKeys,
    }
    console.log(`REPLAY_RESULT ${JSON.stringify(result)}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  const result: Result = {
    ok: false,
    error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e),
  }
  console.log(`REPLAY_RESULT ${JSON.stringify(result)}`)
  process.exit(1)
})

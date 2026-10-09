// 模型工厂（#881 建立于 runner/providerRegistry.ts，#882 下沉至 models 域）：根据
// (lcProvider, baseUrl, apiKey, authHeader) 构造 LangChain ChatModel 的唯一接缝。
//
// 下沉动机（依赖方向）：runner 域本就消费 models 域（presets/cipher），而 #882 端点试连
// （models 域 REST）也要消费同一工厂——models 不得反向依赖 runner，故工厂本体落 models 域，
// providerRegistry re-export 类型保持既有 import 面。
//
// 接缝：ChatModelFactory 可注入（测试 fake——真构造不打网络，fake 断言参数面）。
//
// fetch 注入面（实测锁定）：openai → configuration.fetch（透传 OpenAI client 构造器）；
// anthropic → clientOptions.{baseURL, fetch}（透传 Anthropic SDK client，源码 spread 次序保证
// 显式 clientOptions.baseURL 覆盖 ANTHROPIC_BASE_URL 等环境变量）。
// authHeader=true（anthropic）：经 createClient 覆盖把 SDK 的 apiKey（X-Api-Key 头）置 null、
// authToken（Authorization: Bearer 头）置 key——Bearer-only（双头并存会被部分网关拒）。

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { initChatModel } from 'langchain/chat_models/universal'
import { Anthropic } from '@anthropic-ai/sdk'

export interface ModelFactoryOptions {
  readonly lcProvider: 'openai' | 'anthropic'
  readonly baseUrl: string
  readonly apiKey: string
  /** fetch 注入缝（测试 spy；生产 = globalThis.fetch） */
  readonly fetch: typeof fetch
  /** 凭证头策略（预设派生）：true = 强制 Authorization: Bearer（MiniMax/DeepSeek anthropic
   * 兼容面通行 Bearer——repo 调研文档锁）；false = SDK 原生头策略（anthropic=x-api-key） */
  readonly authHeader: boolean
}

export type ChatModelFactory = (model: string, opts: ModelFactoryOptions) => Promise<BaseChatModel>

export const defaultFactory: ChatModelFactory = async (model, opts) => {
  if (opts.lcProvider === 'openai') {
    return (await initChatModel(model, {
      modelProvider: 'openai',
      configurableFields: ['model', 'modelProvider', 'temperature'],
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl, // initChatModel 映射 → ChatOpenAI baseURL（实测验证）
      configuration: { fetch: opts.fetch },
    })) as unknown as BaseChatModel
  }
  return (await initChatModel(model, {
    modelProvider: 'anthropic',
    configurableFields: ['model', 'modelProvider', 'temperature'],
    apiKey: opts.apiKey,
    clientOptions: { baseURL: opts.baseUrl, fetch: opts.fetch },
    ...(opts.authHeader
      ? {
          createClient: (options: ConstructorParameters<typeof Anthropic>[0]) =>
            new Anthropic({ ...options, apiKey: null, authToken: opts.apiKey }),
        }
      : {}),
  })) as unknown as BaseChatModel
}

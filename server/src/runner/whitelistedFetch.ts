// 白名单 fetch wrapper（731 §5.1 白名单第二层之运行时请求面 / #775）：
//   ① 发出前校验最终请求 URL origin ∈ 白名单（防配置侧绕过——admin 直改库、redirect 之外的
//      任何来源）；
//   ② `redirect: 'manual'` 强制禁跟随：白名单端点 302 跳恶意端点时 key 不得随行。manual 模式下
//      重定向不被跟随、以 3xx/opaqueredirect 形态返回，本层对任何重定向响应一律抛错（fail-closed
//      ——LLM API 无合法重定向场景，不校验目标 origin 是否可信）。
// 未命中 → EndpointNotAllowedError（code = 40042「端点不在白名单」，不泄露白名单内容）。
//
// 生产接线（#777 runner 核心）：initChatModel 构造 ChatOpenAI/ChatAnthropic 时把本 wrapper 注入
// fetch 配置位；本文件不引 langchain 依赖（协议同形，#772 先例），fetch 契约 = 全局 fetch 同形。

import { CODE } from '../codes'
import { EnvelopeError } from '../envelope'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// 40042 错误对象：继承信封错误（run 语境下经统一错误面/错误三分类消费，#777），码与默认文案
// 单一来源 codes.ts。
export class EndpointNotAllowedError extends EnvelopeError {
  constructor(message?: string) {
    super(CODE.PROVIDER_ENDPOINT_NOT_ALLOWED, message)
    this.name = 'EndpointNotAllowedError'
  }
}

function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

// undici 对 redirect:'manual' 返回 opaqueredirect 过滤响应（status 0、headers 不可读）——
// status 0 与 3xx 同按「发生重定向」处理。
function isRedirectResponse(resp: Response): boolean {
  return (resp.status >= 300 && resp.status < 400) || resp.status === 0
}

export interface WhitelistedFetchOptions {
  // origin 判定（调用方供给：CRUD/registry 侧的 allowlist 匹配逻辑，本层不管数据来源）
  isAllowed: (origin: string) => boolean
  // 缺省 = globalThis.fetch（测试注入 fake delegate）
  delegate?: FetchLike
}

export function createWhitelistedFetch(opts: WhitelistedFetchOptions): FetchLike {
  const delegate = opts.delegate ?? globalThis.fetch
  return async (input, init) => {
    let origin: string
    try {
      origin = new URL(requestUrlOf(input)).origin
    } catch {
      throw new EndpointNotAllowedError('端点 URL 非法')
    }
    if (origin === 'null' || !opts.isAllowed(origin)) throw new EndpointNotAllowedError()
    // redirect: 'manual' 覆盖调用方 init——禁跟随是本层不变量，调用方不得放宽。
    const resp = await delegate(input, { ...init, redirect: 'manual' })
    if (isRedirectResponse(resp)) {
      throw new EndpointNotAllowedError('端点重定向被拒绝（redirect 禁随）')
    }
    return resp
  }
}

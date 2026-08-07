// 共享错误词表 —— 错误响应体 → 可读消息（零依赖纯模块）。
//
// 注册/登录（stores/auth.ts）与 api/client.ts 均依赖此处统一解析，避免各自重写。
// 独立成模块而非内联进 auth.ts：client.ts 已 import useAuthStore（auth.ts），
// 若 auth.ts 反向依赖 client.ts 会成环，故错误词表须落在中立、无依赖的模块。
//
// 错误体形态（TS 后端 #312 信封 + HTTP 状态兜底）：
//   {"code":90002,"message":"参数校验失败","data":{...}}        信封：message 即总述
//   {"detail": "未登录或登录已过期"}                              权限/通用
//   {"password": ["这个密码太常见了。"]}                         字段级
//   {"non_field_errors": ["用户名或密码错误"]}                    serializer 级
//   ["msg"] / "msg"                                             裸数组/字符串
//   非对象 / 非 JSON（如 5xx HTML）                              状态码兜底

// 把错误响应体压平成单条可读消息；body 为空或不可解析时用状态码兜底。
// #312 信封优先：#312 全局信封（TS 后端）HTTP 200 + {code,message,data}——message 即人类可读
// 总述，先取它；非信封响应走字段级形状解析（登录/注册错误仍经 HTTP 状态码 + 字段级 body）。
export function extractApiError(status: number, body: unknown): string {
  if (typeof body === 'string' && body.trim()) return body

  if (Array.isArray(body)) {
    const first = body.find((item): item is string => typeof item === 'string')
    if (first) return first
  }

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
    if (typeof obj.code === 'number' && obj.code !== 0 && typeof obj.message === 'string' && obj.message.trim()) {
      return obj.message // #312 信封：message 即总述
    }
    if (typeof obj.detail === 'string' && obj.detail.trim()) return obj.detail
    // 字段级 / non_field_errors：收集所有字符串消息，多条用分号拼接。
    const messages: string[] = []
    for (const value of Object.values(obj)) {
      if (typeof value === 'string') {
        messages.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') messages.push(item)
        }
      }
    }
    if (messages.length) return messages.join('；')
  }

  return `请求失败（${status}）`
}

// #312 全局信封形状：{code:number, message:string, data:T|null}。所有 REST 一律 HTTP 200，
// 错误信号在 body 信封（code!==0）。非信封响应（非 0 code 缺省）返回 null。
export interface EnvelopeBody<T = unknown> {
  readonly code: number
  readonly message: string
  readonly data: T | null
}

// body 信封形状检查（0 信任：非对象/缺 code → 不是信封）。零依赖纯函数——auth store 与
// api client 共用（client.ts import auth.ts 会成环，故落在中立模块）。
export function parseEnvelope(body: unknown): EnvelopeBody<unknown> | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.code !== 'number') return null
  return { code: b.code, message: typeof b.message === 'string' ? b.message : '', data: b.data as unknown }
}

// codex P2：标记「已解析的 API 错误」——区别于 fetch 因后端不可达 reject 抛的原生
// TypeError（"Failed to fetch" / "Load failed"）。视图据此二分:ApiError 逐字透传消息,
// 其余（网络/意外）走模式专属本地化兜底,避免把英文浏览器报错文本直接展示给用户。
export class ApiError extends Error {
  readonly status?: number
  readonly code?: number

  constructor(message: string)
  constructor(status: number, message: string, code?: number)
  constructor(statusOrMessage: number | string, message?: string, code?: number) {
    super(typeof statusOrMessage === 'number' ? (message ?? '') : statusOrMessage)
    this.name = 'ApiError'
    if (typeof statusOrMessage === 'number') {
      this.status = statusOrMessage
      this.code = code ?? -1
    }
    // 维持 instanceof 语义(es5 target 下子类化内建 Error 的常见坑由 tsconfig target 保证)
  }
}

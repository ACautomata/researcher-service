// API client —— JWT 拦截 + 401 刷新重试/跳登录（spec §9.1）。
// 所有需认证请求经 apiFetch/apiJson：自动注入 Authorization Bearer；
// 401 时先用 httpOnly refresh cookie 换新并重试一次，刷新失败才清会话并跳登录（codex R2）。
// #312 全局信封：TS 后端所有 REST 一律 HTTP 200，错误信号在 body 信封（code!==0）——apiJson
// 对非 0 码抛携带 code 的业务 ApiError（HTTP 层 200 不代表成功，apiFetch 的 401 分支看不到错误）。
// 系统码（10001 未认证 / 10004 角色不足等）按 HTTP 401 同语义映射 apiFetch 的刷新链：
// 吊销的 token 在 body 信封里拒绝业务请求，经刷新链换新重试/确认失效跳登录（P0 code review）。
import { useAuthStore } from '@/stores/auth'
import { parseEnvelope } from '@/api/errors'

export class ApiError extends Error {
  status: number
  code: number

  constructor(status: number, message: string, code?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code ?? -1
  }
}

// #312 信封系统码：code 以 1xxxx 开头 = 认证/授权层错误（未认证/角色不足/强制改密）。
// 对 HTTP 200 信封里的这些码，apiFetch 按 HTTP 401 同语义触发刷新重试链（否则吊销的 token
// 只在业务层被拒、刷新链永不触发，用户被留在原地反复看到内部错误文案——P0）。
const ENVELOPE_UNAUTHENTICATED_CODES: ReadonlySet<number> = new Set([10001, 10004, 10005])

function buildHeaders(init: RequestInit, token: string): Headers {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return headers
}

// 响应 body 只可读一次（流语义）——把解析结果缓存到响应对象，envelope 判定与 apiJson 复用同一份，
// 避免对同一响应读两次 json()。
function parseEnvelopeBody(resp: Response): Promise<unknown> {
  const cached = resp as Response & { __envBody?: unknown }
  if ('__envBody' in cached) return Promise.resolve(cached.__envBody ?? null)
  return resp
    .json()
    .then((body) => {
      cached.__envBody = body
      return body
    })
    .catch(() => {
      cached.__envBody = null
      return null
    })
}

async function envelopeCodeOf(resp: Response): Promise<number> {
  const env = parseEnvelope(await parseEnvelopeBody(resp))
  return env ? env.code : -1
}

// 401 刷新链：forceRefresh 换新 token 后重试一次；成功返回新响应。刷新失败（refreshExhausted 确认
// 失效）→ 清会话跳登录；瞬态失败（cookie 仍可能有效）→ 返回 null 抛错，保留会话供上层重试
// （codex R8 F2，避免 auth 服务临时中断即踢人）。
async function refreshAndRetry(path: string, init: RequestInit): Promise<Response | null> {
  const auth = useAuthStore()
  await auth.forceRefresh()
  if (auth.token) {
    const retried = await fetch(path, { ...init, headers: buildHeaders(init, auth.token) })
    const rejected =
      retried.status === 401 ||
      (retried.status === 200 && ENVELOPE_UNAUTHENTICATED_CODES.has(await envelopeCodeOf(retried)))
    if (!rejected) return retried
  }
  if (auth.refreshExhausted) {
    auth.clearSession()
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
  }
  return null
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = useAuthStore()
  const resp = await fetch(path, { ...init, headers: buildHeaders(init, auth.token) })
  // HTTP 200 但信封码是认证/授权层错误（TS 后端 #312 信封：吊销的 token 以 10001 拒业务请求，
  // HTTP 层恒 200）→ 与 HTTP 401 同语义触发刷新重试链。Django 非信封响应不在此列（走 HTTP 状态）。
  if (resp.status === 200 && ENVELOPE_UNAUTHENTICATED_CODES.has(await envelopeCodeOf(resp))) {
    const retried = await refreshAndRetry(path, init)
    if (retried) return retried
    // 刷新确认失效 / 瞬态失败：与 HTTP 401 同语义抛错（清会话/跳登录已在 refreshAndRetry 内完成，
    // 不得把 10001 原响应当成功返回——上层会以为请求成功而读到错误 body）。
    throw new ApiError(401, '未登录或登录已过期')
  }
  if (resp.status !== 401) return resp
  // 服务端已拒绝当前 access；即使本地 exp 尚未到期，也必须强制用 refresh cookie 换新。
  const retried = await refreshAndRetry(path, init)
  if (retried) return retried
  throw new ApiError(401, '未登录或登录已过期')
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await apiFetch(path, init)
  if (!resp.ok) {
    // 非信封路径（Django 旧响应 / 未走信封的 HTTP 语义）：按 HTTP 状态抛错 + detail 透传。
    let detail = `请求失败 (${resp.status})`
    try {
      const body = (await parseEnvelopeBody(resp)) as Record<string, unknown> | null
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      // 无 JSON body，沿用默认 detail
    }
    throw new ApiError(resp.status, detail)
  }
  const body = await parseEnvelopeBody(resp)
  // TS 后端 #312 信封：HTTP 200 但 code!==0 → 业务错误（20040 越权 / 90002 校验 / 10001 未认证…）。
  // 只按 HTTP 状态判错会让 apiFetch 的 401 分支与上层 status 分支（ChatView 20040 等）全成死代码，
  // 用户看到原始内部文案（P0 code review）。非信封（Django 响应）按成功透传兼容。
  const env = parseEnvelope(body)
  if (env && env.code !== 0) throw new ApiError(resp.status, env.message, env.code)
  return body as T
}

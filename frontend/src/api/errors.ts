// 共享错误词表 —— DRF 错误响应体 → 可读消息（零依赖纯模块）。
//
// 注册/登录（stores/auth.ts）与 api/client.ts 均依赖此处统一解析，避免各自重写。
// 独立成模块而非内联进 auth.ts：client.ts 已 import useAuthStore（auth.ts），
// 若 auth.ts 反向依赖 client.ts 会成环，故错误词表须落在中立、无依赖的模块。
//
// DRF 错误体形态（见后端 accounts/serializers.py 校验器实测）：
//   {"password": ["这个密码太常见了。", "密码只包含数字。"]}   字段级
//   {"username": ["该字段必须唯一。"]}                       字段级
//   {"non_field_errors": ["用户名或密码错误"]}               serializer 级
//   {"detail": "未登录或登录已过期"}                          权限/通用
//   ["msg"] / "msg"                                         裸数组/字符串
//   非对象 / 非 JSON（如 5xx HTML）                          状态码兜底

// 把 DRF 错误响应体压平成单条可读消息；body 为空或不可解析时用状态码兜底。
export function extractApiError(status: number, body: unknown): string {
  if (typeof body === 'string' && body.trim()) return body

  if (Array.isArray(body)) {
    const first = body.find((item): item is string => typeof item === 'string')
    if (first) return first
  }

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>
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

// codex P2：标记「已解析的 API 错误」——区别于 fetch 因后端不可达 reject 抛的原生
// TypeError（"Failed to fetch" / "Load failed"）。视图据此二分:ApiError 逐字透传消息,
// 其余（网络/意外）走模式专属本地化兜底,避免把英文浏览器报错文本直接展示给用户。
// issue #202 问题5：全仓唯一定义（api/client.ts re-export 兼容两类导入源），
// instanceof/status 行为不再随导入源漂移。status 可选：鉴权解析路径（auth.ts）无 HTTP
// 状态语义时不填；client.ts 路径带状态供 `e.status === 401` 这类判定。
export class ApiError extends Error {
  status?: number

  // 兼容两种既有调用形态：new ApiError(message)（本文件旧签名）与
  // new ApiError(status, message)（client.ts 旧签名，api/*.ts 多处沿用）。
  constructor(message: string)
  constructor(status: number, message: string)
  constructor(a: string | number, b?: string) {
    super(typeof a === 'string' ? a : (b ?? ''))
    this.name = 'ApiError'
    if (typeof a === 'number') this.status = a
    // 维持 instanceof 语义(es5 target 下子类化内建 Error 的常见坑由 tsconfig target 保证)
  }
}

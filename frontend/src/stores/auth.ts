// auth store —— 认证状态单例（spec §9.1 Pinia store: auth）。
// P0：login 调后端 /api/v1/auth/login 拿 access token；isAuthenticated 驱动路由守卫。
import { defineStore } from 'pinia'

import { extractApiError } from '@/api/errors'

interface LoginResponse {
  access: string
}

// codex P2-1：检查 access token 是否过期（JWT exp claim）
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]))
    return Date.now() >= payload.exp * 1000
  } catch {
    return true
  }
}

// 读取失败响应并抛出含后端真实错误消息的 Error（DRF 校验消息，见 api/errors.ts）。
// 修复 BUG：旧实现只抛写死文案，丢弃 {"password":["这个密码太常见了。"]} 等真实原因，
// 致 LoginView 误显示「用户名可能已存在」——实际是密码被拒。
async function rejectWithApiError(resp: Response): Promise<never> {
  let body: unknown
  try {
    body = await resp.json()
  } catch {
    // 非 JSON（如 5xx HTML 错误页）→ body 留空，extractApiError 走状态码兜底
  }
  throw new Error(extractApiError(resp.status, body))
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: '' as string,
    // codex P2-3：cookie 确认无效（401/403）后置真，避免无意义重试；瞬时失败不置
    refreshExhausted: false as boolean,
  }),
  getters: {
    isAuthenticated: (state): boolean => !!state.token,
  },
  actions: {
    async login(username: string, password: string): Promise<void> {
      const resp = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!resp.ok) {
        return rejectWithApiError(resp)
      }
      const data = (await resp.json()) as LoginResponse
      this.token = data.access
      this.refreshExhausted = false
    },
    // codex round-4 F5（spec §9.2 注册/登录表单）：注册成功后自动登录建立会话
    async register(username: string, password: string): Promise<void> {
      const resp = await fetch('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!resp.ok) {
        return rejectWithApiError(resp)
      }
      await this.login(username, password)
    },
    async forceRefresh(): Promise<void> {
      // 服务端 401 优先于本地 exp 判断：先丢弃被拒 token，再用 httpOnly cookie 换新。
      this.token = ''
      if (this.refreshExhausted) return
      try {
        const resp = await fetch('/api/v1/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        if (resp.ok) {
          const data = (await resp.json()) as { access: string }
          this.token = data.access
        } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
          this.refreshExhausted = true
        }
      } catch {
        // 网络异常：瞬时失败，不标记，下次重试
      }
    },
    // codex P2-1/P2-3/round-4 F1：进入受保护路由前恢复登录态。
    // token 未过期 → 跳过；过期/无 → 先清 token 再用 cookie 换新。
    async hydrate(): Promise<void> {
      if (this.token && !isTokenExpired(this.token)) return
      await this.forceRefresh()
    },
    // codex P2-2/round-4 F2：access 过期先 refresh 换新，再调后端清 httpOnly cookie，最后重置本地。
    async logout(): Promise<void> {
      if (this.token && isTokenExpired(this.token)) {
        await this.hydrate()
      }
      if (this.token) {
        try {
          await fetch('/api/v1/auth/logout', {
            method: 'POST',
            credentials: 'include',
            headers: { Authorization: `Bearer ${this.token}` },
          })
        } catch {
          // 后端不可达也清本地
        }
      }
      this.token = ''
      this.refreshExhausted = true
    },
    // codex R1 :102：API 收到 401 时清 access token（失效/被吊销）。
    // 不标 refreshExhausted——401 可能仅 access 过期，httpOnly refresh cookie 仍有效；
    // 让 hydrate 用 refresh 端点真实结果决定耗尽（避免不必要的强制重登）。
    // 主动 logout 才标 refreshExhausted（用户意图结束会话，cookie 应随之失效）。
    clearSession(): void {
      this.token = ''
    },
  },
})

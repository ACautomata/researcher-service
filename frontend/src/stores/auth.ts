// auth store —— 认证状态单例（spec §9.1 Pinia store: auth）。
// P0：login 调后端 /api/v1/auth/login 拿 access token；isAuthenticated 驱动路由守卫。
import { defineStore } from 'pinia'

interface LoginResponse {
  access: string
  refresh: string
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
        throw new Error('登录失败')
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
        throw new Error('注册失败')
      }
      await this.login(username, password)
    },
    // codex P2-1/P2-3/round-4 F1：进入受保护路由前恢复登录态。
    // token 未过期 → 跳过；过期/无 → 先清 token 再用 cookie 换新；
    // 4xx（含 400 cookie 缺失/过期）→ 标记耗尽；5xx/网络 → 不标记，下次导航重试。
    async hydrate(): Promise<void> {
      if (this.token && !isTokenExpired(this.token)) return
      // 过期/无 token：先清空，避免 refresh 失败时仍带过期 token 被 guard 放行（F1）
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
        // 5xx/其他：瞬时失败，token 已空，refreshExhausted 保持 false，下次导航重试
      } catch {
        // 网络异常：瞬时失败，不标记，下次重试
      }
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

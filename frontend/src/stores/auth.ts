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
    // codex P2-1/P2-3：进入受保护路由前恢复登录态。
    // token 未过期 → 跳过；过期/无 → 用 cookie 换新；明确 401/403 → 标记耗尽；
    // 瞬时失败（5xx/网络）→ 不标记，下次导航重试。
    async hydrate(): Promise<void> {
      if (this.token && !isTokenExpired(this.token)) return
      if (this.refreshExhausted) return
      try {
        const resp = await fetch('/api/v1/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        if (resp.ok) {
          const data = (await resp.json()) as { access: string }
          this.token = data.access
        } else if (resp.status === 401 || resp.status === 403) {
          this.refreshExhausted = true
          this.token = ''
        }
      } catch {
        // 网络异常：瞬时失败，不标记，下次重试
      }
    },
    // codex P2-2：调后端清 httpOnly cookie（JS 无法清），再重置本地
    async logout(): Promise<void> {
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
  },
})

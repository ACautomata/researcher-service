// auth store —— 认证状态单例（spec §9.1 Pinia store: auth）。
// P0：login 调后端 /api/v1/auth/login 拿 access token；isAuthenticated 驱动路由守卫。
import { defineStore } from 'pinia'

interface LoginResponse {
  access: string
  refresh: string
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: '' as string,
    hydrated: false as boolean,
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
      this.hydrated = true
    },
    // codex P2-2：刷新页面后内存 token 丢失，用 httpOnly refresh cookie 换 access 恢复登录态。
    // 幂等：已登录或已尝试过则跳过；失败（无 cookie / 后端不可用）静默，留给守卫重定向。
    async hydrate(): Promise<void> {
      if (this.token || this.hydrated) return
      this.hydrated = true
      try {
        const resp = await fetch('/api/v1/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        if (resp.ok) {
          const data = (await resp.json()) as { access: string }
          this.token = data.access
        }
      } catch {
        // 无 cookie / 网络不可用：保持未认证
      }
    },
    logout(): void {
      this.token = ''
      this.hydrated = false
    },
  },
})

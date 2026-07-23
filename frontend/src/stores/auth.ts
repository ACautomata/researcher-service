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
    },
    logout(): void {
      this.token = ''
    },
  },
})

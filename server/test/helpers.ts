import type { SuperTest, Test } from 'supertest'
import type { PrismaClient, User } from '../src/generated/prisma/client'
import { hashPassword } from '../src/auth/password'

// 测试身份种子：直接写库（绕过 bootstrap/HTTP），拿已知密码登录。
export async function seedAdmin(
  prisma: PrismaClient,
  username = 'admin1',
  password = 'pw-admin1-secure',
  overrides: Partial<User> = {},
): Promise<User> {
  return prisma.user.create({
    data: {
      username,
      passwordHash: await hashPassword(password),
      role: 'admin',
      isActive: true,
      mustChangePassword: false,
      maxContainers: 3,
      ...overrides,
    },
  })
}

export async function seedUser(
  prisma: PrismaClient,
  username = 'user1',
  password = 'pw-user1-secure',
  overrides: Partial<User> = {},
): Promise<User> {
  return prisma.user.create({
    data: {
      username,
      passwordHash: await hashPassword(password),
      role: 'user',
      isActive: true,
      mustChangePassword: false,
      maxContainers: 3,
      ...overrides,
    },
  })
}

export interface LoginResult {
  access?: string
  status: number
  body: { code: number; message: string; data: { access?: string; mustChangePassword?: boolean } | null }
  setCookie?: string[] // 原始 Set-Cookie（含属性）
  refreshCookie?: string // 完整 "refresh_token=…" 串，便于手动重放
}

export async function login(
  req: SuperTest<Test>,
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await req.post('/api/v1/auth/login').send({ username, password })
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined
  return {
    access: res.body?.data?.access,
    status: res.status,
    body: res.body,
    setCookie,
    refreshCookie: parseRefreshCookie(setCookie),
  }
}

export function bearer(token: string | undefined): { Authorization: string } {
  if (!token) throw new Error('no access token')
  return { Authorization: `Bearer ${token}` }
}

export function parseRefreshCookie(setCookie: string[] | undefined): string | undefined {
  if (!setCookie) return undefined
  for (const c of setCookie) {
    const m = /^refresh_token=[^;]+/.exec(c)
    if (m) return m[0]
  }
  return undefined
}

// 断言 Set-Cookie 含规格四属性（HttpOnly/Secure 视环境/SameSite=Lax/Path=/api/v1/auth）
export function assertRefreshCookieShape(setCookie: string[] | undefined): void {
  if (!setCookie) throw new Error('missing Set-Cookie')
  const c = setCookie.find((x) => x.startsWith('refresh_token=')) ?? ''
  if (!c) throw new Error('missing refresh_token cookie')
  void expectShape(c)
}

function expectShape(c: string): void {
  if (!/HttpOnly/i.test(c)) throw new Error('cookie not HttpOnly')
  if (!/SameSite=Lax/i.test(c)) throw new Error('cookie not SameSite=Lax')
  if (!/Path=\/api\/v1\/auth/i.test(c)) throw new Error('cookie Path wrong')
  // Secure 在 test 环境（NODE_ENV!=='production'）关闭，故此处不强制断言 Secure
}

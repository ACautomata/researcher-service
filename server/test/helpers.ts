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
  const c = findSetCookie(setCookie, 'refresh_token')
  return c ? c.split(';')[0] : undefined
}

// 按名取整条 Set-Cookie 头（含属性段，cookie 形状断言用）；未命中返回 undefined。
export function findSetCookie(setCookie: string[] | undefined, name: string): string | undefined {
  return setCookie?.find((c) => c.startsWith(`${name}=`))
}

// 按名取 "name=value" 段（拼请求 Cookie 头用）；未命中抛错（测试前置条件失败）。
export function requireSetCookieValue(setCookie: string[] | undefined, name: string): string {
  const c = findSetCookie(setCookie, name)
  if (!c) throw new Error(`missing ${name} cookie`)
  return c.split(';')[0]
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

// --- SSE 帧解析（issue #773，events 域测试共用） ---
// 帧格式准据 #726：一块 = id:/event:/data: 三行。id 保持字符串原样（eventsSse 用），
// 需要数值的调用方自行 Number()。:ping 等注释块无 id/event 行，frameOfEvent 按 event
// 行过滤天然跳过它们。
export interface SseFrame {
  id: string
  event: string
  data: Record<string, unknown>
}

export function parseSseFrame(block: string): SseFrame {
  return {
    id: /^id: (.+)$/m.exec(block)![1],
    event: /^event: (.+)$/m.exec(block)![1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)![1]),
  }
}

// 累加文本的首个帧块（调用方保证首块非注释块——如 readUntil 谓词先命中 stream.opened）。
export function firstFrameOf(acc: string): SseFrame {
  return parseSseFrame(acc.split('\n\n')[0])
}

// 从累加文本解析出目标事件的帧（跳过 :ping 等无 event 行的注释块）。
export function frameOfEvent(acc: string, event: string): SseFrame {
  const block = acc.split('\n\n').find((b) => b.includes(`event: ${event}`))
  if (!block) throw new Error(`未见事件帧 ${event}：${JSON.stringify(acc)}`)
  return parseSseFrame(block)
}

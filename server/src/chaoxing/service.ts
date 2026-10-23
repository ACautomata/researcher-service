import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma/client'
import { encryptCredential, decryptCredential } from '../models/cipher'
import { fail } from '../envelope'
import type { ChaoxingOptions } from './options'
import { ChaoxingHttpError, ChaoxingMcpError, ChaoxingConfigError, tokenSchema, type ChaoxingQueryTarget, type ChaoxingRemote, type ChaoxingToken } from './remote'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const unavailable = () => fail(90001, '超星尚未配置，请联系管理员')
const rebind = () => fail(90003, '超星授权已失效，请在账号设置重新绑定')

export class ChaoxingService {
  private readonly refreshing = new Map<string, Promise<string>>()
  constructor(private readonly prisma: PrismaClient, private readonly options?: ChaoxingOptions, private readonly remote?: ChaoxingRemote) {}

  async status(ownerId: string) {
    const row = await this.prisma.chaoxingBinding.findUnique({ where: { ownerId } })
    return { configured: !!this.options && !!this.remote, connected: !!row?.tokenCipher, expiresAt: row?.expiresAt?.toISOString() ?? null }
  }
  async authorize(ownerId: string) {
    if (!this.options || !this.remote) throw unavailable()
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const generation = randomUUID()
    await this.prisma.$transaction(async tx => {
      await tx.chaoxingAuthorization.deleteMany({ where: { OR: [{ ownerId }, { expiresAt: { lte: new Date() } }] } })
      // Preserve a working binding while reauthorization is pending; change its generation to fence old requests.
      await tx.chaoxingBinding.upsert({ where: { ownerId }, create: { ownerId, generation }, update: { generation } })
      await tx.chaoxingAuthorization.create({ data: { stateHash: hash(state), ownerId, generation, verifierCipher: encryptCredential(verifier, this.options!.credentialSecret), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    })
    const url = new URL('https://api.chaoxing.com/auth/oauth2/authorize')
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.options.clientId, redirect_uri: this.options.redirectUri, scope: 'statistic:studyai:read', state }).toString()
    if (this.options.pkce !== false) {
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
      url.searchParams.set('code_challenge_method', 'S256')
    }
    return { url: url.toString() }
  }
  async callback(state: string, code?: string): Promise<boolean> {
    if (!this.options || !this.remote) return false
    const row = await this.prisma.chaoxingAuthorization.findUnique({ where: { stateHash: hash(state) } })
    if (!row) return false
    const consumed = await this.prisma.chaoxingAuthorization.deleteMany({ where: { stateHash: row.stateHash } })
    if (!consumed.count || row.expiresAt <= new Date() || !code) return false
    const user = await this.prisma.user.findUnique({ where: { id: row.ownerId } })
    if (!user?.isActive || user.mustChangePassword) return false
    try {
      const tokens = tokenSchema.parse(await this.remote.exchange(code, decryptCredential(row.verifierCipher, this.options.credentialSecret)))
      const result = await this.prisma.chaoxingBinding.updateMany({ where: { ownerId: row.ownerId, generation: row.generation }, data: { ...this.tokenData(tokens), generation: randomUUID() } })
      return result.count === 1
    } catch { return false }
  }
  private tokenData(tokens: ChaoxingToken) {
    return { tokenCipher: encryptCredential(JSON.stringify(tokens), this.options!.credentialSecret), expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null }
  }
  async unlink(ownerId: string) {
    await this.prisma.$transaction(async tx => {
      await tx.chaoxingAuthorization.deleteMany({ where: { ownerId } })
      await tx.session.updateMany({ where: { ownerId }, data: { learningCourseId: null } })
      await tx.chaoxingBinding.updateMany({ where: { ownerId }, data: { tokenCipher: null, expiresAt: null, generation: randomUUID() } })
    })
  }
  private async token(ownerId: string): Promise<string> {
    if (!this.options || !this.remote) throw unavailable()
    const row = await this.prisma.chaoxingBinding.findUnique({ where: { ownerId } })
    if (!row?.tokenCipher) throw rebind()
    let tokens: ChaoxingToken
    try { tokens = tokenSchema.parse(JSON.parse(decryptCredential(row.tokenCipher, this.options.credentialSecret))) }
    catch { await this.invalidate(ownerId, row.generation, row.tokenCipher); throw rebind() }
    if (!row.expiresAt || row.expiresAt.getTime() > Date.now() + 30_000) return tokens.access_token
    if (!tokens.refresh_token) { await this.invalidate(ownerId, row.generation, row.tokenCipher); throw rebind() }
    const key = `${ownerId}:${row.generation}`
    const existing = this.refreshing.get(key)
    if (existing) return existing
    const operation = (async () => {
      try {
        const next = tokenSchema.parse(await this.remote!.refresh(tokens.refresh_token!))
        next.refresh_token ??= tokens.refresh_token
        const written = await this.prisma.chaoxingBinding.updateMany({ where: { ownerId, generation: row.generation, tokenCipher: row.tokenCipher }, data: this.tokenData(next) })
        if (!written.count) throw rebind()
        return next.access_token
      } catch { await this.invalidate(ownerId, row.generation, row.tokenCipher); throw rebind() }
      finally { this.refreshing.delete(key) }
    })()
    this.refreshing.set(key, operation)
    return operation
  }
  private async invalidate(ownerId: string, generation: string, tokenCipher?: string | null) {
    await this.prisma.chaoxingBinding.updateMany({ where: { ownerId, generation, ...(tokenCipher ? { tokenCipher } : {}) }, data: { tokenCipher: null, expiresAt: null, generation: randomUUID() } })
  }
  private async authorized<T>(ownerId: string, operation: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token(ownerId)
    const binding = await this.prisma.chaoxingBinding.findUnique({ where: { ownerId } })
    if (!binding?.tokenCipher) throw rebind()
    const material = tokenSchema.parse(JSON.parse(decryptCredential(binding.tokenCipher, this.options!.credentialSecret)))
    if (material.access_token !== token) throw rebind()
    try {
      const result = await operation(token)
      const current = await this.prisma.chaoxingBinding.findFirst({ where: { ownerId, generation: binding.generation, tokenCipher: { not: null } } })
      if (!current) throw rebind()
      // Remote error/schema text is untrusted: never echo supplied credentials back to browser/model.
      const secrets = [token, material.refresh_token, this.options!.clientSecret].filter((v): v is string => !!v)
      return JSON.parse(JSON.stringify(result, (_key, value: unknown) => typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value) : value)) as T
    } catch (error) {
      if (error instanceof ChaoxingHttpError) {
        if (error.httpStatus === 401) await this.invalidate(ownerId, binding.generation, binding.tokenCipher)
        throw fail(90003, error.message, { httpOperation: [error.operation], ...(error.httpStatus ? { httpStatus: [String(error.httpStatus)] } : {}) })
      }
      if (error instanceof ChaoxingMcpError) {
        if (error.httpStatus === 401) await this.invalidate(ownerId, binding.generation, binding.tokenCipher)
        throw fail(90003, error.message, { mcpStage: [error.stage], ...(error.httpStatus ? { httpStatus: [String(error.httpStatus)] } : {}), ...(error.rejectionReason ? { mcpRejectionReason: [error.rejectionReason] } : {}) })
      }
      if (error instanceof ChaoxingConfigError) throw fail(90003, error.message)
      const authError = error as { code?: unknown; name?: unknown }
      if (authError?.code === 401 || authError?.name === 'UnauthorizedError') await this.invalidate(ownerId, binding.generation, binding.tokenCipher)
      throw fail(90003, '超星调用不可用，请检查绑定状态、课程权限和工具映射后重试')
    }
  }
  async courses(ownerId: string) {
    if (!this.remote?.courses) throw fail(90003, '课程列表能力尚未配置')
    return this.authorized(ownerId, token => this.remote!.courses!(token))
  }
  private async session(ownerId: string, sessionId: string) {
    const row = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId, archivedAt: null, isTeammate: false } })
    if (!row) throw fail(50002)
    return row
  }
  async scope(ownerId: string, sessionId: string) {
    return { courseId: (await this.session(ownerId, sessionId)).learningCourseId }
  }
  async setScope(ownerId: string, sessionId: string, courseId: string | null) {
    await this.session(ownerId, sessionId)
    if (courseId && !(await this.courses(ownerId)).rows.some(c => c.id === courseId)) throw fail(90003, '课程无权限或不在已取得的课程列表中')
    const changed = await this.prisma.session.updateMany({ where: { id: sessionId, ownerId, archivedAt: null, isTeammate: false }, data: { learningCourseId: courseId } })
    if (!changed.count) throw fail(50002)
    return { courseId }
  }
  async inspect(ownerId: string) {
    return this.authorized(ownerId, token => this.remote!.inspect(token))
  }
  async learn(ownerId: string, topic: string, courseId?: string, signal?: AbortSignal, target: ChaoxingQueryTarget = 'all', classId?: string) {
    signal?.throwIfAborted()
    return this.authorized(ownerId, token => this.remote!.learn(token, topic, courseId, signal, target, classId))
  }
}

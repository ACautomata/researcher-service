import { Router } from 'express'
import { z } from 'zod'
import type { PrismaClient } from '../generated/prisma/client'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import { chaoxingAuthorizeSchema, chaoxingLearnSchema, chaoxingScopeSchema } from '../validation/schemas'
import { ok } from '../envelope'
import type { ChaoxingOptions } from './options'
import type { ChaoxingRemote } from './remote'
import { ChaoxingService } from './service'

export interface ChaoxingDeps { options?: ChaoxingOptions; remote?: ChaoxingRemote; mcpRemote?: Pick<ChaoxingRemote, 'inspect'>; service?: ChaoxingService }
const callbackSchema = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(4096).optional(), error: z.string().max(1000).optional() })
export function createChaoxingRouter(prisma: PrismaClient, deps: ChaoxingDeps = {}) {
  const router = Router()
  const service = deps.service ?? new ChaoxingService(prisma, deps.options, deps.remote, deps.mcpRemote)
  const cookie = { httpOnly: true, sameSite: 'lax' as const, secure: deps.options ? new URL(deps.options.redirectUri).protocol === 'https:' : process.env.NODE_ENV === 'production', path: '/api/v1/integrations/chaoxing' }
  router.get('/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const query = callbackSchema.safeParse(req.query)
    const sameBrowser = query.success && typeof req.cookies?.chaoxing_oauth === 'string' && req.cookies.chaoxing_oauth === query.data.state
    if (sameBrowser) res.clearCookie('chaoxing_oauth', cookie)
    const success = query.success && sameBrowser && await service.callback(query.data.state, query.data.error ? undefined : query.data.code)
    res.redirect(303, `/settings?chaoxing=${success ? 'connected' : 'failed'}`)
  })
  router.use(requireAuth, mustChangePasswordGate)
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.get('/', async (req, res) => ok(res, await service.status(req.user!.id)))
  router.post('/authorize', validateBody(chaoxingAuthorizeSchema), async (req, res) => {
    const result = await service.authorize(req.user!.id)
    const authorization = new URL(result.url)
    const secure = new URL(authorization.searchParams.get('redirect_uri')!).protocol === 'https:'
    res.cookie('chaoxing_oauth', authorization.searchParams.get('state'), { ...cookie, secure, maxAge: 10 * 60_000 })
    ok(res, result)
  })
  router.delete('/', validateBody(chaoxingAuthorizeSchema), async (req, res) => { await service.unlink(req.user!.id); ok(res, null) })
  router.get('/courses', async (req, res) => ok(res, await service.courses(req.user!.id)))
  router.get('/sessions/:id/scope', async (req, res) => ok(res, await service.scope(req.user!.id, String(req.params.id))))
  router.put('/sessions/:id/scope', validateBody(chaoxingScopeSchema), async (req, res) => {
    const body: z.infer<typeof chaoxingScopeSchema> = req.body
    ok(res, await service.setScope(req.user!.id, String(req.params.id), body.courseId))
  })
  router.get('/mcp-capabilities', async (req, res) => ok(res, await service.inspectMcp(req.user!.id)))
  router.get('/capabilities', async (req, res) => ok(res, await service.inspect(req.user!.id)))
  router.post('/learn', validateBody(chaoxingLearnSchema), async (req, res) => {
    const body: z.infer<typeof chaoxingLearnSchema> = req.body
    ok(res, await service.learn(req.user!.id, body.topic, body.courseId, undefined, body.target, body.classId))
  })
  return router
}

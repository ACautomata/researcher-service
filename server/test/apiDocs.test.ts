import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import {
  containerCreateSchema,
  loginSchema,
  modelProviderWriteSchema,
  passwordChangeSchema,
  userCreateSchema,
  userPatchSchema,
} from '../src/validation/schemas'

// #761：OpenAPI/Swagger 文档面（/api/docs）。
// 覆盖：admin 门控（#758 Q14）· env 开关装配语义（deps 注入即挂载）· zod 单一来源零漂移
//（文档请求体 schema 键集 === 运行时校验 schema 键集）· 码段表反射自 codes.ts · 字节例外端点。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any // openapi.json 的宽松断言面（结构由 zod-to-openapi 产出）
type ZodShapeLike = z.ZodObject<z.ZodRawShape>

// OpenAPI required 语义：optional / 有 default 的字段不进 required（对齐 zod-to-openapi 产出）。
function requiredKeys(schema: ZodShapeLike): string[] {
  return Object.entries(schema.shape)
    .filter(([, v]) => !(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault))
    .map(([k]) => k)
    .sort()
}

describe('OpenAPI 文档面（#761）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp({ docs: {} }) // flag 开（装配形态对齐 figures：{} = 已启用）
    await seedAdmin(ctx.prisma)
    await seedUser(ctx.prisma, 'plainuser', 'pw-plain-secure')
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  async function adminDoc(): Promise<Doc> {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request.get('/api/docs/openapi.json').set(bearer(admin.access))
    expect(res.status).toBe(200)
    return res.body as Doc
  }

  it('admin GET /api/docs → Swagger UI HTML（裸路径 301 → /api/docs/，跟随后 200）', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const bare = await ctx.request.get('/api/docs').set(bearer(admin.access))
    expect(bare.status).toBe(301) // swagger-ui-express 标准行为：裸路径 301 到尾斜杠
    expect(bare.headers.location).toMatch(/\/api\/docs\//)
    const res = await ctx.request.get('/api/docs').set(bearer(admin.access)).redirects(1)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toContain('swagger-ui')
  })

  it('admin GET /api/docs/openapi.json → OpenAPI 3.1 文档（关键端点全集）', async () => {
    const doc = await adminDoc()
    expect(doc.openapi).toMatch(/^3\.1\./)
    expect(doc.info.title).toContain('控制面')
    expect(doc.info.description).toContain('#312')
    for (const p of [
      '/api/health',
      '/api/v1/auth/login',
      '/api/v1/auth/token/refresh',
      '/api/v1/auth/me',
      '/api/v1/auth/register',
      '/api/v1/users',
      '/api/v1/users/{id}/reset-password',
      '/api/v1/containers',
      '/api/v1/containers/{name}/wiki/tree',
      '/api/v1/containers/{name}/wiki/page',
      '/api/v1/models/providers',
      '/api/v1/models/providers/{pid}',
      '/api/v1/containers/{name}/files',
      '/api/v1/figures',
      '/api/v1/figures/{id}/png',
      '/api/v1/figures/{id}/svg',
      '/api/v1/trace-logs',
    ]) {
      expect(doc.paths, `缺少端点 ${p}`).toHaveProperty(p)
    }
    // T0 #801 退役端点不得再出现在文档面
    for (const p of [
      '/api/v1/containers/{name}/upgrade',
      '/api/v1/containers/{name}/bootstrap-token',
      '/api/v1/containers/{name}/pairing/approve/{requestId}',
      '/api/v1/containers/{name}/files/raw',
      // #857：models 归属门改挂 ownerId，容器前缀路径下线
      '/api/v1/containers/{name}/models/providers',
      '/api/v1/containers/{name}/models/providers/{pid}',
    ]) {
      expect(doc.paths, `退役端点残留 ${p}`).not.toHaveProperty(p)
    }
  })

  it('swagger-ui 静态资源（Express 5 兼容面）：admin GET swagger-ui-init.js → 200 内嵌 spec', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    const res = await ctx.request.get('/api/docs/swagger-ui-init.js').set(bearer(admin.access))
    expect(res.status).toBe(200)
    expect(res.text).toContain('openapi')
    expect(res.text).toContain('researcher-service')
  })

  it('门控：无 token → 10001（UI/JSON/静态资源同门）', async () => {
    for (const p of ['/api/docs', '/api/docs/openapi.json', '/api/docs/swagger-ui.css']) {
      const res = await ctx.request.get(p)
      expect(res.body.code, p).toBe(10001)
    }
  })

  it('门控：非 admin → 10004（requireAdmin）', async () => {
    const u = await login(ctx.request, 'plainuser', 'pw-plain-secure')
    const res = await ctx.request.get('/api/docs/openapi.json').set(bearer(u.access))
    expect(res.body.code).toBe(10004)
  })

  it('安全定义：Bearer JWT；admin 端点带安全要求', async () => {
    const doc = await adminDoc()
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
    expect(doc.paths['/api/v1/users'].get.security).toEqual([{ bearerAuth: [] }])
    expect(doc.paths['/api/v1/auth/login'].post.security).toBeUndefined()
  })

  // 零漂移核心断言：文档请求体 schema 与运行时校验 zod schema 同源同形（键集 + required 一致）。
  it('零漂移：文档请求体 schema 键集 === zod 单一来源 shape 键集', async () => {
    const doc = await adminDoc()
    const cases: Array<[string, string, ZodShapeLike]> = [
      ['login', '/api/v1/auth/login', loginSchema],
      ['passwordChange', '/api/v1/auth/password/change', passwordChangeSchema],
      ['userCreate', '/api/v1/users', userCreateSchema],
      ['userPatch', '/api/v1/users/{id}', userPatchSchema],
      ['containerCreate', '/api/v1/containers', containerCreateSchema],
      ['modelProviderWrite', '/api/v1/models/providers', modelProviderWriteSchema],
    ]
    for (const [label, path, schema] of cases) {
      const methods = doc.paths[path]
      expect(methods, path).toBeTruthy()
      const op = methods.post ?? methods.put ?? methods.patch
      const bodySchema = op.requestBody.content['application/json'].schema
      expect(Object.keys(bodySchema.properties).sort(), `${label} properties`).toEqual(
        Object.keys(schema.shape).sort(),
      )
      expect((bodySchema.required ?? []).slice().sort(), `${label} required`).toEqual(requiredKeys(schema))
    }
  })

  it('码段表反射自 codes.ts（info.description 含运行时码值与常量名）', async () => {
    const doc = await adminDoc()
    for (const token of ['10001', 'ROUTE_NOT_FOUND', '90002', '70043', '60042']) {
      expect(doc.info.description).toContain(token)
    }
  })

  it('字节例外：figures/png 与 figures/svg 成功响应声明二进制（豁免 #312 信封；files/raw 已随 T0 #801 关闭）', async () => {
    const doc = await adminDoc()
    const png = doc.paths['/api/v1/figures/{id}/png'].get.responses['200']
    expect(JSON.stringify(png.content)).toContain('binary')
    const svg = doc.paths['/api/v1/figures/{id}/svg'].get.responses['200']
    expect(JSON.stringify(svg.content)).toContain('binary')
    // 错误面仍走信封（default 响应引用 ErrorEnvelope 形状）
    expect(JSON.stringify(doc.paths['/api/v1/figures/{id}/png'].get.responses.default)).toContain('code')
  })

  it('query 参数：wiki page path 与 figures svg download 进文档', async () => {
    const doc = await adminDoc()
    const pageParams = doc.paths['/api/v1/containers/{name}/wiki/page'].get.parameters
    expect(pageParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'path', in: 'query', required: true })]),
    )
    const svgParams = doc.paths['/api/v1/figures/{id}/svg'].get.parameters
    expect(svgParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'download', in: 'query' })]),
    )
  })

  it('admin 端点注明专属门控语义', async () => {
    const doc = await adminDoc()
    expect(doc.paths['/api/v1/users'].get.description).toContain('admin')
    expect(doc.paths['/api/v1/trace-logs'].get.description).toContain('admin')
  })
})

describe('OpenAPI 文档面 flag 关（#761）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    ctx = await setupTestApp() // 不注入 docs deps = flag 关（装配层语义）
    await seedAdmin(ctx.prisma)
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('flag 关：/api/docs 整树未挂载 → 90005（notFound 信封）', async () => {
    const admin = await login(ctx.request, 'admin1', 'pw-admin1-secure')
    for (const p of ['/api/docs', '/api/docs/openapi.json']) {
      const res = await ctx.request.get(p).set(bearer(admin.access))
      expect(res.body.code, p).toBe(90005)
    }
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setupTestApp, type TestContext } from './setup'
import { buildOpenApiDocument } from '../src/openapi/document'

// #761 覆盖守卫：实际挂载端点全集（Express 5 路由栈反射）=== spec 登记全集。
// 双向断言——漏登记（端点先行，如 #778 sessions 域曾整域漏登）与幻影登记（文档先行/
// 端点已退役未清册，如 T0 #801 / #858 先例）同红。守卫依赖 side-effect import：
// buildOpenApiDocument → document.ts → import './paths' 完成 registry 登记。
//
// 排除面（有注释的既定决策，扩排除须过 review）：
// - /api/docs 整树：文档面自引用，不进文档；
// - GET /api/v1/events：SSE 流式端点语义超出请求/响应文档模型（document.ts description 明文）。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayer = any

// 挂载序镜像（app.ts createApp 条件装配全开的 router 层顺序；与 prodDeploy 部署契约文本断言
// 同纪律——app.ts 增删/调序挂载 → 本表失同步 → 守卫红）。Express 5（router 2.x）把挂载路径
// 编译进 matcher 闭包、layer 上不保留，无法纯反射取前缀；端点 method+path 仍全部来自真实栈。
const MOUNTS_IN_ORDER = [
  '/api',
  '/api/v1/auth',
  '/api/v1/users',
  '/api/v1/trace-logs',
  '/api/v1/approval-logs',
  '/api/v1/file-overwrite-logs',
  '/api/v1/usage',
  '/api/v1/wiki',
  '/api/v1/models',
  '/api/v1/containers',
  '/api/v1/figures',
  '/api/docs',
  '/api/v1/events',
  '/api/v1/sessions',
  '/api/v1', // attachments（与 sessions 共根，序在 sessions 后——app.ts 注释既定）
  '/api/v1/plugins',
]

// 路由栈展开：route 层收 method+path；子 router 层按 MOUNTS_IN_ORDER 序配挂载前缀下钻。
// 依赖 router 2.x 的 layer.shape（同进程 tsx 运行期，破坏即测试红）。
function collectRoutes(app: AnyLayer): string[] {
  const out: string[] = []
  const walk = (stack: AnyLayer[], prefix: string): void => {
    let mountIdx = 0
    for (const layer of stack) {
      if (layer.route) {
        const p = (prefix + String(layer.route.path)).replace(/\/$/, '') // 根路由 '/' 拼前缀出尾斜杠，归一
        for (const m of Object.keys(layer.route.methods ?? {})) {
          if (layer.route.methods[m]) out.push(`${m.toUpperCase()} ${p}`)
        }
      } else if (layer.name === 'router' && Array.isArray(layer.handle?.stack)) {
        const mount = MOUNTS_IN_ORDER[mountIdx++]
        if (mount === undefined) {
          throw new Error('守卫失同步：app.ts 挂载数超过 MOUNTS_IN_ORDER（表需跟进 app.ts 变更）')
        }
        walk(layer.handle.stack, prefix + mount)
      }
    }
  }
  walk(app.router.stack, '')
  return out
}

// Express ':param' → OpenAPI '{param}'
const toOpenApiPath = (p: string): string => p.replace(/:([A-Za-z]+)/g, '{$1}')

const EXCLUDED = new Set(['GET /api/v1/events'])

describe('OpenAPI 覆盖守卫（#761）', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // 全量装配（对齐 server.ts 注入面；服务面只走桩——守卫只看路由树形状，不发请求）。
    ctx = await setupTestApp({
      docs: {},
      files: { archive: {} as never },
      events: { hub: {} as never },
      sessions: { service: {} as never },
      attachments: { service: {} as never, tmpRoot: mkdtempSync(`${tmpdir()}/att-coverage-`) },
      plugins: { manifests: [], prisma: {} as never },
    })
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('实际挂载端点 === spec 登记端点（漏登/幻影双向断言）', () => {
    const actual = new Set(
      collectRoutes(ctx.app as never)
        .filter((r) => !r.startsWith('GET /api/docs'))
        .filter((r) => !EXCLUDED.has(r))
        .map((r) => {
          const sp = r.indexOf(' ')
          return `${r.slice(0, sp)} ${toOpenApiPath(r.slice(sp + 1))}`
        }),
    )
    const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, unknown>> }
    const spec = new Set<string>()
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const m of Object.keys(ops)) spec.add(`${m.toUpperCase()} ${p}`)
    }
    const missing = [...actual].filter((r) => !spec.has(r)).sort()
    const phantom = [...spec].filter((r) => !actual.has(r)).sort()
    expect({ missing, phantom }).toEqual({ missing: [], phantom: [] })
  })
})

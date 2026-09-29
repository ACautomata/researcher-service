// OpenAPI/Swagger 文档面路由（#761 · wayfinder #750 票 761）——挂 /api/docs。
//
// 门控（#758 Q14 决策）：requireAuth + requireAdmin —— admin 角色可见；env 开关（API_DOCS_ENABLED）
// 在装配层 server.ts 消费（flag 关 → 不注入 docs deps → 本路由不挂载 → /api/docs 整树 90005，
// 对齐 figures 条件挂载先例：app.ts 只认 deps 注入、不读 config）。
//
// Express 5 兼容核对（任务首步结论）：swagger-ui-express@^5.0.1 peer 显式支持 Express 5；
// zod-to-openapi 为纯文档生成器、与框架无交互面。主库方案成立，未启用备选 @samchungy/zod-openapi。

import { Router, type Request, type Response } from 'express'
import swaggerUi from 'swagger-ui-express'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { buildOpenApiDocument } from './document'

export interface DocsRouterDeps {
  // 无注入项：文档为启动期静态构建（zod → JSON Schema），路由只依赖认证身份。
  // 存在即装配（对齐 figures 条件挂载先例）；flag 门在装配层消费。
}

export function createDocsRouter(_deps: DocsRouterDeps): Router {
  const router = Router()
  const doc = buildOpenApiDocument()

  // admin 门控先于一切（UI 页/静态资源/openapi.json 全部要求 admin）。
  router.use(requireAuth, requireAdmin)

  // 原始文档 JSON（客户端/CI 消费面；与 UI 同源同一份静态对象）。
  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(doc)
  })

  // Swagger UI（swagger-ui-express serve = swagger-ui-dist 静态资源中间件数组）。
  router.use('/', swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: '控制面 API 文档' }))
  return router
}

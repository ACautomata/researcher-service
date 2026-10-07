import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import type { PrismaClient } from './generated/prisma/client'
import { healthRouter } from './routes/health'
import { createAuthRouter } from './routes/auth'
import { createUsersRouter } from './routes/users'
import { traceLogsRouter } from './routes/traceLogs'
import { approvalLogsRouter, fileOverwriteLogsRouter } from './runner/auditRoutes'
import { usageRouter } from './runner/usageRoutes'
import { createContainersRouter } from './routes/containers'
import { createWikiRouter, type WikiRouterDeps } from './wiki/routes'
import { createModelsRouter, type ModelsRouterDeps } from './models/routes'
import {
  createProviderEndpointsRouter,
  type ProviderEndpointsRouterDeps,
} from './models/endpoints'
import { createFilesRouter, type FilesRouterDeps } from './files/routes'
import { createFiguresRouter } from './figures/routes'
import { createDocsRouter, type DocsRouterDeps } from './openapi/routes'
import { createEventsRouter, type EventsRouterDeps } from './events/routes'
import { createSessionsRouter, type SessionsRouterDeps } from './sessions/routes'
import { createAttachmentsRouter, type AttachmentsRouterDeps } from './attachments/routes'
import { createPluginsRouter, type PluginsRouterDeps } from './plugins/routes'
import { Orchestrator } from './containers/orchestrator'
import { FleetDeps } from './containers/deps'
import type { FleetConfig } from './containers/values'
import { envelopeErrorHandler, notFound } from './middleware/errorHandler'
import './types' // Express Request 增强（req.user / req.prisma）

export interface AppDeps {
  prisma: PrismaClient
  // 容器编排接缝（#334）：测试注入假 runtime + inline queue + tmp fleet config；
  // 生产由 server.ts 装真 DockerRuntime + BullMQ 队列。缺省 = 无编排（containers 路由不挂）。
  orchestrator?: Orchestrator
  // wiki 接缝（#335）：compile 触发等。缺省 = no-op（无编排）。
  wiki?: WikiRouterDeps
  // models 接缝（#336；#775 写盘链退役后仅剩白名单校验注入缝——lookup 测试注 fake 免真 DNS，
  // allowPrivate 覆盖 env 开关）。路由无条件挂载（零外部资源依赖）。
  models?: ModelsRouterDeps
  // provider_endpoints 接缝（#775，731 §3.1）：端点白名单 admin 管理面，同款注入缝。
  providerEndpoints?: ProviderEndpointsRouterDeps
  // files（#589 · T0 #801 只读化）：FileArchive Port 必填（缺 archive 属装配错误——静默禁用
  // 不安全），由下方条件挂载（models/files 条件挂载先例）。
  files?: FilesRouterDeps
  // figures 读面（#791 · #744 §11.3 资产常驻）：无 flag 门（历史图卡渲染不受插件启用位影响），
  // 无条件挂载——只依赖 req.prisma + 认证身份（对齐 models 无条件挂载先例）。
  docs?: DocsRouterDeps
  // events 接缝（#773，#747 C 节）：SSE 事件流（GET /api/v1/events）。注入即挂载——
  // 生产 server.ts 装配 StreamHub 单例；缺省 = 不挂（/api/v1/events → 90005，对齐
  // figures/docs 条件挂载先例）。panel_stream cookie 颁发在 auth 路由（login/refresh），
  // 不依赖本 deps。
  events?: EventsRouterDeps
  // sessions 接缝（#778，#747 C 节会话 REST 全件）：会话扁平挂用户 + 发消息幂等 + abort/
  // resume + 历史投影。注入即挂载（条件挂载先例）——生产 server.ts 装配 SessionService
  //（持 runner 命令面 + hub + dispatch）；缺省 = 不挂（/api/v1/sessions → 90005）。
  sessions?: SessionsRouterDeps
  // attachments 接缝（#780，#747 G 节附件 D1–D6）：上传/下载 REST（挂 /api/v1，
  // POST /sessions/:id/attachments + GET /attachments/:id/download）。注入即挂载（条件挂载
  // 先例）——生产 server.ts 装配 AttachmentsService（临时区 + files 沙箱读通道）；缺省 = 不挂。
  attachments?: AttachmentsRouterDeps
  // plugins 接缝（#788，#752 §4.3 R8）：目录清单 + per-user 启用位（8xxxx 段）。注入即挂载
  //（条件挂载先例）——生产 server.ts 注入编译期目录 PLUGIN_MANIFESTS；缺省 = 不挂。
  plugins?: PluginsRouterDeps
}

// createApp 工厂：PrismaClient 经依赖注入，测试可传 test DB（接缝 #2）。
export function createApp({ prisma, orchestrator, wiki, models, providerEndpoints, files, docs, events, sessions, attachments, plugins }: AppDeps): Application {
  const app = express()
  // wiki 内容契约无大小上限（codex PR#346）：挂载路径内请求先走 5mb limit，其余端点仍 256kb。
  // 须先于全局 parser —— body-parser 对已解析 body（req._body）会跳过，故 wiki 命中后不二次解析。
  app.use('/api/v1/containers/:name/wiki', express.json({ limit: '5mb' }))
  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.prisma = prisma
    next()
  })

  app.use('/api', healthRouter)
  // auth（#773）：logout 终止 SSE 流（session.terminated{logout}）需 StreamHub——
  // events 挂载时经其注入同一单例；未挂载（缺省装配）传 undefined，logout 静默跳过流终止。
  app.use('/api/v1/auth', createAuthRouter({ streamHub: events?.hub }))
  // #773：reset-password 终止目标 user SSE 流（session.terminated{logout}）——
  // 同 auth 的 streamHub 注入语义：events 挂载时同一单例，未挂载静默跳过。
  app.use('/api/v1/users', createUsersRouter({ streamHub: events?.hub }))
  app.use('/api/v1/trace-logs', traceLogsRouter)
  app.use('/api/v1/approval-logs', approvalLogsRouter)
  // #785 覆盖审计检索（file_overwrite_logs）：admin 全量审计面，同款 admin 门
  app.use('/api/v1/file-overwrite-logs', fileOverwriteLogsRouter)
  // #800 admin 核算面：usage 聚合（llm_usage_records → aggregateUsage；admin-only）。
  app.use('/api/v1/usage', usageRouter)
  if (orchestrator) {
    app.use('/api/v1/containers', createContainersRouter(orchestrator))
  }
  // wiki（#335）：只依赖 prisma + 容器行 homeDir，不依赖编排器；compile 触发经 wiki 注入。
  // 注意：Express 5 不把 app.use 挂载路径的 :name 合并进 router 的 req.params，故挂到
  // /api/v1/containers、把 `/:name/wiki/...` 路径声明在 router 内部（见 wiki/routes.ts）。
  app.use('/api/v1/containers', createWikiRouter(wiki ?? {}))
  // models（#336；#775 写盘链退役；#857 归属门改挂 ownerId）：owner 级路由
  // /api/v1/models/providers[/<pid>]（对齐 sessions 扁平挂用户先例），零容器行查询；
  // 零外部资源依赖（事务 = DB mutation + config_meta bump），无条件挂载；deps 仅剩白名单
  // 校验注入缝（测试注 fake lookup 免真 DNS）。
  app.use('/api/v1/models', createModelsRouter(models ?? {}))
  // provider_endpoints（#775，731 §3.1）：端点白名单 admin 管理面，无条件挂载（requireAdmin
  // 在路由内；deps 同为白名单校验注入缝）。
  app.use('/api/v1', createProviderEndpointsRouter(providerEndpoints ?? {}))
  // files（T0 #801 只读化）：root=lab 只读 GET 面，FileArchive 必填，仅在有注入时挂载
  // （条件挂载先例）。
  if (files) {
    app.use('/api/v1/containers', createFilesRouter(files))
  }
  // figures 读面（#791）：无条件挂载（资产常驻，不设 flag 门——#744 §11.3）。
  app.use('/api/v1/figures', createFiguresRouter())
  // docs（#761）：存在即挂载（对齐 figures 条件挂载——app.ts 只认 deps 注入、不读 config；
  // flag 门在装配层 server.ts 由 config.apiDocs.enabled 决定是否注入）。
  if (docs) {
    app.use('/api/docs', createDocsRouter(docs))
  }
  // events（#773）：SSE 单工流（/api/v1/events，panel_stream cookie 认证）。存在即挂载
  // （对齐 figures/docs 条件挂载先例）；生产由 server.ts 装配 StreamHub 单例注入。
  if (events) {
    app.use('/api/v1/events', createEventsRouter(events))
  }
  // sessions（#778）：会话 REST 域（/api/v1/sessions）。存在即挂载（条件挂载先例）。
  if (sessions) {
    app.use('/api/v1/sessions', createSessionsRouter(sessions))
  }
  // attachments（#780）：上传/下载（挂 /api/v1——POST /sessions/:id/attachments 与
  // GET /attachments/:id/download 共根）。存在即挂载（条件挂载先例）；须在 sessions 之后
  //（/sessions/:id/attachments 不被 sessions 路由吞——session 路由无该子路径，落空即穿透）。
  if (attachments) {
    app.use('/api/v1', createAttachmentsRouter(attachments))
  }
  // plugins（#788）：目录 + 启用位（/api/v1/plugins，8xxxx 段）。存在即挂载（条件挂载先例）。
  if (plugins) {
    app.use('/api/v1/plugins', createPluginsRouter(plugins))
  }

  app.use(notFound) // 未匹配路由 → 信封 90005（兑现「所有 REST HTTP 200」）
  app.use(envelopeErrorHandler) // 唯一错误面（必须最后挂载）
  return app
}

// 生产装配：由 server.ts 调用（DockerRuntime + BullMQ 队列），返回编排器与资源句柄供优雅关闭。
export interface FleetAssembly {
  orchestrator: Orchestrator
  deps: FleetDeps
}

export type { FleetConfig }

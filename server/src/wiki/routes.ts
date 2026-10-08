// wiki 6 路由 7 方法（#335 · #315 逐字节迁移；#784 存储面换轨新 wiki 容器；#856 归属门改挂
// ownerId）—— 挂 /api/v1/wiki（owner 级，对齐 #857 models / sessions 扁平挂用户先例）。
//
// #856（退役①）：归属门从容器行解析（getInstanceForUser）改为认证身份直派生，wiki 域与
// 容器行完全脱钩（容器行删除后 wiki 功能无损运行，为③容器消费面退役清障）。随之移除：
//   - 路径 <name> 参数与其校验（90002 data.name 随路径参数一并消失）；
//   - 容器不存在/越权 20040（无容器行可查——跨用户寻址面结构性消失：ownerId 即认证身份，
//     寻址只达本人 wiki 容器，隔离由派生封闭保证；admin 亦只操作本人 wiki）。
//
// #784 存储换轨：wiki 数据源 = 每用户 wiki 容器（researcher-wiki-<ownerId>，树根 /wiki），
// 读写不触达 legacy 容器。每操作前置 ensure（kind=wiki 支路的 create/health 合一面）：容器
// 不存在惰性创建（零初始化）、stopped 复启、running 原样——requireAuth 之后（未授权探测不建
// 容器）且在 path/body 校验之后（非法请求不触碰编排面）；ownerId 无客户端覆写面，
// 「归属先于 ensure」由派生封闭兑现。
// compile 触发（#315 §6）已随 #859 退役：busybox 级 wiki 容器无 openclaw 运行时，索引生成
// 归 OpenWiki 工具形态（#737，G 节 wiki 三通道）。
// 错误映射：path 非法/穿越/managed → 90002(data.path) · 页不存在 → 30040 · 页已存在 → 30041。

import { Router, type Request, type Response } from 'express'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { wikiContainerName } from '../wikiContainers/runtime'
import { DockerWikiFileSystem } from './dockerFs'
import { WikiService } from './service'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from './errors'
import { parseWikiWriteBody, requireRelPath } from './paths'

// wiki 容器生命周期 ensure 面（kind=wiki 支路，#784）：结构子集注入（生产 = WikiContainerLifecycle）。
// 返回 void：快照无消费面（ensure 是 create/health 合一面，成功即容器 running）。
export interface WikiContainersEnsurePort {
  ensure(ownerId: string): Promise<void>
}

// wiki 全量更新独立 run 触发面（#790 · #747 G 节三通道③）：结构子集注入（生产 =
// WikiUpdateRunService）。start 在飞互斥（30042，EnvelopeError 上抛走信封）；返回 runId
// 供 SSE wiki_run.* 事件关联。
export interface WikiUpdateRunnerPort {
  start(params: { ownerId: string; wikiContainer: string }): Promise<{ runId: string }>
}

export interface WikiRouterDeps {
  // wiki 容器 ensure（#784）：缺省 = 不 ensure（纯测试装配）；生产 app.ts 必注入——缺注入时
  // 容器缺失的读写以原语层错误暴露（不静默伪装成功）。
  wikiContainers?: WikiContainersEnsurePort
  // service 工厂：缺省 = Docker 适配器挂请求者本人的 wiki 容器（researcher-wiki-<ownerId>，
  // 树根 /wiki）；测试注入内存 fake（#856 起 fake 以 ownerId 键控）。
  serviceFor?: (ownerId: string) => WikiService
  // 全量更新独立 run（#790）：缺省不注入 = 端点以 90005 回应（对齐 figures/docs 条件挂载
  // 先例——未装配的面不虚挂）；生产 server.ts 注入 WikiUpdateRunService。
  updateRunner?: WikiUpdateRunnerPort
}

// 页级域错误 → 信封（30040 / 90002+data.path）；其余上抛走统一错误面。
function assertPageOpError(err: unknown): void {
  if (err instanceof WikiPageNotFound) throw fail(CODE.WIKI_PAGE_NOT_FOUND)
  if (err instanceof WikiInvalidPath) throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['非法 path'] })
  throw err
}

export function createWikiRouter(deps: WikiRouterDeps = {}): Router {
  // 缺省经 Docker 原语读写请求者本人的 wiki 容器（#784；#856 起 ownerId 即认证身份）：docker
  // 名单一来源 wikiContainerName 派生，树根 /wiki（DockerWikiFileSystem 缺省）。
  const serviceFor =
    deps.serviceFor ?? ((ownerId: string) => new WikiService(new DockerWikiFileSystem(wikiContainerName(ownerId))))
  const ensureWiki = deps.wikiContainers
  const updateRunner = deps.updateRunner
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // 公共前置（#856，对齐 #857 models 同款）：owner 直取认证身份（requireAuth 已保证 req.user
  // 非空；不接收任何客户端 userId 作为授权覆写面）+ 每操作前置 ensure（create/health 合一面）。
  // 顺序不变量「校验先于 ensure」由调用点自律：各 handler 先跑完自身 path/body 校验再调本守卫
  // （未授权/非法请求不触碰编排面，见文件头与 wikiContainerRest.test.ts 顺序契约）。
  const ownerWithEnsure = async (req: Request): Promise<string> => {
    const owner = req.user!.id
    await ensureWiki?.ensure(owner)
    return owner
  }

  // GET /wiki/tree —— 文件树（开放目录分组；不收顶层散落页）。
  router.get('/tree', async (req: Request, res: Response) => {
    ok(res, await serviceFor(await ownerWithEnsure(req)).buildTree())
  })

  // GET /wiki/page?path= —— 读一页原文全文。
  router.get('/page', async (req: Request, res: Response) => {
    const relPath = requireRelPath(req.query.path) // 非法 → 90002(data.path)；先于 ensure（非法请求不触碰编排面）
    try {
      ok(res, await serviceFor(await ownerWithEnsure(req)).readPage(relPath))
    } catch (err) {
      assertPageOpError(err)
    }
  })

  // PUT /wiki/page —— 覆写已存在页（byte-exact 保留空白）。
  router.put('/page', async (req: Request, res: Response) => {
    const body = parseWikiWriteBody(req.body) // 非法 → 90002；先于 ensure（非法请求不触碰编排面）
    try {
      await serviceFor(await ownerWithEnsure(req)).writePage(body.path, body.content)
    } catch (err) {
      assertPageOpError(err)
    }
    ok(res, { path: body.path })
  })

  // POST /wiki/page —— 新建页。
  router.post('/page', async (req: Request, res: Response) => {
    const body = parseWikiWriteBody(req.body)
    try {
      await serviceFor(await ownerWithEnsure(req)).createPage(body.path, body.content)
    } catch (err) {
      if (err instanceof WikiPageExists) throw fail(CODE.WIKI_PAGE_EXISTS)
      assertPageOpError(err)
    }
    ok(res, { path: body.path })
  })

  // DELETE /wiki/page?path= —— 删页。
  router.delete('/page', async (req: Request, res: Response) => {
    const relPath = requireRelPath(req.query.path)
    try {
      await serviceFor(await ownerWithEnsure(req)).deletePage(relPath)
    } catch (err) {
      assertPageOpError(err)
    }
    ok(res, null)
  })

  // GET /wiki/graph —— 全库图谱（nodes + edges；边不 dedup、不可解析 → ghost 节点）。
  router.get('/graph', async (req: Request, res: Response) => {
    ok(res, await serviceFor(await ownerWithEnsure(req)).buildGraph())
  })

  // GET /wiki/categories —— 按 `category:` 标记聚合（开放词表；收顶层散落页）。
  router.get('/categories', async (req: Request, res: Response) => {
    ok(res, await serviceFor(await ownerWithEnsure(req)).listCategories())
  })

  // GET /wiki/claims?path= —— 页 claims 旁车只读面（#789 story 42 数据面：论断 →
  // 源文件行锚 evidence + 页级漂移状态）。页缺失 → 30040（与 page GET 同码）；旁车缺失/
  // 畸形 → 200 + drift null + 空 claims（「无证据面板」语义，不报错）。
  router.get('/claims', async (req: Request, res: Response) => {
    const relPath = requireRelPath(req.query.path)
    try {
      ok(res, await serviceFor(await ownerWithEnsure(req)).readClaims(relPath))
    } catch (err) {
      assertPageOpError(err)
    }
  })

  // POST /wiki/update —— 全量更新独立 run 触发面（#790 · 三通道③）：wiki 容器 ensure 后
  // 即返 {runId}；进度经 SSE wiki_run.progress/text/tool_start/tool_end/finished 五类事件扇出
  // （事件即焚不落盘）。在飞互斥 30042（start 同步抛 EnvelopeError）；缺装配 → 90005。
  router.post('/update', async (req: Request, res: Response) => {
    if (!updateRunner) throw fail(CODE.ROUTE_NOT_FOUND)
    const owner = await ownerWithEnsure(req)
    ok(res, await updateRunner.start({ ownerId: owner, wikiContainer: wikiContainerName(owner) }))
  })

  return router
}

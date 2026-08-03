// wiki 5 路由 7 方法（#335 · #315 逐字节迁移）—— 挂 /api/v1/containers，路由路径 `/:name/wiki/...`。
//
// Express 5 不把 app.use 挂载路径的 :name 合并进 router 的 req.params，故 :name 在 router 内部
// 声明（对齐 containers 路由同款挂载方式）；路由层不加 name 正则（校验在 handler 内做，
// 保「非法 → 90002」而非 Express 默认 404）。
//
// 路由 + 成功载荷与 Django 版逐字节一致；仅错误搬进信封（#312）。隔离经 getInstanceForUser
// 归属前置（#312⑤）：admin 全放行 / user 仅本人，越权 20040 同码防探测。
// 错误映射（#335）：name 非法 → 90002(data.name) · 容器不存在/越权 → 20040 ·
// path 非法/穿越/managed → 90002(data.path) · 页不存在 → 30040 · 页已存在 → 30041。
// 顺序陷阱（#315 §0）：name 非法 ≠ name 合法但无此容器，两码不可混。

import { Router, type Request, type Response } from 'express'
import path from 'node:path'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { getInstanceForUser } from '../containers/orchestrator'
import { CONTAINER_NAME_REGEX } from '../validation/schemas'
import { NodeWikiFileSystem } from './nodeFs'
import { WikiService } from './service'
import { WikiInvalidPath, WikiPageExists, WikiPageNotFound } from './errors'
import { parseWikiWriteBody, requireRelPath } from './paths'
import { noopCompile, type CompileTrigger } from './compile'

export interface WikiRouterDeps {
  // compile 触发（#315 §6）：POST/DELETE 触发、PUT 不触发、5s 去抖。缺省 = 无编排 no-op。
  compile?: CompileTrigger
}

// 页级域错误 → 信封（30040 / 90002+data.path）；其余上抛走统一错误面。
function assertPageOpError(err: unknown): void {
  if (err instanceof WikiPageNotFound) throw fail(CODE.WIKI_PAGE_NOT_FOUND)
  if (err instanceof WikiInvalidPath) throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['非法 path'] })
  throw err
}

export function createWikiRouter(deps: WikiRouterDeps = {}): Router {
  const compile = deps.compile ?? noopCompile
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // 公共前置（对齐 Django _get_instance）：name 校验（400/90002）→ 查容器 + owner 判定（404/20040）。
  // Express 5 :name 可为 string | string[]（重复段）；非字符串直接按非法处理（90002）。
  const resolveInstance = async (req: Request, name: string | string[]) => {
    if (typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'],
      })
    }
    return getInstanceForUser(req.prisma, req.user!, name)
  }
  const makeService = (homeDir: string): WikiService =>
    new WikiService(new NodeWikiFileSystem(path.join(homeDir, 'wiki', 'main')))

  // GET /:name/wiki/tree —— 文件树（开放目录分组；不收顶层散落页）。
  router.get('/:name/wiki/tree', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    ok(res, await makeService(inst.homeDir).buildTree())
  })

  // GET /:name/wiki/page?path= —— 读一页原文全文。
  router.get('/:name/wiki/page', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const relPath = requireRelPath(req.query.path) // 非法 → 90002(data.path)；在容器/越权校验之后
    try {
      ok(res, await makeService(inst.homeDir).readPage(relPath))
    } catch (err) {
      assertPageOpError(err)
    }
  })

  // PUT /:name/wiki/page —— 覆写已存在页（byte-exact 保留空白；不触发 compile）。
  router.put('/:name/wiki/page', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const body = parseWikiWriteBody(req.body) // 非法 → 90002；在容器/越权校验之后（对齐 Django 顺序）
    try {
      await makeService(inst.homeDir).writePage(body.path, body.content)
    } catch (err) {
      assertPageOpError(err)
    }
    ok(res, { path: body.path }) // PUT 不触发 compile（r29 §2.3）
  })

  // POST /:name/wiki/page —— 新建页；触发 5s 去抖 recompile 入搜索索引。
  router.post('/:name/wiki/page', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const body = parseWikiWriteBody(req.body)
    try {
      await makeService(inst.homeDir).createPage(body.path, body.content)
    } catch (err) {
      if (err instanceof WikiPageExists) throw fail(CODE.WIKI_PAGE_EXISTS)
      assertPageOpError(err)
    }
    compile.trigger(inst.name)
    ok(res, { path: body.path })
  })

  // DELETE /:name/wiki/page?path= —— 删页；触发 5s 去抖 recompile 清索引残留。
  router.delete('/:name/wiki/page', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const relPath = requireRelPath(req.query.path)
    try {
      await makeService(inst.homeDir).deletePage(relPath)
    } catch (err) {
      assertPageOpError(err)
    }
    compile.trigger(inst.name)
    ok(res, null)
  })

  // GET /:name/wiki/graph —— 全库图谱（nodes + edges；边不 dedup、不可解析 → ghost 节点）。
  router.get('/:name/wiki/graph', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    ok(res, await makeService(inst.homeDir).buildGraph())
  })

  // GET /:name/wiki/categories —— 按 `category:` 标记聚合（开放词表；收顶层散落页）。
  router.get('/:name/wiki/categories', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    ok(res, await makeService(inst.homeDir).listCategories())
  })

  return router
}

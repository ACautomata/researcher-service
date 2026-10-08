// files 路由（#589 · ADR 0012；#776 root=lab 换轨；T0 #801 只读化 + root=wiki/workspace 整根退役）。
// 挂 /api/v1/containers，路径 `/:name/files`（#858 容器 CRUD 退役后本域是该前缀唯一残余——
// URL 契约保留）。现役面 = 唯一 GET 只读面 root=lab（:name = sessionId，经 getSessionForUser
// 归属门（50002 同码防探测）后由 archive.readLab 直读沙箱 docker 名）。
// root=wiki/workspace（含缺省值——legacy 前端硬发 workspace 的历史面）→ 60042 FILE_ROOT_RETIRED
//（退役码在 name 形状校验之后返回；#858 起容器行表删除，旧「容器行归属前置」无归属真源可查，
// 退役面背后本无数据，不再做实例级防探测）；写面 PUT/POST/DELETE 端点整体移除（→ 90005 路由不存在）。
// 底层经 FileArchive Port（生产 DockerFileArchive，测试注入内存 fake）。沿用 #312 信封。
// 错误映射：name 非法 → 90002(data.name) · 会话不存在/越权（lab）→ 50002 · root 非法 →
// 90002(data.root) · root 已退役 → 60042 · 文件不存在 → 60040。
// 顺序陷阱（#315 §0 同源）：name 非法 ≠ name 合法，两码不可混。

import { Router, type Request, type Response } from 'express'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { getSessionForUser } from '../sandboxes/service'
import { sandboxContainerName } from '../sandboxes/runtime'
import { CONTAINER_NAME_REGEX } from '../validation/schemas'
import type { FileArchive } from './fsPort'
import { FileNotFound, FileInvalidPath } from './errors'
import { requireFilePath, requireFileRoot } from './paths'

export interface FilesRouterDeps {
  // FileArchive Port：生产 DockerFileArchive（readLab 经 getArchive），测试注入内存 fake。
  // 必填——缺 archive 属装配错误（静默禁用不安全），由 app.ts 条件挂载。
  archive: FileArchive
}

// 文件级域错误 → 信封（60040/90002+data.path）；其余上抛走统一错误面。
function assertFileOpError(err: unknown): void {
  if (err instanceof FileNotFound) throw fail(CODE.FILE_NOT_FOUND)
  if (err instanceof FileInvalidPath) throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['非法 path'] })
  throw err
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { archive } = deps
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // name 校验公共段：Express 5 :name 可为 string | string[]（重复段）；非字符串直接按非法处理（90002）。
  function requireName(name: string | string[]): string {
    if (typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'],
      })
    }
    return name
  }

  // root=lab 前置（#776）：name = sessionId → 查会话 + owner 判定（50002 同码防探测）→
  // 派生沙箱 docker 名（sandboxContainerName 单一来源）。不触发惰性创建（读面只读；
  // 创建归 runner ensure，#766 D5）。
  const resolveLabDockerName = async (req: Request, name: string | string[]) => {
    const session = await getSessionForUser(req.prisma, req.user!, requireName(name))
    return sandboxContainerName(session.id)
  }

  // GET /:name/files?root=&path=&recursive= —— 现役唯一读面 root=lab：path 指目录 →
  // {files:[{path,type,size,modified}]}（recursive=true 递归 walk 全量相对路径）；
  // path 指文件 → {path,content,size,modified}。沙箱存在即可读（stopped 可读）；空 path = 树根。
  // root=wiki/workspace → 60042 退役码（T0 #801；wiki 读走 wiki 域 REST）。
  // 缺省 root（legacy 前端硬发 workspace 的历史面）按 workspace 退役语义处理（数据面不猜）。
  router.get('/:name/files', async (req: Request, res: Response) => {
    // lab 分支在 root 校验前按原值分派（root=lab 本身即合法值；其余值仍走「归属前置 → root 判定」
    // 顺序，防探测优先不变）
    if (req.query.root === 'lab') {
      const dockerName = await resolveLabDockerName(req, req.params.name)
      const relPath = requireFilePath(req.query.path, { allowEmpty: true })
      try {
        ok(res, await archive.readLab(dockerName, relPath, req.query.recursive === 'true'))
      } catch (err) {
        assertFileOpError(err)
      }
      return
    }
    // 退役根（#858：容器行表删除，旧「容器行归属前置」随之退役——退役面背后无数据，
    // name 形状校验后整根拒，不再做实例级防探测）：
    requireName(req.params.name)
    // root 合法性校验（缺省按 legacy workspace 面退役——历史前端硬发 workspace）后整根拒：
    requireFileRoot(req.query.root ?? 'workspace')
    // wiki / workspace：T0 整根退役（wiki 读走 wiki 域 REST；workspace 字眼退役）。
    throw fail(CODE.FILE_ROOT_RETIRED)
  })

  return router
}

// files 路由（#589 · ADR 0012 统一文件 CRUD；#776 root=lab 换轨）——挂 /api/v1/containers，
// 路径 `/:name/files`。root ∈ {wiki, lab}（workspace 字眼退役 #776）：wiki = legacy 容器树
//（读写面暂留，退役归 T0）；lab = 会话沙箱 /lab 只读 GET 面——:name 此时是 sessionId，
// 经 getSessionForUser 归属门（50002 同码防探测）后由 archive.readLab 直读沙箱 docker 名。
// 底层经 FileArchive Port（生产 DockerFileArchive，测试注入内存 fake）。沿用 #312 信封。
// 错误映射（#589 AC + #776）：name 非法 → 90002(data.name) · 容器不存在/越权 → 20040 ·
// 会话不存在/越权（lab）→ 50002 · root/path 非法 → 90002(data.root/path) · 写面 root=lab →
// 90002(data.root 只读) · 文件不存在 → 60040 · 已存在 → 60041。
// 顺序陷阱（#315 §0 同源）：name 非法 ≠ name 合法但无此容器，两码不可混；root/path 校验在
// 容器/会话/越权之后（防探测优先，对齐 wiki/models）。

import { Router, type Request, type Response } from 'express'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { getInstanceForUser } from '../containers/orchestrator'
import { getSessionForUser } from '../sandboxes/service'
import { sandboxContainerName } from '../sandboxes/runtime'
import { CONTAINER_NAME_REGEX } from '../validation/schemas'
import type { FileArchive } from './fsPort'
import { FileExists, FileInvalidPath, FileNotFound } from './errors'
import { parseFileWriteBody, requireFilePath, requireLegacyFileRoot, resolveWorkspaceAbsPath } from './paths'
import { FILE_ROOTS } from './values'

// WebChat 媒体白名单（files/raw 端点）：仅图片扩展名 → mime。未知扩展名 → 90002（前端也不渲染）。
const MEDIA_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export interface FilesRouterDeps {
  // FileArchive Port（#589 新接缝）：生产 DockerFileArchive（getArchive/putArchive/exec rm），
  // 测试注入内存 fake。必填——缺 archive 属装配错误（静默禁用不安全），由 app.ts 条件挂载。
  archive: FileArchive
}

// 文件级域错误 → 信封（60040/60041/90002+data.path）；其余上抛走统一错误面。
function assertFileOpError(err: unknown): void {
  if (err instanceof FileNotFound) throw fail(CODE.FILE_NOT_FOUND)
  if (err instanceof FileExists) throw fail(CODE.FILE_EXISTS)
  if (err instanceof FileInvalidPath) throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['非法 path'] })
  throw err
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { archive } = deps
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // 公共前置（对齐 wiki _get_instance）：name 校验（90002）→ 查容器 + owner 判定（20040）。
  // Express 5 :name 可为 string | string[]（重复段）；非字符串直接按非法处理（90002）。
  const resolveInstance = async (req: Request, name: string | string[]) => {
    if (typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'],
      })
    }
    return getInstanceForUser(req.prisma, req.user!, name)
  }

  // root=lab 前置（#776）：name = sessionId → 查会话 + owner 判定（50002 同码防探测）→
  // 派生沙箱 docker 名（sandboxContainerName 单一来源）。不触发惰性创建（读面只读；
  // 创建归 runner ensure，#766 D5）。
  const resolveLabSession = async (req: Request, name: string | string[]) => {
    if (typeof name !== 'string' || !CONTAINER_NAME_REGEX.test(name)) {
      throw fail(CODE.VALIDATION_FAILED, undefined, {
        name: ['name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'],
      })
    }
    const session = await getSessionForUser(req.prisma, req.user!, name)
    return sandboxContainerName(session.id)
  }

  // GET /:name/files?root=&path=&recursive= —— root=wiki：path 指目录 → {files:[{path,type,size,modified}]}
  // （recursive=true 递归 walk 全量相对路径）；path 指文件 → {path,content,size,modified}。
  // 容器存在即可读（stopped 可读）；空 path = 树根（列根目录）。
  // root=lab（#776）：同形读面指向会话沙箱 /lab（:name = sessionId；只读 GET）。
  router.get('/:name/files', async (req: Request, res: Response) => {
    // lab 分支在 root 校验前按原值分派（root=lab 本身即合法值；其余值仍走 legacy 路径的
    // 「归属前置 → root 校验」顺序，防探测优先不变）
    if (req.query.root === 'lab') {
      const dockerName = await resolveLabSession(req, req.params.name)
      const relPath = requireFilePath(req.query.path, { allowEmpty: true })
      try {
        ok(res, await archive.readLab(dockerName, relPath, req.query.recursive === 'true'))
      } catch (err) {
        assertFileOpError(err)
      }
      return
    }
    const inst = await resolveInstance(req, req.params.name)
    // workspace = legacy 只读消费值（现存前端 fileTabs 硬发，#793 迁 lab）；非法 → 90002(data.root)；
    // 在容器/越权校验之后（防探测优先）
    const root = requireLegacyFileRoot(req.query.root) // lab 已分派；workspace=legacy 只读合法值
    const relPath = requireFilePath(req.query.path, { allowEmpty: true })
    const recursive = req.query.recursive === 'true' // 非 'true' 一律 false（宽容布尔）
    try {
      ok(res, await archive.read(inst.name, root, relPath, recursive))
    } catch (err) {
      assertFileOpError(err)
    }
  })

  // GET /:name/files/raw?path=<workspace 绝对路径> —— WebChat 媒体字节端点（Phase 2 图片显示修复）。
  // agent mediaUrls 携带容器内绝对路径（如 /home/node/.openclaw/workspace/test.png）；本端点只接受
  // workspace 树根前缀内路径（resolveWorkspaceAbsPath：前缀 + 穿越防护），按扩展名白名单 → mime，
  // 成功路径豁免 #312 信封直发原生字节（对齐 figures /figures/:id/png 先例：浏览器经带 JWT 的
  // apiFetch→blob→objectURL 消费，<img> 直连带不了 Authorization header）。错误面仍走信封。
  router.get('/:name/files/raw', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name) // 容器/归属门（20040 同码防探测）
    const abs = resolveWorkspaceAbsPath(req.query.path) // 非 workspace 前缀/穿越 → 90002(data.path)
    if (!abs.ok) throw fail(CODE.VALIDATION_FAILED, undefined, { path: abs.errors })
    const ext = abs.path.split('.').pop()?.toLowerCase() ?? ''
    const mime = MEDIA_MIME_BY_EXT[ext]
    if (!mime) throw fail(CODE.VALIDATION_FAILED, undefined, { path: ['仅支持 png/jpg/jpeg/webp/gif 图片'] })
    try {
      const bytes = await archive.readBytes(inst.name, FILE_ROOTS.workspace, abs.path)
      res.set('Content-Type', mime)
      res.set('Cache-Control', 'no-store') // 工作区图片可变，不缓存
      res.send(bytes)
    } catch (err) {
      assertFileOpError(err) // FileNotFound → 60040；FileInvalidPath → 90002
    }
  })

  // PUT /:name/files {root,path,content} —— 覆写已存在文本文件（root=lab → 90002 只读，parseFileWriteBody）。
  router.put('/:name/files', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const body = parseFileWriteBody(req.body) // 非法 / lab → 90002；在容器/越权校验之后
    try {
      await archive.write(inst.name, body.root, body.path, body.content)
    } catch (err) {
      assertFileOpError(err)
    }
    ok(res, { path: body.path })
  })

  // POST /:name/files {root,path,content} —— 新建（已存在 → 60041 冲突）。
  router.post('/:name/files', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const body = parseFileWriteBody(req.body)
    try {
      await archive.create(inst.name, body.root, body.path, body.content)
    } catch (err) {
      assertFileOpError(err)
    }
    ok(res, { path: body.path })
  })

  // DELETE /:name/files?root=&path= —— 删除文件（目录 → 90002；stopped 容器先 start 再 rm）。
  // 写面收敛（#776/#769）：root=lab → 90002（/lab 写收敛 runner 工具 + 上传端点）；
  // root=workspace → 90002（legacy 只读消费值）。
  router.delete('/:name/files', async (req: Request, res: Response) => {
    const inst = await resolveInstance(req, req.params.name)
    const root = requireLegacyFileRoot(req.query.root) // lab → 90002（只读）
    if (root === 'workspace') {
      throw fail(CODE.VALIDATION_FAILED, undefined, { root: ['root=workspace 为 legacy 只读面（写经对话让 agent 改）'] })
    }
    const relPath = requireFilePath(req.query.path) // 空 path 无删除语义 → 90002
    try {
      await archive.delete(inst.name, root, relPath)
    } catch (err) {
      assertFileOpError(err)
    }
    ok(res, null)
  })

  return router
}

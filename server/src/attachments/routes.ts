// 附件域 REST（#780 · #747 C 节「写操作全 REST」）：挂 /api/v1。两端点：
//   - POST /sessions/:id/attachments —— multipart 上传（multer 落控制面临时区；REST 不直写沙箱）。
//   - GET /attachments/:id/download —— 原生字节（成功豁免 #312 信封，仿 figures PNG 先例；
//     错误面走信封，owner 门 + 不存在/越权同码 50002 防枚举）。
// 字节上限（multer limits 挡）与单消息件数（service.linkToMessage 挡）——D6 规模。

import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { ok, fail } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import type { AttachmentsService } from './service'
import { ATTACHMENT_MAX_BYTES, sanitizeFileName } from './values'

export interface AttachmentsRouterDeps {
  readonly service: AttachmentsService
  /** 控制面临时区根（multer destination；须已存在） */
  readonly tmpRoot: string
}

// Express 5 params 可为 string | string[]；:id 单段路径恒 string。
function pathId(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : ''
}

export function createAttachmentsRouter(deps: AttachmentsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // multer 落控制面临时区（<tmpRoot>/<uuid>.upload）：REST 只收字节不直写沙箱（#780 D5 修订）；
  // destination 须已存在（multer 不自建）——工厂期 mkdirSync 确保。
  mkdirSync(deps.tmpRoot, { recursive: true })
  const upload = multer({
    storage: multer.diskStorage({
      destination: deps.tmpRoot,
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: ATTACHMENT_MAX_BYTES },
  })

  // POST /sessions/:id/attachments —— multipart field 'file'（字节）+ 表单字段 fileName/mimeType。
  // multer 先落临时文件再进 handler；超大（LIMIT_FILE_SIZE）由下方错误面映射 90002（明确文案，
  // 非模糊 500）。文件名经 sanitizeFileName 净化（防路径穿越——沙箱物化路径由 fileName 拼入）。
  router.post(
    '/sessions/:id/attachments',
    upload.single('file'),
    async (req: Request, res: Response) => {
      if (!req.file) throw fail(CODE.VALIDATION_FAILED, '缺少文件字段 file')
      const fileName = sanitizeFileName(
        typeof req.body.fileName === 'string' && req.body.fileName ? req.body.fileName : 'file',
      )
      const mimeType =
        typeof req.body.mimeType === 'string' && req.body.mimeType ? req.body.mimeType.slice(0, 127) : 'application/octet-stream'
      ok(res, await deps.service.upload(req.user!, pathId(req), { tempPath: req.file.path, fileName, mimeType }))
    },
    // multer 错误面（Express 5：中间件抛错落错误处理器；LIMIT_FILE_SIZE → 明确 90002）
    (err: unknown, _req: Request, _res: Response, next: (e?: unknown) => void) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        next(fail(CODE.VALIDATION_FAILED, `附件过大（≤${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB）`))
        return
      }
      next(err)
    },
  )

  // GET /attachments/:id/download —— 仅 owner/admin、成功豁免信封：原生字节 + Content-Type 透传
  //（附件的 mimeType 来自上传时声明）。错误面信封：不存在/越权 → 50002（同码防枚举探测，仿
  // figures PNG 的 70040 先例——附件域无独立码段，归会话域 5xxxx）。
  router.get('/attachments/:id/download', async (req: Request, res: Response) => {
    const id = pathId(req)
    const { meta, buf } = await deps.service.download(req.user!, id)
    res.set('Content-Type', meta.mimeType)
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(meta.fileName)}"`)
    res.send(buf)
  })

  return router
}

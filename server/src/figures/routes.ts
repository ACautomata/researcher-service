// AutoFigure 域路由（#791 · #744 v2 §8 读面收缩后形状）。
// figures API = 读/下载/SVG 面（创建入口随 REST 端点退役——figure 工具是唯一生成入口，
// #744 §4.1/Q10；执行状态语义归会话 run 域）。资产读面常驻（插件禁用后历史图卡仍可渲染，
// #744 §11.3），不设 flag 门。
//   GET /        —— 列表（admin = 所有用户；createdAt DESC + id DESC 稳定排序）
//   GET /:id     —— 详情（归属门 70040 同码防探测）
//   GET /:id/png —— 预览 PNG 字节（成功路径豁免 #312 信封；产物缺失 70043）
//   GET /:id/svg —— final SVG 文本（?download=1 → Content-Disposition: attachment；#744 §4.2）

import { Router, type Request, type Response } from 'express'
import { ok } from '../envelope'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import {
  getFigureForUser,
  getFigurePngForUser,
  getFigureSvgForUser,
  listFigures,
} from './service'

export function createFiguresRouter(): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // GET / —— 当前认证用户自己的 Figure 资产（admin = 所有用户，沿用已批准可见性规则）。
  // 只读，无任何删除/变更路径。
  router.get('/', async (req: Request, res: Response) => {
    const data = await listFigures(req.prisma, req.user!)
    ok(res, data)
  })

  // GET /:id —— Figure 元数据 + 预览可用性。归属门「不存在 vs 越权」同码 70040 防枚举；
  // :id 为 cuid，非法 id 自然落入「不存在」→ 70040（不引入格式特例）。
  router.get('/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string // Express 5 params 可含 string[]；cuid 单段路径恒 string
    const figure = await getFigureForUser(req.prisma, req.user!, id)
    ok(res, figure)
  })

  // GET /:id/png —— 预览 PNG 字节下载。成功路径豁免 #312 信封：原生 image/png 字节，绝不
  // base64-in-JSON。错误面走信封：不存在/越权 → 70040（共享归属门）；产物缺失 → 70043——
  // 明确应用级响应，非模糊 500。Express res.send 对 Uint8Array 会 JSON 序列化（Buffer.isBuffer
  // false）→ 必须先 Buffer.from 转换才按字节直发。
  router.get('/:id/png', async (req: Request, res: Response) => {
    const id = req.params.id as string
    const png = await getFigurePngForUser(req.prisma, req.user!, id)
    res.set('Content-Type', 'image/png')
    res.send(Buffer.from(png))
  })

  // GET /:id/svg —— final SVG 文本（#744 §4.2：前端 <img> blob URL 渲染 / Figure Editor 读写
  // 接缝；脚本执行面由消费形态收敛——前端禁 innerHTML 直插）。?download=1 → Content-Disposition:
  // attachment（浏览器不以内联文档打开）。成功路径豁免 #312 信封（同 PNG 先例：产物直发）；
  // 错误面走信封（70040 / 70043）。
  router.get('/:id/svg', async (req: Request, res: Response) => {
    const id = req.params.id as string
    const svg = await getFigureSvgForUser(req.prisma, req.user!, id)
    res.set('Content-Type', 'image/svg+xml; charset=utf-8')
    if (req.query.download === '1' || req.query.download === 'true') {
      res.set('Content-Disposition', `attachment; filename="figure-${id}.svg"`)
    }
    res.send(svg)
  })

  return router
}

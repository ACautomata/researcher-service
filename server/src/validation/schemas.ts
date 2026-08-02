import { z } from 'zod'

// 请求体 schema（zod）。校验失败 → 90002 + flatten().fieldErrors（{field:[errors]}）。
// username 格式：字母/数字/下划线/连字符，3–30 字符（近似 Django UnicodeUsernameValidator，更严）。
export const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,30}$/

// bcryptjs 截断 >72 字节的输入（72 字节后丢弃）。若不对密码设 UTF-8 字节上限，首 72 字节
// 相同而后续不同的两个密码可互登（碰撞面）。共享此校验：login / 建号 / 改密一律拒绝 >72 字节。
// Codex #342 四轮 P2。
const BYTE72_MAX = 72
const BYTE72_ERR = `密码不能超过 ${BYTE72_MAX} 字节`

function max72Bytes(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') <= BYTE72_MAX
}

export const loginSchema = z.object({
  username: z.string().min(1, '不能为空'),
  password: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
})

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
  newPassword: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
})

// 建账号（admin register / users POST 共用）：用户名格式 + 密码≥8 + 可选 email + 可选配额。
export const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, '用户名仅允许字母、数字、下划线、连字符（3-30 位）'),
  password: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
  email: z.string().email('email 格式非法').optional(),
  maxContainers: z.number().int().optional(),
})

// 改账号（users PATCH）：可改 active / 配额。
export const userPatchSchema = z.object({
  isActive: z.boolean().optional(),
  maxContainers: z.number().int().optional(),
})

// ── 容器（#334 M2）──
// name DNS-label（spec §4 / #310）：单一来源 = orchestrator/ports.NAME_REGEX。
// schema 层（zod body 校验）+ 路由层（DELETE 路径参数）+ 编排层（防御二次校验）共用同一正则，
// 避免校验逻辑分散。校验失败 → 90002(data.name)。
import { NAME_REGEX } from '../orchestrator/ports'

export const containerCreateSchema = z.object({
  name: z.string().regex(NAME_REGEX, '名称仅允许小写字母、数字、连字符（3-30 位，小写字母开头）'),
})

import { z } from 'zod'

// 请求体 schema（zod）。校验失败 → 90002 + flatten().fieldErrors（{field:[errors]}）。
// username 格式：字母/数字/下划线/连字符，3–30 字符（近似 Django UnicodeUsernameValidator，更严）。
export const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,30}$/

export const loginSchema = z.object({
  username: z.string().min(1, '不能为空'),
  password: z.string().min(1, '不能为空'),
})

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '不能为空'),
  newPassword: z.string().min(8, '至少 8 个字符'),
})

// 建账号（admin register / users POST 共用）：用户名格式 + 密码≥8 + 可选 email + 可选配额。
export const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, '用户名仅允许字母、数字、下划线、连字符（3-30 位）'),
  password: z.string().min(8, '至少 8 个字符'),
  email: z.string().email('email 格式非法').optional(),
  maxContainers: z.number().int().optional(),
})

// 改账号（users PATCH）：可改 active / 配额。
export const userPatchSchema = z.object({
  isActive: z.boolean().optional(),
  maxContainers: z.number().int().optional(),
})

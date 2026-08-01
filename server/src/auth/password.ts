import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { config } from '../config'

// bcrypt(12)（规格锁）。bcryptjs 纯 JS、无原生编译、cost=12 语义与 bcrypt 一致。
// 现有数据不迁移（#312），无跨库散列互操作约束。

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptCost)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

// 临时密码（bootstrap / admin 建号 / 重置）：24 字符强随机 base64url。
export function generateTempPassword(): string {
  return randomBytes(18).toString('base64url').slice(0, 24)
}

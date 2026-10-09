// BYOK 凭证 AES-256-GCM 加密（#881）：明文 key 单向流——只在写请求出现，落库即密文
// （v1 信封）；读路径只出掩码；解密失败可检出（读不炸，上层标 key_error、运行时报
// LLM 未配置）。V1 单密钥（LLM_CREDENTIAL_SECRET），无轮换机制（#880 Out of Scope）。
//
// 信封形状 `v1:<iv_b64>:<tag_b64>:<ct_b64>`：版本前缀为轮换留位；密钥经 SHA-256 派生
// 32 字节（AES-256），任意非空 secret 可用（生产 ≥32 字符下限归 config 校验）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ENVELOPE_VERSION = 'v1'

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

export function encryptCredential(plaintext: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [ENVELOPE_VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

// 解密失败（错 secret / 篡改 / 形状残缺）一律抛错——调用方 catch 后按 key_error 处理，本层不吞。
export function decryptCredential(envelope: string, secret: string): string {
  const parts = envelope.split(':')
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error('credential envelope 形状非法')
  }
  const iv = Buffer.from(parts[1]!, 'base64')
  const tag = Buffer.from(parts[2]!, 'base64')
  const ct = Buffer.from(parts[3]!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export function isCredentialEnvelope(value: string | null | undefined): boolean {
  if (!value) return false
  const parts = value.split(':')
  return parts.length === 4 && parts[0] === ENVELOPE_VERSION
}

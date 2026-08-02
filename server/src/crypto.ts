// 凭证加密设施（AGENTS.md §5.2 / L94-95：gateway token 等真值不落盘；DB 只存密文，用时解密）。
// AES-256-GCM（认证加密：密文不可篡改、防 padding/oracle）。密钥经 CREDENTIAL_ENCRYPTION_KEYS
// 注入（逗号分隔 base64(32B)），首个 = active（加密用），其余仅解密——支持密钥轮换：
// 新密钥 prepend 为 active 后，旧密钥保留在列表中即可继续解密历史行（解密遍历尝试所有密钥，
// GCM 认证通过者即为正确密钥），新行用 active 重加密逐步迁移。
// sealed 串格式：v1:<b64(iv12)>:<b64(ciphertext||tag16)>（不带 keyId，解密按认证命中选 key）。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const ENCRYPTION_KEY_BYTES = 32 // AES-256
const GCM_IV_BYTES = 12 // GCM 标准 96-bit nonce
const GCM_TAG_BYTES = 16
const SEALED_VERSION = 'v1'

// dev/test 固定密钥（确定性，本地/测试可复现加解密；生产须经 CREDENTIAL_ENCRYPTION_KEYS 覆盖）。
// 非零填充避免全零密钥（部分实现视为弱密钥告警）。
export const DEV_ENCRYPTION_KEYS: readonly Buffer[] = [Buffer.alloc(ENCRYPTION_KEY_BYTES, 0x07)]

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionKeyError'
  }
}

// 解析 CREDENTIAL_ENCRYPTION_KEYS：逗号分隔的 base64(32B) 列表。
// 空 + production → fail-fast（缺密钥会让所有已落盘 token 不可解密）；空 + 非 production → dev 固定密钥。
export function parseEncryptionKeys(env: string | undefined): readonly Buffer[] {
  const raw = env?.trim()
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new EncryptionKeyError(
        'CREDENTIAL_ENCRYPTION_KEYS 必须在生产显式提供：逗号分隔的 base64(32 字节) 列表，首个为 active',
      )
    }
    // eslint-disable-next-line no-console
    console.warn('[crypto] CREDENTIAL_ENCRYPTION_KEYS 未设置，使用 dev 固定密钥。切勿用于生产。')
    return DEV_ENCRYPTION_KEYS
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new EncryptionKeyError('CREDENTIAL_ENCRYPTION_KEYS 解析为空')
  return parts.map((part, i) => {
    let buf: Buffer
    try {
      buf = Buffer.from(part, 'base64')
    } catch {
      throw new EncryptionKeyError(`CREDENTIAL_ENCRYPTION_KEYS 第 ${i} 项非合法 base64`)
    }
    if (buf.length !== ENCRYPTION_KEY_BYTES) {
      throw new EncryptionKeyError(
        `CREDENTIAL_ENCRYPTION_KEYS 第 ${i} 项长度 ${buf.length} ≠ ${ENCRYPTION_KEY_BYTES} 字节`,
      )
    }
    return buf
  })
}

export interface CryptoPort {
  encrypt(plaintext: string): string
  decrypt(sealed: string): string
}

export class AesGcmCrypto implements CryptoPort {
  constructor(private readonly keys: readonly Buffer[]) {
    if (keys.length === 0) throw new EncryptionKeyError('AesGcmCrypto 至少需要 1 个密钥')
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(GCM_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.keys[0], iv) // active = 首个
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [SEALED_VERSION, iv.toString('base64'), Buffer.concat([ciphertext, tag]).toString('base64')].join(':')
  }

  decrypt(sealed: string): string {
    // 兼容历史明文 token（无 v1: 前缀、tokenEncrypted=false 的旧行）——原样返回供平滑期读取。
    // 本切片新行一律加密；旧行经 delete+recreate 自然收敛，不强制批量迁移。
    if (!sealed.startsWith(`${SEALED_VERSION}:`)) return sealed
    const parts = sealed.split(':')
    if (parts.length !== 3) throw new EncryptionKeyError(`sealed 格式非法: ${sealed.slice(0, 32)}...`)
    const iv = Buffer.from(parts[1], 'base64')
    const payload = Buffer.from(parts[2], 'base64')
    if (payload.length < GCM_TAG_BYTES) throw new EncryptionKeyError('sealed payload 过短（缺 GCM tag）')
    const tag = payload.subarray(payload.length - GCM_TAG_BYTES)
    const ciphertext = payload.subarray(0, payload.length - GCM_TAG_BYTES)
    // 遍历所有密钥尝试 GCM 解密——认证（final）通过者即正确密钥；支持轮换期旧密钥解旧行。
    // GCM 认证误判概率可忽略（2^-128 量级），auth 通过即正确密钥。
    let lastErr: unknown
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      } catch (e) {
        lastErr = e // 该密钥不匹配，继续尝试下一个
      }
    }
    throw new EncryptionKeyError(
      `无密钥可解密（密钥未配置或已删除）：${(lastErr as Error)?.message ?? 'unknown'}`,
    )
  }
}

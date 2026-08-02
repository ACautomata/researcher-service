// 凭证加密设施单测（Codex C1）：AES-256-GCM round-trip / 篡改检测 / 旧明文兼容 / 密钥轮换。
// 真容器 token 落盘密文由 orchestrator.test.ts 集成断言；此处隔离测 crypto 原语正确性。

import { describe, it, expect } from 'vitest'
import { AesGcmCrypto, EncryptionKeyError, parseEncryptionKeys, DEV_ENCRYPTION_KEYS } from '../src/crypto'

const k0 = Buffer.alloc(32, 0x10)
const k1 = Buffer.alloc(32, 0x21)

describe('AesGcmCrypto（Codex C1 token 加密）', () => {
  it('encrypt → decrypt round-trip 还原明文', () => {
    const c = new AesGcmCrypto([k0])
    const sealed = c.encrypt('my-secret-gateway-token')
    expect(sealed.startsWith('v1:')).toBe(true) // sealed 格式版本前缀
    expect(sealed).not.toContain('my-secret-gateway-token') // 明文不出现在密文里
    expect(c.decrypt(sealed)).toBe('my-secret-gateway-token')
  })

  it('同明文多次加密 → 密文不同（随机 iv，防确定性关联）', () => {
    const c = new AesGcmCrypto([k0])
    expect(c.encrypt('same')).not.toBe(c.encrypt('same'))
  })

  it('密文篡改 → decrypt 抛错（GCM 认证失败，防 oracle/降级）', () => {
    const c = new AesGcmCrypto([k0])
    const sealed = c.encrypt('secret')
    const tampered = sealed.slice(0, -4) + 'AAAA' // 翻转 payload 尾部
    expect(() => c.decrypt(tampered)).toThrow()
  })

  it('历史明文（无 v1: 前缀）→ decrypt 原样返回（平滑兼容 tokenEncrypted=false 旧行）', () => {
    const c = new AesGcmCrypto([k0])
    expect(c.decrypt('legacy-plaintext-token')).toBe('legacy-plaintext-token')
  })

  it('多密钥：encrypt 用 active(keys[0])，decrypt 遍历命中', () => {
    const c = new AesGcmCrypto([k0, k1])
    const sealed = c.encrypt('multi')
    expect(c.decrypt(sealed)).toBe('multi')
  })

  it('密钥轮换：旧密钥加密的行，新配置保留旧密钥 → 仍可解密', () => {
    const old = new AesGcmCrypto([k0]) // 旧配置：k0 active
    const sealed = old.encrypt('rotated-row')
    // 轮换：k1 新 prepend 为 active，k0 保留在列表供解旧行
    const rotated = new AesGcmCrypto([k1, k0])
    expect(rotated.encrypt('new-row-plain')).not.toBe(sealed) // 新行用 k1（不同密文分布）
    expect(rotated.decrypt(sealed)).toBe('rotated-row') // 旧行仍可解
  })

  it('密钥丢失：解密配置不含原加密密钥 → 抛错（暴露配置漂移，不静默失败）', () => {
    const old = new AesGcmCrypto([k0])
    const sealed = old.encrypt('lost-row')
    const fresh = new AesGcmCrypto([k1]) // k0 已移除
    expect(() => fresh.decrypt(sealed)).toThrow(EncryptionKeyError)
  })
})

describe('parseEncryptionKeys', () => {
  it('合法逗号分隔 base64(32B) → 多密钥列表', () => {
    const env = [k0, k1].map((b) => b.toString('base64')).join(',')
    const keys = parseEncryptionKeys(env)
    expect(keys.length).toBe(2)
    expect(keys[0].equals(k0)).toBe(true)
    expect(keys[1].equals(k1)).toBe(true)
  })

  it('长度非 32 字节 → fail-fast', () => {
    expect(() => parseEncryptionKeys(Buffer.alloc(16).toString('base64'))).toThrow(EncryptionKeyError)
  })

  it('空 + production → fail-fast', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => parseEncryptionKeys(undefined)).toThrow(EncryptionKeyError)
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('空 + 非 production → dev 固定密钥', () => {
    const keys = parseEncryptionKeys(undefined)
    expect(keys[0].equals(DEV_ENCRYPTION_KEYS[0])).toBe(true)
  })
})

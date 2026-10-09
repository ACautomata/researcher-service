// BYOK 凭证 AES-256-GCM 信封 round-trip（#881）：明文 key 单向流——写请求可带明文，
// 落库即密文（v1 信封）；解密失败可检出（读不炸，上层标 key_error）。
import { describe, it, expect } from 'vitest'
import { encryptCredential, decryptCredential, isCredentialEnvelope } from '../src/models/cipher'

const SECRET = 'test-credential-secret-0123456789abcdef'

describe('credential cipher（AES-256-GCM v1 信封）', () => {
  it('encrypt → decrypt round-trip（同 secret）', () => {
    const envelope = encryptCredential('sk-my-plain-key', SECRET)
    expect(envelope).not.toContain('sk-my-plain-key')
    expect(decryptCredential(envelope, SECRET)).toBe('sk-my-plain-key')
  })

  it('信封带 v1 版本前缀，且为三段 base64 结构', () => {
    const envelope = encryptCredential('k', SECRET)
    expect(isCredentialEnvelope(envelope)).toBe(true)
    const parts = envelope.split(':')
    expect(parts[0]).toBe('v1')
    expect(parts).toHaveLength(4)
    for (const seg of parts.slice(1)) expect(seg.length).toBeGreaterThan(0)
  })

  it('错 secret 解密抛错（可检出，不产出明文）', () => {
    const envelope = encryptCredential('sk-secret', SECRET)
    expect(() => decryptCredential(envelope, 'another-secret-0123456789abcdef')).toThrow()
  })

  it('篡改密文解密抛错（GCM tag 校验）', () => {
    const envelope = encryptCredential('sk-secret', SECRET)
    const parts = envelope.split(':')
    const ct = Buffer.from(parts[3]!, 'base64')
    ct[0] = ct[0]! ^ 0xff
    const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':')
    expect(() => decryptCredential(tampered, SECRET)).toThrow()
  })

  it('同明文两次加密产不同密文（随机 IV）', () => {
    expect(encryptCredential('same', SECRET)).not.toBe(encryptCredential('same', SECRET))
  })

  it('非信封字符串 isCredentialEnvelope=false', () => {
    expect(isCredentialEnvelope('sk-plain-key')).toBe(false)
    expect(isCredentialEnvelope('')).toBe(false)
  })

  it('同 secret 加密同一明文可跨实例解密（确定性密钥派生）', () => {
    const a = encryptCredential('deterministic', SECRET)
    expect(decryptCredential(a, SECRET)).toBe('deterministic')
  })
})

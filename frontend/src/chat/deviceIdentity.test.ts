// seam: chat/deviceIdentity —— 浏览器设备 Ed25519 身份 localStorage 持久化（#375 / ADR 0006 决定 3）。
// 对齐官方 webchat-ui（ui/src/lib/nodes/index.ts）：@noble/ed25519 keygen + sha256(pubkey) fingerprint +
// `openclaw-device-identity-v1` key。只测外部可观察行为（生成/复用/持久化/修复/清除），不依赖真实网关。

import { describe, expect, it, beforeEach } from 'vitest'
import { verifyAsync } from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DEVICE_IDENTITY_STORAGE_KEY,
  loadDeviceIdentity,
  clearDeviceIdentity,
} from './deviceIdentity'

// 测试内 base64url 解码 + hex（与实现同构，独立验证派生一致）
function b64urlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('deviceIdentity（#375 设备身份 localStorage 持久化）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('首次访问生成 Ed25519 身份，同 profile 后续访问复用同一身份（同一 deviceId/publicKey）', async () => {
    const first = await loadDeviceIdentity()
    expect(first).not.toBeNull()
    const second = await loadDeviceIdentity()
    expect(second!.deviceId).toBe(first!.deviceId)
    expect(second!.publicKey).toBe(first!.publicKey)
  })

  it('身份持久化格式对齐官方：version:1 + deviceId(64hex) + publicKey/privateKey(base64url)', async () => {
    await loadDeviceIdentity()
    const raw = localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.version).toBe(1)
    expect(parsed.deviceId).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.publicKey).toMatch(/^[A-Za-z0-9_-]+$/) // base64url
    expect(parsed.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(typeof parsed.createdAtMs).toBe('number')
  })

  it('deviceId = sha256(raw publicKey 32B).hex（派生一致）', async () => {
    const id = await loadDeviceIdentity()
    const pub = b64urlDecode(id!.publicKey)
    expect(pub.length).toBe(32) // Ed25519 公钥 32B
    expect(id!.deviceId).toBe(bytesToHex(sha256(pub)))
  })

  it('sign(payload) 签名可由公钥验签，输出 base64url（网关逐字节比对签名）', async () => {
    const id = await loadDeviceIdentity()
    const payload = 'v3|device|webchat-ui|webchat|operator|operator.read|123|token|nonce|browser|'
    const sig = await id!.sign(payload)
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/)
    const ok = await verifyAsync(b64urlDecode(sig), new TextEncoder().encode(payload), b64urlDecode(id!.publicKey))
    expect(ok).toBe(true)
    // 不同 payload 签名不同（不缓存固定签名）
    const sig2 = await id!.sign(payload + 'x')
    expect(sig2).not.toBe(sig)
  })

  it('多 tab 共享：同 profile 多 tab（共享 localStorage）复用同一设备身份', async () => {
    const tabA = await loadDeviceIdentity()
    // 模拟 tab B：独立调用，但共享同一 localStorage
    const tabB = await loadDeviceIdentity()
    expect(tabB!.deviceId).toBe(tabA!.deviceId)
    expect(tabB!.publicKey).toBe(tabA!.publicKey)
    // sign 也一致（同私钥）
    const sig = await tabB!.sign('v3|same-payload')
    const ok = await verifyAsync(b64urlDecode(sig), new TextEncoder().encode('v3|same-payload'), b64urlDecode(tabA!.publicKey))
    expect(ok).toBe(true)
  })

  it('损坏存储（非法 JSON）→ 重新生成新身份（不抛）', async () => {
    localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, 'not-json{{{')
    const id = await loadDeviceIdentity()
    expect(id).not.toBeNull()
    expect(id!.deviceId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('版本/字段不合法（如 version:2）→ 重新生成', async () => {
    localStorage.setItem(
      DEVICE_IDENTITY_STORAGE_KEY,
      JSON.stringify({ version: 2, deviceId: 'deadbeef', publicKey: 'x', privateKey: 'y' }),
    )
    const id = await loadDeviceIdentity()
    expect(id!.deviceId).not.toBe('deadbeef')
  })

  it('publicKey 指纹与存储 deviceId 不匹配 → 派生修复 deviceId 并持久化', async () => {
    const id = await loadDeviceIdentity()
    // 篡改存储的 deviceId（模拟半损坏存储）
    const stored = JSON.parse(localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)!)
    localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify({ ...stored, deviceId: '00'.repeat(32) }))
    const repaired = await loadDeviceIdentity()
    expect(repaired!.deviceId).toBe(id!.deviceId) // 由公钥重新派生
    const raw = JSON.parse(localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)!)
    expect(raw.deviceId).toBe(id!.deviceId) // 修复结果落盘
  })

  it('clearDeviceIdentity 清除本地身份，再访问生成新身份', async () => {
    const id = await loadDeviceIdentity()
    clearDeviceIdentity()
    expect(localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)).toBeNull()
    const next = await loadDeviceIdentity()
    expect(next!.deviceId).not.toBe(id!.deviceId)
  })

  it('storage 不可用（null）→ 返回 null（对齐官方 loadIdentity 降级形态）', async () => {
    const id = await loadDeviceIdentity(null)
    expect(id).toBeNull()
    // clear 也不抛
    expect(() => clearDeviceIdentity(null)).not.toThrow()
  })
})

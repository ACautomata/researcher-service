// #375 浏览器设备 Ed25519 身份 localStorage 持久化（ADR 0006 决定 3/6：面板只供「身份生成」回调）。
// 对齐官方 webchat-ui（ui/src/lib/nodes/index.ts）：
//   - key `openclaw-device-identity-v1`，值 `{version:1, deviceId, publicKey, privateKey, createdAtMs}`
//     （publicKey/privateKey = base64url 的 Ed25519 raw 32B/64B）
//   - deviceId = sha256(raw publicKey 32B).hex（网关侧与官方客户端一致的设备指纹）
//   - sign = Ed25519 签名（base64url）——网关逐字节比对 buildDeviceAuthPayloadV3 签名串
// 实现用 @noble/ed25519（keygen/sign 纯 JS）+ @noble/hashes（sha256）——**不依赖 Web Crypto**
// （crypto.subtle 仅安全上下文可用）：http://<lan-ip> 自托管面板与 jsdom 测试环境（无 crypto.subtle）
// 均可跑，身份生成不被非安全上下文卡死。

import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import type { GatewayBrowserDeviceIdentity } from '@openclaw/gateway-client/browser'
import { getSafeLocalStorage } from './localStorage'

// 对齐官方 webchat-ui 的 localStorage key（openclaw-device-identity-v1）。
export const DEVICE_IDENTITY_STORAGE_KEY = 'openclaw-device-identity-v1'

interface StoredIdentity {
  version: 1
  deviceId: string
  publicKey: string
  privateKey: string
  createdAtMs: number
}

// ---- base64url / hex 工具（与官方 webchat-ui 同构）----
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlDecode(input: string): Uint8Array {
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

// deviceId 指纹 = sha256(raw publicKey).hex。@noble/hashes 纯 JS，非安全上下文可用（见文件头注释）。
function fingerprintPublicKey(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey))
}

async function generateIdentity(): Promise<{ deviceId: string; publicKey: string; privateKey: string }> {
  // utils.randomSecretKey() 用 CSPRNG（浏览器 crypto.getRandomValues / Node 原生随机源）。
  const privateKey = utils.randomSecretKey()
  const publicKey = await getPublicKeyAsync(privateKey)
  const deviceId = fingerprintPublicKey(publicKey)
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  }
}

function parseStoredIdentity(raw: string | null): StoredIdentity | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredIdentity
    if (
      parsed?.version === 1 &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      return parsed
    }
  } catch {
    // 损坏存储 → 调用方重新生成
  }
  return null
}

function identityFromStored(stored: StoredIdentity): GatewayBrowserDeviceIdentity {
  return {
    deviceId: stored.deviceId,
    publicKey: stored.publicKey,
    sign: (payload: string) => signDevicePayload(stored.privateKey, payload),
  }
}

/**
 * 浏览器设备 Ed25519 身份——官方 `GatewayBrowserDeviceAuthLifecycle.loadIdentity` 形态。
 *
 * 读 localStorage → 校验（version/字段）→ deviceId 派生修复（公钥指纹与存储 deviceId 不符时修复落盘，
 * 对齐官方半损坏迁移语义）→ 复用；无/损坏 → 生成新身份并持久化。
 *
 * 同一 profile 多 tab 共享同一 localStorage → 共享同一设备身份（issue #371 用户故事 4）。
 * storage 不可用（隐私模式）→ 返回 null（上层降级为纯 bootstrap token 连接，不对应配对身份）。
 */
export async function loadDeviceIdentity(
  storage: Storage | null = getSafeLocalStorage(),
): Promise<GatewayBrowserDeviceIdentity | null> {
  if (!storage) return null
  try {
    const stored = parseStoredIdentity(storage.getItem(DEVICE_IDENTITY_STORAGE_KEY))
    if (stored) {
      const derivedId = fingerprintPublicKey(base64UrlDecode(stored.publicKey))
      if (derivedId !== stored.deviceId) {
        storage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify({ ...stored, deviceId: derivedId }))
      }
      return identityFromStored({ ...stored, deviceId: derivedId })
    }
  } catch {
    // 非法本地身份 → 下方重新生成
  }
  const identity = await generateIdentity()
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  }
  try {
    storage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // localStorage 写入失败（quota/受限实现）：本次会话仍用生成的身份，下次访问重新生成（对称内部修复分支）
  }
  return identityFromStored(stored)
}

/** Ed25519 签名（base64url）——网关对 buildDeviceAuthPayloadV3 的 `v3|…` 签名串逐字节校验。 */
export async function signDevicePayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url)
  const sig = await signAsync(new TextEncoder().encode(payload), key)
  return base64UrlEncode(sig)
}

/** 清除本地设备身份（「重置设备」路径；token 失效重配对只清 tokenStore，不必动身份）。 */
export function clearDeviceIdentity(storage: Storage | null = getSafeLocalStorage()): void {
  try {
    storage?.removeItem(DEVICE_IDENTITY_STORAGE_KEY)
  } catch {
    // 静默降级
  }
}

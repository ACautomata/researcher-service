// 端点白名单校验纯逻辑（731 §5.1 / #775）。双层校验共用同一套判定原语：
//   第一层（CRUD 时，models/service.ts）：zod URL 形态 → origin 精确匹配 + DNS 私网/环回拒绝；
//   第二层（运行时，runner/providerRegistry.ts + runner/whitelistedFetch.ts）：origin 复验 +
//   fetch wrapper 验最终请求 origin —— 本文件只出判定函数，错误码映射归调用方。
//
// 匹配语义：origin 精确匹配（scheme + host + port），不做路径/子域通配（防 attacker.example.com
// 绕过 example.com，731 §3.1）；host 比较大小写不敏感（DNS 语义；URL 构造本身已小写化 host）。
// DNS 检查：解析 host，命中私网/环回/链路本地地址即拒——防「借白名单条目名做内网探测」的变体
// （白名单内网端点（vLLM 自建）的 escape hatch = admin 显式 allowPrivate 标记位，首期不实现，
// 731 §5.1 原文）。解析失败（NXDOMAIN 等）按拒绝处理（fail-closed：无法确认安全的端点不放行）。

import { lookup as dnsLookupAll } from 'node:dns/promises'

// 白名单条目投影（provider_endpoints 行的判定面子集；Prisma 行结构兼容）。
export interface EndpointEntry {
  scheme: string
  host: string
  port: number | null // NULL = 该 scheme 的默认端口
}

// baseUrl 解析结果：port 为有效端口（显式端口或 scheme 默认端口，已折算）。
export interface ParsedEndpoint {
  scheme: string
  host: string
  port: number // 已折算默认端口（https→443 / http→80；其余 scheme 无默认 → -1 不可能匹配）
  origin: string // scheme://host[:explicit-port]（port 为默认端口时不带冒号，与 URL.origin 同形）
}

export function defaultPortOf(scheme: string): number {
  if (scheme === 'https') return 443
  if (scheme === 'http') return 80
  return -1
}

// 解析 baseUrl 为判定面；非 http(s) / 无 host / 不可解析 → null（调用方转 90002/40042）。
// new URL 的相对地址/裸 host 会抛、file: 等 scheme origin 为 'null'——统一拒。
export function parseEndpointOrigin(baseUrl: string): ParsedEndpoint | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname) return null
  const scheme = url.protocol.slice(0, -1) // 'https:' → 'https'
  const explicitPort = url.port === '' ? null : Number(url.port)
  const port = explicitPort ?? defaultPortOf(scheme)
  const origin = explicitPort === null ? `${scheme}://${url.hostname}` : `${scheme}://${url.hostname}:${explicitPort}`
  return { scheme, host: url.hostname, port, origin }
}

// origin 精确匹配（scheme + host + port；条目 port NULL = 默认端口）。
export function matchesEndpoint(parsed: ParsedEndpoint, entry: EndpointEntry): boolean {
  if (parsed.scheme !== entry.scheme) return false
  if (parsed.host.toLowerCase() !== entry.host.toLowerCase()) return false
  const entryPort = entry.port ?? defaultPortOf(entry.scheme)
  return parsed.port === entryPort
}

// 已解析 origin 对条目集的匹配（isOriginAllowed 的解析后内核心——调用方已持 ParsedEndpoint 时
// 复用，避免重复解析；providerRegistry.getModel 构造前复验走此形态）。
export function parsedOriginAllowed(parsed: ParsedEndpoint, endpoints: ReadonlyArray<EndpointEntry>): boolean {
  return endpoints.some((entry) => matchesEndpoint(parsed, entry))
}

export function isOriginAllowed(origin: string, endpoints: ReadonlyArray<EndpointEntry>): boolean {
  const parsed = parseEndpointOrigin(origin)
  if (!parsed) return false
  return parsedOriginAllowed(parsed, endpoints)
}

// 私网/环回/链路本地地址判定（731 §5.1 列举 + IPv4-mapped IPv6 与 ULA 等显式变体）。
// 只认字面量 IP；域名是否解析到私网由 DNS 检查负责（本函数消费解析结果）。
export function isPrivateAddress(address: string): boolean {
  const addr = address.trim().toLowerCase()
  // IPv4-mapped IPv6（::ffff:10.0.0.1）还原为 v4 再判（私网 host 伪装成 v6 形态绕过）
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (mapped) return isPrivateAddress(mapped[1])
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if ([a, b, Number(v4[3]), Number(v4[4])].some((o) => o > 255)) return true // 非法段按不安全处理
    if (a === 0) return true // 0.0.0.0/8（this-network，含 0.0.0.0）
    if (a === 10) return true // 10/8
    if (a === 127) return true // 127/8 环回
    if (a === 169 && b === 254) return true // 169.254/16 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT（运营商级内网）
    return false
  }
  // IPv6（含环回 ::1 / 链路本地 fe80::/10 / ULA fc00::/7 / 未指定 ::）
  const v6 = addr.replace(/^\[|\]$/g, '') // 容错方括号形态
  if (v6.includes(':')) {
    if (v6 === '::' || v6 === '::1') return true
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true
    return false
  }
  // 非 IP 字符串（本不应出现——lookup 返回 IP；保守按不安全处理）
  return true
}

// DNS 解析 Port（S3 接缝：测试注入 fake；生产 nodeDnsLookup）。
export type DnsLookup = (hostname: string) => Promise<string[]>

// 生产实现：全记录 lookup（A + AAAA）。node:dns/promises lookup all:true。
export const nodeDnsLookup: DnsLookup = async (hostname) => {
  const records = await dnsLookupAll(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

export type EndpointCheckVerdict =
  | { ok: true; origin: string }
  | { ok: false; reason: 'invalid_url' | 'not_in_allowlist' | 'dns_private' | 'dns_unresolvable'; message: string }

// 判定编排（不抛错——错误码映射归调用方：CRUD 层 90002 字段明细 / 运行时 40042）。
// 顺序：URL 形态 → origin 精确匹配 → DNS 私网拒绝（白名单未命中不泄露白名单内容）。
export async function checkEndpointAllowed(opts: {
  baseUrl: string
  endpoints: ReadonlyArray<EndpointEntry>
  resolveDns: DnsLookup
}): Promise<EndpointCheckVerdict> {
  const parsed = parseEndpointOrigin(opts.baseUrl)
  if (!parsed) {
    return { ok: false, reason: 'invalid_url', message: 'base_url 须为合法 URL（http/https，含 scheme://host）' }
  }
  if (!opts.endpoints.some((entry) => matchesEndpoint(parsed, entry))) {
    return { ok: false, reason: 'not_in_allowlist', message: 'base_url 端点不在白名单内，请联系管理员添加' }
  }
  let addresses: string[]
  try {
    addresses = await opts.resolveDns(parsed.host)
  } catch {
    return { ok: false, reason: 'dns_unresolvable', message: 'base_url 域名无法解析，无法确认端点安全' }
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'dns_unresolvable', message: 'base_url 域名无法解析，无法确认端点安全' }
  }
  if (addresses.some((addr) => isPrivateAddress(addr))) {
    return { ok: false, reason: 'dns_private', message: 'base_url 端点解析到内网/环回地址，已拒绝' }
  }
  return { ok: true, origin: parsed.origin }
}

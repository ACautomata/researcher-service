// 端点白名单双层校验的纯逻辑层（接缝 S3，#775 · 731 §5.1 逐条落地）。
//
// 威胁模型（731 §5.1 原文）：LLM key 由 runner 发往 provider 端点；若 baseUrl 可指向任意端点，
// key 即外送。双层校验：
//   第一层（CRUD 时，models/service.ts 经 assertCrudOriginAllowed 调用）：
//     zod URL 形态（validation/schemas.ts）→ origin 精确匹配 provider_endpoints →
//     DNS 解析拒绝私网/环回/链路本地（本文件纯函数 + 可注入 lookup）。
//   第二层（运行时，ProviderRegistry 实例构造复验 + createWhitelistFetch 包 SDK fetch）：
//     复验 origin ∈ 白名单（防 admin 直接改库绕过 API 层）→ fetch wrapper 校验**最终请求
//     origin** + `redirect: 'manual'` 禁跟随（防白名单端点 302 带 key 跳恶意端点）。
//   未命中：CRUD 层 → 90002 字段级（不泄露白名单内容）；运行时 → 40042。
//
// 本文件零网络依赖：DNS lookup 经 HostLookup 注入（生产 dns.promises.lookup，测试注 fake），
// fetch wrapper 的内层 fetch 亦可注入——S3 单测全纯逻辑。

import { lookup as dnsLookup } from 'node:dns/promises'
import { CODE } from '../codes'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

// 白名单条目形状（对齐 Prisma ProviderEndpoint：port NULL = scheme 默认端口）。
export interface EndpointEntry {
  readonly scheme: string
  readonly host: string
  readonly port: number | null
}

// 规范化 origin：小写 host + 有效端口（scheme 默认端口补齐——URL.port 对默认端口返 ''）。
export interface ParsedOrigin {
  readonly scheme: string // 'https' | 'http'（其余 scheme 在解析处拒绝）
  readonly host: string // 小写
  readonly port: number // 有效端口（http→80 / https→443 补齐）
}

// DNS 解析注入缝（测试注 fake 免真网络；生产 = dns.promises.lookup）。
export type HostLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>

export const defaultHostLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true })) as Array<{ address: string; family: number }>

// 运行时白名单未命中错误（40042）：run 失败、错误进事件流，不泄露白名单内容。
export class EndpointNotAllowedError extends Error {
  constructor(message = '端点不在白名单内，请求被拒绝') {
    super(message)
    this.name = 'EndpointNotAllowedError'
  }
  readonly code = CODE.PROVIDER_ENDPOINT_NOT_ALLOWED // 40042
}

// ---------------------------------------------------------------------------
// origin 解析与精确匹配（731 §3.1：scheme+host+port 精确匹配，禁路径/子域通配）
// ---------------------------------------------------------------------------

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 }

// 条目/端口的有效端口：NULL = scheme 默认端口（731 §3.1）。originInWhitelist / fetch wrapper
// 集合键 / provider_endpoints NULL-port 等价查重 三处同源——改规则只动这里。
export function effectivePort(scheme: string, port: number | null): number {
  const fallback = DEFAULT_PORTS[`${scheme}:`]
  if (fallback === undefined) throw new Error(`不支持的 scheme: ${scheme}`)
  return port ?? fallback
}

// new URL 解析 + 规范化。非法 URL / 非 http(s) scheme / 用户名密码片段 → 抛 Error
//（调用方按 90002 字段级处理，models/service 已包 try/catch；白名单匹配调用前已过滤）。
export function parseHttpOrigin(rawUrl: string): ParsedOrigin {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`base_url 不是合法 URL: ${rawUrl}`)
  }
  const scheme = url.protocol // 'https:' / 'http:'
  if (scheme !== 'https:' && scheme !== 'http:') {
    throw new Error(`base_url 仅支持 http/https: ${rawUrl}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`base_url 不允许内嵌凭证: ${rawUrl}`)
  }
  const defaultPort = DEFAULT_PORTS[scheme]
  if (defaultPort === undefined) throw new Error(`不支持的 scheme: ${scheme}`)
  const explicit = url.port === '' ? null : Number(url.port)
  if (explicit !== null && (!Number.isInteger(explicit) || explicit < 1 || explicit > 65535)) {
    throw new Error(`base_url 端口非法: ${rawUrl}`)
  }
  return { scheme: scheme.slice(0, -1), host: url.hostname.toLowerCase(), port: explicit ?? defaultPort }
}

// origin 精确匹配：entry.port NULL = 该 scheme 默认端口（effectivePort 同源）；host 精确
//（小写比较，禁子域通配——attacker.example.com 不匹配 example.com）。
export function originMatchesEntry(origin: ParsedOrigin, entry: EndpointEntry): boolean {
  if (origin.scheme !== entry.scheme) return false
  if (origin.host !== entry.host.toLowerCase()) return false
  return origin.port === effectivePort(entry.scheme, entry.port)
}

export function originInWhitelist(origin: ParsedOrigin, entries: ReadonlyArray<EndpointEntry>): boolean {
  return entries.some((e) => originMatchesEntry(origin, e))
}

// 规范化 origin 字符串 'scheme://host:port'（fetch wrapper 的集合键；恒带显式端口）。
export function originKey(origin: ParsedOrigin): string {
  return `${origin.scheme}://${origin.host}:${origin.port}`
}

// ---------------------------------------------------------------------------
// 私网/环回/链路本地判定（731 §5.1：防借白名单条目名做内网探测）
// ---------------------------------------------------------------------------

export type IpClassification = 'public' | 'blocked'

// 判定单个已规范化 IP（纯函数）。blocked 集（#775 钉，按 SSRF 惯例从严）：
//   IPv4 —— 0.0.0.0/8（unspecified）、10/8、172.16/12、192.168/16、127/8（环回）、
//          169.254/16（链路本地）、100.64/10（CGNAT 共享地址空间）、224/4（组播，含 255 广播）。
//   IPv6 —— ::/128（unspecified）、::1（环回）、fc00::/7（ULA 私网）、fe80::/10（链路本地）、
//          ff00::/8（组播）、IPv4 映射地址（::ffff:a.b.c.d）按映射后 IPv4 再判。
// 反代/CDN 出网的真实公网地址不在此列——白名单只挡「runner 直连即触内网」的面。
export function classifyIp(ip: string): IpClassification {
  const v6MapMatch = /^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (v6MapMatch) return classifyIp(v6MapMatch[1])
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return 'blocked' // 畸形
    if (a === 0) return 'blocked'
    if (a === 10) return 'blocked'
    if (a === 172 && b >= 16 && b <= 31) return 'blocked'
    if (a === 192 && b === 168) return 'blocked'
    if (a === 127) return 'blocked'
    if (a === 169 && b === 254) return 'blocked'
    if (a === 100 && b >= 64 && b <= 127) return 'blocked'
    if (a >= 224) return 'blocked' // 组播 224/4（224–255，含受限广播）
    return 'public'
  }
  const c = ip.toLowerCase()
  if (c.includes(':')) {
    if (c === '::' || c === '::1') return 'blocked'
    if (/^f[cd][0-9a-f]{2}:/.test(c)) return 'blocked' // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(c)) return 'blocked' // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(c)) return 'blocked' // ff00::/8
    return 'public'
  }
  return 'blocked' // 非 IP 形态（畸形 DNS 结果）一律从严
}

// ---------------------------------------------------------------------------
// 第一层（CRUD）：origin 匹配 + DNS 私网拒绝。抛 EnvelopeError(90002, 字段级 base_url)。
// ---------------------------------------------------------------------------

export interface CrudOriginCheckOptions {
  readonly lookup: HostLookup
  readonly allowPrivate: boolean // env ALLOW_PRIVATE_PROVIDER_ENDPOINTS（dev 自建 vLLM 逃生门）
}

export class OriginCheckError extends Error {
  constructor(
    readonly fieldMessage: string,
    readonly kind: 'parse' | 'whitelist' | 'dns',
  ) {
    super(fieldMessage)
    this.name = 'OriginCheckError'
  }
}

// host 级私网校验（checkOriginForCrud 的 DNS 段独立成函数——provider_endpoints admin CRUD
// 直接对 host 做同一校验，两处安全语义同源）：IP 字面量 dns.lookup 原样返回（无网络），
// 域名则解析全部地址，任一 blocked / 解析失败 / 无结果 → OriginCheckError('dns')（fail-closed）。
export async function checkHostAllowed(
  host: string,
  opts: Pick<CrudOriginCheckOptions, 'lookup' | 'allowPrivate'>,
): Promise<void> {
  if (opts.allowPrivate) return
  const hostname = host.toLowerCase()
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = await opts.lookup(hostname)
  } catch {
    throw new OriginCheckError('域名解析失败，无法校验端点安全性', 'dns')
  }
  if (addrs.length === 0) {
    throw new OriginCheckError('域名解析无结果，无法校验端点安全性', 'dns')
  }
  const blocked = addrs.find((a) => classifyIp(a.address) === 'blocked')
  if (blocked) {
    throw new OriginCheckError(
      `解析到内网/环回地址（${blocked.address}），禁止配置（自建私网端点须管理员显式放行）`,
      'dns',
    )
  }
}

// CRUD 层白名单校验（models/service create/update 事务前调用）：
//   ① 解析 origin（失败 → 90002 字段级）；
//   ② 精确匹配 provider_endpoints（未命中 → 90002 字段级，不泄露白名单内容）；
//   ③ allowPrivate=false 时 DNS 解析全部地址，任一私网/环回/链路本地/解析失败 → 90002 字段级
//     （fail-closed：解析失败宁可拒——防「DNS 投毒绕过私网检测」面）。
export async function checkOriginForCrud(
  baseUrl: string,
  entries: ReadonlyArray<EndpointEntry>,
  opts: CrudOriginCheckOptions,
): Promise<void> {
  let origin: ParsedOrigin
  try {
    origin = parseHttpOrigin(baseUrl)
  } catch (e) {
    throw new OriginCheckError((e as Error).message, 'parse')
  }
  if (!originInWhitelist(origin, entries)) {
    throw new OriginCheckError('base_url 的 origin 不在面板端点白名单内', 'whitelist')
  }
  await checkHostAllowed(origin.host, opts)
}

// ---------------------------------------------------------------------------
// 第二层（运行时）：白名单 fetch wrapper
// ---------------------------------------------------------------------------

// 白名单 fetch wrapper（731 §5.1 第二层 ②）：
//   - 每次请求校验**最终请求 URL** 的 origin ∈ allowedOrigins（'scheme://host:port' 键集合，
//     由 ProviderRegistry 在实例构造时按快照白名单派生）；
//   - 强制 redirect: 'manual' 禁跟随——白名单端点若 302 跳走，响应须显式拒绝（带 key 跟随即外送）；
//   - 未命中 / 出现重定向响应 → 抛 EndpointNotAllowedError（40042），run 失败、错误进事件流。
// inner fetch 可注入（测试注 spy），默认 globalThis.fetch。
const REDIRECT_REJECTED = '端点返回重定向，已被禁止（防止凭证随跳转外送）'
export function createWhitelistFetch(
  allowedOrigins: ReadonlySet<string>,
  innerFetch: typeof fetch = (...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args),
): typeof fetch {
  const guarded: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let origin: ParsedOrigin
    try {
      origin = parseHttpOrigin(url)
    } catch {
      throw new EndpointNotAllowedError()
    }
    if (!allowedOrigins.has(originKey(origin))) {
      throw new EndpointNotAllowedError()
    }
    // 禁跟随重定向：manual 下 SDK 收到 3xx 响应本身；任何 location 头 = origin 漂移 = 拒绝。
    // inner fetch 不假设恒为 undici（undici 返回真实 3xx）：合规 fetch 对 redirect:'manual'
    // 可返回 opaqueredirect 过滤响应（status 0、headers 空）——跳转已发生但目标不可读，同按
    // 重定向拒（fail-closed，#812 打捞 #809）。
    const response = await innerFetch(input, { ...init, redirect: 'manual' })
    if (response.status === 0) {
      throw new EndpointNotAllowedError(REDIRECT_REJECTED)
    }
    const location = response.headers?.get?.('location')
    if (response.status >= 300 && response.status < 400 && location !== null && location !== undefined) {
      throw new EndpointNotAllowedError(REDIRECT_REJECTED)
    }
    return response
  }
  return guarded
}

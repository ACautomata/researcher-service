// 端点白名单校验纯逻辑单测（#775 · 731 §5.1 · S3 零新接缝层）。
// 覆盖：URL 解析（scheme/host/port 折算）、origin 精确匹配（端口默认值/显式端口/大小写）、
// 私网/环回/链路本地地址判定（v4 段列举 + IPv6 + IPv4-mapped 伪装）、checkEndpointAllowed
// 编排（未命中不发 DNS / NXDOMAIN fail-closed / 私网拒绝）。DNS 经注入 fake——零网络依赖。

import { describe, it, expect } from 'vitest'
import {
  checkEndpointAllowed,
  defaultPortOf,
  isOriginAllowed,
  isPrivateAddress,
  matchesEndpoint,
  parseEndpointOrigin,
  type DnsLookup,
  type EndpointEntry,
} from '../src/models/endpointAllowlist'

const ep = (scheme: string, host: string, port: number | null): EndpointEntry => ({ scheme, host, port })

describe('parseEndpointOrigin（URL 形态解析）', () => {
  it('https 显式端口 / 默认端口折算', () => {
    expect(parseEndpointOrigin('https://api.example.com:8443/v1')).toEqual({
      scheme: 'https',
      host: 'api.example.com',
      port: 8443,
      origin: 'https://api.example.com:8443',
    })
    expect(parseEndpointOrigin('https://api.example.com/v1')).toEqual({
      scheme: 'https',
      host: 'api.example.com',
      port: 443,
      origin: 'https://api.example.com',
    })
    expect(parseEndpointOrigin('http://api.example.com')).toEqual({
      scheme: 'http',
      host: 'api.example.com',
      port: 80,
      origin: 'http://api.example.com',
    })
  })

  it('host 大小写归一（URL 构造语义）', () => {
    expect(parseEndpointOrigin('https://API.Example.COM/v1')?.host).toBe('api.example.com')
  })

  it('非法形态 → null（裸 host / 相对路径 / 非 http(s) scheme / 空串）', () => {
    for (const bad of ['api.example.com/v1', '/relative', 'ftp://api.example.com', 'file:///etc', '', 'not a url']) {
      expect(parseEndpointOrigin(bad)).toBeNull()
    }
  })

  it('defaultPortOf：https 443 / http 80 / 其余 -1', () => {
    expect(defaultPortOf('https')).toBe(443)
    expect(defaultPortOf('http')).toBe(80)
    expect(defaultPortOf('ftp')).toBe(-1)
  })
})

describe('matchesEndpoint / isOriginAllowed（origin 精确匹配）', () => {
  const endpoints = [ep('https', 'api.minimaxi.com', null), ep('https', 'vllm.local', 8443), ep('http', 'dev.local', 8080)]

  it('scheme+host+port 全等命中（条目 NULL port = scheme 默认端口）', () => {
    const parsed = parseEndpointOrigin('https://api.minimaxi.com/anthropic')!
    expect(matchesEndpoint(parsed, endpoints[0])).toBe(true)
    expect(isOriginAllowed('https://api.minimaxi.com/anthropic', endpoints)).toBe(true)
  })

  it('路径不参与匹配（origin 级）', () => {
    expect(isOriginAllowed('https://api.minimaxi.com/any/path?q=1', endpoints)).toBe(true)
  })

  it('端口不匹配 / scheme 不匹配 / 子域不匹配（禁通配）→ 拒', () => {
    expect(isOriginAllowed('https://api.minimaxi.com:8443', endpoints)).toBe(false)
    expect(isOriginAllowed('http://api.minimaxi.com', endpoints)).toBe(false)
    expect(isOriginAllowed('https://evil.api.minimaxi.com', endpoints)).toBe(false)
    expect(isOriginAllowed('https://api.minimaxi.com.evil.io', endpoints)).toBe(false)
    expect(isOriginAllowed('https://vllm.local', endpoints)).toBe(false) // 显式 8443 条目 vs 默认 443
    expect(isOriginAllowed('https://vllm.local:8443', endpoints)).toBe(true)
    expect(isOriginAllowed('http://dev.local:8080', endpoints)).toBe(true)
  })

  it('非法 origin / 空表 → 拒', () => {
    expect(isOriginAllowed('not a url', endpoints)).toBe(false)
    expect(isOriginAllowed('https://api.minimaxi.com', [])).toBe(false)
  })
})

describe('isPrivateAddress（私网/环回/链路本地判定）', () => {
  it('731 §5.1 列举段全拒', () => {
    const private4 = [
      '0.0.0.0', // this-network（含通配绑定）
      '10.0.0.1',
      '10.255.255.255',
      '127.0.0.1',
      '127.8.8.8',
      '169.254.1.1', // 链路本地
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT（运营商级内网，等）
    ]
    for (const addr of private4) expect(isPrivateAddress(addr)).toBe(true)
  })

  it('公网 v4 放行', () => {
    for (const addr of ['8.8.8.8', '203.0.113.10', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1']) {
      expect(isPrivateAddress(addr)).toBe(false)
    }
  })

  it('非法 v4 段（>255）按不安全处理', () => {
    expect(isPrivateAddress('999.1.1.1')).toBe(true)
  })

  it('IPv6：环回/未指定/链路本地/ULA 拒，公网放行', () => {
    for (const addr of ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isPrivateAddress(addr)).toBe(true)
    }
    expect(isPrivateAddress('2606:4700::1')).toBe(false)
  })

  it('IPv4-mapped IPv6 伪装形态还原判定（::ffff:10.0.0.1 → 私网）', () => {
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('方括号形态容错', () => {
    expect(isPrivateAddress('[::1]')).toBe(true)
    expect(isPrivateAddress('[fe80::1]')).toBe(true)
  })

  it('非 IP 字符串保守按不安全处理（lookup 应返回 IP；防御纵深）', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})

describe('checkEndpointAllowed（判定编排）', () => {
  const endpoints = [ep('https', 'api.minimaxi.com', null), ep('https', 'private.example.com', null)]

  const okDns: DnsLookup = async () => ['203.0.113.10']
  const nxDomain: DnsLookup = async () => {
    throw new Error('ENOTFOUND')
  }

  it('命中 + 公网解析 → ok（origin 回传）', async () => {
    const v = await checkEndpointAllowed({ baseUrl: 'https://api.minimaxi.com/anthropic', endpoints, resolveDns: okDns })
    expect(v).toEqual({ ok: true, origin: 'https://api.minimaxi.com' })
  })

  it('非法 URL → invalid_url（不发 DNS）', async () => {
    let dnsCalls = 0
    const counting: DnsLookup = async () => {
      dnsCalls += 1
      return []
    }
    const v = await checkEndpointAllowed({ baseUrl: 'no-scheme', endpoints, resolveDns: counting })
    expect(v).toMatchObject({ ok: false, reason: 'invalid_url' })
    expect(dnsCalls).toBe(0)
  })

  it('未命中白名单 → not_in_allowlist（不发 DNS）', async () => {
    let dnsCalls = 0
    const counting: DnsLookup = async () => {
      dnsCalls += 1
      return []
    }
    const v = await checkEndpointAllowed({ baseUrl: 'https://elsewhere.io/v1', endpoints, resolveDns: counting })
    expect(v).toMatchObject({ ok: false, reason: 'not_in_allowlist' })
    expect(dnsCalls).toBe(0)
  })

  it('NXDOMAIN → dns_unresolvable（fail-closed）', async () => {
    const v = await checkEndpointAllowed({ baseUrl: 'https://api.minimaxi.com', endpoints, resolveDns: nxDomain })
    expect(v).toMatchObject({ ok: false, reason: 'dns_unresolvable' })
  })

  it('解析空集 → dns_unresolvable', async () => {
    const v = await checkEndpointAllowed({ baseUrl: 'https://api.minimaxi.com', endpoints, resolveDns: async () => [] })
    expect(v).toMatchObject({ ok: false, reason: 'dns_unresolvable' })
  })

  it('解析到私网 → dns_private（多记录任一命中即拒）', async () => {
    const v1 = await checkEndpointAllowed({
      baseUrl: 'https://private.example.com/v1',
      endpoints,
      resolveDns: async () => ['203.0.113.1', '192.168.0.9'],
    })
    expect(v1).toMatchObject({ ok: false, reason: 'dns_private' })
    const v2 = await checkEndpointAllowed({
      baseUrl: 'https://private.example.com/v1',
      endpoints,
      resolveDns: async () => ['::ffff:10.1.2.3'],
    })
    expect(v2).toMatchObject({ ok: false, reason: 'dns_private' })
  })
})

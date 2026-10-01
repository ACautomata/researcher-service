// 端点白名单纯逻辑单测（接缝 S3，#775 验收 ②「白名单双层校验 S3 单测」）：
//   origin 解析/精确匹配（默认端口补齐、子域不通配、大小写、凭证内嵌拒绝）
//   私网/环回/链路本地/CGNAT/组播/IPv4 映射 IPv6 判定
//   CRUD 层：白名单未命中 / DNS 私网拒绝 / 解析失败 fail-closed / allowPrivate 逃生门
//   运行时 fetch wrapper：最终请求 origin 校验 / redirect manual 禁随 / 3xx 显式拒绝

import { describe, it, expect, vi } from 'vitest'
import {
  parseHttpOrigin,
  originMatchesEntry,
  originInWhitelist,
  originKey,
  classifyIp,
  checkOriginForCrud,
  createWhitelistFetch,
  EndpointNotAllowedError,
  OriginCheckError,
  type HostLookup,
} from '../src/runner/allowlist'

describe('parseHttpOrigin', () => {
  it('解析 https origin：host 小写化、默认端口补齐 443', () => {
    expect(parseHttpOrigin('https://API.Minimaxi.com/anthropic')).toEqual({
      scheme: 'https',
      host: 'api.minimaxi.com',
      port: 443,
    })
  })

  it('显式端口保留（含非标端口）', () => {
    expect(parseHttpOrigin('https://api.example.com:8443/v1/chat')).toEqual({
      scheme: 'https',
      host: 'api.example.com',
      port: 8443,
    })
  })

  it('http 默认端口 80', () => {
    expect(parseHttpOrigin('http://127.0.0.1:8080/vllm')).toEqual({
      scheme: 'http',
      host: '127.0.0.1',
      port: 8080,
    })
    expect(parseHttpOrigin('http://internal.example.com/api').port).toBe(80)
  })

  it('路径/query 不参与 origin——同一 origin 不同路径等值', () => {
    const a = parseHttpOrigin('https://api.minimaxi.com/anthropic')
    const b = parseHttpOrigin('https://api.minimaxi.com/v1/chat?x=1')
    expect(originKey(a)).toBe(originKey(b))
  })

  it('非法 URL / 非 http(s) scheme / 内嵌凭证 → 抛错', () => {
    expect(() => parseHttpOrigin('not-a-url')).toThrow()
    expect(() => parseHttpOrigin('ftp://example.com')).toThrow('仅支持 http/https')
    expect(() => parseHttpOrigin('wss://example.com')).toThrow('仅支持 http/https')
    expect(() => parseHttpOrigin('https://user:pass@example.com')).toThrow('内嵌凭证')
  })

  it('畸形端口拒绝', () => {
    expect(() => parseHttpOrigin('https://example.com:99999/x')).toThrow()
  })
})

describe('originMatchesEntry（精确匹配）', () => {
  const entry = { scheme: 'https', host: 'api.minimaxi.com', port: null } // NULL = 默认端口

  it('条目 NULL 端口匹配 scheme 默认端口', () => {
    expect(originMatchesEntry(parseHttpOrigin('https://api.minimaxi.com/x'), entry)).toBe(true)
  })

  it('子域不通配：attacker.minimaxi.com 不匹配', () => {
    expect(originMatchesEntry(parseHttpOrigin('https://attacker.minimaxi.com'), entry)).toBe(false)
  })

  it('父域不通配：minimaxi.com 不匹配 api.minimaxi.com 条目', () => {
    expect(originMatchesEntry(parseHttpOrigin('https://minimaxi.com'), entry)).toBe(false)
  })

  it('scheme 必须精确：https 条目不匹配 http', () => {
    expect(originMatchesEntry(parseHttpOrigin('http://api.minimaxi.com:443'), entry)).toBe(false)
  })

  it('条目显式端口须相等', () => {
    const withPort = { scheme: 'https', host: 'api.minimaxi.com', port: 8443 }
    expect(originMatchesEntry(parseHttpOrigin('https://api.minimaxi.com:8443'), withPort)).toBe(true)
    expect(originMatchesEntry(parseHttpOrigin('https://api.minimaxi.com'), withPort)).toBe(false)
    expect(originMatchesEntry(parseHttpOrigin('https://api.minimaxi.com:8444'), withPort)).toBe(false)
  })

  it('条目 host 大小写不敏感', () => {
    const upper = { scheme: 'https', host: 'API.MINIMAXI.COM', port: null }
    expect(originMatchesEntry(parseHttpOrigin('https://api.minimaxi.com'), upper)).toBe(true)
  })

  it('originInWhitelist 任一命中即可', () => {
    const entries = [
      { scheme: 'https', host: 'other.example.com', port: null },
      { scheme: 'http', host: 'api.minimaxi.com', port: null },
    ]
    expect(originInWhitelist(parseHttpOrigin('https://api.minimaxi.com'), entries)).toBe(false)
    expect(originInWhitelist(parseHttpOrigin('http://api.minimaxi.com'), entries)).toBe(true)
    expect(originInWhitelist(parseHttpOrigin('https://nobody.example.com'), entries)).toBe(false)
  })
})

describe('classifyIp（私网/环回拒绝）', () => {
  it('IPv4 私网段全部 blocked', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(classifyIp(ip), ip).toBe('blocked')
    }
  })

  it('环回 / 链路本地 / unspecified / CGNAT / 组播 blocked', () => {
    for (const ip of ['127.0.0.1', '127.255.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255']) {
      expect(classifyIp(ip), ip).toBe('blocked')
    }
  })

  it('公网 IPv4 public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '11.0.0.1']) {
      expect(classifyIp(ip), ip).toBe('public')
    }
  })

  it('边界：172.15/172.32 非私网；100.63/100.128 非 CGNAT', () => {
    expect(classifyIp('172.15.0.1')).toBe('public')
    expect(classifyIp('172.32.0.1')).toBe('public')
    expect(classifyIp('100.63.0.1')).toBe('public')
    expect(classifyIp('100.128.0.1')).toBe('public')
  })

  it('IPv6 环回 / ULA / 链路本地 / unspecified / 组播 blocked', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fc12::1', 'fe80::1', 'febf::1', 'ff02::1']) {
      expect(classifyIp(ip), ip).toBe('blocked')
    }
  })

  it('公网 IPv6 public', () => {
    expect(classifyIp('2606:4700:4700::1111')).toBe('public')
    expect(classifyIp('2001:4860:4860::8888')).toBe('public')
  })

  it('IPv4 映射 IPv6 按映射后地址判定（::ffff:10.0.0.1 = 私网）', () => {
    expect(classifyIp('::ffff:10.0.0.1')).toBe('blocked')
    expect(classifyIp('0:0:0:0:0:ffff:8.8.8.8')).toBe('public')
  })

  it('畸形/非 IP 形态一律从严 blocked', () => {
    expect(classifyIp('999.1.1.1')).toBe('blocked')
    expect(classifyIp('not-an-ip')).toBe('blocked')
  })
})

describe('checkOriginForCrud（第一层：CRUD 校验）', () => {
  const entries = [{ scheme: 'https', host: 'api.minimaxi.com', port: null }]
  const publicLookup: HostLookup = async () => [{ address: '1.2.3.4', family: 4 }]

  it('白名单命中 + 公网解析 → 通过', async () => {
    await expect(
      checkOriginForCrud('https://api.minimaxi.com/anthropic', entries, {
        lookup: publicLookup,
        allowPrivate: false,
      }),
    ).resolves.toBeUndefined()
  })

  it('白名单未命中 → whitelist 错误（不泄露白名单内容）', async () => {
    try {
      await checkOriginForCrud('https://evil.example.com', entries, {
        lookup: publicLookup,
        allowPrivate: false,
      })
      expect.unreachable()
    } catch (e) {
      const err = e as OriginCheckError
      expect(err.kind).toBe('whitelist')
      expect(err.fieldMessage).not.toContain('minimaxi')
    }
  })

  it('URL 非法 → parse 错误', async () => {
    try {
      await checkOriginForCrud('::bad::', entries, { lookup: publicLookup, allowPrivate: false })
      expect.unreachable()
    } catch (e) {
      expect((e as OriginCheckError).kind).toBe('parse')
    }
  })

  it('白名单命中但 DNS 解析到私网 → dns 错误（防借白名单条目名做内网探测）', async () => {
    const privateLookup: HostLookup = async () => [
      { address: '1.2.3.4', family: 4 },
      { address: '10.0.0.9', family: 4 }, // 任一私网即拒
    ]
    try {
      await checkOriginForCrud('https://api.minimaxi.com', entries, {
        lookup: privateLookup,
        allowPrivate: false,
      })
      expect.unreachable()
    } catch (e) {
      const err = e as OriginCheckError
      expect(err.kind).toBe('dns')
      expect(err.fieldMessage).toContain('10.0.0.9')
    }
  })

  it('DNS 解析失败 → fail-closed dns 错误（防 DNS 投毒绕过）', async () => {
    const failingLookup: HostLookup = async () => {
      throw new Error('ENOTFOUND')
    }
    try {
      await checkOriginForCrud('https://api.minimaxi.com', entries, {
        lookup: failingLookup,
        allowPrivate: false,
      })
      expect.unreachable()
    } catch (e) {
      expect((e as OriginCheckError).kind).toBe('dns')
      expect((e as OriginCheckError).fieldMessage).toContain('解析失败')
    }
  })

  it('DNS 无结果 → dns 错误', async () => {
    try {
      await checkOriginForCrud('https://api.minimaxi.com', entries, {
        lookup: async () => [],
        allowPrivate: false,
      })
      expect.unreachable()
    } catch (e) {
      expect((e as OriginCheckError).kind).toBe('dns')
    }
  })

  it('allowPrivate=true（dev 自建 vLLM 逃生门）→ 跳过 DNS 私网检查', async () => {
    await expect(
      checkOriginForCrud('http://127.0.0.1:8080', [{ scheme: 'http', host: '127.0.0.1', port: 8080 }], {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        allowPrivate: true,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('createWhitelistFetch（第二层：运行时 fetch wrapper）', () => {
  const allowed = new Set(['https://api.minimaxi.com:443'])
  const okResponse = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })

  it('命中白名单 origin 的请求放行（带显式/默认端口都按有效端口规范化）', async () => {
    const inner = vi.fn(async () => okResponse())
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    const res = (await guarded('https://api.minimaxi.com/v1/chat')) as Response
    expect(res.status).toBe(200)
    expect(inner).toHaveBeenCalledTimes(1)
    // redirect 强制 manual
    expect((inner.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
  })

  it('非白名单 origin 直接拒绝，内层 fetch 未被调用（key 不外送）', async () => {
    const inner = vi.fn(async () => okResponse())
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    await expect(guarded('https://attacker.example.com/collect')).rejects.toBeInstanceOf(
      EndpointNotAllowedError,
    )
    expect(inner).not.toHaveBeenCalled()
  })

  it('Request 对象入参同样校验（SDK 实际调用形态）', async () => {
    const inner = vi.fn(async () => okResponse())
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    await expect(
      guarded(new Request('https://evil.example.com'), { redirect: 'manual' }),
    ).rejects.toBeInstanceOf(EndpointNotAllowedError)
  })

  it('3xx + location = 重定向禁随，显式拒绝（防白名单端点 302 带 key 跳走）', async () => {
    const inner = vi.fn(
      async () =>
        new Response('', { status: 302, headers: { location: 'https://attacker.example.com/' } }),
    )
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    await expect(guarded('https://api.minimaxi.com/v1')).rejects.toThrow('重定向')
  })

  it('3xx 无 location（畸形）不拒——非重定向外送面', async () => {
    const inner = vi.fn(async () => new Response('', { status: 301 }))
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    const res = (await guarded('https://api.minimaxi.com/v1')) as Response
    expect(res.status).toBe(301)
  })

  it('undici opaqueredirect（redirect manual 下 status 0、headers 不可读）→ 同按重定向拒（不假设 inner 恒为 undici）', async () => {
    // Response 构造器不收 status 0（spec 限 200–599）——按 opaqueredirect 过滤响应形状造假
    const opaque = { status: 0, headers: { get: () => null } } as unknown as Response
    const inner = vi.fn(async () => opaque)
    const guarded = createWhitelistFetch(allowed, inner as unknown as typeof fetch)
    await expect(guarded('https://api.minimaxi.com/v1')).rejects.toThrow('重定向')
  })

  it('错误携带 40042 码（run 失败面）', async () => {
    const guarded = createWhitelistFetch(allowed, (async () => okResponse()) as typeof fetch)
    try {
      await guarded('https://evil.example.com')
      expect.unreachable()
    } catch (e) {
      expect((e as EndpointNotAllowedError).code).toBe(40042)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 接缝：静态断言（issue #773 AC4；先例 prodDeploy.test.ts）——SSE 部署清单同步。
// 准据 = #747 C 节：X-Accel-Buffering: no 进部署清单；nginx 侧等价机制 =
// proxy_buffering off（禁代理层攒帧）+ 长读超时（心跳 20s 间隙不被掐断）。
const ROOT = resolve(process.cwd(), '..')

function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

// 取 location 块体（从匹配行到下一个块级 `    }`）。
function locationBlock(conf: string, path: string): string {
  const idx = conf.indexOf(`location ${path}`)
  expect(idx, `nginx.conf 缺 location ${path}`).toBeGreaterThanOrEqual(0)
  const end = conf.indexOf('\n    }', idx)
  expect(end, `location ${path} 未闭合`).toBeGreaterThan(idx)
  return conf.slice(idx, end)
}

describe('SSE 端点部署清单（issue #773 AC4，#747 C 节 X-Accel-Buffering 进部署清单）', () => {
  const conf = readRepoFile('frontend/nginx.conf')

  it('events 端点专属精确匹配 location（先于 /api/ 泛前缀被 nginx 选中）', () => {
    expect(conf).toMatch(/location = \/api\/v1\/events\s*\{/)
  })

  it('location 块内 proxy_buffering off（禁代理层攒帧——应用层 X-Accel-Buffering 的 Braces）', () => {
    const block = locationBlock(conf, '= /api/v1/events')
    expect(block).toMatch(/proxy_buffering off;/)
  })

  it('location 块内长读超时（≥3600s 对齐 /ws/，20s 心跳间隙不触发代理 504）', () => {
    const block = locationBlock(conf, '= /api/v1/events')
    expect(block).toMatch(/proxy_read_timeout 3600s;/)
    expect(block).toMatch(/proxy_send_timeout 3600s;/)
  })

  it('仍反代到 backend_api（server:8001 控制面，不外抛其他上游）', () => {
    const block = locationBlock(conf, '= /api/v1/events')
    expect(block).toMatch(/proxy_pass http:\/\/backend_api;/)
  })

  it('DEPLOY.md 超时分层段同步 SSE 端点说明（改任一层超时须同步全链）', () => {
    const md = readRepoFile('deploy/DEPLOY.md')
    expect(md).toContain('/api/v1/events')
  })
})

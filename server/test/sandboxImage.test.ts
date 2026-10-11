// 沙箱镜像 poppler 支路静态断言（#908 · 853 §3.2#2 镜像验收项；文本断言先例同 wikiImage.test.ts：
// 断言对象是 deploy/sandbox-image/ 的声明式产物 Dockerfile，不触真 docker——构建期断言由
// Dockerfile RUN 执行，此处兜底防回归）。
// 与 wiki 镜像的差异（有意）：版本 tag 不取自 FROM 基线——debian:bookworm-slim 是移动 tag，
// 违反 wiki 镜像「版本 tag 一经发布不可移动」约定；故 CD 只推 :latest + :<sha>（钉版引用按
// sha tag），本测试不锁版本双源。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd(), '..')

function readDockerfile(): string {
  return readFileSync(join(ROOT, 'deploy/sandbox-image/Dockerfile'), 'utf8')
}

describe('沙箱镜像 poppler 支路（#908 · extractPdfText 镜像前提）', () => {
  it('FROM debian 基线（含 poppler-utils apt 源；bookworm = config.ts 派生镜像调研基线同族）', () => {
    const fromRef = readDockerfile().match(/^FROM\s+(\S+)/m)?.[1]
    expect(fromRef).toMatch(/^debian:bookworm-slim$/)
  })

  it('poppler-utils + poppler-data 安装 + 构建期 pdftotext 双断言（command -v + -v 版本面）', () => {
    const df = readDockerfile()
    expect(df).toContain('apt-get install -y --no-install-recommends poppler-utils poppler-data')
    expect(df).toContain('command -v pdftotext')
    expect(df).toContain('pdftotext -v')
    // apt 索引不残留镜像层（bookworm-slim 卫生面）
    expect(df).toContain('rm -rf /var/lib/apt/lists/*')
  })

  it('保留 busybox 缺省承载的最小 applet 断言集（runner backend 超时 kill / 保活 / /lab 预置前提）', () => {
    const df = readDockerfile()
    for (const applet of ['sh', 'timeout', 'test', 'tail', 'mkdir', 'rm', 'cat']) {
      expect(df).toContain(`command -v ${applet}`)
    }
  })

  it('零骨架 COPY（与 wiki 镜像零初始化同口径——/lab 由控制面 putArchive 预置）', () => {
    const df = readDockerfile()
    expect(df).not.toMatch(/^\s*COPY\s/m)
    expect(df).not.toMatch(/^\s*ADD\s/m)
  })
})

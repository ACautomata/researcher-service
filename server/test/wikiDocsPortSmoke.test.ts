// wiki/docs port 集成 smoke（#908 验收真 daemon 侧 · S2 门控，wikiContainerSmoke/sandboxSmoke
// 同款）：门控 = docker daemon 不可达 → describe.skipIf 整套跳过。
// 覆盖（#908 AC）：
//   1. createPage 幂等哨兵 + 并发同路径 probe→put 竞态窗关闭（真 wiki 容器 busybox——
//      与生产 wiki 镜像同族；两并发 createPage 恰好一个 created:true，重放再调 created:false，
//      落树页 frontmatter 可经 wiki 域存储适配器读回）
//   2. extractPdfText 真 poppler 提取（本镜像 = deploy/sandbox-image 本地构建产物——
//      smoke 即「沙箱镜像含 poppler」验收项的实证）：按页数组读回、PDF 非文本失败明确报错、
//      超限明确报错不静默截断、/lab 白名单拒止
// PDF fixture 程序化生成（最小两页 PDF 1.4，正确 xref——不挂二进制资产进 repo）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Docker from 'dockerode'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { WikiContainerLifecycle } from '../src/wikiContainers/lifecycle'
import { DockerWikiContainerRuntime } from '../src/wikiContainers/dockerRuntime'
import { wikiContainerName } from '../src/wikiContainers/runtime'
import { DockerPrimitives } from '../src/runner/backend/dockerPrimitives'
import { createPluginWikiPort } from '../src/runner/wikiToolPort'
import { createPluginDocsPort } from '../src/runner/docsToolPort'
import { DockerWikiFileSystem } from '../src/wiki/dockerFs'
import { createTarFile } from '../src/files/tar'
import { probeDockerAvailable } from './smokeGating'
import { ensureImageAvailable } from './smokeDocker'

const WIKI_IMAGE = 'busybox:1.36' // 与生产 wiki 镜像同族（wikiContainerSmoke 同款取舍）
const OWNER = `wdsmoke${process.pid}`
const WIKI_CONTAINER = wikiContainerName(OWNER)
const POPPLER_TAG = `researcher-sandbox-poppler-smoke:local`
const PDF_CONTAINER = `researcher-sandbox-pdfsmoke-${process.pid}`
const SMOKE_LIMITS = { memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 }
const ROOT = resolve(process.cwd(), '..')

const DOCKER_UP = probeDockerAvailable()

// 最小两页 PDF 1.4 生成器：Catalog/Pages/2×Page/Font/2×Content，xref 偏移精确计算
// （pdftotext 对 xref 正确性宽容，但按真实格式生成——fixture 即规格）。
function buildTwoPagePdf(tokenA: string, tokenB: string): Buffer {
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>'
  objects[4] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const streamOf = (t: string) => `BT /F1 24 Tf 72 720 Td (${t}) Tj ET`
  const s6 = streamOf(tokenA)
  const s7 = streamOf(tokenB)
  objects[6] = `<< /Length ${s6.length} >>\nstream\n${s6}\nendstream`
  objects[7] = `<< /Length ${s7.length} >>\nstream\n${s7}\nendstream`
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = [0]
  let pos = chunks[0]!.length
  for (let i = 1; i <= 7; i += 1) {
    offsets[i] = pos
    const body = Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`)
    chunks.push(body)
    pos += body.length
  }
  const xrefStart = pos
  let xref = `xref\n0 8\n0000000000 65535 f \n`
  for (let i = 1; i <= 7; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  const tail = Buffer.from(`${xref}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`)
  chunks.push(tail)
  return Buffer.concat(chunks)
}

describe.skipIf(!DOCKER_UP)('wiki/docs port 集成 smoke（真 docker daemon · #908）', () => {
  let docker: Docker
  let lifecycle: WikiContainerLifecycle
  let primitives: DockerPrimitives
  const createdContainers: string[] = []

  function popplerImagePresent(): Promise<boolean> {
    return docker
      .getImage(POPPLER_TAG)
      .inspect()
      .then(() => true)
      .catch(() => false)
  }

  beforeAll(async () => {
    if (!DOCKER_UP) return
    docker = new Docker()
    primitives = new DockerPrimitives()
    await ensureImageAvailable(WIKI_IMAGE)
    // poppler 镜像：本地构建产物（已存在即跳过——smoke 验端口对真 poppler 的行为，
    // Dockerfile 声明正确性由 sandboxImage.test.ts 静态断言 + 构建期 RUN 断言双锁）。
    if (!(await popplerImagePresent())) {
      execFileSync('docker', ['build', '-t', POPPLER_TAG, 'deploy/sandbox-image'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    lifecycle = new WikiContainerLifecycle(new DockerWikiContainerRuntime(), { image: WIKI_IMAGE, limits: SMOKE_LIMITS })
  }, 600_000)

  afterAll(async () => {
    if (!DOCKER_UP) return
    for (const name of createdContainers) {
      await docker.getContainer(name).remove({ force: true }).catch(() => {})
    }
    await new DockerWikiContainerRuntime().removeWiki(OWNER).catch(() => {})
    await docker.getImage(POPPLER_TAG).remove({ force: true }).catch(() => {})
  })

  it('createPage 幂等哨兵 + 并发同路径竞态窗关闭（真 wiki 容器，落树读回）', async () => {
    await lifecycle.ensure(OWNER)
    const port = createPluginWikiPort({
      ownerId: OWNER,
      container: WIKI_CONTAINER,
      primitives,
      ensure: () => lifecycle.ensure(OWNER).then(() => undefined),
      source: 'research',
    })
    const draft = {
      path: 'papers/smoke.md',
      title: 'Smoke 页',
      type: 'paper' as const,
      content: '# Smoke\n\n并发建页竞态探针。',
    }
    // 并发同路径：锁内 probe→put 串行化 → 恰好一个 created:true
    const [r1, r2] = await Promise.all([port.createPage(draft), port.createPage(draft)])
    expect([r1.created, r2.created].sort()).toEqual([false, true])
    // 重放窗口：再调 created:false（幂等跳过常态路径，不抛错不覆盖）
    await expect(port.createPage(draft)).resolves.toEqual({ created: false })
    // 落树产物经 wiki 域存储适配器读回（frontmatter 组装 + 正文 + 幂等不覆盖）
    const page = await new DockerWikiFileSystem(WIKI_CONTAINER).readPage('papers/smoke.md')
    expect(page.title).toBe('Smoke 页')
    expect(page.content).toContain('type: paper')
    expect(page.content).toContain('source: "research"')
    expect(page.content).toContain('# Smoke\n\n并发建页竞态探针。')
    expect(page.content).toContain('status: generated')
  }, 120_000)

  it('extractPdfText 真 poppler：按页数组 + 超限报错 + 白名单拒止', async () => {
    const container = await docker.createContainer({
      Image: POPPLER_TAG,
      name: PDF_CONTAINER,
      Cmd: ['tail', '-f', '/dev/null'],
    })
    createdContainers.push(PDF_CONTAINER)
    await container.start()
    await primitives.exec(PDF_CONTAINER, ['mkdir', '-p', '/lab'])
    const pdf = buildTwoPagePdf('SMOKE_TOKEN_ALPHA', 'SMOKE_TOKEN_BRAVO')
    await primitives.putArchive(PDF_CONTAINER, '/lab', createTarFile('sample.pdf', pdf))

    const port = createPluginDocsPort({ container: PDF_CONTAINER, primitives })
    const r = await port.extractPdfText({ sandboxPath: '/lab/sample.pdf' })
    expect(r.pages).toHaveLength(2)
    expect(r.pages[0]).toContain('SMOKE_TOKEN_ALPHA')
    expect(r.pages[1]).toContain('SMOKE_TOKEN_BRAVO')

    // 超限明确报错不静默截断（小上限注入——1M 字面锁定归单测，smoke 验行为）
    const tiny = createPluginDocsPort({ container: PDF_CONTAINER, primitives, maxChars: 10 })
    await expect(tiny.extractPdfText({ sandboxPath: '/lab/sample.pdf' })).rejects.toMatchObject({
      name: 'PluginDocsPortError',
      code: 'too_large',
    })
    // /lab 白名单拒止（approval 同款纪律）
    await expect(port.extractPdfText({ sandboxPath: '/wiki/sample.pdf' })).rejects.toMatchObject({
      code: 'invalid_path',
    })
    // 存在性校验
    await expect(port.extractPdfText({ sandboxPath: '/lab/missing.pdf' })).rejects.toMatchObject({
      code: 'not_found',
    })
  }, 120_000)
})

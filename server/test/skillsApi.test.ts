// #1056 B 票 Skill 市场 REST（S1 信封级 · #1054 D1/D5）：上传（管线拒收 → 80002
// data.reasons 结构化透传）/ 市场列表（类别 + 子串筛选）/ 详情 / 下载（重打包 zip
// 字节往返）/ 删除（作者/admin 权限矩阵 + 80041 同码防探测）/ 启用位（幂等 + 80041）。
// 装配沿 attachments.test.ts 先例：setupTestApp 拿 prisma/request，再 createApp 注入
// skills 服务重建 app（同一 DB）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SuperTest, Test } from 'supertest'
import AdmZip from 'adm-zip'
import { setupTestApp, type TestContext } from './setup'
import { seedAdmin, seedUser, login, bearer } from './helpers'
import { SkillMarketService } from '../src/skills/service'
import { CODE } from '../src/codes'

function skillMd(name = 'paper-writing', category = 'writing'): string {
  return `---\nname: ${name}\ndescription: 论文写作辅助技能\ncategory: ${category}\n---\n\n# 正文\n`
}

async function upload(
  request: SuperTest<Test>,
  access: string | undefined,
  name: string,
  opts: { raw?: Buffer; category?: string; description?: string } = {},
): Promise<Test> {
  const md = opts.raw
    ? opts.raw
    : skillMd(name, opts.category ?? 'writing').replace('论文写作辅助技能', opts.description ?? '论文写作辅助技能')
  // 上传的是「真 zip 包」（管线按 zip 解析）——SKILL.md 打包进包根
  const zip = new AdmZip()
  zip.addFile('SKILL.md', typeof md === 'string' ? Buffer.from(md, 'utf8') : md)
  return request
    .post('/api/v1/skills')
    .set(bearer(access))
    .attach('file', zip.toBuffer(), { filename: 'skill.zip', contentType: 'application/zip' })
}

describe('#1056 Skill 市场 REST（S1）', () => {
  let ctx: TestContext
  let request: SuperTest<Test>

  beforeAll(async () => {
    ctx = await setupTestApp()
    const skills = new SkillMarketService({ prisma: ctx.prisma })
    const { createApp } = await import('../src/app')
    const supertestMod = (await import('supertest')).default
    const app = createApp({ prisma: ctx.prisma, skills: { service: skills } })
    request = supertestMod(app) as unknown as SuperTest<Test>
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it('上传 happy：80002 之外的 code 0 + {id,name,category}；行 + 文件 BLOB 落库', async () => {
    await seedUser(ctx.prisma, 'sk-up', 'pw-sk-secure')
    const l = await login(request, 'sk-up', 'pw-sk-secure')
    const res = await upload(request, l.access, 'paper-writing')
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.name).toBe('paper-writing')
    expect(res.body.data.category).toBe('writing')
    expect(res.body.data.id).toMatch(/^\d+$/) // 雪花
    // 行 + 文件落库（BLOB 可读回）
    const pkg = await ctx.prisma.skillPackage.findUnique({
      where: { id: res.body.data.id },
      include: { files: true },
    })
    expect(pkg).toMatchObject({ name: 'paper-writing', category: 'writing', status: 'published', uploaderRole: 'user' })
    expect(pkg!.files.some((f) => f.path === 'SKILL.md' && f.content.length > 0)).toBe(true)
  })

  it('拒收透传：缺 SKILL.md → 80002 + data.reasons[]（A 票结构化原因直达上传者）', async () => {
    await seedUser(ctx.prisma, 'sk-bad', 'pw-sk-secure')
    const l = await login(request, 'sk-bad', 'pw-sk-secure')
    const zip = new AdmZip()
    zip.addFile('assets/only.md', Buffer.from('# x\n'))
    const res = await request
      .post('/api/v1/skills')
      .set(bearer(l.access))
      .attach('file', zip.toBuffer(), { filename: 'skill.zip', contentType: 'application/zip' })
    expect(res.body.code).toBe(CODE.SKILL_PACKAGE_INVALID)
    expect(res.body.data.reasons.some((r: string) => r.includes('缺少 SKILL.md'))).toBe(true)
  })

  it('保留字 name → 80002（registry + 内置命令同源纪律）', async () => {
    await seedUser(ctx.prisma, 'sk-res', 'pw-sk-secure')
    const l = await login(request, 'sk-res', 'pw-sk-secure')
    const res = await upload(request, l.access, 'judge')
    expect(res.body.code).toBe(CODE.SKILL_PACKAGE_INVALID)
    expect(res.body.data.reasons.some((r: string) => r.includes('保留字'))).toBe(true)
  })

  it('重名仲裁：同 name 二次上传 → 80002（P2002 兜底路径）；category 不在枚举 → 80002', async () => {
    await seedUser(ctx.prisma, 'sk-dup', 'pw-sk-secure')
    const l = await login(request, 'sk-dup', 'pw-sk-secure')
    const first = await upload(request, l.access, 'dup-skill', { category: 'research' })
    expect(first.body.code).toBe(0)
    const second = await upload(request, l.access, 'dup-skill', { category: 'research' })
    expect(second.body.code).toBe(CODE.SKILL_PACKAGE_INVALID)
    expect(second.body.data.reasons.some((r: string) => r.includes('已被占用'))).toBe(true)
    // 枚举外类别（D5 固定枚举）
    const badCat = await upload(request, l.access, 'cat-skill', { category: 'hacking' })
    expect(badCat.body.code).toBe(CODE.SKILL_PACKAGE_INVALID)
    expect(badCat.body.data === undefined || badCat.body.data.reasons.length > 0).toBe(true)
  })

  it('缺 file 字段 → 90002', async () => {
    await seedUser(ctx.prisma, 'sk-nofile', 'pw-sk-secure')
    const l = await login(request, 'sk-nofile', 'pw-sk-secure')
    const res = await request.post('/api/v1/skills').set(bearer(l.access))
    expect(res.body.code).toBe(90002)
  })

  it('市场列表：类别筛选 + 名称/描述子串搜索；未登录 10001', async () => {
    await seedUser(ctx.prisma, 'sk-list', 'pw-sk-secure')
    const l = await login(request, 'sk-list', 'pw-sk-secure')
    await upload(request, l.access, 'writing-a', { category: 'writing' })
    await upload(request, l.access, 'data-b', { category: 'data', description: '数据分析必备' })

    const all = await request.get('/api/v1/skills').set(bearer(l.access))
    expect(all.body.code).toBe(0)
    expect(all.body.data.length).toBeGreaterThanOrEqual(2)
    const byCat = await request.get('/api/v1/skills?category=data').set(bearer(l.access))
    expect(byCat.body.data.every((i: { category: string }) => i.category === 'data')).toBe(true)
    const byQ = await request.get('/api/v1/skills?q=数据分析').set(bearer(l.access))
    expect(byQ.body.data.some((i: { description: string }) => i.description === '数据分析必备')).toBe(true)
    const none = await request.get('/api/v1/skills?category=nonexistent').set(bearer(l.access))
    expect(none.body.data).toEqual([])

    const anon = await request.get('/api/v1/skills')
    expect(anon.body.code).toBe(10001)
  })

  it('详情 + 下载往返：上传→下载 zip 解包字节一致；未知 id → 80041', async () => {
    await seedUser(ctx.prisma, 'sk-dl', 'pw-sk-secure')
    const l = await login(request, 'sk-dl', 'pw-sk-secure')
    const up = await upload(request, l.access, 'dl-skill')
    const id = up.body.data.id

    const detail = await request.get(`/api/v1/skills/${id}`).set(bearer(l.access))
    expect(detail.body.code).toBe(0)
    expect(detail.body.data.files.some((f: { path: string }) => f.path === 'SKILL.md')).toBe(true)

    // application/zip 非 JSON：superagent 默认不进 Buffer——显式二进制 parse 收整段字节
    const dl = await request
      .get(`/api/v1/skills/${id}/download`)
      .set(bearer(l.access))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(dl.status).toBe(200)
    expect(dl.headers['content-type']).toContain('application/zip')
    // 解包还原 → SKILL.md 内容与上传一致（往返契约）
    const back = new AdmZip(dl.body)
    const md = back.getEntry('SKILL.md')!
    expect(md.getData().toString('utf8')).toBe(skillMd('dl-skill'))

    const missing = await request.get('/api/v1/skills/999999/download').set(bearer(l.access))
    expect(missing.body.code).toBe(CODE.SKILL_NOT_FOUND)
  })

  it('删除权限矩阵：他人 → 80041（与不存在同码）；admin → 放行；删除后市场消失', async () => {
    const owner = await seedUser(ctx.prisma, 'sk-del', 'pw-sk-secure')
    await seedUser(ctx.prisma, 'sk-del-other', 'pw-sk-secure')
    const lo = await login(request, 'sk-del', 'pw-sk-secure')
    const up = await upload(request, lo.access, 'deleteme', { category: 'other' })
    const id = up.body.data.id

    // 他人删除 → 80041；删不存在 → 80041（逐字节同码防探测）
    const lx = await login(request, 'sk-del-other', 'pw-sk-secure')
    const cross = await request.delete(`/api/v1/skills/${id}`).set(bearer(lx.access))
    const missing = await request.delete('/api/v1/skills/999999').set(bearer(lx.access))
    expect(cross.body.code).toBe(CODE.SKILL_NOT_FOUND)
    expect(cross.body).toEqual(missing.body)

    // admin 删除 → 放行（市场消失 + 下载随之 80041）
    await seedAdmin(ctx.prisma, 'sk-admin', 'pw-sk-secure')
    const la = await login(request, 'sk-admin', 'pw-sk-secure')
    void owner
    const adminDel = await request.delete(`/api/v1/skills/${id}`).set(bearer(la.access))
    expect(adminDel.body.code).toBe(0)
    const after = await request.get(`/api/v1/skills/${id}/download`).set(bearer(la.access))
    expect(after.body.code).toBe(CODE.SKILL_NOT_FOUND)
  })

  it('启用位：幂等 upsert（true→false→true）；未知 id → 80041；级联删除后启用行随删', async () => {
    const u = await seedUser(ctx.prisma, 'sk-en', 'pw-sk-secure')
    const l = await login(request, 'sk-en', 'pw-sk-secure')
    const up = await upload(request, l.access, 'enable-skill', { category: 'literature' })
    const id = up.body.data.id

    for (const enabled of [true, false, true]) {
      const res = await request.put(`/api/v1/skills/${id}/enablement`).set(bearer(l.access)).send({ enabled })
      expect(res.body.code).toBe(0)
      expect(res.body.data).toEqual({ skillId: id, enabled })
    }
    const row = await ctx.prisma.skillEnablement.findUnique({
      where: { ownerId_skillId: { ownerId: u.id, skillId: id } },
    })
    expect(row?.enabled).toBe(true)

    const unknown = await request
      .put('/api/v1/skills/999999/enablement')
      .set(bearer(l.access))
      .send({ enabled: true })
    expect(unknown.body.code).toBe(CODE.SKILL_NOT_FOUND)

    // 删除包 → 启用行随删（deletePackage 显式清 skillId 维度）
    await request.delete(`/api/v1/skills/${id}`).set(bearer(l.access))
    const gone = await ctx.prisma.skillEnablement.findUnique({
      where: { ownerId_skillId: { ownerId: u.id, skillId: id } },
    })
    expect(gone).toBeNull()
  })

  it('未认证上传 → 10001', async () => {
    const res = await request.post('/api/v1/skills')
    expect(res.body.code).toBe(10001)
  })
})

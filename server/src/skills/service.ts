// Skill 市场域业务服务（#1056 B 票 · #1054 D1 全员直发）：上传/列表/详情/下载/删除/启用位。
// 六端点的语义单点（路由层零业务，wiki 先例）：
//   - 上传 = A 票管线全量校验（parseSkillPackage 结构化拒收 → 80002 data.reasons）+ 雪花 id +
//     sha256 + 事务落 package/files 行（D1：所有登录用户直发 published）。
//   - 列表/详情 = 市场全员可见（所有登录用户；D1 市场语义——可见 ≠ 本人启用）。
//   - 下载 = 按包重打包 zip 原生字节（packSkillZip，成功豁免信封——figures PNG 先例）。
//   - 删除 = 作者本人或 admin（级联：files 随 FK 删；enablements 按 skillId 显式清——无 FK）。
//   - 启用位 = per-user 幂等 upsert（对齐 plugins 80040 纪律：包不存在 → 80041 同码防探测）。

import { createHash } from 'node:crypto'
import type { PrismaClient, User } from '../generated/prisma/client'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { snowflakeId } from '../attachments/snowflake'
import { packSkillZip, parseSkillPackage } from './zip'
import { SKILL_CATEGORIES } from './values'

// 市场列表行（GET /skills 输出；前端市场列表渲染面）。
export interface SkillMarketItem {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly uploaderName: string
  readonly fileCount: number
  readonly publishedAt: string
  // 请求者维度启用位（#1058 D 票开关初始态）：市场「发布」≠ 本人「启用」——列表/详情都
  // 带当前用户的 per-user 位（未启用缺省 false），前端开关据此渲染。
  readonly enabled: boolean
}

export interface SkillPackageDetail extends SkillMarketItem {
  readonly files: Array<{ path: string; mime: string; size: number }>
}

export interface SkillMarketServiceDeps {
  readonly prisma: PrismaClient
}

export class SkillMarketService {
  constructor(private readonly deps: SkillMarketServiceDeps) {}

  // ---- 上传（multipart zip 字节）----
  // A 票管线全量校验（含整包大小守卫）→ 雪花 id + 整包 sha256 → 事务落 package + files（字节即
  // BLOB）。name 唯一约束 P2002 → 80002（reasons 明示重名，与管线拒收同形状）。
  async createPackage(
    user: Pick<User, 'id' | 'role'>,
    p: { zip: Buffer },
  ): Promise<{ id: string; name: string; category: string }> {
    const parsed = parseSkillPackage(p.zip)
    if (!parsed.ok) throw fail(CODE.SKILL_PACKAGE_INVALID, 'Skill 包校验未通过', { reasons: parsed.reasons })

    const id = snowflakeId()
    const sha256 = createHash('sha256').update(p.zip).digest('hex')
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        await tx.skillPackage.create({
          data: {
            id,
            name: parsed.manifest.name,
            description: parsed.manifest.description,
            category: parsed.manifest.category,
            uploaderId: user.id,
            uploaderRole: user.role,
            sha256,
            status: 'published',
          },
        })
        await tx.skillFile.createMany({
          data: parsed.files.map((f) => ({
            packageId: id,
            path: f.path,
            mime: f.mime,
            size: f.size,
            sha256: f.sha256,
            // adm-zip getData 产 Buffer<ArrayBufferLike>——Prisma Bytes 收窄到 Uint8Array<ArrayBuffer>
            content: new Uint8Array(f.content),
          })),
        })
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw fail(CODE.SKILL_PACKAGE_INVALID, 'Skill name 已被使用', {
          reasons: [`name 已被占用: ${parsed.manifest.name}`],
        })
      }
      throw e
    }
    return { id, name: parsed.manifest.name, category: parsed.manifest.category }
  }

  // ---- 市场列表：published 包，按类别 + 名称/描述子串筛选（D5 中心筛选面）----
  async listPackages(p: { category?: string; q?: string; viewerId: string }): Promise<SkillMarketItem[]> {
    const rows = await this.deps.prisma.skillPackage.findMany({
      where: {
        status: 'published',
        ...(p.category !== undefined && p.category !== '' ? { category: p.category } : {}),
        ...(p.q !== undefined && p.q !== ''
          ? { OR: [{ name: { contains: p.q } }, { description: { contains: p.q } }] }
          : {}),
      },
      orderBy: { publishedAt: 'desc' },
      include: { files: { select: { path: true } } },
    })
    // 上传者名批量预取（避免 N+1——routes 层 pairing 预取先例）
    const uploaderIds = [...new Set(rows.map((r) => r.uploaderId))]
    const users = await this.deps.prisma.user.findMany({
      where: { id: { in: uploaderIds } },
      select: { id: true, username: true },
    })
    const nameById = new Map(users.map((u) => [u.id, u.username]))
    // 请求者启用位批量预取（无 relation，按 ownerId 直查 enabled 行）——前端开关初始态
    const enabledRows = await this.deps.prisma.skillEnablement.findMany({
      where: { ownerId: p.viewerId, enabled: true },
      select: { skillId: true },
    })
    const enabledSet = new Set(enabledRows.map((r) => r.skillId))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      uploaderName: nameById.get(r.uploaderId) ?? '',
      fileCount: r.files.length,
      publishedAt: r.publishedAt.toISOString(),
      enabled: enabledSet.has(r.id),
    }))
  }

  // ---- 详情：文件清单 + 元数据（市场全员可见；不存在 → 80041 同码防探测）----
  async getPackage(skillId: string, viewerId: string): Promise<SkillPackageDetail> {
    const row = await this.deps.prisma.skillPackage.findUnique({
      where: { id: skillId },
      include: { files: { select: { path: true, mime: true, size: true } }, },
    })
    if (!row || row.status !== 'published') throw fail(CODE.SKILL_NOT_FOUND)
    const uploader = await this.deps.prisma.user.findUnique({
      where: { id: row.uploaderId },
      select: { username: true },
    })
    const enablement = await this.deps.prisma.skillEnablement.findUnique({
      where: { ownerId_skillId: { ownerId: viewerId, skillId } },
      select: { enabled: true },
    })
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      uploaderName: uploader?.username ?? '',
      fileCount: row.files.length,
      publishedAt: row.publishedAt.toISOString(),
      enabled: enablement?.enabled === true,
      files: [...row.files].sort((a, b) => a.path.localeCompare(b.path)),
    }
  }

  // ---- 下载：按包重打包 zip 原生字节（B 票验收「上传→下载 zip 解包字节一致」）----
  async downloadPackage(skillId: string): Promise<{ name: string; buf: Buffer }> {
    const row = await this.deps.prisma.skillPackage.findUnique({
      where: { id: skillId },
      include: { files: true },
    })
    if (!row || row.status !== 'published') throw fail(CODE.SKILL_NOT_FOUND)
    const buf = packSkillZip(
      [...row.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => ({ path: f.path, content: Buffer.from(f.content) })),
    )
    return { name: row.name, buf }
  }

  // ---- 删除：作者本人或 admin；enablements 按 skillId 显式清（无 FK）----
  async deletePackage(user: Pick<User, 'id' | 'role'>, skillId: string): Promise<void> {
    const row = await this.deps.prisma.skillPackage.findUnique({ where: { id: skillId } })
    // 不存在 vs 越权同码 80041 防探测（对齐 plugins 80040 纪律）
    if (!row || (user.role !== 'admin' && row.uploaderId !== user.id)) {
      throw fail(CODE.SKILL_NOT_FOUND)
    }
    await this.deps.prisma.$transaction([
      this.deps.prisma.skillEnablement.deleteMany({ where: { skillId } }),
      this.deps.prisma.skillPackage.delete({ where: { id: skillId } }), // files 随 FK 级联
    ])
  }

  // ---- 启用位：per-user 幂等 upsert（D4；包不存在 → 80041 同码防探测）----
  async setEnablement(
    user: Pick<User, 'id'>,
    skillId: string,
    enabled: boolean,
  ): Promise<{ skillId: string; enabled: boolean }> {
    const row = await this.deps.prisma.skillPackage.findUnique({ where: { id: skillId } })
    if (!row || row.status !== 'published') throw fail(CODE.SKILL_NOT_FOUND)
    await this.deps.prisma.skillEnablement.upsert({
      where: { ownerId_skillId: { ownerId: user.id, skillId } },
      create: { ownerId: user.id, skillId, enabled },
      update: { enabled },
    })
    return { skillId, enabled }
  }

  // ---- 类别枚举透传（D5；前端上传单选的数据源）----
  static categories(): readonly string[] {
    return SKILL_CATEGORIES
  }
}

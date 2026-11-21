// #1055 A 票（Skill 市场存储与数据模型）S3 纯逻辑测试：
//   1) zip 管线防护清单逐条用例（#1054 D2——每条拒收原因独立可断言）
//   2) pack↔parse 往返字节级一致（下载端点还原的契约前提）
//   3) 三表落库 parity：fresh（init.sql）与增量（runIncrementalSchema 镜像）两路径列集一致
//      （对齐 schemaLanggraphFoundation.test.ts 的 parity 保险纪律——镜像漂移即测试红）

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { packSkillZip, parseSkillPackage, parseSkillFrontmatter, safeRelativePath } from '../src/skills/zip'
import {
  SKILL_ALLOWED_EXTENSIONS,
  SKILL_BODY_MAX_BYTES,
  SKILL_CATEGORIES,
  SKILL_ENTRY_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_MANIFEST_PATH,
  SKILL_PACKAGE_MAX_BYTES,
} from '../src/skills/values'
import { runIncrementalSchema } from '../scripts/lib/incremental-schema.mjs'

const INIT_SQL = readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8')

// 合法 SKILL.md（frontmatter + 正文）
function skillMd(name = 'paper-writing', category = 'writing'): string {
  return `---\nname: ${name}\ndescription: 论文写作辅助技能\ncategory: ${category}\n---\n\n# 正文\n写作指南……\n`
}

// 构造合法包（默认 = SKILL.md + 一个资源文件），测试可覆盖条目
function makeZip(entries: ReadonlyArray<{ name: string; data: string | Buffer }>): Buffer {
  const zip = new AdmZip()
  for (const e of entries) zip.addFile(e.name, Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8'))
  return zip.toBuffer()
}

function validEntries(): { name: string; data: string | Buffer }[] {
  return [
    { name: SKILL_MANIFEST_PATH, data: skillMd() },
    { name: 'assets/guide.md', data: '# 指南\n' },
  ]
}

// ---- 手工 STORE 法 zip 写入器（测试专用）----
// adm-zip addFile 会归一化坏路径，无法构造「原始名条目」的包；此处按 ZIP 规范直写字节
//（STORE 不压缩 + CRC32），条目名逐字保留——覆盖解析侧的穿越攻击面。
let CRC_TABLE: number[] | null = null
function crc32(buf: Buffer): number {
  if (CRC_TABLE === null) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function rawZip(entries: ReadonlyArray<{ name: string; data: string | Buffer }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method = STORE
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed
    local.writeUInt32LE(data.length, 22) // uncompressed
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // central directory signature
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10) // method = STORE
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, name)
    offset += local.length + name.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16) // central directory offset
  return Buffer.concat([...parts, centralBuf, eocd])
}

describe('#1055 A 票 zip 管线（S3 纯逻辑）', () => {
  it('happy path：合法包解析通过（manifest 三字段 + 文件清单/mime/sha）', () => {
    const res = parseSkillPackage(makeZip(validEntries()))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.manifest).toEqual({ name: 'paper-writing', description: '论文写作辅助技能', category: 'writing' })
    expect(res.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'assets/guide.md'].sort())
    expect(res.files[0].mime).toBe('text/markdown')
    expect(res.files[1].mime).toBe('text/markdown')
    expect(res.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(res.files.every((f) => f.size === f.content.length)).toBe(true)
  })

  it('整包过大（>1MB）→ 拒收（高熵 base64 使 zip 体积超限）', () => {
    const big = randomBytes(Math.ceil(SKILL_PACKAGE_MAX_BYTES)).toString('base64') // ~1.33MB 文本
    const zip = makeZip([{ name: SKILL_MANIFEST_PATH, data: skillMd() }, { name: 'assets/big.txt', data: big }])
    expect(zip.length).toBeGreaterThan(SKILL_PACKAGE_MAX_BYTES)
    const res = parseSkillPackage(zip)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('整包过大'))).toBe(true)
  })

  it('单文件过大（>256KB）→ 拒收（整包仍 <1MB）', () => {
    const big = randomBytes(Math.ceil(SKILL_FILE_MAX_BYTES * 1.2)).toString('base64') // ~320KB
    const zip = makeZip([{ name: SKILL_MANIFEST_PATH, data: skillMd() }, { name: 'assets/big.txt', data: big }])
    expect(zip.length).toBeLessThan(SKILL_PACKAGE_MAX_BYTES)
    const res = parseSkillPackage(zip)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('单文件过大'))).toBe(true)
  })

  it('条目数超限（>50）→ 拒收', () => {
    const entries = [{ name: SKILL_MANIFEST_PATH, data: skillMd() }]
    for (let i = 0; i <= SKILL_ENTRY_MAX; i++) entries.push({ name: `assets/f${i}.md`, data: `# ${i}\n` })
    expect(entries.length).toBeGreaterThan(SKILL_ENTRY_MAX)
    const res = parseSkillPackage(makeZip(entries))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('文件数超限'))).toBe(true)
  })

  it('路径穿越（解析侧攻击面）：手工 zip 保留原始条目名 → 逐条拒收', () => {
    // adm-zip addFile 会归一化坏路径（写入语义），但**读取外来 zip 原样保留条目名**——
    // 恶意客户端可构造 `../` 条目。此处以手工 STORE 法 zip 逐字写入原始名，覆盖真实攻击面。
    const res = parseSkillPackage(rawZip([
      { name: '../escape.md', data: 'x' },
      { name: 'a\\b.md', data: 'x' },
      { name: '/abs.md', data: 'x' },
      { name: 'a/./c.md', data: 'x' },
      { name: SKILL_MANIFEST_PATH, data: skillMd() },
    ]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.filter((r) => r.includes('非法路径')).length).toBe(4)
  })

  it('safeRelativePath 纯函数：穿越/绝对/反斜杠/空段/NUL 全拒；合法相对路径归一通过', () => {
    expect(safeRelativePath('../escape.md')).toBeNull()
    expect(safeRelativePath('a/../../b.md')).toBeNull()
    expect(safeRelativePath('/abs.md')).toBeNull()
    expect(safeRelativePath('C:/evil.md')).toBeNull()
    expect(safeRelativePath('a\\b.md')).toBeNull()
    expect(safeRelativePath('a/./c.md')).toBeNull()
    expect(safeRelativePath('a//b.md')).toBeNull()
    expect(safeRelativePath('a\u0000b.md')).toBeNull()
    expect(safeRelativePath('assets/guide.md')).toBe('assets/guide.md')
    expect(safeRelativePath('SKILL.md')).toBe('SKILL.md')
  })

  it('白名单外扩展名 → 拒收（exe/无扩展名）', () => {
    const res = parseSkillPackage(makeZip([
      { name: SKILL_MANIFEST_PATH, data: skillMd() },
      { name: 'evil.exe', data: 'MZ' },
      { name: 'noext', data: 'x' },
    ]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.filter((r) => r.includes('不允许的文件类型')).length).toBe(2)
    expect(res.reasons.join('\n')).toContain(SKILL_ALLOWED_EXTENSIONS.join(' '))
  })

  it('缺 SKILL.md → 拒收', () => {
    const res = parseSkillPackage(makeZip([{ name: 'assets/only.md', data: '# x\n' }]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('缺少 SKILL.md'))).toBe(true)
  })

  it('frontmatter 校验：缺 name/description/category、category 不在枚举、name 保留字/过长 → 各自拒收', () => {
    const missing = parseSkillPackage(makeZip([{ name: SKILL_MANIFEST_PATH, data: '---\ndescription: x\ncategory: writing\n---\n\n# x\n' }]))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reasons.some((r) => r.includes('缺少 name'))).toBe(true)

    const badCategory = parseSkillPackage(makeZip([{ name: SKILL_MANIFEST_PATH, data: skillMd('s1', 'hacking') }]))
    expect(badCategory.ok).toBe(false)
    if (!badCategory.ok) expect(badCategory.reasons.some((r) => r.includes('category 不在枚举'))).toBe(true)

    const reserved = parseSkillPackage(makeZip([{ name: SKILL_MANIFEST_PATH, data: skillMd('judge') }]))
    expect(reserved.ok).toBe(false)
    if (!reserved.ok) expect(reserved.reasons.some((r) => r.includes('保留字'))).toBe(true)

    const longName = parseSkillPackage(makeZip([{ name: SKILL_MANIFEST_PATH, data: skillMd('x'.repeat(80)) }]))
    expect(longName.ok).toBe(false)
    if (!longName.ok) expect(longName.reasons.some((r) => r.includes('name 过长'))).toBe(true)
  })

  it('非 zip 字节 → 明确拒收（不抛模糊错误）', () => {
    const res = parseSkillPackage(Buffer.from('this is not a zip at all'))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('不是合法的 zip'))).toBe(true)
  })

  it('SKILL.md 正文过大（>64KB）→ 拒收', () => {
    const bigBody = `---\nname: s\ndescription: d\ncategory: other\n---\n\n${'x'.repeat(SKILL_BODY_MAX_BYTES + 1)}`
    const res = parseSkillPackage(makeZip([{ name: SKILL_MANIFEST_PATH, data: bigBody }]))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reasons.some((r) => r.includes('SKILL.md 正文过大'))).toBe(true)
  })

  it('frontmatter 解析器：CRLF 容忍 + 非法形状回空', () => {
    const crlf = parseSkillFrontmatter('---\r\nname: a\r\ndescription: b\r\ncategory: research\r\n---\r\nbody')
    expect(crlf).toEqual({ name: 'a', description: 'b', category: 'research' })
    expect(parseSkillFrontmatter('no frontmatter here')).toEqual({})
    expect(parseSkillFrontmatter('---\nbroken')).toEqual({})
  })

  it('pack↔parse 往返：字节级一致（下载端点还原契约）', () => {
    const files = [
      { path: SKILL_MANIFEST_PATH, content: Buffer.from(skillMd('data-skill', 'data'), 'utf8') },
      { path: 'assets/img.png', content: randomBytes(64) },
    ]
    const zip = packSkillZip(files)
    const res = parseSkillPackage(zip)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.manifest).toEqual({ name: 'data-skill', description: '论文写作辅助技能', category: 'data' })
    for (const f of files) {
      const back = res.files.find((x) => x.path === f.path)
      expect(back).toBeDefined()
      expect(back!.content.equals(f.content)).toBe(true) // 字节级
    }
    // 枚举值完整性（D5 固定枚举自检）
    expect(SKILL_CATEGORIES).toEqual(['research', 'writing', 'data', 'literature', 'other'])
  })
})

// ---- 三表落库 parity：fresh（init.sql）vs 增量（runIncrementalSchema 镜像）----
describe('#1055 A 票三表 parity（fresh vs 增量）', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), `skill-schema-${process.pid}-`))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function skillShape(db: Database.Database): Record<string, unknown> {
    const shape: Record<string, unknown> = {}
    for (const t of ['skill_packages', 'skill_files', 'skill_enablements']) {
      shape[t] = db.prepare(`PRAGMA table_info("${t}")`).all()
      shape[`${t}__idx`] = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name")
        .all(t)
    }
    return shape
  }

  it('fresh（init.sql）与增量（runIncrementalSchema）两路径列集/索引一致（镜像漂移即红）', () => {
    // fresh 路径
    const dbFresh = new Database(path.join(dir, 'fresh.db'))
    dbFresh.exec(INIT_SQL)
    // 增量路径：最小库（仅 users 表——FK 语义面）+ runIncrementalSchema 收敛
    const dbUp = new Database(path.join(dir, 'up.db'))
    dbUp.exec(`CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL)`)
    runIncrementalSchema(dbUp)
    runIncrementalSchema(dbUp) // 幂等二跑

    const a = skillShape(dbFresh)
    const b = skillShape(dbUp)
    expect(b).toEqual(a)
    // 关键列/约束抽检（存在性 + 主键 + 唯一索引语义）
    const cols = (a.skill_packages as Array<{ name: string; notnull: number; pk: number }>).map((c) => c.name)
    expect(cols).toEqual(['id', 'name', 'description', 'category', 'uploaderId', 'uploaderRole', 'sha256', 'status', 'publishedAt', 'updatedAt'])
    expect((a.skill_files as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['packageId', 'path'])
    expect((a.skill_enablements as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['ownerId', 'skillId'])
    expect((a.skill_packages__idx as Array<{ name: string }>).some((i) => i.name === 'skill_packages_name_key')).toBe(true)
    dbFresh.close()
    dbUp.close()
  })

  it('SCHEMA_VERSION 升至 20 且 upgrade-schema.mjs 幂等收敛（脚本入口）', async () => {
    const { SCHEMA_VERSION } = await import('../scripts/lib/incremental-schema.mjs')
    expect(SCHEMA_VERSION).toBe(20)
    const db = new Database(path.join(dir, 'entry.db'))
    db.exec(`CREATE TABLE "users" ("id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL)`)
    // 经入口脚本跑（child process——runDbScript 先例），断言退出 0 + user_version=20
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['scripts/upgrade-schema.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${path.join(dir, 'entry.db')}` },
      stdio: 'pipe',
    })
    expect(db.pragma('user_version', { simple: true })).toBe(20)
    db.close()
  })
})

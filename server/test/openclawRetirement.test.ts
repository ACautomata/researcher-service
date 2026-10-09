import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// #860 OpenClaw 退役⑤：CI/CD 镜像链 + deploy 模板链 + env 样例/部署文档的痕迹清零静态断言
//（先例：prodDeploy.test.ts / devDeploy.test.ts 文本断言模式，不触真 docker）。编排内核与
// OPENCLAW_* env 读取面已随 #859 清零（prodDeploy/devDeploy 负断言锁死），本文件钉⑤新增的
// 外围不变量：CI 零镜像步骤/job 链完整、dev 工具链（driver/skill）零 fleet 预拉、env 样例与
// 部署文档零 OpenClaw 配置项/镜像引用。路径解析沿 prodDeploy.test.ts：vitest 自 server/ 运行，
// cwd 上溯取仓库根。
const ROOT = resolve(process.cwd(), '..')

function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

// 功能性引用形态（镜像引用 / env 赋值 / 步骤名），不匹配「#858：OPENCLAW_IMAGE 预拉随…」这类
// 退役注记注释——注释是决策历史，功能面清零才是本票验收。
const OPENCLAW_IMAGE_REF = /researcher-service\/openclaw/
const OPENCLAW_ENV_ASSIGN = /OPENCLAW_[A-Z_]+ *=/

describe('CI 工作流（#860：零 OpenClaw 镜像步骤，编排 smoke 删除后 job 链完整）', () => {
  const ci = readRepoFile('.github/workflows/ci.yml')

  it('无 OpenClaw 镜像预拉步骤 / 无 OPENCLAW_* env 使用', () => {
    expect(ci).not.toMatch(OPENCLAW_IMAGE_REF)
    expect(ci).not.toMatch(OPENCLAW_ENV_ASSIGN)
  })

  it('无 fleet 编排 smoke 步骤（frontend / server 双 job 链完整）', () => {
    expect(ci).not.toMatch(/containers-smoke/)
    expect(ci).toMatch(/^  frontend:/m)
    expect(ci).toMatch(/^  server:/m)
  })
})

describe('CD 工作流（#860：镜像面 = server/frontend/wiki 三支路，零 OpenClaw）', () => {
  const cd = readRepoFile('.github/workflows/cd.yml')

  it('镜像面三支路在位（server / frontend / wiki 三个 GITHUB_ENV 镜像引用）', () => {
    expect(cd).toMatch(/SERVER_IMAGE=ghcr\.io\//)
    expect(cd).toMatch(/FRONTEND_IMAGE=ghcr\.io\//)
    expect(cd).toMatch(/WIKI_IMAGE=ghcr\.io\//)
  })

  it('无 OpenClaw 镜像引用 / 无 OPENCLAW_* env 使用', () => {
    expect(cd).not.toMatch(OPENCLAW_IMAGE_REF)
    expect(cd).not.toMatch(OPENCLAW_ENV_ASSIGN)
  })
})

describe('dev 工具链（driver.sh / skill）零 fleet 预拉与退役端点', () => {
  const driver = readRepoFile('.claude/skills/run-ai-research-pipeline/driver.sh')
  const loadEnvTest = readRepoFile('.claude/skills/run-ai-research-pipeline/test_load_env.sh')
  const skill = readRepoFile('.claude/skills/run-ai-research-pipeline/SKILL.md')

  it('driver.sh 无 _ensure_fleet_image（fleet 镜像预拉随 #858 退役，容器 CRUD 面已不存在）', () => {
    expect(driver).not.toMatch(/_ensure_fleet_image/)
    expect(driver).not.toMatch(OPENCLAW_IMAGE_REF)
    expect(driver).not.toMatch(/OPENCLAW_IMAGE/)
    expect(driver).not.toMatch(/GATEWAY_TOKEN/)
  })

  it('test_load_env.sh 夹具变量零退役键（GATEWAY_TOKEN / OPENCLAW_IMAGE）', () => {
    expect(loadEnvTest).not.toMatch(/GATEWAY_TOKEN/)
    expect(loadEnvTest).not.toMatch(/OPENCLAW_IMAGE/)
  })

  it('SKILL.md 无退役容器 REST 面引用（POST /containers 随 #858 退役 → 90005）', () => {
    // 宽断言有意覆盖整个 containers 前缀：skill 操作面 = sessions。契约保留的 /:name/files
    // lab 只读面（#858）属前端消费、非 skill 面；将来 skill 若需引用，此处红 = 预期审视点，
    // 届时收窄正则表达例外而非放行前缀。
    expect(skill).not.toMatch(/\/api\/v1\/containers\//)
    expect(skill).not.toMatch(/POST \/containers/)
  })
})

describe('env 样例族（.env.example × 2）零 OpenClaw 配置项', () => {
  it('deploy/.env.example 与 server/.env.example 无 OPENCLAW_* / GATEWAY_TOKEN 键', () => {
    for (const rel of ['deploy/.env.example', 'server/.env.example']) {
      const example = readRepoFile(rel)
      expect(example, rel).not.toMatch(OPENCLAW_ENV_ASSIGN)
      expect(example, rel).not.toMatch(/^GATEWAY_TOKEN/m)
      expect(example, rel).not.toMatch(OPENCLAW_IMAGE_REF)
    }
  })
})

describe('部署文档（DEPLOY.md / 根 README）零 OpenClaw 现状描述', () => {
  const deploy = readRepoFile('deploy/DEPLOY.md')
  const readme = readRepoFile('README.md')

  it('DEPLOY.md 无「构建期 clone 模板入镜像」现行描述（#858 起模板注入退役，CD 仅分发 compose）', () => {
    expect(deploy).not.toMatch(/构建期 clone researcher home 模板/)
    expect(deploy).not.toMatch(/模板随镜像/)
    expect(deploy).not.toMatch(/运行时拉 OpenClaw 镜像/)
    expect(deploy).not.toMatch(/编排 OpenClaw 容器/)
  })

  it('根 README 配置表零 OPENCLAW_* 行 / 无 fleet 产品定位描述（退役注记里的历史键名保留，同 AGENTS.md 先例）', () => {
    expect(readme).not.toMatch(/\| `OPENCLAW_/)
    expect(readme).not.toMatch(/OPENCLAW_TEMPLATE_DIR=/)
    expect(readme).not.toMatch(/多 OpenClaw 容器管理面板/)
    expect(readme).not.toMatch(/researcher 模板/)
  })
})

describe('server/README.md（#860：目录树/接缝零 fleet 现役描述）', () => {
  const readme = readRepoFile('server/README.md')

  it('无 openclaw-gw 前缀/GATEWAY_BIND 常量描述（#858 后 constants = kind/session/owner 标签）', () => {
    expect(readme).not.toMatch(/openclaw-gw- 前缀\/label\/卷前缀\/GATEWAY_BIND/)
    expect(readme).not.toMatch(/HomeProvisioner|FleetCommand|FleetReadModel|fleetAssembly/)
  })
})

// #861 OpenClaw 退役⑥（终局）：现役代码零功能性引用 + 全仓叙述仅剩档案级与退役注记。
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'generated'])

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SCAN_SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function rel(file: string): string {
  return file.slice(ROOT.length + 1)
}

// 功能性引用形态（赋值 / 容器名前缀拼接 / 名字面量），注释里的键名提及（无赋值、无引号
// 字面量）不中——注释是决策历史，功能面清零才是验收。单双引号 = 代码字面量；反引号 =
// 注释内的历史值标注，放行。env 赋值形态与上文 OPENCLAW_ENV_ASSIGN 共用同一常量（#861
// code review：双源漂移）。
const FUNCTIONAL_OPENCLAW = [
  OPENCLAW_ENV_ASSIGN, // env 赋值形态（与上文共用常量）
  /process\.env\.OPENCLAW_[A-Z_]+/, // env 读取形态
  /GATEWAY_TOKEN\s*=/, // 网关 token 注入形态
  /openclaw-gw-\$\{/, // 容器名前缀模板
  /['"]openclaw-gw-/, // 容器名前缀字面量拼接
  /['"]\.openclaw-wiki['"]/, // wiki SKIP 旧成员字面量
  /['"]openclaw:skip-rewind-confirm['"]/, // localStorage 旧 key 字面量
  /['"]openclaw-panel['"]/, // JWT iss/aud 旧值
]

describe('#861 终局闸：现役代码域（server/src + frontend/src + server/scripts）零功能性 OpenClaw 引用', () => {
  const codeFiles = ['server/src', 'frontend/src', 'server/scripts'].flatMap((d) =>
    walkFiles(join(ROOT, d)),
  )

  it('零功能性引用形态（env 赋值 / 前缀拼接 / 旧标识字面量；注释提及放行）', () => {
    const offenders: string[] = []
    for (const file of codeFiles) {
      const content = readFileSync(file, 'utf8')
      if (FUNCTIONAL_OPENCLAW.some((re) => re.test(content))) offenders.push(rel(file))
    }
    expect(offenders).toEqual([])
  })
})

describe('#861 终局闸：全仓 openclaw 叙述仅剩档案级与退役注记', () => {
  // 档案目录（决策历史，不回删）+ 已注记文件清单（退役注记/负断言/守卫本体，逐文件
  // 钉定）。新文件出现 openclaw 字样 → 此处红 = 强制审视；从清单移除条目前先确认该文件
  // 已清零（清单是超集，清零后条目冗余不报错）。
  const ALLOWED = [
    // 档案级：
    /^\.out-of-scope\//,
    /^docs\/adr\//,
    /^docs\/research\//,
    /^docs\/autofigure\//,
    /^docs\/prototypes\//,
    // 文档层退役注记（叙述/表格/部署契约中的历史说明）：
    /^README\.md$/,
    /^AGENTS\.md$/,
    /^GLOSSARY\.md$/,
    /^\.gitignore$/,
    /^server\/README\.md$/,
    /^server\/Dockerfile$/,
    /^deploy\/DEPLOY\.md$/,
    /^deploy\/README\.md$/,
    /^deploy\/docker-compose\.(dev|deploy)\.yml$/,
    /^deploy\/wiki-image\/Dockerfile$/,
    /^docs\/agents\/constraints\.md$/,
    /^docs\/agents\/server-modules\.md$/,
    /^\.github\/workflows\/(ci|cd)\.yml$/,
    // 代码内退役注记（注释形态；功能性引用由上一 describe 独立锁死）：
    /^server\/scripts\/apply-schema\.mjs$/,
    /^server\/scripts\/lib\/incremental-schema\.mjs$/,
    /^server\/src\/codes\.ts$/,
    /^server\/src\/config\.ts$/,
    /^server\/src\/validation\/schemas\.ts$/,
    /^server\/src\/containers\/constants\.ts$/,
    /^server\/src\/containers\/imageRef\.ts$/,
    /^server\/src\/containers\/lifecycleQueue\.ts$/,
    /^server\/src\/files\/dockerArchive\.ts$/,
    /^server\/src\/models\/service\.ts$/,
    /^server\/src\/runner\/providerRegistry\.ts$/,
    /^server\/src\/sandboxes\/dockerRuntime\.ts$/,
    /^server\/src\/wiki\/dockerFs\.ts$/,
    /^server\/src\/wiki\/fsPort\.ts$/,
    /^server\/src\/wiki\/routes\.ts$/,
    /^server\/src\/wiki\/values\.ts$/,
    /^server\/src\/wikiContainers\/dockerRuntime\.ts$/,
    /^frontend\/src\/api\/models\.ts$/,
    /^frontend\/src\/chat\/rewindPreference\.ts$/,
    /^frontend\/src\/views\/ModelView\.vue$/,
    // 退役负断言/注记测试（「不再出现」形态断言、注释说明）与守卫本体：
    /^server\/test\/openclawRetirement\.test\.ts$/,
    /^server\/test\/config\.test\.ts$/,
    /^server\/test\/devDeploy\.test\.ts$/,
    /^server\/test\/dockerFileArchive\.test\.ts$/,
    /^server\/test\/dockerSandboxRuntime\.test\.ts$/,
    /^server\/test\/files\.test\.ts$/,
    /^server\/test\/prodDeploy\.test\.ts$/,
    /^server\/test\/providerMigration\.test\.ts$/,
    /^server\/test\/sandboxSmoke\.test\.ts$/,
    /^server\/test\/schemaUpgrade\.test\.ts$/,
    /^server\/test\/wikiContainerDockerRuntime\.test\.ts$/,
    /^server\/test\/wikiContainerSmoke\.test\.ts$/,
  ]

  const SCAN_EXT = /\.(ts|tsx|mjs|cjs|js|md|yml|yaml|json|vue|html|sh|prisma|sql|css)$/

  it('命中文件全部落在档案/注记白名单内', () => {
    const hits = walkFiles(ROOT)
      .map(rel)
      .filter((r) => SCAN_EXT.test(r) || r === 'Dockerfile' || r === '.gitignore')
      .filter((r) => readRepoFile(r).match(/openclaw/i))
    const unexpected = hits.filter((r) => !ALLOWED.some((re) => re.test(r)))
    expect(unexpected).toEqual([])
  })
})

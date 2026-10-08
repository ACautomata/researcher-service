import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// issue #594 dev 控制面容器化静态断言（issue #586 测试接缝 5；先例：prodDeploy.test.ts 文本断言
// 模式，不触真 docker）。断言对象是声明式产物——dev compose——防「dev 回退宿主直跑 / 引入宿主数据
// 挂载 / fleet 编排配置残留」回归，并交叉校验与 prod 同形态。
// 路径解析沿 prodDeploy.test.ts 模式：vitest 自 server/ 目录运行，cwd 上溯取仓库根。
const ROOT = resolve(process.cwd(), '..')
const DEV = 'deploy/docker-compose.dev.yml'
const PROD = 'deploy/docker-compose.deploy.yml'

function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

// server 服务的 volumes 段（compose 中唯一带 volumes 的服务）：从 `volumes:` 行到下一
// `    networks:` 行之间，取所有挂载条目（`- <src>:<dst>` 形态）。文本定位不经 YAML 解析，
// 断言只对挂载条目行生效（注释提及历史/构建语境词汇不误伤）。
// 与 prodDeploy.test.ts 同名函数同逻辑。
function serverMountLines(compose: string): string[] {
  const afterVolumes = compose.split('volumes:')[1]
  expect(afterVolumes, 'compose 缺 server volumes 段').toBeDefined()
  const section = afterVolumes.split('\n    networks:')[0]
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
}

// 取 compose 中某 environment 键的 `KEY: value` 整行（用于 dev↔prod 同形态交叉校验）。
function envLine(compose: string, key: string): string | undefined {
  return compose
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key}: `))
}

describe('dev compose 去 host 挂载（issue #594，ADR 0013）', () => {
  const compose = readRepoFile(DEV)

  it('server 仅挂载 docker.sock（唯一豁免）+ dev SQLite named volume，无任何宿主数据路径', () => {
    const mounts = serverMountLines(compose)
    expect(mounts).toEqual([
      '- /var/run/docker.sock:/var/run/docker.sock',
      '- panel-dev-db:/app/db',
    ])
  })

  it('挂载条目无残留 host 数据挂载形态（/fleet、./openclaw.json、researcher bind、:ro）', () => {
    const mounts = serverMountLines(compose)
    for (const m of mounts) {
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\/fleet:/)
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\.\/openclaw\.json/)
      expect(m, `残留 researcher bind: ${m}`).not.toMatch(/researcher.*:/)
      expect(m, `残留 :ro 挂载: ${m}`).not.toContain(':ro')
    }
  })
})

describe('dev 寻址与 prod 同形态（issue #594，ADR 0013）', () => {
  const compose = readRepoFile(DEV)

  it('T0 #801：fleet 宿主寻址面整体退役——无 WS host / 端口绑定 host / host-gateway 映射', () => {
    expect(compose).not.toMatch(/OPENCLAW_FLEET_WS_HOST/)
    expect(compose).not.toMatch(/OPENCLAW_FLEET_PORT_BIND_HOST/)
    expect(compose).not.toMatch(/host\.docker\.internal:host-gateway/)
    expect(compose).not.toMatch(/extra_hosts:/)
  })

  it('#858：fleet 编排配置面退役——OPENCLAW_TEMPLATE_DIR / OPENCLAW_FLEET_ROOT / OPENCLAW_IMAGE / OPENCLAW_NAMED_VOLUMES / LIFECYCLE_WORKER_CONCURRENCY 不再出现', () => {
    expect(compose).not.toMatch(/OPENCLAW_TEMPLATE_DIR:/)
    expect(compose).not.toMatch(/OPENCLAW_FLEET_ROOT:/)
    expect(compose).not.toMatch(/OPENCLAW_IMAGE:/)
    expect(compose).not.toMatch(/OPENCLAW_NAMED_VOLUMES:/)
    expect(compose).not.toMatch(/LIFECYCLE_WORKER_CONCURRENCY:/)
    expect(compose).not.toMatch(/CREDENTIAL_ENCRYPTION_KEYS:/)
  })

  it('落盘根与 SQLite 走容器内路径 / named volume 挂载点（同 prod；#858 DATA_ROOT 取代 fleet 根）', () => {
    expect(compose).toMatch(/DATA_ROOT: \/data/)
    expect(compose).not.toMatch(/OPENCLAW_FLEET_ROOT:/)
    expect(compose).toMatch(/DATABASE_URL: file:\/app\/db\/db\.sqlite3/)
  })

  it('REDIS_URL 指向栈内 redis 服务（同 prod）', () => {
    expect(compose).toMatch(/REDIS_URL: redis:\/\/redis:6379\/0/)
    expect(compose).toMatch(/redis:7-alpine/)
  })

  it('build 多 context 仅 official/ + plugins/（#858：template context 随 fleet provisioning 退役）', () => {
    expect(compose).toMatch(/official: \.\.\/official/)
    expect(compose).toMatch(/plugins: \.\.\/plugins/)
    expect(compose).not.toMatch(/template:/)
    expect(compose).not.toMatch(/RESEARCHER_DIR/)
  })
})

describe('dev 与 prod 逐键对齐（issue #594 同形态交叉校验）', () => {
  // 这些键决定「寻址/落盘」行为，dev 与 prod 必须完全一致，否则分叉重生。
  // T0 #801：OPENCLAW_TEMPLATE_JSON / OPENCLAW_FLEET_WS_HOST / OPENCLAW_FLEET_PORT_BIND_HOST
  // 随端口池与模板面退役；#858：OPENCLAW_TEMPLATE_DIR / OPENCLAW_FLEET_ROOT 随 fleet 编排退役，
  // 不再属于对齐面。
  const SHARED_KEYS = [
    'REDIS_URL',
    'DATABASE_URL',
    'DATA_ROOT',
  ]
  const dev = readRepoFile(DEV)
  const prod = readRepoFile(PROD)

  for (const key of SHARED_KEYS) {
    it(`${key} 取值与 prod 一致`, () => {
      const prodLine = envLine(prod, key)
      expect(prodLine, `prod compose 缺 ${key}`).toBeDefined()
      expect(envLine(dev, key), `dev 与 prod 的 ${key} 不一致`).toBe(prodLine)
    })
  }
})

describe('dev 特有项（issue #594）', () => {
  const compose = readRepoFile(DEV)

  it('NODE_ENV=development（覆盖 Dockerfile 的 production，走 config.ts dev 分支）', () => {
    expect(compose).toMatch(/NODE_ENV: development/)
  })

  it('server 暴露 127.0.0.1:8001:8001（宿主 vite dev proxy 目标；prod server 不暴露）', () => {
    expect(compose).toMatch(/127\.0\.0\.1:8001:8001/)
  })
})

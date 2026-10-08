import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// issue #593 prod compose/CD 去 host 挂载静态断言（issue #586 测试接缝 5；先例：config.test.ts
// 文本断言模式，不触真 docker）。断言对象是声明式产物——prod compose、
// server 镜像 Dockerfile、CD workflow——防「模板/配置回退到宿主挂载」回归。
// 路径解析模式：vitest 自 server/ 目录运行，cwd 上溯取仓库根。
const ROOT = resolve(process.cwd(), '..')

function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

// server 服务的 volumes 段（compose 中唯一带 volumes 的服务）：从 `volumes:` 行到下一
// `    networks:` 行之间，取所有挂载条目（`- <src>:<dst>` 形态）。文本定位不经 YAML 解析，
// 断言只对挂载条目行生效（注释提及 /fleet 等历史语境词汇不误伤）。
function serverMountLines(compose: string): string[] {
  const afterVolumes = compose.split('volumes:')[1]
  expect(afterVolumes, 'compose 缺 server volumes 段').toBeDefined()
  const section = afterVolumes.split('\n    networks:')[0]
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
}

describe('prod compose 去 host 挂载（issue #593，ADR 0013）', () => {
  const compose = readRepoFile('deploy/docker-compose.deploy.yml')

  it('server 仅挂载 docker.sock（唯一豁免）+ SQLite named volume，无任何宿主数据路径', () => {
    const mounts = serverMountLines(compose)
    expect(mounts).toEqual([
      '- /var/run/docker.sock:/var/run/docker.sock',
      '- panel-db:/app/db',
    ])
  })

  it('挂载条目无残留 host 数据挂载形态（/fleet、/srv/openclaw、./openclaw.json、:ro）', () => {
    const mounts = serverMountLines(compose)
    for (const m of mounts) {
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\/fleet:/)
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\/srv\/openclaw/)
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\.\/openclaw\.json/)
      expect(m, `残留 :ro 挂载: ${m}`).not.toContain(':ro')
    }
  })

  it('#858：fleet 编排配置面退役——OPENCLAW_TEMPLATE_DIR / OPENCLAW_FLEET_ROOT / OPENCLAW_IMAGE / OPENCLAW_NAMED_VOLUMES / LIFECYCLE_WORKER_CONCURRENCY 不再出现', () => {
    expect(compose).not.toMatch(/OPENCLAW_TEMPLATE_DIR:/)
    expect(compose).not.toMatch(/OPENCLAW_FLEET_ROOT:/)
    expect(compose).not.toMatch(/OPENCLAW_IMAGE:/)
    expect(compose).not.toMatch(/OPENCLAW_NAMED_VOLUMES:/)
    expect(compose).not.toMatch(/LIFECYCLE_WORKER_CONCURRENCY:/)
    expect(compose).not.toMatch(/CREDENTIAL_ENCRYPTION_KEYS:/)
  })

  it('落盘根为容器内工作目录、无宿主 bind（#858 DATA_ROOT 取代 fleet 根；与 devDeploy.test.ts 同形断言）', () => {
    expect(compose).toMatch(/DATA_ROOT: \/data/)
    expect(compose).not.toMatch(/OPENCLAW_FLEET_ROOT/)
  })
})

describe('server 镜像构建（#858 后：无模板注入）', () => {
  const df = readRepoFile('server/Dockerfile')

  it('无 COPY --from=template / 无 .git 清理（#858：home 模板 provisioning 随 fleet 退役）', () => {
    expect(df).not.toMatch(/COPY --from=template/)
    expect(df).not.toMatch(/templates\/researcher/)
    expect(df).not.toMatch(/rm -rf \/app\/templates/)
  })

  it('无 COPY --from=deploy（openclaw.json 配置面随 T0 #801 退役，server 不再消费模板文件）', () => {
    expect(df).not.toMatch(/COPY --from=deploy/)
  })

  it('runtime 层安装 git（issue #790：openwiki 生成生命周期硬依赖 git——落地镜像 git init/源指纹；宿主 CI 直跑 npm test 有 git 必绿、容器内每个 wiki 更新 run 必坏的 gap 只能靠部署契约测试钉住）', () => {
    const runtimeStart = df.lastIndexOf('FROM node:lts-slim')
    const entrypointIdx = df.indexOf('COPY docker-entrypoint.sh')
    expect(runtimeStart).toBeGreaterThanOrEqual(0)
    expect(entrypointIdx).toBeGreaterThan(runtimeStart)
    const runtime = df.slice(runtimeStart, entrypointIdx)
    expect(runtime).toMatch(/apt-get install[^\n]*\bgit\b/)
  })
})

describe('CD 工作流（issue #593，ADR 0013；#858 后无模板注入）', () => {
  const cd = readRepoFile('.github/workflows/cd.yml')

  it('server 构建多 context 仅 official/ + plugins/（#858：template context 随 fleet provisioning 退役）', () => {
    expect(cd).toMatch(/build-contexts:/)
    expect(cd).toMatch(/official=\$\{\{ github\.workspace \}\}\/official/)
    expect(cd).toMatch(/plugins=\$\{\{ github\.workspace \}\}\/plugins/)
    expect(cd).not.toMatch(/template=/)
    expect(cd).not.toMatch(/deploy=\$\{\{ github\.workspace \}\}\/deploy/)
  })

  it('无构建期 clone researcher 模板步骤（#858 退役）', () => {
    expect(cd).not.toMatch(/Clone researcher home template/)
    expect(cd).not.toMatch(/RESEARCHER_REPO/)
    expect(cd).not.toMatch(/git clone --depth 1/)
  })

  it('不再 scp 分发 openclaw.json', () => {
    expect(cd).not.toMatch(/cp deploy\/openclaw\.json/)
    expect(cd).not.toMatch(/TEMPLATE_DIR=\/srv\/openclaw\/template/)
  })
})

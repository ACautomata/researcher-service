// wiki 容器镜像静态断言（#784；文本断言先例同 prodDeploy.test.ts：断言对象是 deploy/wiki-image/
// 的声明式产物 Dockerfile，不触真 docker——构建期断言由 Dockerfile RUN 执行，此处兜底防回归，
// 与 server/src/config.ts WIKI_IMAGE 默认值交叉锁死版本双源漂移）。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isFloatingImageRef } from '../src/containers/imageRef'

const ROOT = resolve(process.cwd(), '..')

function readDockerfile(): string {
  return readFileSync(join(ROOT, 'deploy/wiki-image/Dockerfile'), 'utf8')
}

// config.ts WIKI_IMAGE 默认值的版本段（与 readWikiImage 缺省明文同源锁死）
const CONFIG_DEFAULT = 'ghcr.io/acautomata/researcher-service/wiki:1.36'

describe('wiki 容器镜像（#784 · E 节 wiki 列「busybox 级极简 + 零初始化」）', () => {
  it('FROM busybox 基线（版本 tag 与 config 默认镜像版本同源）', () => {
    const fromRef = readDockerfile().match(/^FROM\s+(\S+)/m)?.[1]
    expect(fromRef).toBe('busybox:1.36')
    expect(isFloatingImageRef(CONFIG_DEFAULT)).toBe(false) // config 默认钉精确版本
    expect(CONFIG_DEFAULT.split(':').pop()).toBe(fromRef?.split(':').pop()) // 版本段同源
  })

  it('零初始化：无骨架 COPY（E 节「现状骨架 COPY 废止」——/wiki 内容归 OpenWiki 按需生成）', () => {
    const df = readDockerfile()
    expect(df).not.toMatch(/^\s*COPY\s/m)
    expect(df).not.toMatch(/^\s*ADD\s/m)
  })

  it('构建期断言最小 applet 集在位（tail 保活 / mkdir / rm / cat / test / timeout）', () => {
    const df = readDockerfile()
    for (const applet of ['sh', 'tail', 'mkdir', 'rm', 'cat', 'test', 'timeout']) {
      expect(df).toContain(`command -v ${applet}`)
    }
  })
})

// config 原子写单源（平移 backend/containers/fleet/config_store.py，#334）。
// 唯一落盘 seam：bytes-agnostic（只管「把一段 JSON 文本原子放到
// instances/<id>/config/openclaw.json」——config 独立目录，见下）。
//
// #366 两轮：config 落 instances/<id>/config（非 home）——容器只 ro bind 该目录、gateway 经
// OPENCLAW_CONFIG_PATH 读取：宿主侧 rename 换 inode 容器内可见（目录 bind，热加载保留），ro 只
// 约束容器侧（宿主写 host 路径不受影响，恢复只读边界）。单文件 bind 在 openclaw 镜像上不可靠
// （m2 实证：bind 源缺失时容器内变目录），故用目录 bind。ConfigStore 仍是唯一原子写 seam。
//
// 原子性不变量：tmp 与目标同目录（保证 rename 同文件系统原子）→ tmp 先 chmod 0644 再
// rename（防 umask 致容器内 node 读不了 openclaw.json）；tmp 名每次唯一
// （并发写者互不覆盖）；OSError 时清 tmp 并抛 ConfigWriteError（既有文件不被污染）。

import { mkdir, rename, unlink, writeFile, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { FleetConfig } from './values'

export class ConfigWriteError extends Error {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(`config write failed for ${containerName}: ${path}`)
    this.name = 'ConfigWriteError'
  }
}

export class ConfigStore {
  // 仅依赖 root（instances/ 落盘根）；config 写入 instances/<id>/config/openclaw.json——
  // config 是固定子目录名（与 command.createComplete 的 configDir = instances/<id>/config 对齐，#366）。
  constructor(private readonly config: Pick<FleetConfig, 'root'>) {}

  // 把 payload（JSON 文本）原子写到 instances/<id>/config/openclaw.json（代系绑定 #360），
  // 返回落地路径。name 仅用于 ConfigWriteError 诊断（与其它容器错误一致收 name，路径用 id）。
  async write(name: string, id: string, payload: string): Promise<string> {
    const configPath = path.join(this.config.root, 'instances', id, 'config', 'openclaw.json')
    const tmp = path.join(
      path.dirname(configPath),
      `${path.basename(configPath)}.${randomBytes(8).toString('hex')}.tmp`,
    )
    try {
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(tmp, payload, 'utf8')
      await chmod(tmp, 0o644)
      await rename(tmp, configPath) // POSIX 原子：要么整体新配置生效，要么保留旧文件
    } catch {
      // cleanup best-effort：unlink 失败不得掩盖 ConfigWriteError 主异常
      await unlink(tmp).catch(() => {})
      throw new ConfigWriteError(name, configPath)
    }
    return configPath
  }
}

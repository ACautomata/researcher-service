// pre-image 打包（#782）：journal blob 的字节语义 = 「恢复用 tar」——单文件 createTarFile、
// 目录树 createTarTree（定序稳定重打包，symlink 等非常规条目不入树 = 降级面）。JournalingBackend
//（write/edit 的文件级 pre）与 delete 面（含目录 rm -rf）共用。

import { createTarFile, createTarTree, parseTar } from '../../files/tar'
import type { SandboxFilePrimitives } from '../backend/primitives'

// 文件级 pre tar（write/edit：guardedFile 已收集的字节）。
export function filePreTar(basename: string, buf: Buffer): Buffer {
  return createTarFile(basename, buf)
}

// delete 面现状快照（文件/目录统一）：null = 不存在；非常规条目/超限 → 树内省略（restore
// 时缺失部分 = 降级；blob 语义仍自洽——sha 对「可恢复面」计算）。
export async function snapshotAsTar(
  primitives: SandboxFilePrimitives,
  container: string,
  absPath: string,
  opts: { maxDataBytes: number },
): Promise<Buffer | null> {
  const raw = await primitives.getArchive(container, absPath)
  if (raw === null) return null
  const parsed = parseTar(raw, { collectData: true, maxDataBytes: opts.maxDataBytes })
  const root = parsed[0]
  if (!root) return null
  const basename = absPath.split('/').pop() ?? 'file'
  if (root.type !== 'directory') {
    if (root.data === null) return null // 超限：不保 pre → 调用方（JournalingBackend.delete）super 直删不打点 = delete 降级为无恢复面
    return createTarFile(basename, root.data)
  }
  const entries: Array<{ name: string; type: 'file' | 'directory'; content?: Buffer; modeOctal?: string }> = [
    { name: `${basename}/`, type: 'directory', modeOctal: '0000755' },
  ]
  for (const t of parsed.slice(1)) {
    let rel = t.name.startsWith('./') ? t.name.slice(2) : t.name
    while (rel.endsWith('/')) rel = rel.slice(0, -1)
    if (rel === '' || rel === '.') continue
    if (rel.startsWith(`${basename}/`)) rel = rel.slice(basename.length + 1)
    if (t.type === 'file' && t.data !== null) {
      entries.push({ name: rel, type: 'file', content: t.data })
    } else if (t.type === 'directory') {
      entries.push({ name: `${rel}/`, type: 'directory', modeOctal: '0000755' })
    }
  }
  return createTarTree(entries)
}

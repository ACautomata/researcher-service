// ctx.lab 核心实现（#912 · 853 §11.3B 拍板形态②）：W4 spec 落盘窄口——
// `write({path, content})` 写面 /lab/specs/ 固定前缀白名单 + `read({path})` 读面 /lab/
// 前缀白名单。仅此窄域两口，无通用 exec/fs 透传（#752 已钉）。
//
// 纪律（docsToolPort 同族）：
//   - 归一化：复用 normalizeLabPath（/lab/ 前缀 + 穿越/反斜杠/空字节/超长拒止）；
//     写面再收紧 /lab/specs/ 段前缀（W4 三件产物 design/spec/audit 的专属落点——
//     交付物结果文件不在写面）。
//   - 写 = exec mkdir -p 父目录 + putArchive 单文件 tar（createTarFile——argv 直达不经
//     shell，无转义面；父目录自动创建使修订覆盖/重放幂等零额外步）。同路径再写 =
//     内容替换（tar 解包语义），修订轮覆盖天然成立。
//   - 读 = test -f 存在性探针 + getArchive 收集（parseTar maxDataBytes =
//     MAX_FILE_READ_BYTES 护栏——853 §7.2「collect 输入走既有 16MiB 护栏」钉面；单文件
//     data=null 即超大 → too_large 明确报错不静默截断）+ NUL 嗅探（fsPort.readLab
//     同口径：lab read 是文本对账面，二进制拒读）。
//   - 永不 throw 的 Result 契约（853 §3.2 B4 拍板）——infra 面 exec/archive 原生抛错归
//     sandbox_unavailable；PluginLabPortError 只是内部异常载体。
//
// 幂等短路点消费面（853 §5.1）：spec 已落盘 = resume 重放跳过 design LLM 的哨兵——
// read(spec.md) ok:true 即短路，not_found 即首次执行；audit.md 同目录同寿命。

import { normalizeLabPath, PluginDocsPortError } from './docsToolPort'
import { MAX_FILE_READ_BYTES } from '../files/values'
import { createTarFile, parseTar } from '../files/tar'
import { EXEC_DEFAULT_TIMEOUT_MS } from './backend/values'
import type { SandboxFilePrimitives } from './backend/primitives'
import type { PluginLabPort, PluginLabPortErrorCode, PluginLabResult } from '../plugins/api'

export class PluginLabPortError extends Error {
  constructor(
    readonly code: PluginLabPortErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginLabPortError'
  }
}

const SPECS_PREFIX = '/lab/specs/'

// 写面归一化：normalizeLabPath 全纪律 + /lab/specs/ 段前缀收紧（形态②的「固定前缀」钉面）。
export function normalizeSpecsPath(raw: string): string {
  const norm = normalizeLabPath(raw)
  if (!norm.startsWith(SPECS_PREFIX)) {
    throw new PluginLabPortError('invalid_path', `lab write 仅允许 /lab/specs/ 前缀路径: ${JSON.stringify(raw)}`)
  }
  return norm
}

const parentDirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))
const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export interface PluginLabToolPortDeps {
  /** run 的沙箱容器（/lab 工具根；RunService 沙箱 ensure 后的 labContainer）。 */
  readonly container: string
  /** Docker exec/archive 原语（S2 接缝；测试 fake）。 */
  readonly primitives: Pick<SandboxFilePrimitives, 'exec' | 'putArchive' | 'getArchive'>
  /** 读写超时毫秒（缺省 EXEC_DEFAULT_TIMEOUT_MS 全局口径；可注入缩短）。 */
  readonly timeoutMs?: number
}

export function createPluginLabPort(deps: PluginLabToolPortDeps): PluginLabPort {
  const timeoutMs = deps.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS
  return {
    async write(input): Promise<PluginLabResult<{ written: true }>> {
      try {
        const path = normalizeSpecsPath(input.path)
        const dir = parentDirOf(path)
        // 父目录自动创建（mkdir -p 幂等；目录创建失败按 infra 面归类——exec 抛错走
        // sandbox_unavailable，非零退出按 extract 语义给 not_found 不合适，归 sandbox_unavailable）。
        const mkdir = await deps.primitives.exec(deps.container, ['mkdir', '-p', dir], { timeoutMs })
        if (mkdir.exitCode !== 0) {
          throw new PluginLabPortError('sandbox_unavailable', `specs 目录创建失败（exit ${mkdir.exitCode}）: ${dir}`)
        }
        await deps.primitives.putArchive(deps.container, dir, createTarFile(baseNameOf(path), Buffer.from(input.content, 'utf8')))
        return { ok: true, data: { written: true } }
      } catch (e) {
        return labError(e, deps.container)
      }
    },

    async read(input): Promise<PluginLabResult<{ content: string }>> {
      try {
        const path = normalizeLabPath(input.path)
        const probe = await deps.primitives.exec(deps.container, ['test', '-f', path], { timeoutMs })
        if (probe.exitCode !== 0) {
          throw new PluginLabPortError('not_found', `文件不存在或不可读: ${path}`)
        }
        // getArchive 直打文件路径（dockerFs.probeFile 先例——daemon 返单文件 tar，不拉
        // 父目录整树；tar 名 = basename 经 normalizeTarName 归一）。
        const tar = await deps.primitives.getArchive(deps.container, path)
        if (tar === null) {
          throw new PluginLabPortError('sandbox_unavailable', `getArchive 返回空（容器不可达）: ${deps.container}`)
        }
        const entries = parseTar(tar, { collectData: true, maxDataBytes: MAX_FILE_READ_BYTES })
        const base = baseNameOf(path)
        const entry = entries.find((x) => x.type === 'file' && x.name === base)
        // 归因分开（#912 review P1）：归档内无目标文件 = 探针后竞态/daemon 返回面异常 →
        // not_found；data=null 只可能是 maxDataBytes 截断（collectData 且单文件护栏）→ 超大。
        if (entry === undefined) {
          throw new PluginLabPortError('not_found', `归档内无目标文件（探针后竞态或 daemon 返回面异常）: ${path}`)
        }
        if (entry.data === null) {
          throw new PluginLabPortError('too_large', `文件超 ${MAX_FILE_READ_BYTES} 字节护栏（collect 对账输入面，不静默截断）: ${path}`)
        }
        const content = entry.data.toString('utf8')
        if (content.includes('\u0000')) {
          throw new PluginLabPortError('binary', `文件含 NUL 字节（lab read 是文本对账面——collect 交付物须为 JSON/CSV/md 文本）: ${path}`)
        }
        return { ok: true, data: { content } }
      } catch (e) {
        return labError(e, deps.container)
      }
    },
  }
}

function labError(e: unknown, container: string): { ok: false; error: { code: PluginLabPortErrorCode; message: string } } {
  if (e instanceof PluginLabPortError) return { ok: false, error: { code: e.code, message: e.message } }
  if (e instanceof PluginDocsPortError) return { ok: false, error: { code: 'invalid_path', message: e.message } }
  return {
    ok: false,
    error: {
      code: 'sandbox_unavailable',
      message: `沙箱容器 exec/archive 不可达 (${container}): ${e instanceof Error ? e.message : String(e)}`,
    },
  }
}

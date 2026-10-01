// runner backend 双根路由（#747·02 · #747 E 节双容器模型）。
// agent 工具 path 以 /wiki/（wiki 容器，用户知识树）或 /lab/（会话沙箱）双根书写；
// 根即容器内挂载根（E 节：wiki 容器可写层 /wiki、沙箱可写层 /lab），路由只做「选容器」，
// 容器内绝对路径 = 原路径归一化结果。纯函数零 IO（files/paths.ts 先例延伸），单测直锁。

export interface BackendTargets {
  /** wiki 容器 docker 名（每用户一个，生命周期归 #776/#784） */
  wiki: string
  /** 会话沙箱容器 docker 名（researcher-sandbox-<sessionId>） */
  lab: string
}

export type RouteResult = { container: string; absPath: string } | { error: string }

// 非法路径统一错误面（agent 自纠读 error 文案；防探测不区分细因——对齐 files 域同码哲学）。
function invalid(path: string, why: string): RouteResult {
  return { error: `invalid path ${JSON.stringify(path)}: ${why}（expect /wiki/... or /lab/...）` }
}

export function routePath(path: string, targets: BackendTargets): RouteResult {
  if (path === '') return invalid(path, 'empty path')
  if (path.includes('\0')) return invalid(path, 'NUL byte')
  if (path.includes('\\')) return invalid(path, 'backslash')
  if (!path.startsWith('/')) return invalid(path, 'not absolute')

  // 归一化：折叠双斜杠、吸收单点段、去尾斜杠（长度 >1 时）。
  const segments = path.split('/')
  const normalized: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return invalid(path, 'parent directory traversal (..) is not allowed')
    normalized.push(seg)
  }
  if (normalized.length === 0) return invalid(path, 'must be rooted at /wiki or /lab')

  const root = normalized[0]
  if (root !== 'wiki' && root !== 'lab') {
    return invalid(path, `unknown root ${JSON.stringify(root)}`)
  }
  const absPath = '/' + normalized.join('/')
  return { container: root === 'wiki' ? targets.wiki : targets.lab, absPath }
}

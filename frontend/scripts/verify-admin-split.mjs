// #800 产物级隔离验证：用户面板 bundle（index.html 入口沿静态 import 可达的全部 chunk）
// 不得包含 admin 子应用代码（admin 视图 chunk 与 admin 专属文案）。失败 → exit 1（构建失败）。
// 验收口径（issue #800 acceptance #1「产物分析验证」）：这里做可达集分析 + 特征串双保险。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.cwd(), 'dist')
if (!existsSync(join(dist, 'index.html')) || !existsSync(join(dist, 'admin.html'))) {
  console.error('[verify-admin-split] dist/index.html 或 dist/admin.html 缺失——双入口构建未产出')
  process.exit(1)
}

const assetsDir = join(dist, 'assets')
const files = new Set(readdirSync(assetsDir).filter((f) => f.endsWith('.js')))
const read = (f) => readFileSync(join(assetsDir, f), 'utf8')

// 静态 import 图遍历（rolldown 产物形态全覆盖：from"./x.js" 无空格 / import("...") / 反引号
// import(`./x.js`)；构建产物 chunk 引用均为相对路径）
const IMPORT_RE = /(?:import|from)\s*\(?\s*["'`](\.\/[^"'`]+?\.js)["'`]/g
const entryOf = (html) => {
  const m = readFileSync(join(dist, html), 'utf8').match(/\/assets\/([\w.-]+\.js)/g)
  return m ? m.map((s) => s.replace('/assets/', '')) : []
}

// 从入口 html 出发沿静态 import 图遍历，返回可达 chunk 集合（index.html / admin.html 各调一次）
function collectReachable(html) {
  const reachable = new Set()
  const queue = entryOf(html)
  while (queue.length) {
    const f = queue.pop()
    if (!f || reachable.has(f) || !files.has(f)) continue
    reachable.add(f)
    for (const m of read(f).matchAll(IMPORT_RE)) queue.push(m[1].replace('./', ''))
  }
  return reachable
}

const reachable = collectReachable('index.html')

// 1) admin 视图 chunk 不得可达
const ADMIN_CHUNKS = [
  'AdminUsersView',
  'TraceLogsView',
  'ApiDocsView',
  'AuditLogsView',
  'UsageView',
]
const leakedChunks = [...reachable].filter((f) => ADMIN_CHUNKS.some((c) => f.startsWith(c)))

// 2) admin 专属文案/标识不得出现在可达 chunk 内容中
const MARKERS = ['运营管理台', '端点白名单', 'Usage 核算', '审计检索', 'provider-endpoints']
const leakedMarkers = []
for (const f of reachable) {
  const body = read(f)
  for (const marker of MARKERS) {
    if (body.includes(marker)) leakedMarkers.push(`${f} ←「${marker}」`)
  }
}

// 3) admin 入口自身必须可达 admin 视图（反向 sanity：admin.html 没把页面 chunk 拉进来才奇怪）
const adminReachable = collectReachable('admin.html')
const adminHasViews = ADMIN_CHUNKS.filter((c) => [...adminReachable].some((f) => f.startsWith(c)))

const failed =
  leakedChunks.length > 0 || leakedMarkers.length > 0 || adminHasViews.length < ADMIN_CHUNKS.length
console.log(`[verify-admin-split] 用户 bundle 可达 chunk ${reachable.size} 个；admin 可达 chunk ${adminReachable.size} 个`)
console.log(`[verify-admin-split] admin 视图 chunk 在 admin 入口可达: ${adminHasViews.join(', ')}`)
if (leakedChunks.length) console.error(`[verify-admin-split] 泄漏 chunk: ${leakedChunks.join(', ')}`)
if (leakedMarkers.length) console.error(`[verify-admin-split] 泄漏文案: ${leakedMarkers.join(', ')}`)
if (failed) {
  console.error('[verify-admin-split] FAIL：用户 bundle 含 admin 代码（或 admin 入口缺页面 chunk）')
  process.exit(1)
}
console.log('[verify-admin-split] OK：用户 bundle 不含 admin 代码（产物级隔离）')

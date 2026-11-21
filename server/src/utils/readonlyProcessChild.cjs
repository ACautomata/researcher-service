// 只读查询执行子进程（#1079 历史 / #1082 反思共用）。由 leasedProcessPool.ts 以独立进程拉起；
// stdout/stderr 丢弃，只经 IPC 回传稳定结果/错误代码——不把 SQLite 原文、路径、堆栈带回主进程。
//
// 协作时限：核心在逐行/逐候选循环检查传入的 cooperativeDeadline；真正的硬停止是主进程
// SIGKILL，本文件不自行超时退出，以免伪造「已终止」。
const { createRequire } = require('node:module')

const req = createRequire(process.env.RES_READONLY_MODULE_BASE)
const Database = req('better-sqlite3')
const core = req(process.env.RES_READONLY_CORE)

let db = null
let dbPath = null

function open(path) {
  if (db && dbPath === path) return db
  if (db) db.close()
  db = new Database(path, { readonly: true, fileMustExist: true })
  dbPath = path
  return db
}

function close() {
  try {
    if (db) db.close()
  } catch {
    // 已关闭
  }
}

function send(payload) {
  try {
    process.send(payload)
  } catch {
    // 主进程已断开
  }
}

process.on('disconnect', () => {
  close()
  process.exit(0)
})

process.on('message', (m) => {
  const respond = (payload) => send({ id: m.id, ...payload })
  try {
    if (m.fn === 'dispose') {
      close()
      process.exit(0)
      return
    }
    if (m.fn === 'probe-busy') {
      const end = Date.now() + m.durationMs
      while (Date.now() < end) {
        if (m.cooperativeDeadline && Date.now() > m.cooperativeDeadline) {
          const error = new Error('cooperative timeout')
          error.readonlyCode = (core && core.COOPERATIVE_TIMEOUT) || 'cooperative_timeout'
          throw error
        }
      }
      respond({ ok: true, data: { done: true } })
      return
    }
    if (m.fn === 'probe-readonly') {
      const probe = core.probeWrite || core.probeReadOnly
      respond({ ok: true, data: probe(open(m.dbPath)) })
      return
    }
    const fn = m.fn && core[m.fn]
    if (typeof fn !== 'function') {
      respond({ ok: false, code: 'system_error' })
      return
    }
    const args = Array.isArray(m.args) ? m.args : []
    respond({ ok: true, data: fn(open(m.dbPath), ...args, m.cooperativeDeadline) })
  } catch (e) {
    respond({ ok: false, code: (e && (e.readonlyCode || e.historyCode)) || 'system_error', denied: e && e.denied })
  }
})

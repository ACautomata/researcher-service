// 历史只读执行子进程（#1079 · RF-T03）。由 executor.ts 以独立进程拉起；stdout/stderr
// 丢弃，只经 IPC 回传稳定结果/错误代码——不把 SQLite 原文、路径、堆栈带回主进程。
//
// 2 秒协作时限：核心在逐行/逐候选循环检查传入的 cooperativeDeadline；真正的硬停止是主进程
// SIGKILL（见 executor.ts），本文件不自行超时退出，以免伪造「已终止」。
const { createRequire } = require('node:module')

const req = createRequire(process.env.RES_HISTORY_MODULE_BASE)
const Database = req('better-sqlite3')
const core = req(process.env.RES_HISTORY_CORE)

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
    if (m.type === 'dispose') {
      close()
      process.exit(0)
      return
    }
    if (m.type === 'probe-busy') {
      // 验证缝：真实忙循环，证明协作时限与硬停止（SIGKILL）。
      const end = Date.now() + m.durationMs
      while (Date.now() < end) {
        if (m.cooperativeDeadline && Date.now() > m.cooperativeDeadline) {
          const error = new Error('cooperative timeout')
          error.historyCode = core.HISTORY_COOPERATIVE_TIMEOUT
          throw error
        }
      }
      respond({ ok: true, data: { done: true } })
      return
    }
    if (m.type === 'probe-readonly') {
      respond({ ok: true, data: core.probeWrite(open(m.dbPath)) })
      return
    }
    if (m.type === 'sessions') {
      respond({ ok: true, data: core.sessions(open(m.dbPath), m.context, m.options, m.limits, m.cooperativeDeadline) })
      return
    }
    if (m.type === 'scan') {
      respond({ ok: true, data: core.scan(open(m.dbPath), m.context, m.sessionId, m.options, m.cooperativeDeadline) })
      return
    }
    respond({ ok: false, code: 'system_error' })
  } catch (e) {
    respond({ ok: false, code: (e && e.historyCode) || 'system_error', denied: e && e.denied })
  }
})

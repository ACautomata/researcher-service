// seam: chat/ws —— ChatWebSocket（issue #41 / spec §8.4）。
// 覆盖：access_token subprotocol 携 jwt、start/send 帧、ready/text/done/error 分发、断线 onClose/onError。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// MockWS 用 readyState 忠实原生 WebSocket 语义（WHATWG #dom-websocket-send）：
// CONNECTING(0) send 抛 InvalidStateError；OPEN(1) 发送；CLOSING(2)/CLOSED(3) 静默丢弃不抛错。
// 供 ws.ts 的 readyState 守卫收尾路径测试（codex P2 修正：CLOSING/CLOSED 不抛，catch 捕不到）。
const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

class MockWS {
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = CLOSING
  static CLOSED = CLOSED
  static last: MockWS | null = null
  url: string
  protocols: string | string[]
  sent: unknown[] = []
  readyState = CONNECTING // 新 socket 从 CONNECTING 起步（对齐原生生命周期）
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    MockWS.last = this
    this.url = url
    this.protocols = protocols ?? []
  }

  send(data: string): void {
    if (this.readyState === CONNECTING) throw new Error('InvalidStateError')
    if (this.readyState !== OPEN) return // CLOSING/CLOSED：原生静默丢弃，不 push、不抛
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    // 对齐原生：主动 close() 触发 onclose（静默看门狗判死走此路径，issue #239）
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }

  fireOpen(): void {
    this.readyState = OPEN
    this.onopen?.({})
  }

  fireMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }

  fireRawMessage(raw: string): void {
    this.onmessage?.({ data: raw })
  }

  fireError(): void {
    this.onerror?.({})
  }

  fireClose(code?: number, reason?: string): void {
    this.readyState = CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true })
  }

  fireClosing(): void {
    // close() 之后、onclose 触发之前的窗口：readyState=CLOSING，原生 send() 静默丢弃不抛错
    this.readyState = CLOSING
  }
}

// codex #249 P2：模拟后台标签挂起后恢复可见——把 visibilityState 置 'visible' 并派生 visibilitychange，
// 触发 ws.ts 的「恢复给一整个新应答窗口」逻辑（jsdom 提供 document，visibilityState 可写）。
function fireVisibilityVisible(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

import { ChatWebSocket } from './ws'

describe('ChatWebSocket', () => {
  beforeEach(() => {
    MockWS.last = null
    vi.stubGlobal('WebSocket', MockWS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('closes a socket whose opening handshake stalls', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { connectTimeoutMs: 1000 })

    vi.advanceTimersByTime(999)
    expect(MockWS.last!.readyState).toBe(CONNECTING)
    vi.advanceTimersByTime(1)
    expect(MockWS.last!.readyState).toBe(CLOSED)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cancels the opening-handshake timeout after the socket opens', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { connectTimeoutMs: 1000 })
    MockWS.last!.fireOpen()

    vi.advanceTimersByTime(1001)
    expect(MockWS.last!.readyState).toBe(OPEN)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('connects with access_token subprotocol carrying jwt', () => {
    new ChatWebSocket('/ws/chat/', 'jwt-abc', {})
    expect(MockWS.last!.url).toBe('/ws/chat/')
    expect(MockWS.last!.protocols).toEqual(['access_token', 'jwt-abc'])
  })

  it('start buffers the start frame until open, then flushes', () => {
    // 原生 WebSocket 在 CONNECTING 态调 send() 抛 InvalidStateError → 必须缓冲到 onopen 后再发（codex P1）
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.start('demo')
    expect(MockWS.last!.sent).toEqual([]) // CONNECTING 期间缓冲，未发出
    MockWS.last!.fireOpen()
    expect(MockWS.last!.sent).toEqual([{ type: 'start', container: 'demo' }])
  })

  it('send sends a send frame with sessionKey and message once open', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    MockWS.last!.fireOpen()
    ws.send('sk-1', '你好')
    expect(MockWS.last!.sent).toEqual([{ type: 'send', sessionKey: 'sk-1', message: '你好' }])
  })

  it('buffers multiple frames in order until open, then flushes', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    ws.start('demo')
    ws.send('sk-1', 'hi')
    expect(MockWS.last!.sent).toEqual([])
    MockWS.last!.fireOpen()
    expect(MockWS.last!.sent).toEqual([
      { type: 'start', container: 'demo' },
      { type: 'send', sessionKey: 'sk-1', message: 'hi' },
    ])
  })

  it('dispatches ready frame to onReady', () => {
    const onReady = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onReady })
    MockWS.last!.fireMessage({ type: 'ready', container: 'demo' })
    expect(onReady).toHaveBeenCalledWith('demo')
  })

  it('dispatches text delta to onText', () => {
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好' })
    expect(onText).toHaveBeenCalledWith('r1', '你好', undefined)
  })

  it('forwards replace flag on text frames', () => {
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好世界', replace: true })
    expect(onText).toHaveBeenCalledWith('r1', '你好世界', true)
  })

  it('dispatches done to onDone', () => {
    const onDone = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onDone })
    MockWS.last!.fireMessage({ type: 'done', runId: 'r1' })
    expect(onDone).toHaveBeenCalledWith('r1')
  })

  it('dispatches error message and runId to onError', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireMessage({ type: 'error', runId: 'r1', message: '模型超时' })
    expect(onError).toHaveBeenCalledWith('模型超时', 'r1', undefined)
  })

  it('dispatches approval id on a resolve-error frame (codex R2 P2)', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireMessage({ type: 'error', message: '审批回覆失败', id: 'ap-1' })
    expect(onError).toHaveBeenCalledWith('审批回覆失败', undefined, 'ap-1')
  })

  it('fires onClose when underlying socket closes (断线)', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose()
    expect(onClose).toHaveBeenCalled()
  })

  it('fires onError when underlying socket errors', () => {
    const onError = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireError()
    expect(onError).toHaveBeenCalledWith('连接错误')
  })

  it('routes send to onError after the socket has closed (no throw, codex P2)', () => {
    // socket 关闭后原生 WebSocket.send() 静默丢弃不抛错（不触发 handler）；
    // wrapper 标记 closed 后改走 onError，不真正发出（codex #4）
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    MockWS.last!.fireClose()
    expect(() => ws.send('sk-1', 'hi')).not.toThrow()
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // CLOSED 态未真正发出
  })

  // ---- T06 权限审批（issue #42 / spec §8.2）----
  it('dispatches approval card to onApproval (连接级，无 runId，带 sessionKey)', () => {
    const onApproval = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onApproval })
    MockWS.last!.fireMessage({ type: 'approval', id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp', sessionKey: 'sk-1' })
    expect(onApproval).toHaveBeenCalledWith({ id: 'ap-1', kind: 'exec', command: 'rm -rf /tmp', sessionKey: 'sk-1' })
  })

  it('dispatches approvalResolved to onApprovalResolved (回执 → 卡片标记已处理)', () => {
    const onApprovalResolved = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onApprovalResolved })
    MockWS.last!.fireMessage({ type: 'approvalResolved', id: 'ap-1', decision: 'allow-once' })
    expect(onApprovalResolved).toHaveBeenCalledWith('ap-1', 'allow-once')
  })

  it('resolve sends a resolve frame with id/kind/decision once open', () => {
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    MockWS.last!.fireOpen()
    ws.resolve('ap-1', 'exec', 'deny')
    expect(MockWS.last!.sent).toEqual([{ type: 'resolve', id: 'ap-1', kind: 'exec', decision: 'deny' }])
  })

  // ---- T08 工具执行（issue #44 / spec §9.4 / r26 §3）----
  // tool 帧（runId 级，挂在所属 chat run 内）→ onTool 回调；前端按 name 聚合 start→result 渲染一行标题+状态。
  it('dispatches tool frame to onTool', () => {
    const onTool = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onTool })
    MockWS.last!.fireMessage({
      type: 'tool', runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: '检索', input: { q: 'x' }, result: null,
    })
    expect(onTool).toHaveBeenCalledWith({
      runId: 'r1', name: 'wiki.search', state: 'running',
      id: 'call-1', title: '检索', input: { q: 'x' }, result: null,
    })
  })

  // ---- #237 帧健壮性（评审 issue #198 问题 4.1/5.1）----
  it('drops a malformed JSON frame with console.warn and keeps dispatching later frames', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onText = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onText })
    MockWS.last!.fireRawMessage('not-json{')
    expect(warn).toHaveBeenCalledTimes(1) // 仅 warn，不抛未捕获异常
    MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: '你好' })
    expect(onText).toHaveBeenCalledWith('r1', '你好', undefined) // 后续正常帧继续分发
    warn.mockRestore()
  })

  it('drops a non-JSON text frame without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', {})
    expect(() => MockWS.last!.fireRawMessage('hello plain text')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ws.isClosed).toBe(false) // 帧丢弃不影响连接
    warn.mockRestore()
  })

  it('forwards CloseEvent.code and reason to onClose (4401 判定用)', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose(4401, 'Unauthorized')
    expect(onClose).toHaveBeenCalledWith(4401, 'Unauthorized')
  })

  it('normal close (code 1000) forwards code and empty reason', () => {
    const onClose = vi.fn()
    new ChatWebSocket('/ws/chat/', 'jwt', { onClose })
    MockWS.last!.fireClose(1000)
    expect(onClose).toHaveBeenCalledWith(1000, '')
  })

  it('CLOSING window send routes to onError, not a raw send (readyState 守卫)', () => {
    // CLOSING 原生 send 静默丢弃不抛错（try/catch 捕不到）→ 守卫 must 用 readyState 判走 onError，
    // 否则消息从 composer 清空但帧没发出（codex P2）
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    MockWS.last!.fireClosing() // close() 后、onclose 前：readyState=CLOSING
    expect(() => ws.send('sk-1', 'hi')).not.toThrow()
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // 未真正发出
  })

  it('CLOSING window start/resolve also take the onError wrap-up (issue #237 AC3 三入口)', () => {
    // start()/resolve() 与 send() 共用 sendRaw 守卫：CLOSING 窗口同样不抛、走 onError、不真正发出
    const onError = vi.fn()
    const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onError })
    MockWS.last!.fireOpen()
    MockWS.last!.fireClosing()
    expect(() => ws.start('demo')).not.toThrow()
    expect(() => ws.resolve('ap-1', 'exec', 'deny')).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith('连接已断开，请重试或切换容器')
    expect(MockWS.last!.sent).toEqual([]) // 未真正发出
  })

  // ---- #239 静默看门狗（评审 issue #198 问题 1）+ codex #249 P2：判死基于「ping 无应答」----
  // codex #249 P2：看门狗不再凭「纯静默时长」判死——健康连接可能无 ping 在飞（繁忙流量/pong 刚到）。
  // 仅当 ping 已发出且超一整个 silenceTimeout 无应答（真半开）才 close；否则重布防再核。
  // toFake:['performance'] 让 performance.now() 随 fake timers 推进，与判死的「应答窗口」计时对齐。
  describe('silence watchdog (issue #239)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('closes the socket only after a ping goes unanswered for a full response window (真半开判死)', () => {
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000, pingIntervalMs: 400 })
      MockWS.last!.fireOpen()
      MockWS.last!.sent.length = 0 // 清掉 open flush 的缓冲帧
      vi.advanceTimersByTime(400) // 心跳发出 ping → awaitingPong 置位、_lastPingAt=400、看门狗布防到 1400
      expect(MockWS.last!.sent).toContainEqual({ type: 'ping' })
      // 应答窗口未满（ping 才发 600ms）：看门狗不在窗口内触发
      vi.advanceTimersByTime(600)
      expect(onClose).not.toHaveBeenCalled()
      // ping 满一整个 silenceTimeout 无应答（真半开）：看门狗于 1400 触发判死
      vi.advanceTimersByTime(400)
      expect(onClose).toHaveBeenCalled()
    })

    it('does not kill a healthy busy connection that has no ping in flight (健康繁忙不误杀)', () => {
      // codex #249 P2：连接持续有业务流量（每次入站帧清除 awaitingPong、重置看门狗）→ 永无
      // 「ping 满应答窗口无应答」情形，多次越过 silenceTimeout 也不判死。
      const onClose = vi.fn()
      const onText = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose, onText }, { silenceTimeoutMs: 1000, pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      // 每 900ms 收一帧（< 阈值）：ping 即使发出也被下一帧应答，看门狗反复重置，永不判死
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(900)
        MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'x' })
      }
      expect(onText).toHaveBeenCalledTimes(8)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('resets the watchdog on every inbound frame (活跃连接不判死，断流后 ping 无应答判死)', () => {
      const onClose = vi.fn()
      const onText = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose, onText }, { silenceTimeoutMs: 1000, pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      // 每 900ms 收一帧（< 阈值）：看门狗被反复重置，永不判死
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(900)
        MockWS.last!.fireMessage({ type: 'text', runId: 'r1', delta: 'x' })
      }
      expect(onClose).not.toHaveBeenCalled()
      expect(onText).toHaveBeenCalledTimes(5)
      // 来帧停止后：心跳于下一周期发出 ping，该 ping 满一个 silenceTimeout 无应答 → 判死
      vi.advanceTimersByTime(2_500)
      expect(onClose).toHaveBeenCalled()
    })

    it('grants a fresh response window when a suspended tab becomes visible again (codex #249 P2，不误杀)', () => {
      // 复现：后台标签被挂起 >silenceTimeout，心跳 interval 与看门狗定时器都被冻结；恢复瞬间两者一并
      // 过期、入队顺序不定——旧实现（看门狗拿挂起前 stale「连续等待」状态）会误杀健康连接。修正后标签
      // 回到可见即给一整个新应答窗口（清零连续等待起点并重布防），恢复 ping 的 pong 有机会先返回。
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000, pingIntervalMs: 400 })
      MockWS.last!.fireOpen()
      vi.advanceTimersByTime(400) // 发 ping
      MockWS.last!.fireMessage({ type: 'pong' }) // 挂起前对端回 pong（健康）
      // —— 标签被挂起：时钟冻结，期间挂起前 ping 的「连续等待」状态变 stale ——
      // 标签恢复可见：给一整个新应答窗口，不拿挂起前 stale 状态判死
      fireVisibilityVisible()
      vi.advanceTimersByTime(999) // 新窗口内：不判死
      expect(onClose).not.toHaveBeenCalled()
      // 恢复后健康：对端回 pong，连接在多倍 silenceTimeout 内不再判死
      MockWS.last!.fireMessage({ type: 'pong' })
      vi.advanceTimersByTime(400)
      MockWS.last!.fireMessage({ type: 'pong' })
      expect(onClose).not.toHaveBeenCalled()
    })

    it('still kills after resume when the connection is genuinely half-open (恢复后真半开仍判死)', () => {
      // 对偶：恢复（标签再可见）给足一整个新应答窗口后，恢复 ping 仍无应答（真半开）→ 判死。
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000, pingIntervalMs: 400 })
      MockWS.last!.fireOpen()
      vi.advanceTimersByTime(400)
      MockWS.last!.fireMessage({ type: 'pong' })
      fireVisibilityVisible() // 恢复：给新窗口
      expect(onClose).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5_000) // 恢复 ping 始终无应答（真半开）：窗口满后判死
      expect(onClose).toHaveBeenCalled()
    })

    it('does not fire before the timeout elapses', () => {
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000, pingIntervalMs: 400 })
      MockWS.last!.fireOpen()
      vi.advanceTimersByTime(999)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('does not start the watchdog before the socket opens', () => {
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000 })
      // 未 open（CONNECTING）：看门狗未布防，计时流逝不判死
      vi.advanceTimersByTime(5000)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('clears the watchdog on an explicit close() (主动关闭后看门狗不再重复判死)', () => {
      const onClose = vi.fn()
      const ws = new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 1000 })
      MockWS.last!.fireOpen()
      ws.close() // 主动关闭：触发一次 onclose，并清看门狗
      expect(onClose).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(5000) // 看门狗已清：计时流逝不再二次判死
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  // ---- codex #249 P1 应用层心跳：周期 ping 给本腿活性流量，idle 健康连接不被看门狗误判半开 ----
  describe('heartbeat ping (codex #249 P1)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('sends a ping on the heartbeat interval after open', () => {
      new ChatWebSocket('/ws/chat/', 'jwt', {}, { pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      MockWS.last!.sent.length = 0 // 清掉 open flush 的缓冲帧
      vi.advanceTimersByTime(1000)
      expect(MockWS.last!.sent).toContainEqual({ type: 'ping' })
    })

    it('keeps an idle connection alive: periodic pong resets the watchdog (idle 健康不判死)', () => {
      // 复现 Codex P1：本腿无周期帧时 idle 60s 会被看门狗掐死。有心跳后——前端周期 ping、
      // 对端回 pong（入站帧）重置看门狗，idle 健康连接在多倍 silenceTimeout 内不被判死。
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 3000, pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      // 每个 ping 周期对端回 pong（模拟 consumer ping→pong）：推进 5 个周期（5s > silenceTimeout 3s）
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(1000) // 触发一次 ping
        MockWS.last!.fireMessage({ type: 'pong' }) // 对端应答 → 入站帧重置看门狗
      }
      expect(onClose).not.toHaveBeenCalled() // idle 但有 pong：健康，不判死
    })

    it('still kills a genuinely half-open connection when pings go unanswered (ping 无应答判死)', () => {
      const onClose = vi.fn()
      new ChatWebSocket('/ws/chat/', 'jwt', { onClose }, { silenceTimeoutMs: 3000, pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      // ping 照发但对端无任何应答（真半开）：首个 ping 于 t=1000 发出、看门狗布防到其窗口截止点
      // t=4000；窗口未满不判死，满一整个 silenceTimeout 无应答才判死。
      vi.advanceTimersByTime(3_999)
      expect(onClose).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onClose).toHaveBeenCalled()
    })

    it('stops the heartbeat on close (关闭后不再发 ping)', () => {
      const ws = new ChatWebSocket('/ws/chat/', 'jwt', {}, { pingIntervalMs: 1000 })
      MockWS.last!.fireOpen()
      ws.close()
      MockWS.last!.sent.length = 0
      vi.advanceTimersByTime(5000)
      expect(MockWS.last!.sent).toEqual([]) // 关闭后心跳停止
    })
  })
})

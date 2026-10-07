// seam: 投影归约器纯函数全量用例（#730 §4.1 / #793 硬验收「单管线渲染 = 流式终态与刷新回放零差异」）。
// 结构：
//   1. fromProjection 单入口用例（投影行 → 视图模型各形状）；
//   2. applyEvent 逐事件语义用例（镜像 server sessions/reducer.ts TurnReducer：tool.start 重复
//      忽略 / tool.end 无先前行忽略 / attachment 校验门 / 空聚合终态剥落）；
//   3. **零差异一致性组**：同一 run 的事件序列走 applyEvent，对应投影行走 fromProjection，
//      断言两者渲染显著字段全等（reduce(全量事件) ≡ 投影行；id/runId/sendKey 为非渲染簿记
//      字段，normalize 时剥离——实时路径 id 由 POST 响应回填、终态画面由投影整替接管）。
import { describe, expect, it } from 'vitest'
import type { ProjectionMessage, SessionProjection, ToolLine } from '@/api/sessions'
import type { SessionEvent } from './useEventStream'
import { applyEvent, applyTeamEvent, fromProjection, hasTrace, newMsg, shouldFoldTrace, teamFoldsFromProjection, type Msg, type TeamFold } from './projection'

// ---- fixtures ----

const ev = (type: string, payload: Record<string, unknown> = {}, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ type, payload, ...extra })

const userRow = (over: Partial<ProjectionMessage> = {}): ProjectionMessage => ({
  id: 'm1', turn: 1, role: 'user', content: '第一问', anchorCheckpointId: null, createdAt: '2026-10-06T00:00:00Z', ...over,
})

const toolLine = (over: Partial<ToolLine> = {}): ToolLine => ({
  toolCallId: 't1', name: 'bash', input: '{"command":"ls"}', state: 'success', ...over,
})

const assistantRow = (over: Partial<ProjectionMessage> = {}): ProjectionMessage => ({
  id: 'm2', turn: 2, role: 'assistant', content: '回答', anchorCheckpointId: 'ck-1', createdAt: '2026-10-06T00:00:01Z', ...over,
})

// 渲染显著字段归一（剥 id/runId/sendKey 簿记字段——见文件头注 3）。
function normalize(m: Msg) {
  return {
    role: m.role, raw: m.raw, text: m.text, thinking: m.thinking, thinkingOpen: m.thinkingOpen,
    streaming: m.streaming, traceFolded: m.traceFolded,
    tools: m.tools.map((t) => ({ id: t.id, name: t.name, state: t.state, title: t.title, input: t.input, result: t.result, durationMs: t.durationMs, truncated: t.truncated, rejection: t.rejection, stage: t.stage })),
    media: m.media,
  }
}

describe('fromProjection（回放入口）', () => {
  it('user/assistant 行 → 视图模型；assistant 行 id 落位、无轨迹不折叠', () => {
    const vm = fromProjection({ sessionId: 's1', title: 'T', messages: [userRow(), assistantRow()] })
    expect(vm).toHaveLength(2)
    expect(vm[0]).toMatchObject({ role: 'user', text: '第一问', raw: '第一问', streaming: false, id: 'm1' })
    expect(vm[1]).toMatchObject({ role: 'assistant', text: '回答', thinking: '', streaming: false, id: 'm2' })
    expect(vm[1].traceFolded).toBeUndefined()
  })

  it('assistant 行 thinking/tools 挂载；success → done 呈现映射；有轨迹默认折叠（#664 T3）', () => {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [assistantRow({ thinking: '想一想', tools: [toolLine()] })],
    })
    expect(vm[0].thinking).toBe('想一想')
    expect(vm[0].tools[0]).toMatchObject({ id: 't1', name: 'bash', state: 'done', input: { command: 'ls' } })
    expect(vm[0].traceFolded).toBe(true)
  })

  it('details 字符串 JSON 解析（对象进 toolRender）；非 JSON 原串兜底', () => {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [assistantRow({ tools: [toolLine({ details: '{"diff":"+a"}' }), toolLine({ toolCallId: 't2', details: '纯文本结果' })] })],
    })
    expect(vm[0].tools[0].result).toEqual({ diff: '+a' })
    expect(vm[0].tools[1].result).toBe('纯文本结果')
  })

  it('rejection（审批拒绝回喂）与 truncated 截断标记透传', () => {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [assistantRow({ tools: [toolLine({ state: 'error', truncated: true, rejection: { source: 'funnel', reason: '被拒绝' } })] })],
    })
    expect(vm[0].tools[0].state).toBe('error')
    expect(vm[0].tools[0].truncated).toBe(true)
    expect(vm[0].tools[0].rejection).toEqual({ source: 'funnel', reason: '被拒绝' })
  })

  it('media 引用直挂；纯媒体行（content 空）照常渲染形态', () => {
    const vm = fromProjection({
      sessionId: 's1', title: 'T',
      messages: [assistantRow({ content: '', media: [{ attachmentId: 'a1', mime: 'image/png', size: 1, fileName: 'x.png' }] })],
    })
    expect(vm[0].media).toEqual([{ attachmentId: 'a1', mime: 'image/png', size: 1, fileName: 'x.png' }])
  })

  it('command 行（user 角色 /new /model）→ 平凡 user 消息（命令元数据不在投影读面）', () => {
    const vm = fromProjection({ sessionId: 's1', title: 'T', messages: [userRow({ content: '/new' })] })
    expect(vm[0]).toMatchObject({ role: 'user', text: '/new' })
  })

  it('inFlight（#779 story 11）→ 流式 overlay 挂尾（断线重建画面同构）', () => {
    const vm = fromProjection({
      sessionId: 's1', title: 'T', messages: [userRow()],
      inFlight: { runId: 'r9', state: 'running', turn: { content: '生成中', thinking: '嗯' } },
    })
    expect(vm).toHaveLength(2)
    expect(vm[1]).toMatchObject({ role: 'assistant', text: '生成中', thinking: '嗯', streaming: true, runId: 'r9' })
    expect(vm[1].traceFolded).toBeUndefined() // 进行态不折叠
  })
})

describe('applyEvent（实时入口）事件语义', () => {
  it('run.started → 空 overlay 建行（streaming + runId）；重复 started 幂等', () => {
    const once = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    expect(once).toHaveLength(1)
    expect(once[0]).toMatchObject({ role: 'assistant', streaming: true, runId: 'r1', text: '' })
    const twice = applyEvent(once, ev('run.started', {}, { runId: 'r1' }))
    expect(twice).toHaveLength(1)
  })

  it('text.delta 累积正文 + raw 同步；空 delta 忽略', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('text.delta', { delta: '你好' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('text.delta', { delta: '，世界' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('text.delta', { delta: '' }, { runId: 'r1' }))
    expect(vm[0].text).toBe('你好，世界')
    expect(vm[0].raw).toBe('你好，世界')
  })

  it('thinking.delta 累积 + thinkingOpen；text.delta 到来后闭合', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('thinking.delta', { delta: '思考' }, { runId: 'r1' }))
    expect(vm[0].thinkingOpen).toBe(true)
    vm = applyEvent(vm, ev('text.delta', { delta: '正文' }, { runId: 'r1' }))
    expect(vm[0].thinkingOpen).toBe(false)
    expect(vm[0].thinking).toBe('思考')
  })

  it('tool.start → running 行；重复 toolCallId 忽略（镜像 server 先到者赢）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 't1', name: 'bash', input: '{"command":"ls"}' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 't1', name: 'bash', input: '{"command":"OTHER"}' }, { runId: 'r1' }))
    expect(vm[0].tools).toHaveLength(1)
    expect(vm[0].tools[0]).toMatchObject({ id: 't1', state: 'running', input: { command: 'ls' } })
  })

  it('tool.end 合入 state/durationMs/details；无先行 start 的 end 忽略（镜像 server）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 't1', name: 'bash', input: '{"command":"ls"}' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 'ghost', state: 'success', details: 'x' }, { runId: 'r1' }))
    expect(vm[0].tools).toHaveLength(1)
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 't1', state: 'success', durationMs: 42, details: '{"ok":1}' }, { runId: 'r1' }))
    expect(vm[0].tools[0]).toMatchObject({ state: 'done', durationMs: 42, result: { ok: 1 } })
  })

  it('tool.end rejection 载荷透传（审批拒绝回喂红显）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 't1', name: 'bash', input: 'x' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 't1', state: 'error', rejection: { source: 'funnel', reason: '拒绝' } }, { runId: 'r1' }))
    expect(vm[0].tools[0].rejection).toEqual({ source: 'funnel', reason: '拒绝' })
  })

  it('figure_run.progress 写入匹配工具行的 stage（#799 story 50 进行态）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 'f1', name: 'figure_generate', input: '{"method_text":"流程图"}' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'f1', stage: 'segmenting' }, { runId: 'r1' }))
    expect(vm[0].tools[0]).toMatchObject({ id: 'f1', state: 'running', stage: 'segmenting' })
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'f1', stage: 'rendering' }, { runId: 'r1' }))
    expect(vm[0].tools[0].stage).toBe('rendering')
  })

  it('figure_run.progress 白名单外/无落点帧忽略（镜像 server parseFigureRunProgress 丢弃纪律）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 'f1', name: 'figure_generate', input: '{}' }, { runId: 'r1' }))
    const before = vm[0].tools[0]
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'f1', stage: '未知阶段' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('figure_run.progress', { stage: 'generating' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'ghost', stage: 'generating' }, { runId: 'r1' }))
    expect(vm[0].tools[0]).toBe(before) // 无变化 → 原引用返回（copy-on-write 零噪声）
  })

  it('stage 随 tool.end 剥落（终态行回放无此装饰——零差异不被污染）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 'f1', name: 'figure_generate', input: '{}' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('figure_run.progress', { toolCallId: 'f1', stage: 'assembling' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 'f1', state: 'success', details: '{"figureId":"fig1"}' }, { runId: 'r1' }))
    expect(vm[0].tools[0]).toMatchObject({ state: 'done', result: { figureId: 'fig1' } })
    expect(vm[0].tools[0].stage).toBeUndefined()
  })

  it('attachment 引用进 media（校验门镜像 server：缺字段整帧忽略）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('attachment', { attachmentId: 'a1', mime: 'image/png', size: 3, fileName: 'x.png', width: 2 }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('attachment', { attachmentId: '', mime: 'image/png', size: 3, fileName: 'bad.png' }, { runId: 'r1' }))
    expect(vm[0].media).toEqual([{ attachmentId: 'a1', mime: 'image/png', size: 3, fileName: 'x.png', width: 2 }])
  })

  it('终态（completed）剥进行态装饰 + 有轨迹默认折叠；空 run 终态整行剥落（镜像 isEmpty 不落行）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('text.delta', { delta: '答' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.start', { toolCallId: 't1', name: 'bash', input: 'x' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('tool.end', { toolCallId: 't1', state: 'success' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('run.completed', {}, { runId: 'r1' }))
    expect(vm[0].streaming).toBe(false)
    expect(vm[0].thinkingOpen).toBe(false)
    expect(vm[0].traceFolded).toBe(true)

    const empty = applyEvent([], ev('run.started', {}, { runId: 'r2' }))
    const dropped = applyEvent(empty, ev('run.completed', {}, { runId: 'r2' }))
    expect(dropped).toHaveLength(0)
  })

  it('run.failed/aborted 保留部分内容（服务端部分聚合落行）；归约器不落错误态（错误横幅在编排层）', () => {
    let vm = applyEvent([], ev('run.started', {}, { runId: 'r1' }))
    vm = applyEvent(vm, ev('text.delta', { delta: '半截' }, { runId: 'r1' }))
    vm = applyEvent(vm, ev('run.failed', { errorKind: 'llm_error' }, { runId: 'r1' }))
    expect(vm).toHaveLength(1)
    expect(vm[0]).toMatchObject({ text: '半截', streaming: false })
    expect((vm[0] as Msg & { errorKind?: string }).errorKind).toBeUndefined()
  })

  it('非归约器白名单事件（session.*/approval.*/teammate.*）原样返回', () => {
    const vm: Msg[] = [newMsg('user', 'hi')]
    expect(applyEvent(vm, ev('session.updated', {}))).toBe(vm)
    expect(applyEvent(vm, ev('approval.requested', {}))).toBe(vm)
    expect(applyEvent(vm, ev('teammate.started', {}))).toBe(vm)
    expect(applyEvent(vm, ev('totally.unknown', {}))).toBe(vm)
  })

  it('copy-on-write：无关消息引用复用，受影响消息替换为新对象（不改入参）', () => {
    const user = newMsg('user', 'q')
    const prev: Msg[] = [user]
    const next = applyEvent(prev, ev('run.started', {}, { runId: 'r1' }))
    expect(next[0]).toBe(user) // 复用
    expect(prev).toHaveLength(1) // 入参不变
    const next2 = applyEvent(next, ev('text.delta', { delta: 'a' }, { runId: 'r1' }))
    expect(next2[0]).toBe(user) // user 复用
    expect(next2[1]).not.toBe(next[1]) // overlay 克隆
  })
})

describe('零差异一致性（硬验收：reduce(全量事件) ≡ 投影行）', () => {
  // server TurnReducer 语义的投影行构造器：与事件序列一一对应（服务端由 TurnReducer.feed + recordTurn
  // 落行——此处按 reducer.ts 逐条语义手工折叠，作为「服务端会写出什么」的镜像）。
  // 注意：审批拒绝回喂帧（tool.end 带 rejection，runService.publishRejection 直发）**不经**
  // server TurnReducer（不落行）——带 rejection 的事件序列不在本一致性组覆盖（服务端投影缺口，
  // 修复归 server 侧票）；归约器对 rejection 的实时渲染语义由上方单测锁定，终态以投影重拉整替为准。
  function rowsFromEvents(events: SessionEvent[], userText: string): ProjectionMessage[] {
    let content = ''
    let thinking: string | undefined
    const tools = new Map<string, ToolLine>()
    const media: Array<Record<string, unknown>> = []
    for (const e of events) {
      if (e.type === 'text.delta' && typeof e.payload.delta === 'string') content += e.payload.delta
      if (e.type === 'thinking.delta' && typeof e.payload.delta === 'string') thinking = (thinking ?? '') + e.payload.delta
      if (e.type === 'tool.start' && typeof e.payload.toolCallId === 'string' && !tools.has(e.payload.toolCallId)) {
        tools.set(e.payload.toolCallId, { toolCallId: e.payload.toolCallId, name: String(e.payload.name), input: String(e.payload.input ?? ''), state: 'running' })
      }
      if (e.type === 'tool.end' && typeof e.payload.toolCallId === 'string' && tools.has(e.payload.toolCallId)) {
        const t = tools.get(e.payload.toolCallId)!
        if (e.payload.state === 'success' || e.payload.state === 'error') t.state = e.payload.state
        if (typeof e.payload.durationMs === 'number') t.durationMs = e.payload.durationMs
        if (typeof e.payload.details === 'string') t.details = e.payload.details
        if (e.payload.truncated === true) t.truncated = true
      }
      if (e.type === 'attachment' && typeof e.payload.attachmentId === 'string') media.push({ ...e.payload })
    }
    const rows: ProjectionMessage[] = [userRow({ id: 'm1', content: userText })]
    const aggregate: Record<string, unknown> = {}
    if (thinking !== undefined) aggregate.thinking = thinking
    if (tools.size > 0) aggregate.tools = [...tools.values()]
    if (media.length > 0) aggregate.media = media
    rows.push(assistantRow({ id: 'm2', content, ...aggregate }))
    return rows
  }

  const LIVE_USER: Msg = {
    role: 'user', raw: '帮我看看', text: '帮我看看', thinking: '', thinkingOpen: false,
    streaming: false, tools: [], media: [], id: 'm1',
  }

  const SCENARIOS: Array<{ name: string; events: SessionEvent[] }> = [
    {
      name: '纯文本轮',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('text.delta', { delta: '你好' }, { runId: 'r1' }),
        ev('text.delta', { delta: '，我是助手' }, { runId: 'r1' }),
        ev('run.completed', {}, { runId: 'r1' }),
      ],
    },
    {
      name: '思考 + 多工具 + 媒体 + 文本（error 工具 + truncated details）',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('thinking.delta', { delta: '先查文件' }, { runId: 'r1' }),
        ev('thinking.delta', { delta: '，再跑命令' }, { runId: 'r1' }),
        ev('tool.start', { toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}' }, { runId: 'r1' }),
        ev('tool.end', { toolCallId: 't1', state: 'success', durationMs: 12, details: '{"content":"# hi"}' }, { runId: 'r1' }),
        ev('tool.start', { toolCallId: 't2', name: 'bash', input: '{"command":"ls"}', truncated: true }, { runId: 'r1' }),
        ev('tool.end', { toolCallId: 't2', state: 'error', durationMs: 5, details: '命令执行失败', truncated: true }, { runId: 'r1' }),
        ev('text.delta', { delta: '查到了，' }, { runId: 'r1' }),
        ev('attachment', { attachmentId: 'a1', mime: 'image/png', size: 8, fileName: 'shot.png', width: 10, height: 10 }, { runId: 'r1' }),
        ev('text.delta', { delta: '见图。' }, { runId: 'r1' }),
        ev('run.completed', {}, { runId: 'r1' }),
      ],
    },
    {
      name: '工具先于文本、details 为纯文本（非 JSON）',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('tool.start', { toolCallId: 't1', name: 'write', input: '{"file_path":"b.md","content":"x\\n"}' }, { runId: 'r1' }),
        ev('tool.end', { toolCallId: 't1', state: 'success', details: '已写入 1 行' }, { runId: 'r1' }),
        ev('text.delta', { delta: '完成' }, { runId: 'r1' }),
        ev('run.completed', {}, { runId: 'r1' }),
      ],
    },
    {
      name: 'thinking-only 轮（无正文无工具）',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('thinking.delta', { delta: '只想了想' }, { runId: 'r1' }),
        ev('run.completed', {}, { runId: 'r1' }),
      ],
    },
    {
      name: '失败轮保留部分聚合（llm_error）',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('text.delta', { delta: '生成到一半' }, { runId: 'r1' }),
        ev('tool.start', { toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}' }, { runId: 'r1' }),
        ev('run.failed', { errorKind: 'llm_error' }, { runId: 'r1' }),
      ],
    },
    {
      name: 'figure 工具全生命周期（六 stage progress + 终态 details，#799 story 50）',
      events: [
        ev('run.started', {}, { runId: 'r1' }),
        ev('tool.start', { toolCallId: 'f1', name: 'figure_generate', input: '{"method_text":"方法流程图"}' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'generating' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'segmenting' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'preparing' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'templating' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'assembling' }, { runId: 'r1' }),
        ev('figure_run.progress', { toolCallId: 'f1', stage: 'rendering' }, { runId: 'r1' }),
        ev('tool.end', { toolCallId: 'f1', state: 'success', durationMs: 4200, details: '{"figureId":"fig1","state":"completed","previewReady":true}' }, { runId: 'r1' }),
        ev('text.delta', { delta: '图已生成。' }, { runId: 'r1' }),
        ev('run.completed', {}, { runId: 'r1' }),
      ],
    },
  ]

  for (const s of SCENARIOS) {
    it(`场景：${s.name}`, () => {
      // 实时路径：用户消息在位（POST 响应已回填 id），事件依到达序灌入归约器
      let live: Msg[] = [LIVE_USER]
      for (const e of s.events) live = applyEvent(live, e)
      const rows = rowsFromEvents(s.events, '帮我看看')
      const replay = fromProjection({ sessionId: 's1', title: 'T', messages: rows })
      expect(live).toHaveLength(replay.length)
      for (let i = 0; i < replay.length; i++) {
        expect(normalize(live[i])).toEqual(normalize(replay[i]))
      }
    })
  }

  it('流式中途画面 = 刷新重建画面（inFlight 重建同构，#730 §1.3 断线无跳变）', () => {
    const events = [
      ev('run.started', {}, { runId: 'r1' }),
      ev('text.delta', { delta: '已生成部分' }, { runId: 'r1' }),
      ev('tool.start', { toolCallId: 't1', name: 'bash', input: '{"command":"ls"}' }, { runId: 'r1' }),
      ev('tool.end', { toolCallId: 't1', state: 'success', details: 'ok' }, { runId: 'r1' }),
    ]
    let live: Msg[] = [LIVE_USER]
    for (const e of events) live = applyEvent(live, e)
    // 断线重连：GET /messages 返回已落库行 + inFlight（server 由 checkpoint blob 重建）
    const replay = fromProjection({
      sessionId: 's1', title: 'T', messages: [userRow({ id: 'm1', content: '帮我看看' })],
      inFlight: { runId: 'r1', state: 'running', turn: { content: '已生成部分', tools: [toolLine({ details: 'ok' })] } },
    })
    expect(normalize(live[0])).toEqual(normalize(replay[0]))
    expect(live).toHaveLength(2)
    expect(normalize(live[1])).toEqual(normalize(replay[1]))
    expect(live[1].streaming).toBe(true)
    expect(live[1].runId).toBe('r1')
  })
})

describe('辅助判定（渲染层共用单一实现）', () => {
  it('hasTrace：思考或工具即真；正文与媒体不算', () => {
    const m = newMsg('assistant', '正文')
    expect(hasTrace(m)).toBe(false)
    m.thinking = 'x'
    expect(hasTrace(m)).toBe(true)
    m.thinking = ''
    m.tools.push({ id: 't', name: 'n', state: 'done', title: null, input: null, result: null })
    expect(hasTrace(m)).toBe(true)
  })
  it('shouldFoldTrace：仅 assistant 折叠', () => {
    const u = newMsg('user', 'q')
    u.tools.push({ id: 't', name: 'n', state: 'done', title: null, input: null, result: null })
    expect(shouldFoldTrace(u)).toBe(false)
  })
})

// ---- teammate 具名折叠区（#796 / #730 §4.3 TraceFold 泛化）----
// 分区纪律：主时间线只挂 leader 发言与产物；带顶层 teammateId 的事件经 applyTeamEvent 路由进
// 具名分区（fold.msgs 与主时间线同一归约器 applyEvent——同形状的机制载体）。mailbox 无实时
// 事件（server sendMail 不 publish），是 REST-only 面——实时靠投影重拉整替，不入事件归约。
describe('teamFoldsFromProjection（teammate 回放入口）', () => {
  const peerRow = (over: Partial<ProjectionMessage> = {}): ProjectionMessage => ({
    id: 'pm1', turn: 1, role: 'assistant', content: '队友产出', anchorCheckpointId: null, createdAt: '2026-10-06T01:00:00Z', ...over,
  })

  it('teammates 行 → TeamFold[]：id/name/task/status 直挂，msgs 走 fromProjection 同构，mailbox 直挂', () => {
    const p: SessionProjection = {
      sessionId: 's1', title: 'T',
      messages: [],
      teammates: [{
        id: 'tm1', name: '文献员', task: '整理文献', status: 'completed',
        messages: [peerRow({ thinking: '翻一翻', tools: [toolLine()] })],
        mailbox: [{ id: 'mail1', senderTeammateId: 'tm1', recipientTeammateId: null, kind: 'message', content: '已完成', createdAt: '2026-10-06T01:01:00Z' }],
      }],
    }
    const folds = teamFoldsFromProjection(p)
    expect(folds).toHaveLength(1)
    expect(folds[0]).toMatchObject({ id: 'tm1', name: '文献员', task: '整理文献', status: 'completed' })
    expect(folds[0].msgs).toHaveLength(1)
    expect(folds[0].msgs[0]).toMatchObject({ role: 'assistant', text: '队友产出', thinking: '翻一翻', streaming: false })
    expect(folds[0].msgs[0].tools[0]).toMatchObject({ id: 't1', name: 'bash', state: 'done' })
    expect(folds[0].msgs[0].traceFolded).toBe(true) // 有轨迹默认折叠（#664 语义延伸）
    expect(folds[0].mailbox).toEqual([p.teammates![0].mailbox[0]])
  })

  it('teammate inFlight → 流式 overlay 挂尾（与主时间线同构）', () => {
    const folds = teamFoldsFromProjection({
      sessionId: 's1', title: 'T', messages: [],
      teammates: [{
        id: 'tm1', name: '文献员', task: 't', status: 'running', messages: [],
        mailbox: [],
        inFlight: { runId: 'r9', state: 'running', turn: { content: '检索中' } },
      }],
    })
    expect(folds[0].msgs).toHaveLength(1)
    expect(folds[0].msgs[0]).toMatchObject({ streaming: true, text: '检索中', runId: 'r9' })
  })

  it('无 teammates → 空数组（server 缺省省略 teammates 字段）', () => {
    expect(teamFoldsFromProjection({ sessionId: 's1', title: 'T', messages: [] })).toEqual([])
  })
})

describe('applyTeamEvent（teammate 实时入口：teammateId 分区路由）', () => {
  const fold = (over: Partial<TeamFold> = {}): TeamFold => ({
    id: 'tm1', name: '文献员', task: '整理文献', status: 'running', msgs: [], mailbox: [], ...over,
  })

  it('无 teammateId 的事件原样返回（非分区事件不入 fold）', () => {
    const teams = [fold()]
    expect(applyTeamEvent(teams, ev('run.started', {}, { runId: 'r1' }))).toBe(teams)
  })

  it('teammate.started（未知 teammate）→ 占位 fold（payload.name 取名，status running）', () => {
    const next = applyTeamEvent([], ev('teammate.started', { teammateId: 'tm2', name: '写作员' }, { runId: 'r1', teammateId: 'tm2' }))
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'tm2', name: '写作员', task: '', status: 'running', msgs: [] })
  })

  it('轨迹事件路由进当事 fold：text/tool 累积于 fold.msgs（与主时间线同款 overlay）', () => {
    let teams = [fold()]
    teams = applyTeamEvent(teams, ev('run.started', {}, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('text.delta', { delta: '检索' }, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('tool.start', { toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}' }, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('tool.end', { toolCallId: 't1', state: 'success', details: 'ok' }, { runId: 'r1', teammateId: 'tm1' }))
    expect(teams[0].msgs).toHaveLength(1)
    expect(teams[0].msgs[0].text).toBe('检索')
    expect(teams[0].msgs[0].tools[0]).toMatchObject({ id: 't1', state: 'done', result: 'ok' })
    expect(teams[0].msgs[0].streaming).toBe(true)
  })

  it('run 终态 → fold 内 finalize（剥装饰 + 有轨迹默认折叠）', () => {
    let teams = [fold()]
    teams = applyTeamEvent(teams, ev('run.started', {}, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('thinking.delta', { delta: '检索策略' }, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('text.delta', { delta: '检索完成' }, { runId: 'r1', teammateId: 'tm1' }))
    teams = applyTeamEvent(teams, ev('run.completed', {}, { runId: 'r1', teammateId: 'tm1' }))
    expect(teams[0].msgs[0].streaming).toBe(false)
    expect(teams[0].msgs[0].traceFolded).toBe(true)
  })

  it('teammate 终态事件 → status 更新（started→running 镜像 server startTeammate；archived 归档终态）', () => {
    let teams = [fold({ status: 'running' })]
    teams = applyTeamEvent(teams, ev('teammate.completed', { name: '文献员' }, { runId: 'r1', teammateId: 'tm1' }))
    expect(teams[0].status).toBe('completed')
    teams = applyTeamEvent(teams, ev('teammate.suspended', { name: '文献员' }, { teammateId: 'tm1' }))
    expect(teams[0].status).toBe('suspended')
    teams = applyTeamEvent(teams, ev('teammate.archived', { name: '文献员' }, { teammateId: 'tm1' }))
    expect(teams[0].status).toBe('archived')
    expect(teams[0].msgs).toHaveLength(0) // 归档不删：轨迹保留可回看
  })

  it('未知 teammate 的轨迹事件 → 占位 fold 兜底（乱序源不丢帧，REST 整替补全 task/mailbox）', () => {
    const next = applyTeamEvent([], ev('text.delta', { delta: '迟到帧' }, { runId: 'r1', teammateId: 'tm9' }))
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('tm9')
    expect(next[0].msgs[0].text).toBe('迟到帧')
  })

  it('copy-on-write：无关 fold 引用复用，当事 fold 替换为新对象', () => {
    const a = fold({ id: 'tm1' })
    const b = fold({ id: 'tm2', name: '写作员' })
    const teams = [a, b]
    const next = applyTeamEvent(teams, ev('text.delta', { delta: 'x' }, { runId: 'r1', teammateId: 'tm2' }))
    expect(next[0]).toBe(a)
    expect(next[1]).not.toBe(b)
    expect(b.msgs).toHaveLength(0)
  })

  it('无变化帧（空 delta 等）原样返回同一数组引用', () => {
    const teams = [fold()]
    expect(applyTeamEvent(teams, ev('text.delta', { delta: '' }, { runId: 'r1', teammateId: 'tm1' }))).toBe(teams)
  })
})

describe('teammate 零差异一致性 + 并发不串区（#796 验收）', () => {
  // 零差异断言面 = 事件流可推导的渲染显著字段（msgs 轨迹 + status 徽标）。name/task/mailbox 是
  // REST-only 元数据（事件流不含 task/mailbox 载荷；name 仅 teammate.* 事件附带）——实时路径由
  // 投影整替补全（useChatSession.refreshProjection 灌 setTeams），不在纯归约器断言面内。
  function normalizeFold(f: TeamFold) {
    return {
      status: f.status,
      msgs: f.msgs.map(normalize),
    }
  }

  const PEER_EVENTS: SessionEvent[] = [
    ev('run.started', {}, { runId: 'r9', teammateId: 'tm1' }),
    ev('thinking.delta', { delta: '先查' }, { runId: 'r9', teammateId: 'tm1' }),
    ev('tool.start', { toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}' }, { runId: 'r9', teammateId: 'tm1' }),
    ev('tool.end', { toolCallId: 't1', state: 'success', durationMs: 3, details: '{"n":1}' }, { runId: 'r9', teammateId: 'tm1' }),
    ev('text.delta', { delta: '查到 1 条' }, { runId: 'r9', teammateId: 'tm1' }),
    ev('run.completed', {}, { runId: 'r9', teammateId: 'tm1' }),
    ev('teammate.completed', { name: '文献员' }, { teammateId: 'tm1' }),
  ]

  it('场景：单 teammate 全生命周期（reduce(事件) ≡ 投影行）', () => {
    let live = applyTeamEvent([], PEER_EVENTS[0])
    for (let i = 1; i < PEER_EVENTS.length; i++) live = applyTeamEvent(live, PEER_EVENTS[i])
    const replay = teamFoldsFromProjection({
      sessionId: 's1', title: 'T', messages: [],
      teammates: [{
        id: 'tm1', name: '文献员', task: '整理文献', status: 'completed', mailbox: [],
        messages: [{
          id: 'pm1', turn: 1, role: 'assistant', content: '查到 1 条', anchorCheckpointId: null, createdAt: '2026-10-06T01:00:00Z',
          thinking: '先查',
          tools: [{ toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}', state: 'success', durationMs: 3, details: '{"n":1}' }],
        }],
      }],
    })
    expect(live).toHaveLength(1)
    expect(normalizeFold(live[0])).toEqual(normalizeFold(replay[0]))
  })

  it('场景：并发两 teammate 交错事件流——各 fold 内容不混，各自零差异', () => {
    const a: SessionEvent[] = [
      ev('run.started', {}, { runId: 'rA', teammateId: 'tmA' }),
      ev('text.delta', { delta: '甲线' }, { runId: 'rA', teammateId: 'tmA' }),
      ev('run.completed', {}, { runId: 'rA', teammateId: 'tmA' }),
      ev('teammate.completed', { name: 'A' }, { teammateId: 'tmA' }),
    ]
    const b: SessionEvent[] = [
      ev('run.started', {}, { runId: 'rB', teammateId: 'tmB' }),
      ev('text.delta', { delta: '乙线' }, { runId: 'rB', teammateId: 'tmB' }),
      ev('run.completed', {}, { runId: 'rB', teammateId: 'tmB' }),
      ev('teammate.completed', { name: 'B' }, { teammateId: 'tmB' }),
    ]
    // 严格交错（真实并发到达序）
    let live: TeamFold[] = []
    for (let i = 0; i < 4; i++) {
      live = applyTeamEvent(live, a[i])
      live = applyTeamEvent(live, b[i])
    }
    expect(live).toHaveLength(2)
    const fa = live.find((f) => f.id === 'tmA')!
    const fb = live.find((f) => f.id === 'tmB')!
    expect(fa.msgs).toHaveLength(1)
    expect(fa.msgs[0].text).toBe('甲线')
    expect(fb.msgs[0].text).toBe('乙线')
    // 各自与自己的投影行零差异
    const replay = teamFoldsFromProjection({
      sessionId: 's1', title: 'T', messages: [],
      teammates: [
        { id: 'tmA', name: 'A', task: '', status: 'completed', mailbox: [], messages: [{ id: 'pa', turn: 1, role: 'assistant', content: '甲线', anchorCheckpointId: null, createdAt: '2026-10-06T01:00:00Z' }] },
        { id: 'tmB', name: 'B', task: '', status: 'completed', mailbox: [], messages: [{ id: 'pb', turn: 1, role: 'assistant', content: '乙线', anchorCheckpointId: null, createdAt: '2026-10-06T01:00:00Z' }] },
      ],
    })
    expect(normalizeFold(live.find((f) => f.id === 'tmA')!)).toEqual(normalizeFold(replay[0]))
    expect(normalizeFold(live.find((f) => f.id === 'tmB')!)).toEqual(normalizeFold(replay[1]))
  })

  it('场景：流式中途画面 = 刷新重建画面（teammate inFlight 同构）', () => {
    const partial = PEER_EVENTS.slice(0, 5) // 终态前
    let live: TeamFold[] = []
    for (const e of partial) live = applyTeamEvent(live, e)
    const replay = teamFoldsFromProjection({
      sessionId: 's1', title: 'T', messages: [],
      teammates: [{
        id: 'tm1', name: '文献员', task: '', status: 'running', mailbox: [],
        messages: [],
        inFlight: {
          runId: 'r9', state: 'running',
          turn: { content: '查到 1 条', thinking: '先查', tools: [{ toolCallId: 't1', name: 'read', input: '{"file_path":"a.md"}', state: 'success', durationMs: 3, details: '{"n":1}' }] },
        },
      }],
    })
    expect(live).toHaveLength(1)
    expect(normalizeFold(live[0])).toEqual(normalizeFold(replay[0]))
  })
})

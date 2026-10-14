// S3 纯逻辑单测（#778 · #747 Testing Decisions）：TurnReducer——run 域事件 → 单 turn 聚合。
// 「单管线渲染」后端面：同一事件流归约出的终态形状 = session_messages 行（attachmentsJson v1）
// = 投影 GET 输出——测试锁定三面同构中的归约器一面（API 面零差异断言在 sessionsApi.test.ts）。

import { describe, it, expect } from 'vitest'
import { TurnReducer, serializeAttachments, type TurnSnapshot } from '../src/sessions/reducer'
import type { CatalogEvent } from '../src/events/logic'

function ev(type: string, payload: unknown): Omit<CatalogEvent, 'sessionId' | 'runId'> {
  return { type, payload }
}

describe('TurnReducer：run 域事件归约（S3）', () => {
  it('text.delta 拼接为 content（多 delta 有序累积）', () => {
    const r = new TurnReducer()
    r.feed(ev('text.delta', { delta: '你好' }))
    r.feed(ev('text.delta', { delta: '，世界' }))
    const snap = r.snapshot()
    expect(snap.content).toBe('你好，世界')
    expect(snap.thinking).toBeUndefined()
    expect(snap.tools).toBeUndefined()
  })

  it('thinking.delta 聚合为 thinking（与 content 分轨不串流）', () => {
    const r = new TurnReducer()
    r.feed(ev('thinking.delta', { delta: '先想' }))
    r.feed(ev('text.delta', { delta: '正文' }))
    r.feed(ev('thinking.delta', { delta: '一下' }))
    const snap = r.snapshot()
    expect(snap.content).toBe('正文')
    expect(snap.thinking).toBe('先想一下')
    expect(snap.tools).toBeUndefined()
  })

  it('tool.start/end 聚合为 tools（start 建行 running，end 填 state/durationMs/details）', () => {
    const r = new TurnReducer()
    r.feed(ev('tool.start', { toolCallId: 'c1', name: 'write_file', input: '{"path":"/lab/a"}' }))
    const running = r.snapshot()
    expect(running.tools).toEqual([
      { toolCallId: 'c1', name: 'write_file', input: '{"path":"/lab/a"}', state: 'running' },
    ])
    r.feed(
      ev('tool.end', {
        toolCallId: 'c1',
        name: 'write_file',
        state: 'success',
        durationMs: 42,
        details: 'ok',
      }),
    )
    expect(r.snapshot().tools).toEqual([
      {
        toolCallId: 'c1',
        name: 'write_file',
        input: '{"path":"/lab/a"}',
        state: 'success',
        durationMs: 42,
        details: 'ok',
      },
    ])
  })

  it('多工具按 start 顺序成列；未见 start 的 end（不可达防御）忽略不炸', () => {
    const r = new TurnReducer()
    r.feed(ev('tool.start', { toolCallId: 'a', name: 't1', input: '1' }))
    r.feed(ev('tool.start', { toolCallId: 'b', name: 't2', input: '2' }))
    r.feed(ev('tool.end', { toolCallId: 'ghost', name: 't3', state: 'success', durationMs: 1, details: '' }))
    r.feed(ev('tool.end', { toolCallId: 'b', name: 't2', state: 'error', durationMs: 5, details: 'boom' }))
    expect(r.snapshot().tools?.map((t) => t.toolCallId)).toEqual(['a', 'b'])
    expect(r.snapshot().tools?.[1]).toMatchObject({ state: 'error', durationMs: 5 })
  })

  it('#783 拒绝红显：tool.end{rejection} 进聚合——短 reason 原样直通，非法形态丢弃', () => {
    const r = new TurnReducer()
    r.feed(ev('tool.start', { toolCallId: 'c1', name: 'exec', input: 'curl' }))
    r.feed(ev('tool.start', { toolCallId: 'c2', name: 'exec', input: 'ls' }))
    r.feed(
      ev('tool.end', {
        toolCallId: 'c1',
        name: 'exec',
        state: 'error',
        durationMs: 0,
        rejection: { source: 'judge', reason: '数据外送类拒绝' },
      }),
    )
    // source 非二值白名单（blacklist|judge）→ 整个 rejection 丢弃（0 信任）
    r.feed(
      ev('tool.end', {
        toolCallId: 'c2',
        name: 'exec',
        state: 'error',
        rejection: { source: 'human', reason: 'x' },
      }),
    )
    const tools = r.snapshot().tools!
    expect(tools[0]!.rejection).toEqual({ source: 'judge', reason: '数据外送类拒绝' })
    expect(tools[0]!.truncated).toBeUndefined()
    expect(tools[1]!.rejection).toBeUndefined()
  })

  it('#783 拒绝红显：超长 reason 防御截断 ≤1k（对齐 input 纪律）+ truncated 标记', () => {
    const r = new TurnReducer()
    r.feed(ev('tool.start', { toolCallId: 'c1', name: 'exec', input: 'curl' }))
    r.feed(
      ev('tool.end', {
        toolCallId: 'c1',
        name: 'exec',
        state: 'error',
        durationMs: 0,
        rejection: { source: 'judge', reason: 'x'.repeat(5000) },
      }),
    )
    const line = r.snapshot().tools![0]!
    expect(line.rejection!.source).toBe('judge')
    expect(line.rejection!.reason).toBe('x'.repeat(1024))
    expect(line.truncated).toBe(true)
  })

  it('#783 拒绝红显：中文 reason 按 UTF-8 字节截断（≤1k 字节、不切残字符、保前缀）', () => {
    const r = new TurnReducer()
    r.feed(ev('tool.start', { toolCallId: 'c1', name: 'exec', input: 'x' }))
    const reason = '拒'.repeat(600) // 600 字 × 3 字节 = 1800 字节 > 1k
    r.feed(
      ev('tool.end', {
        toolCallId: 'c1',
        name: 'exec',
        state: 'error',
        rejection: { source: 'blacklist', reason },
      }),
    )
    const got = r.snapshot().tools![0]!.rejection!.reason
    expect(Buffer.byteLength(got, 'utf8')).toBeLessThanOrEqual(1024)
    expect(reason.startsWith(got)).toBe(true)
  })

  it('run 域生命周期事件与未知类型一律忽略（白名单外不进聚合）', () => {
    const r = new TurnReducer()
    r.feed(ev('run.started', {}))
    r.feed(ev('run.resumed', {}))
    r.feed(ev('session.updated', { session: {} }))
    r.feed(ev('text.delta', { nonsense: true })) // delta 缺失
    expect(r.isEmpty()).toBe(true)
  })

  it('空聚合 isEmpty=true；有任一内容即 false（终态空 run 不落行的判据）', () => {
    const r = new TurnReducer()
    expect(r.isEmpty()).toBe(true)
    r.feed(ev('text.delta', { delta: 'x' }))
    expect(r.isEmpty()).toBe(false)
    const r2 = new TurnReducer()
    r2.feed(ev('tool.start', { toolCallId: 't', name: 'n', input: '' }))
    expect(r2.isEmpty()).toBe(false)
  })

  it('serializeAttachments v1：字段序稳定、空聚合缺省 thinking/tools（schema 版本化）', () => {
    const r = new TurnReducer()
    expect(JSON.parse(serializeAttachments(r.snapshot()))).toEqual({ v: 1 })
    r.feed(ev('thinking.delta', { delta: '想' }))
    r.feed(ev('text.delta', { delta: '答' }))
    r.feed(ev('tool.start', { toolCallId: 'c', name: 'exec', input: 'ls' }))
    r.feed(ev('tool.end', { toolCallId: 'c', name: 'exec', state: 'success', durationMs: 1, details: '' }))
    const parsed = JSON.parse(serializeAttachments(r.snapshot())) as Record<string, unknown>
    expect(parsed.v).toBe(1)
    expect(parsed.thinking).toBe('想')
    expect(Array.isArray(parsed.tools)).toBe(true)
    // 字段序稳定（逐字节一致断言的前提）
    expect(serializeAttachments(r.snapshot())).toBe(serializeAttachments(r.snapshot()))
  })

  it('#959 turn.files 事件进聚合：合法行入快照，非法行（缺 path / op 白名单外）丢弃', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', {
      files: [
        { path: 'new.md', op: 'created' },
        { path: '', op: 'created' }, // 空 path 丢弃
        { path: 'x.md', op: 'renamed' }, // op 白名单外丢弃
        { path: 'ok.md', op: 'modified' },
      ],
    }))
    expect(r.snapshot().files).toEqual([
      { path: 'new.md', op: 'created' },
      { path: 'ok.md', op: 'modified' },
    ])
  })

  it('#959 turn.files 校验门：payload 缺 files 数组 / 全非法行 → 不设 files 键', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', { nonsense: true }))
    r.feed(ev('turn.files', { files: 'not-an-array' }))
    r.feed(ev('turn.files', { files: [{ path: 'x.md', op: 'renamed' }, { op: 'created' }] }))
    r.feed(ev('turn.files', null))
    expect(r.snapshot().files).toBeUndefined()
    expect(r.isEmpty()).toBe(true)
  })

  it('#959 空聚合判据：仅 files 非空即非空（纯产物轮不落行会丢卡——回放零差异前提）', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }] }))
    expect(r.isEmpty()).toBe(false)
    expect(r.snapshot().content).toBe('')
  })

  it('#959 serializeAttachments：files 键入 v1 JSON（media 后 command 前——字段序稳定）', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }] }))
    const json = JSON.parse(serializeAttachments(r.snapshot())) as Record<string, unknown>
    expect(json.files).toEqual([{ path: 'a.md', op: 'created' }])
    expect(json.media).toBeUndefined()
    expect(serializeAttachments(r.snapshot())).toBe(serializeAttachments(r.snapshot()))
  })

  it('#960 filesTotal：截断帧 total 入快照与 v1 JSON（回放面「等 N 个文件」数据源）', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], total: 25 }))
    expect(r.snapshot().filesTotal).toBe(25)
    const json = JSON.parse(serializeAttachments(r.snapshot())) as Record<string, unknown>
    expect(json.filesTotal).toBe(25)
    // 字段序稳定（files 后 filesTotal）
    expect(serializeAttachments(r.snapshot())).toBe(serializeAttachments(r.snapshot()))
  })

  it('#960 物化行形状三面同构：事件帧（attachmentId/fileName/size）→ 快照 → v1 JSON 往返一致', () => {
    const r = new TurnReducer()
    const frame = {
      files: [
        { path: 'notes/new.md', op: 'created', attachmentId: 'att-1', fileName: 'new.md', size: 5 },
        { path: 'notes/gone.md', op: 'deleted' },
      ],
      total: 2,
    }
    r.feed(ev('turn.files', frame))
    // 快照 ≡ 事件帧（回放面 recordTurn 落行即此快照）
    expect(r.snapshot().files).toEqual(frame.files)
    expect(r.snapshot().filesTotal).toBe(2)
    // 投影面：serializeAttachments 往返（attachmentsJson → toProjectionMessage rest 透传）
    const json = JSON.parse(serializeAttachments(r.snapshot())) as { v?: number; files?: unknown[]; filesTotal?: number }
    expect(json.files).toEqual(frame.files)
    expect(json.filesTotal).toBe(2)
    const { v: _v, ...aggregate } = json
    expect(aggregate).toEqual({ files: frame.files, filesTotal: 2 })
  })

  it('#960 filesTotal 校验门：缺省 = files.length；非 number / 小于列出数 → 丢弃用缺省（0 信任）', () => {
    const r1 = new TurnReducer()
    r1.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }] }))
    expect(r1.snapshot().filesTotal).toBe(1)
    const r2 = new TurnReducer()
    r2.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], total: '25' }))
    expect(r2.snapshot().filesTotal).toBe(1)
    const r3 = new TurnReducer()
    r3.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], total: 0 }))
    expect(r3.snapshot().filesTotal).toBe(1)
    // files 空 → 无 filesTotal（无卡面即无计数行）
    const r4 = new TurnReducer()
    r4.feed(ev('turn.files', { files: [], total: 30 }))
    expect(r4.snapshot().files).toBeUndefined()
    expect(r4.snapshot().filesTotal).toBeUndefined()
  })

  it('#961 hasExec：帧标记 true 入快照与 v1 JSON（files 块内，字段序 files → filesTotal → hasExec）', () => {
    const r = new TurnReducer()
    r.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], total: 1, hasExec: true }))
    expect(r.snapshot().hasExec).toBe(true)
    const json = JSON.parse(serializeAttachments(r.snapshot())) as Record<string, unknown>
    expect(json.hasExec).toBe(true)
    expect(Object.keys(json)).toEqual(['v', 'files', 'filesTotal', 'hasExec'])
    // 回放面往返：attachmentsJson → 投影行聚合面同形状（toProjectionMessage 透传面）
    const { v: _v, ...aggregate } = json
    expect(aggregate).toEqual({ files: [{ path: 'a.md', op: 'created' }], filesTotal: 1, hasExec: true })
  })

  it('#961 hasExec 校验门：帧无标记 / 非 true（0 信任）不落键——「不含 execute 轮无标记」回放面', () => {
    const r1 = new TurnReducer()
    r1.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }] }))
    expect(r1.snapshot().hasExec).toBeUndefined()
    const r2 = new TurnReducer()
    r2.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], hasExec: 'yes' }))
    expect(r2.snapshot().hasExec).toBeUndefined()
    const r3 = new TurnReducer()
    r3.feed(ev('turn.files', { files: [{ path: 'a.md', op: 'created' }], hasExec: 1 }))
    expect(r3.snapshot().hasExec).toBeUndefined()
    // 键缺省：v1 JSON 不落 hasExec（与 filesTotal 不落键同纪律）
    const json = JSON.parse(serializeAttachments(r1.snapshot())) as Record<string, unknown>
    expect(json.hasExec).toBeUndefined()
  })

  it('snapshot 与 attachmentsJson 反序列化同构（投影行 = content 列 + JSON 聚合面组装）', () => {
    const r = new TurnReducer()
    r.feed(ev('text.delta', { delta: '答案' }))
    r.feed(ev('thinking.delta', { delta: '思路' }))
    r.feed(ev('tool.start', { toolCallId: 'c1', name: 'exec', input: 'ls' }))
    r.feed(ev('tool.end', { toolCallId: 'c1', name: 'exec', state: 'success', durationMs: 3, details: 'out' }))
    const snap = r.snapshot()
    const json = JSON.parse(serializeAttachments(snap)) as {
      v: number
      thinking?: string
      tools?: TurnSnapshot['tools']
    }
    expect(json.thinking).toBe(snap.thinking)
    expect(json.tools).toEqual(snap.tools)
    // 投影行组装（service 投影路径同款）：content 独立列 + JSON 聚合面（v 版本字段不外露）→
    // 与事件流归约快照一致
    const { v: _v, ...aggregate } = json
    const row = { content: snap.content, ...aggregate }
    expect(row).toEqual({ content: '答案', thinking: '思路', tools: snap.tools })
  })
})

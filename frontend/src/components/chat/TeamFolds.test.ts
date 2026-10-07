// seam: TeamFolds 哑组件（#796 / #730 §4.3 具名折叠区渲染面）——折叠条具名 + 状态徽标 +
// 审批局部冻结/注销归档终态 + 展开区轨迹同形状行 + 信箱往来（story 23/24/26）。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ApprovalItem } from '@/stores/chat'
import type { TeamFold } from '@/chat/projection'
import TeamFolds from '@/components/chat/TeamFolds.vue'

const fold = (over: Partial<TeamFold> = {}): TeamFold => ({
  id: 'tm1', name: '文献员', task: '整理文献', status: 'running',
  msgs: [{
    role: 'assistant', raw: '查到 3 篇', text: '查到 3 篇', thinking: '先检索', thinkingOpen: false,
    streaming: false,
    tools: [{ id: 't1', name: 'read', state: 'done', title: null, input: { file_path: 'a.md' }, result: 'ok' }],
    media: [],
  }],
  mailbox: [{ id: 'mail1', senderTeammateId: 'tm1', recipientTeammateId: null, kind: 'message', content: '已完成整理', createdAt: '2026-10-06T01:00:00Z' }],
  ...over,
})

const approval = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'e1', source: 'cautious-mode', toolName: 'bash', toolCallSummary: 'x', teammateId: 'tm1',
  status: 'pending', decision: '', detailOpen: false, seq: 1, ...over,
})

const mountFolds = (over: { teams?: TeamFold[]; approvals?: ApprovalItem[]; expanded?: Record<string, boolean> } = {}) =>
  mount(TeamFolds, {
    props: {
      teams: over.teams ?? [fold()],
      approvals: over.approvals ?? [],
      expanded: over.expanded ?? {},
    },
  })

describe('折叠条（具名 + 状态徽标）', () => {
  it('空 teams 不渲染区', () => {
    const w = mountFolds({ teams: [] })
    expect(w.find('[data-test="team-folds"]').exists()).toBe(false)
  })

  it('具名 + 状态徽标；点击 emit toggle(teammateId)；aria-expanded 随 expanded prop', async () => {
    const w = mountFolds()
    expect(w.get('[data-test="teammate-name"]').text()).toBe('文献员')
    expect(w.get('[data-test="teammate-status"]').text()).toBe('运行中')
    expect(w.find('[data-test="teammate-toggle"]').attributes('aria-expanded')).toBe('false')
    await w.find('[data-test="teammate-toggle"]').trigger('click')
    expect(w.emitted('toggle')?.[0]).toEqual(['tm1'])
    await w.setProps({ expanded: { tm1: true } })
    expect(w.find('[data-test="teammate-toggle"]').attributes('aria-expanded')).toBe('true')
  })

  it('未展开不渲染轨迹体；展开后 task + 轨迹行同形状（thinking/tool/正文可见）', () => {
    const w = mountFolds()
    expect(w.find('[data-test="teammate-body-tm1"]').exists()).toBe(false)
    const open = mountFolds({ expanded: { tm1: true } })
    expect(open.get('[data-test="teammate-task"]').text()).toBe('整理文献')
    const trace = open.get('[data-test="teammate-trace"]')
    expect(trace.text()).toContain('先检索') // ThinkingCard
    expect(trace.text()).toContain('查到 3 篇') // MarkdownRenderer
    expect(trace.text()).toContain('a.md') // ToolLine（剥壳目标名）
  })

  it('未知状态徽标回退原文；无名占位「队友」', () => {
    const w = mountFolds({ teams: [fold({ status: 'mystery', name: '' })] })
    expect(w.get('[data-test="teammate-status"]').text()).toBe('mystery')
    expect(w.get('[data-test="teammate-name"]').text()).toBe('队友')
  })
})

describe('局部冻结与注销终态（story 23/26）', () => {
  it('status=suspended → 「等待审批」徽标 + 冻结强调（freeze-dot）', () => {
    const w = mountFolds({ teams: [fold({ status: 'suspended' })] })
    expect(w.get('[data-test="teammate-status"]').text()).toBe('等待审批')
    expect(w.find('.freeze-dot').exists()).toBe(true)
    expect(w.find('.team-fold.frozen').exists()).toBe(true)
  })

  it('status 未及（竞态窗口）但存在当事 pending 审批 → 同样呈冻结态', () => {
    const w = mountFolds({ teams: [fold({ status: 'running' })], approvals: [approval()] })
    expect(w.find('.team-fold.frozen').exists()).toBe(true)
  })

  it('leader 审批（teammateId null）不冻结 teammate 折叠条（局部冻结不外溢）', () => {
    const w = mountFolds({ teams: [fold({ status: 'running' })], approvals: [approval({ teammateId: null })] })
    expect(w.find('.team-fold.frozen').exists()).toBe(false)
  })

  it('archived 终态：「已归档」徽标；轨迹保留可展开（归档不删）', () => {
    const w = mountFolds({ teams: [fold({ status: 'archived' })], expanded: { tm1: true } })
    expect(w.get('[data-test="teammate-status"]').text()).toBe('已归档')
    expect(w.get('[data-test="teammate-trace"]').text()).toContain('查到 3 篇')
  })
})

describe('信箱往来（story 23 追问/广播）', () => {
  it('展开区渲染 mailbox：方向 + kind 标签（request 内容解析自 server JSON 载荷）', () => {
    const w = mountFolds({
      expanded: { tm1: true },
      teams: [fold({
        mailbox: [
          // server requestSpawn 落库 content = JSON.stringify({name, task})——真实载荷呈现
          { id: 'm1', senderTeammateId: 'tm1', recipientTeammateId: null, kind: 'request', content: JSON.stringify({ name: '写作员', task: '起草第二章' }), createdAt: '2026-10-06T01:00:00Z' },
          { id: 'm2', senderTeammateId: 'tmB', recipientTeammateId: 'tm1', kind: 'broadcast', content: '各队友注意进度', createdAt: '2026-10-06T01:01:00Z' },
          { id: 'm3', senderTeammateId: null, recipientTeammateId: 'tm1', kind: 'message', content: '继续补充第二节', createdAt: '2026-10-06T01:02:00Z' },
          { id: 'm4', senderTeammateId: 'tm1', recipientTeammateId: 'tmB', kind: 'message', content: '收到', createdAt: '2026-10-06T01:03:00Z' },
          // server 信箱超时唤醒（runService）：等待者自收提醒 + 广播升级追问本体
          { id: 'm5', senderTeammateId: null, recipientTeammateId: 'tm1', kind: 'timeout', content: '等待超时', createdAt: '2026-10-06T01:04:00Z' },
          { id: 'm6', senderTeammateId: 'tmB', recipientTeammateId: 'tm1', kind: 'timeout-follow-up', content: '请汇报进展', createdAt: '2026-10-06T01:05:00Z' },
        ],
      })],
    })
    const box = w.get('[data-test="teammate-mailbox"]')
    expect(box.text()).toContain('通信记录 · 6')
    expect(w.get('[data-test="mail-m1"]').text()).toContain('发给主助手')
    expect(w.get('[data-test="mail-m1"]').text()).toContain('协助申请')
    expect(w.get('[data-test="mail-m1"]').text()).toContain('申请派生 写作员 · 起草第二章')
    expect(w.get('[data-test="mail-m2"]').text()).toContain('来自队友')
    expect(w.get('[data-test="mail-m2"]').text()).toContain('广播')
    expect(w.get('[data-test="mail-m3"]').text()).toContain('来自主助手')
    expect(w.get('[data-test="mail-m4"]').text()).toContain('发给队友')
    expect(w.get('[data-test="mail-m5"]').text()).toContain('超时提醒')
    expect(w.get('[data-test="mail-m6"]').text()).toContain('超时追问')
  })

  it('request 载荷解析失败兜底原文（0 信任宽容度）', () => {
    const w = mountFolds({
      expanded: { tm1: true },
      teams: [fold({ mailbox: [{ id: 'm9', senderTeammateId: 'tm1', recipientTeammateId: null, kind: 'request', content: '不是 JSON', createdAt: '2026-10-06T01:00:00Z' }] })],
    })
    expect(w.get('[data-test="mail-m9"]').text()).toContain('不是 JSON')
  })

  it('空 mailbox 不渲染通信记录节', () => {
    const w = mountFolds({ teams: [fold({ mailbox: [] })], expanded: { tm1: true } })
    expect(w.find('[data-test="teammate-mailbox"]').exists()).toBe(false)
  })
})

describe('并发多 teammate 不串区（#796 验收）', () => {
  it('两折叠区各自 data-teammate-id 隔离；开合互不影响；内容不混', async () => {
    const w = mountFolds({
      teams: [
        fold({ id: 'tmA', name: '文献员', msgs: [{ role: 'assistant', raw: '甲线产出', text: '甲线产出', thinking: '', thinkingOpen: false, streaming: false, tools: [], media: [] }] }),
        fold({ id: 'tmB', name: '写作员', msgs: [{ role: 'assistant', raw: '乙线产出', text: '乙线产出', thinking: '', thinkingOpen: false, streaming: false, tools: [], media: [] }] }),
      ],
      expanded: { tmA: true },
    })
    const a = w.find('[data-teammate-id="tmA"]')
    const b = w.find('[data-teammate-id="tmB"]')
    expect(a.find('[data-test="teammate-body-tmA"]').exists()).toBe(true)
    expect(b.find('[data-test="teammate-body-tmB"]').exists()).toBe(false) // B 未展开
    expect(a.text()).toContain('甲线产出')
    expect(a.text()).not.toContain('乙线产出')
    await b.find('[data-test="teammate-toggle"]').trigger('click')
    expect(w.emitted('toggle')?.[0]).toEqual(['tmB'])
  })
})

// #910 S2：W2 discover 九节点图 invoke 返回值面（Agreements「零新缝」——图 invoke + fake
// ports）。覆盖（853 §4.2 / issue AC）：happy path / resolveInputs 检索定位（papers/ 过滤 +
// 读面路径域换算）与缺失 clarify（产物串联出口）/ 输入形态白名单与单篇约束 / load 论文页
// 缺失 clarify / validate¹ 禁语拒 → 重试附诊断 / validate² 候选数拒 → 重试 → 再拒明确失败 /
// evidenceGate 引用回查（三类钉面：本页节锚 / 他页 readPage 存在性 / 上传件形态；剔除清单
// 进 summary 不静默）/ stage 序列。
import { describe, expect, it } from 'vitest'
import { createDiscoverGraph } from '../../plugins/research/discover'
import { CRITIC_DOC_SCHEMA, EXTRACT_DOC_SCHEMA } from '../../plugins/research/pageValidate'
import { createSlotLlm, createWikiFake, paperPageBody, PAPER_PATH, validCriticDoc, validExtractDoc } from './researchFixtures'

const otherPaperBody = (): string =>
  ['# 其他论文分析页', '', '## 1 背景与动机', '', '背景内容。', '', '## 2 方法概述', '', '方法内容。'].join('\n')

const makePorts = (
  overrides: {
    extract?: () => unknown
    critic?: () => unknown
    pages?: Record<string, string>
  } = {},
) => {
  const llm = createSlotLlm({ extract: overrides.extract, critic: overrides.critic })
  const fake = createWikiFake(overrides.pages ?? { [PAPER_PATH]: paperPageBody() })
  return { llm, wiki: fake.wiki, calls: llm.calls, fake }
}

const invoke = (ports: ReturnType<typeof makePorts>, request: Record<string, unknown>) =>
  createDiscoverGraph({ llm: ports.llm, wiki: ports.wiki }).invoke({ request: request as never })

describe('W2 discover 图 invoke（S2 端口注入 fake）', () => {
  it('happy path（source_paths 钉定论文页）→ completed + critic 页 artifactPages + claims/provenance 组装', async () => {
    const ports = makePorts()
    const result = await invoke(ports, { workflow: 'discover', question: '这篇论文有哪些问题', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.artifactPages).toEqual([{ path: 'critics/robust-out-of-distribution-detection.md', title: '某论文审稿式问题分析' }])
    expect(result.summary).toContain('critics/robust-out-of-distribution-detection.md')

    const [draft, provenance] = ports.fake.createPage.mock.calls[0] as unknown as [
      { path: string; title: string; type: string; content: string; claims: { statement: string; evidence: string[] }[] },
      Record<string, unknown>,
    ]
    expect(draft.path).toBe('critics/robust-out-of-distribution-detection.md')
    expect(draft.type).toBe('critic')
    expect(draft.claims).toHaveLength(2)
    expect(draft.claims[0]!.evidence).toEqual([`${PAPER_PATH}#6 Results`])
    // related_pages 钉给 W4（853 §3.3）——W2 provenance 仅 workflow（Spec#20）。
    expect(provenance).toEqual({ workflow: 'discover' })
  })

  it('resolveInputs：无 source_paths → search 定位论文页（papers/ 过滤 + openwiki/ 前缀 ref 归一）', async () => {
    const ports = makePorts()
    const result = await invoke(ports, { workflow: 'discover', question: '找 robust detection 的问题' })

    expect(ports.fake.search).toHaveBeenCalled()
    expect(result.status).toBe('completed')
    // load 读面路径域换算锁定（P0#1/#2）：readPage 收 openwiki/ 前缀形态。
    expect(ports.fake.readPage).toHaveBeenCalledWith(`openwiki/${PAPER_PATH}`, expect.anything())
  })

  it('resolveInputs：search 命中非 papers 页（critic 页混入）→ papers/ 过滤后 clarify（不跑错论文）', async () => {
    const ports = makePorts({ pages: { 'critics/some-critic.md': '# 某分析\n\n## 1 概述\n\n内容' } })
    const result = await invoke(ports, { workflow: 'discover', question: 'q' })

    expect(ports.fake.search).toHaveBeenCalled()
    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('ingest')
  })

  it('resolveInputs：search 无命中 → clarify 出口（提示先 ingest，产物串联）', async () => {
    const ports = makePorts()
    ports.fake.search.mockResolvedValue({ ok: true, data: { results: [] } })
    const result = await invoke(ports, { workflow: 'discover', question: '找不到的论文' })

    expect(result.status).toBe('clarify')
    expect(result.summary).toBe('')
    expect(result.artifactPages).toEqual([])
    expect(result.clarify?.candidates).toEqual([])
    expect(result.clarify?.question).toContain('ingest')
  })

  it('load：论文页不存在（readPage not_found）→ clarify 出口（提示先 ingest）', async () => {
    const ports = makePorts({ pages: {} })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('ingest')
  })

  it('resolveInputs：source_paths 非 papers/*.md 论文页形态 → clarify（路径前缀白名单，853 §4 横切）', async () => {
    const ports = makePorts()
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: ['/lab/uploads/a.pdf'] })
    expect(result.status).toBe('clarify')
    expect(result.clarify?.question).toContain('papers/')
    expect(result.clarify?.question).toContain('.md')
  })

  it('resolveInputs：多篇 source_paths → 单论文链明确失败（与 W1 单篇同口径）', async () => {
    const ports = makePorts()
    await expect(
      invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH, 'papers/other.md'] }),
    ).rejects.toThrow(/单篇/)
  })

  it('validate¹ 拒（三态禁语）→ 回 extract 重试附诊断；重试过 → completed', async () => {
    let n = 0
    const ports = makePorts({
      extract: () => {
        n += 1
        return n === 1 ? { content: `${validExtractDoc().content}\n\n这一现象可能是过拟合。` } : validExtractDoc()
      },
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    const extractCalls = ports.calls.filter((c) => c.slot === 'extract')
    expect(extractCalls).toHaveLength(2)
    expect(extractCalls[1]!.prompt).toContain('上一轮产出未通过校验')
    // 断言诊断特有子串——「可能是」在模板禁语清单恒在，不作判据（PR #917 review S3）。
    expect(extractCalls[1]!.prompt).toContain('出现禁语「可能是」')
  })

  it('validate² 拒（候选 1 个 < 2）→ 回 critic 重试附诊断；重试过 → completed', async () => {
    let n = 0
    const ports = makePorts({
      critic: () => {
        n += 1
        return n === 1 ? validCriticDoc([{ question: '仅一个', priority: 'high' }]) : validCriticDoc()
      },
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    const criticCalls = ports.calls.filter((c) => c.slot === 'critic')
    expect(criticCalls).toHaveLength(2)
    expect(criticCalls[1]!.prompt).toContain('上一轮产出未通过校验')
    // 断言诊断特有子串——「2–4」在模板恒在，「（当前 1 个）」是校验 issue 特有（S3）。
    expect(criticCalls[1]!.prompt).toContain('须为 2–4 个（当前 1 个）')
  })

  it('validate² 再拒 → 明确失败（critic 恰 2 次，K≤2 有界）', async () => {
    const ports = makePorts({ critic: () => validCriticDoc([]) })
    await expect(invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })).rejects.toThrow(/重试耗尽/)
    expect(ports.calls.filter((c) => c.slot === 'critic')).toHaveLength(2)
  })

  it('critic prompt 注入真实论文页路径（evidence 引用指引锚，Spec#4）', async () => {
    const ports = makePorts()
    await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })
    expect(ports.calls[0]!.slot).toBe('extract')
    const criticPrompt = ports.calls.find((c) => c.slot === 'critic')!.prompt
    expect(criticPrompt).toContain(`${PAPER_PATH}#<节标题>`)
  })

  it('evidenceGate：本页节锚存在性回查——坏节锚剔除、清单进 summary 不静默', async () => {
    const ports = makePorts({
      critic: () =>
        validCriticDoc([
          { question: '消融是否充分？', priority: 'high', evidence: [`${PAPER_PATH}#6 Results`, `${PAPER_PATH}#99 无此节`] },
          { question: '泛化证据？', priority: 'medium', evidence: [PAPER_PATH] },
        ]),
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('剔除')
    expect(result.summary).toContain('#99 无此节')
    const [draft] = ports.fake.createPage.mock.calls[0] as unknown as [{ claims: { statement: string; evidence: string[] }[] }]
    expect(draft.claims[0]!.evidence).toEqual([`${PAPER_PATH}#6 Results`])
  })

  it('evidenceGate：evidence 全部剔除 → 整条 claim 不进 persist（claims 提交面）', async () => {
    const ports = makePorts({
      critic: () =>
        validCriticDoc([
          { question: '证据全缺的候选', priority: 'high', evidence: [`${PAPER_PATH}#99 无此节`] },
          { question: '正常候选', priority: 'medium', evidence: [`${PAPER_PATH}#4 Method`] },
        ]),
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('整条剔除')
    const [draft] = ports.fake.createPage.mock.calls[0] as unknown as [{ claims: { statement: string; evidence: string[] }[] }]
    expect(draft.claims.map((c) => c.statement)).toEqual(['正常候选'])
  })

  it('evidenceGate：他页引用 readPage 存在性回查（Spec#8）——页缺失/节缺失剔、裸页哨兵探锚放行', async () => {
    const ports = makePorts({
      pages: { [PAPER_PATH]: paperPageBody(), 'papers/other-paper.md': otherPaperBody() },
      critic: () =>
        validCriticDoc([
          { question: '他页节锚存在', priority: 'high', evidence: ['papers/other-paper.md#2 方法概述'] },
          { question: '他页整页不存在', priority: 'high', evidence: ['papers/missing-page.md#1 Citation'] },
          { question: '他页裸页引用', priority: 'medium', evidence: ['papers/other-paper.md'] },
          { question: '他页节锚缺失', priority: 'low', evidence: ['papers/other-paper.md#99 无此节'] },
        ]),
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('papers/missing-page.md#1 Citation')
    expect(result.summary).toContain('引用的 wiki 页不存在')
    expect(result.summary).toContain('#99 无此节')
    const [draft] = ports.fake.createPage.mock.calls[0] as unknown as [{ claims: { statement: string; evidence: string[] }[] }]
    const survived = draft.claims.map((c) => c.statement)
    expect(survived).toContain('他页节锚存在')
    expect(survived).toContain('他页裸页引用')
    expect(survived).not.toContain('他页整页不存在')
    expect(survived).not.toContain('他页节锚缺失')
  })

  it('evidenceGate：上传件非 .pdf 形态剔除；extract 文档引用归描述性放行（Spec#14 收敛三类钉面）', async () => {
    const ports = makePorts({
      critic: () =>
        validCriticDoc([
          { question: 'txt 上传件', priority: 'high', evidence: ['/lab/uploads/notes.txt'] },
          { question: '描述性引用', priority: 'medium', evidence: ['extract 文档 §4 消融现象'] },
        ]),
    })
    const result = await invoke(ports, { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] })

    expect(result.status).toBe('completed')
    expect(result.summary).toContain('/lab/uploads/notes.txt')
    const [draft] = ports.fake.createPage.mock.calls[0] as unknown as [{ claims: { statement: string; evidence: string[] }[] }]
    expect(draft.claims.map((c) => c.statement)).toEqual(['描述性引用'])
  })

  it('stage 序列：resolveInputs → load → extract → validate → critic → validate → evidenceGate → persist → summary', async () => {
    const ports = makePorts()
    const stages: string[] = []
    await createDiscoverGraph({ llm: ports.llm, wiki: ports.wiki }).invoke(
      { request: { workflow: 'discover', question: 'q', source_paths: [PAPER_PATH] } as never },
      { onStage: (s) => stages.push(s) },
    )
    expect(stages).toEqual(['resolveInputs', 'load', 'extract', 'validate', 'critic', 'validate', 'evidenceGate', 'persist', 'summary'])
  })

  it('schema 面：EXTRACT_DOC_SCHEMA 单 content；CRITIC_DOC_SCHEMA candidates 可省略（宽容缺省，消费侧 ?? []）', () => {
    expect(EXTRACT_DOC_SCHEMA.parse({ content: 'x' })).toEqual({ content: 'x' })
    const parsed = CRITIC_DOC_SCHEMA.parse({ content: 'x' })
    expect(parsed.candidates).toBeUndefined()
  })
})

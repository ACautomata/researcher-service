// #912 S2：W4 调用①（方案设计图）invoke 返回值面（Agreements 零新缝——图 invoke +
// fake ports）。覆盖（853 §4.4–§5.1 / issue #912 AC）：happy path（resolveInputs→preflight
// 映射池→design→validate¹→spec→validate²→audit→persist 三件落盘→summary + plan 面）/
// 输入页形态白名单与缺失 clarify / 幂等短路点（spec 已落盘 → design/spec/audit LLM 零调用
// 直达 summary）/ 修订模式（带上轮 spec + 用户理由回 design，覆盖落盘）/ validate¹ 拒回边
// 重试（K≤2）/ validate² 可推断占位符拒 / audit blocking 非空 → throw（不进人审）。
import { describe, expect, it } from 'vitest'
import { createExperimentPlanGraph } from '../../plugins/research/experiment'
import { specPathOf } from '../../plugins/research/experimentPlan'
import {
  createLabFake,
  createSlotLlm,
  createWikiFake,
  validAuditVerdict,
  validCriticPage,
  validDesignDoc,
  validIdeaCardPage,
  validSpecDoc,
  CRITIC_PATH,
  IDEA_CARD_PATH,
} from './researchFixtures'

const REQUEST = { workflow: 'experiment', question: '验证能量分数判据', source_paths: [CRITIC_PATH] } as const

const makePorts = (handlers: Parameters<typeof createSlotLlm>[0] = {}, labInitial: Record<string, string> = {}) => {
  const llm = createSlotLlm(handlers)
  const fake = createWikiFake({ [CRITIC_PATH]: validCriticPage(), [IDEA_CARD_PATH]: validIdeaCardPage() })
  const lab = createLabFake(labInitial)
  return { llm, wiki: fake.wiki, lab: lab.lab, calls: llm.calls, labFake: lab }
}

const invoke = (
  ports: ReturnType<typeof makePorts>,
  request: Record<string, unknown>,
  revisionReason?: string,
  round?: number,
) =>
  createExperimentPlanGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab }).invoke(
    { request: request as never, ...(revisionReason !== undefined ? { revisionReason } : {}), ...(round !== undefined ? { round } : {}) },
  )

describe('W4 调用① 方案设计图（S2 fake ports）', () => {
  it('happy path：critic 页输入 → 映射池提取 → design → validate¹ → spec → validate² → audit → 三件落盘 → plan 面', async () => {
    const ports = makePorts()
    const result = await invoke(ports, REQUEST)

    expect(result.status).toBe('completed')
    expect(result.clarify).toBeUndefined()
    expect(result.experiment).toBeDefined()
    expect(result.experiment!.specRef).toBe(specPathOf(REQUEST))
    expect(result.experiment!.deliverables.length).toBeGreaterThan(0)
    expect(result.summary).toContain('等待人工审批')

    // 落盘三件（design/spec/audit 同目录）——spec.md 是短路哨兵。
    const specRef = specPathOf(REQUEST)
    const dir = specRef.slice(0, specRef.lastIndexOf('/'))
    expect(ports.labFake.files.has(`${dir}/design.md`)).toBe(true)
    expect(ports.labFake.files.get(specRef)).toContain('## 1 任务背景')
    expect(ports.labFake.files.get(`${dir}/audit.md`)).toContain('## 0 评估元信息')

    // LLM 调用面：design 1 + spec 1 + audit 1（≤35 口径内）。
    expect(ports.calls.filter((c) => c.slot === 'design')).toHaveLength(1)
    expect(ports.calls.filter((c) => c.slot === 'spec')).toHaveLength(1)
    expect(ports.calls.filter((c) => c.slot === 'audit')).toHaveLength(1)

    // design prompt 注入映射池（critic §4 候选问题在池内）。
    const designPrompt = ports.calls.find((c) => c.slot === 'design')!.prompt
    expect(designPrompt).toContain('<mapping-targets>')
    expect(designPrompt).toContain('消融是否覆盖核心组件？')
  })

  it('idea card 页输入：minimum_experiment 精确值入映射池（双向子串匹配的精确面）', async () => {
    const minExp = '在 CIFAR-100 上复现 baseline 并替换打分函数，对比 AUROC/FPR95。'
    const ports = makePorts({
      design: () => ({
        ...validDesignDoc(),
        experiments: [{ name: '打分函数替换', validation_target: minExp, expected_outcome: 'AUROC 提升' }],
      }),
    })
    const result = await invoke(ports, { ...REQUEST, source_paths: [IDEA_CARD_PATH] })
    expect(result.status).toBe('completed')
    const designPrompt = ports.calls.find((c) => c.slot === 'design')!.prompt
    expect(designPrompt).toContain(minExp)
  })

  it('双输入：critic §4 节与 idea minimum_experiment 并集池（双映射允许面）', async () => {
    const minExp = '在 CIFAR-100 上复现 baseline 并替换打分函数，对比 AUROC/FPR95。'
    const ports = makePorts({
      design: () => ({
        ...validDesignDoc(),
        experiments: [
          { name: '消融覆盖审计', validation_target: '消融是否覆盖核心组件？', expected_outcome: 'x' },
          { name: '打分函数替换', validation_target: minExp, expected_outcome: 'AUROC 提升' },
        ],
      }),
    })
    const result = await invoke(ports, { ...REQUEST, source_paths: [CRITIC_PATH, IDEA_CARD_PATH] })
    expect(result.status).toBe('completed')
    const designPrompt = ports.calls.find((c) => c.slot === 'design')!.prompt
    expect(designPrompt).toContain('消融是否覆盖核心组件？')
    expect(designPrompt).toContain(minExp)
  })

  it('resolveInputs：形态白名单（非 critics/idea-cards 路径 / 穿越）→ clarify', async () => {
    const ports = makePorts()
    const bad = await invoke(ports, { ...REQUEST, source_paths: ['papers/x.md'] })
    expect(bad.status).toBe('clarify')
    expect(bad.clarify?.question).toContain('critics/')
    expect(ports.calls.filter((c) => c.slot === 'design')).toHaveLength(0)

    const traversal = await invoke(ports, { ...REQUEST, source_paths: ['critics/../../etc.md'] })
    expect(traversal.status).toBe('clarify')
  })

  it('resolveInputs：页缺失（哨兵探 not_found）→ clarify 列缺失清单；无输入页 → clarify', async () => {
    const ports = makePorts()
    const missing = await invoke(ports, { ...REQUEST, source_paths: ['critics/gone.md'] })
    expect(missing.status).toBe('clarify')
    expect(missing.clarify?.question).toContain('critics/gone.md')
    expect(missing.clarify?.question).toContain('缺失')

    const none = await invoke(ports, { workflow: 'experiment', question: 'q' })
    expect(none.status).toBe('clarify')
  })

  it('resolveInputs：实验意图缺失 → clarify（question/topic 至少其一）', async () => {
    const ports = makePorts()
    const r = await invoke(ports, { workflow: 'experiment', source_paths: [CRITIC_PATH] })
    expect(r.status).toBe('clarify')
    expect(r.clarify?.question).toContain('实验意图')
  })

  it('幂等短路点：spec 已落盘（非修订轮）→ design/spec/audit LLM 零调用直达 summary', async () => {
    const ports = makePorts()
    const first = await invoke(ports, REQUEST)
    expect(first.status).toBe('completed')
    const llmCallsBefore = ports.calls.length

    const replay = await invoke(ports, REQUEST)
    expect(replay.status).toBe('completed')
    expect(ports.calls.length).toBe(llmCallsBefore) // 零新增 LLM 调用
    expect(replay.experiment!.specContent).toContain('## 1 任务背景')
    expect(replay.experiment!.auditReport).toContain('## 0 评估元信息')
    expect(replay.summary).toContain('待审批')
  })

  it('修订模式：带上轮 spec + 用户理由回 design（零新图节点），覆盖落盘', async () => {
    const ports = makePorts()
    await invoke(ports, REQUEST)
    const before = ports.labFake.files.get(specPathOf(REQUEST))!

    const revisionPrompts: string[] = []
    const llm2 = createSlotLlm({
      design: (prompt) => {
        revisionPrompts.push(prompt)
        return validDesignDoc()
      },
    })
    const graph = createExperimentPlanGraph({ llm: llm2, wiki: ports.wiki, lab: ports.lab })
    const revised = await graph.invoke({ request: REQUEST as never, revisionReason: '样本量不足，补大样本对照', round: 2 })

    expect(revised.status).toBe('completed')
    expect(revised.experiment!.specRef).toContain('/r2/spec.md') // round 键控：修订落 r2
    expect(revisionPrompts).toHaveLength(1)
    expect(revisionPrompts[0]).toContain('修订模式')
    expect(revisionPrompts[0]).toContain('样本量不足，补大样本对照')
    expect(revisionPrompts[0]).toContain(before.slice(0, 40)) // 上轮（r1）spec 注入
  })

  it('修订轮重放短路：本 round spec 已落盘（重放历史修订轮）→ design/spec/audit LLM 零调用', async () => {
    const ports = makePorts()
    // 首轮生成 r1。
    await invoke(ports, REQUEST)
    // 模拟「重放 A 的修订轮」：r2 产物已落盘（上轮重放生成）→ 再调 round=2 → 全短路。
    const r2Dir = specPathOf(REQUEST, 2).slice(0, specPathOf(REQUEST, 2).lastIndexOf('/'))
    ports.labFake.files.set(`${r2Dir}/spec.md`, validSpecDoc().content)
    ports.labFake.files.set(`${r2Dir}/design.md`, validDesignDoc().content)
    ports.labFake.files.set(`${r2Dir}/audit.md`, '# audit')
    const callsBefore = ports.calls.length
    const replay = await invoke(ports, REQUEST, 'r1 理由', 2)
    expect(replay.status).toBe('completed')
    expect(ports.calls.length).toBe(callsBefore) // 零新增 LLM 调用
    expect(replay.experiment!.specContent).toContain('## 1 任务背景')
    expect(replay.experiment!.specRef).toContain('/r2/spec.md')
  })

  it('validate¹ 拒（实验映射偏离候选池）→ 回 design 重试 1 次附诊断，K≤2 过', async () => {
    let designCalls = 0
    const ports = makePorts({
      design: () => {
        designCalls++
        if (designCalls === 1) {
          return {
            ...validDesignDoc(),
            experiments: [{ name: '跑偏实验', validation_target: '验证宇宙射线对损失曲线的影响', expected_outcome: 'x' }],
          }
        }
        return validDesignDoc() // 修复轮：合法实验面
      },
    })
    const r = await invoke(ports, REQUEST)
    expect(r.status).toBe('completed')
    expect(ports.calls.filter((c) => c.slot === 'design')).toHaveLength(2) // 初次 + 修复
    const retryPrompt = ports.calls.filter((c) => c.slot === 'design')[1]!.prompt
    expect(retryPrompt).toContain('上一轮产出未通过校验')
    expect(retryPrompt).toContain('跑偏实验')
  })

  it('validate² 拒（可推断占位符「论文基础 Wiki 标识」）→ 回 spec 重试', async () => {
    let specCalls = 0
    const badSpec = {
      content:
        '# 沙箱执行规格\n\n## 1 任务背景\n\n此处应填写论文基础 Wiki 标识\n\n' +
        '## 2 可用输入材料\n\n材料\n## 3 当前论文方法与验证目标\n\n目标\n## 4 优先实现的验证实验\n\n实验\n## 5 总体实现要求\n\n要求\n## 6 建议优先查看的代码位置\n\n位置\n## 7 交付内容\n\n交付\n## 8 完成标准\n\n标准\n## 9 汇报格式\n\n汇报',
      deliverables: [{ path: '/lab/results/r.json', success_criterion: 'c' }],
    }
    const ports = makePorts({
      spec: () => {
        specCalls++
        return specCalls === 1 ? badSpec : { ...badSpec, content: badSpec.content.replace('此处应填写论文基础 Wiki 标识', 'critics/robust-out-of-distribution-detection.md') }
      },
    })
    const r = await invoke(ports, REQUEST)
    expect(r.status).toBe('completed')
    expect(ports.calls.filter((c) => c.slot === 'spec')).toHaveLength(2)
    const retryPrompt = ports.calls.filter((c) => c.slot === 'spec')[1]!.prompt
    expect(retryPrompt).toContain('上一轮产出未通过校验')
    expect(retryPrompt).toContain('此处应填写论文基础 Wiki 标识')
  })

  it('audit blocking 非空（LLM 维度）→ throw：该调用 fail 不进人审', async () => {
    const ports = makePorts({ audit: () => validAuditVerdict({ blocking: ['spec ##4 缺第 3 个优先实验（design ##6 top-3 传递断裂）'] }) })
    await expect(invoke(ports, REQUEST)).rejects.toThrow('方案审计未通过')
    // 落盘不发生（fail 在 persist 前）。
    expect(ports.labFake.files.size).toBe(0)
  })

  it('audit 确定性 blocking（design 缺节）→ throw 不进人审', async () => {
    const ports = makePorts({
      design: () => ({
        ...validDesignDoc(),
        content: validDesignDoc().content.replace('## 6 最值得优先执行的 3 个实验', '## 6 改名'),
      }),
    })
    await expect(invoke(ports, REQUEST)).rejects.toThrow('方案审计未通过')
    await expect(invoke(ports, REQUEST)).rejects.toThrow('## 6 最值得优先执行的 3 个实验')
  })

  it('stage 序列：resolveInputs/preflight/design/validate/spec/audit/persist/summary 冒泡', async () => {
    const ports = makePorts()
    const stages: string[] = []
    await createExperimentPlanGraph({ llm: ports.llm, wiki: ports.wiki, lab: ports.lab }).invoke(
      { request: REQUEST as never },
      { onStage: (s) => stages.push(s) },
    )
    expect(stages).toEqual(['resolveInputs', 'preflight', 'design', 'validate', 'spec', 'validate', 'audit', 'persist', 'summary'])
  })
})

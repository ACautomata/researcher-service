// #909 路由图测试：S3 routeByIntent 纯状态派生 + S2 图 invoke 返回值面（端口注入 fake，
// 约定 seam——不测内部节点接线）。
// 覆盖（853 §2.2 / issue AC）：NL 高置信恰一分支 / seed 透传不调分类器 / 阈值判定
//（conf<0.60 或 none → clarify 两形态）/ 条件边互斥 / 多意图高置信选首 + 尾注 / stage 上报。
import { describe, expect, it } from 'vitest'
import {
  createResearchRoutingGraph,
  routeByIntent,
  RESEARCH_WORKFLOW_NAMES,
  RESEARCH_ENTRY_STAGES,
} from '../../plugins/research/graph'
import type { ResearchRoutingPorts } from '../../plugins/research/graph'
import { WORKFLOW_CATALOG } from '../../plugins/research/clarify'
import type { IntentClassifier } from '../../plugins/research/classifier'
import { MIN_CONFIDENCE } from '../../plugins/research/values'

const makePorts = (classifier: IntentClassifier = async () => ({ label: 'discover', confidence: 0.9 })) => {
  const calls = { classifierCalls: [] as string[], branchCalls: [] as string[] }
  const ports: ResearchRoutingPorts & { classifierCalls: string[]; branchCalls: string[] } = {
    ...calls,
    classifier: async (text) => {
      ports.classifierCalls.push(text)
      return classifier(text)
    },
    runWorkflow: async (workflow) => {
      ports.branchCalls.push(workflow)
      return `${workflow} 占位产出`
    },
  }
  return ports
}

describe('routeByIntent 纯状态派生（S3）', () => {
  it('seed / 分类结果 workflow → 同名分支', () => {
    expect(routeByIntent({ workflow: 'ingest' })).toBe('ingest')
    expect(routeByIntent({ workflow: 'experiment' })).toBe('experiment')
  })

  it('clarify 已落 → end（低置信/none 兜底路径）', () => {
    expect(routeByIntent({ clarify: { status: 'clarify', candidates: [], question: 'q' } })).toBe('end')
  })

  it('空状态防御兜底 → end（分类器枚举锁定下理论不可达）', () => {
    expect(routeByIntent({})).toBe('end')
  })
})

describe('入口图 invoke（S2 端口注入 fake）', () => {
  it('NL 高置信：调分类器 → 互斥分发恰一分支 → branch 结果', async () => {
    const ports = makePorts()
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { topic: '一篇 CVPR 论文的问题' } })

    expect(ports.classifierCalls).toHaveLength(1)
    expect(ports.branchCalls).toEqual(['discover']) // 恰一分支在跑（互斥）
    expect(result.status).toBe('branch')
    expect(result.workflow).toBe('discover')
    expect(result.summary).toContain('discover 占位产出')
    expect(result.clarify).toBeUndefined()
  })

  it('seed 透传：workflow 已带 → 分类器零调用，直通同名分支', async () => {
    const ports = makePorts()
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { workflow: 'ingest', source_paths: ['/lab/uploads/a.pdf'] } })

    expect(ports.classifierCalls).toHaveLength(0)
    expect(ports.branchCalls).toEqual(['ingest'])
    expect(result.status).toBe('branch')
    expect(result.workflow).toBe('ingest')
    expect(result.intent).toBeUndefined()
  })

  it('低置信 < MIN_CONFIDENCE → clarify 两形态（Top-2 候选），分支零执行', async () => {
    const ports = makePorts(async () => ({ label: 'hypothesize', confidence: MIN_CONFIDENCE - 0.01, secondaryIntent: 'experiment' }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { question: '帮我想个方向' } })

    expect(ports.branchCalls).toEqual([])
    expect(result.status).toBe('clarify')
    expect(result.workflow).toBeUndefined()
    expect(result.clarify?.candidates.map((c) => c.label)).toEqual(['hypothesize', 'experiment'])
    expect(result.clarify?.question.length).toBeGreaterThan(0)
  })

  it('none → clarify 空候选拒识形态，分支零执行', async () => {
    const ports = makePorts(async () => ({ label: 'none', confidence: 0.95 }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { question: '今天天气如何' } })

    expect(ports.branchCalls).toEqual([])
    expect(result.status).toBe('clarify')
    expect(result.clarify?.candidates).toEqual([])
  })

  it('阈值边界：confidence = MIN_CONFIDENCE 恰放行（< 才拦）', async () => {
    const ports = makePorts(async () => ({ label: 'ingest', confidence: MIN_CONFIDENCE }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { topic: '入库' } })

    expect(result.status).toBe('branch')
    expect(ports.branchCalls).toEqual(['ingest'])
  })

  it('多意图高置信：选首路由 + summary 尾注「检测到后续意图」', async () => {
    const ports = makePorts(async () => ({ label: 'discover', confidence: 0.85, secondaryIntent: 'experiment' }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { question: '找问题然后设计实验' } })

    expect(result.status).toBe('branch')
    expect(result.workflow).toBe('discover')
    expect(result.summary).toContain('检测到后续意图 experiment')
  })

  it('无次选高置信：summary 无尾注', async () => {
    const ports = makePorts(async () => ({ label: 'discover', confidence: 0.9 }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { question: 'x' } })

    expect(result.summary).not.toContain('检测到后续意图')
  })

  it('同值次选（自指）：secondaryIntent = 主选视为无次选，summary 无尾注', async () => {
    const ports = makePorts(async () => ({ label: 'discover', confidence: 0.9, secondaryIntent: 'discover' }))
    const graph = createResearchRoutingGraph(ports)
    const result = await graph.invoke({ request: { question: 'x' } })

    expect(result.status).toBe('branch')
    expect(result.workflow).toBe('discover')
    expect(result.summary).not.toContain('检测到后续意图')
  })

  it('stage 上报：branch 路径 = classify + 分支名；clarify 路径只报 classify', async () => {
    const ports = makePorts()
    const stages: string[] = []
    const graph = createResearchRoutingGraph(ports)
    await graph.invoke({ request: { topic: 'x' } }, { onStage: (stage) => stages.push(stage) })
    expect(stages).toEqual(['classify', 'discover'])

    const clarifyStages: string[] = []
    const clarifyPorts = makePorts(async () => ({ label: 'none', confidence: 0.9 }))
    const clarifyGraph = createResearchRoutingGraph(clarifyPorts)
    await clarifyGraph.invoke({ request: { question: 'y' } }, { onStage: (stage) => clarifyStages.push(stage) })
    expect(clarifyStages).toEqual(['classify'])
  })

  it('分类输入 = topic/question 序列化文本（解读点 A：source_paths 不进分类面）', async () => {
    const ports = makePorts()
    const graph = createResearchRoutingGraph(ports)
    await graph.invoke({ request: { topic: 'T1', question: 'Q1', source_paths: ['/lab/uploads/a.pdf'] } })
    expect(ports.classifierCalls[0]).toContain('T1')
    expect(ports.classifierCalls[0]).toContain('Q1')
    expect(ports.classifierCalls[0]).not.toContain('/lab/uploads/a.pdf')
  })
})

describe('节点名常量（progressStages 声明准据）', () => {
  it('入口面 stage 五值 = classify + 四流程名；四流程名与目录 1:1', () => {
    expect(RESEARCH_ENTRY_STAGES).toEqual(['classify', 'ingest', 'discover', 'hypothesize', 'experiment'])
    expect(RESEARCH_WORKFLOW_NAMES).toEqual(WORKFLOW_CATALOG.map((c) => c.label))
  })
})

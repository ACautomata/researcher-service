// 并行 Send 扇出骨架（R1 / issue #847 后续「多视角假设生成」形态验证件）——同一 recommend
// 选项（单 StateGraph）下，addConditionalEdges 的 path 函数返回 Send[] 即得并行扇出，
// 无需第二入口图、无需子图（对比论证见 FINDINGS.md）。
//
// 拓扑：START → seed →⌗ Send[] 并行扇出 N 个 generate 实例 → END（fan-in 经 reducer 归并）
// 关键语义（langgraph 1.4.18 实测类型面）：
//   - BranchPathReturnValue = string | Send | (string|Send)[]（graph/graph.d.ts:22）——path 直接返 Send[]。
//   - new Send(node, args) 的 args 按 key 合入该任务的状态拷贝 → 并行实例互不踩踏；
//     归并靠 annotation reducer（与 routingGraph.ts 同一 branchResults/hypotheses 追加语义）。

import { Annotation, END, Send, START, StateGraph } from '../../server/src/plugins/autofigureDeps'
import type { BaseCheckpointSaver } from '../../server/src/plugins/autofigureDeps'

export const HYPOTHESIS_ANGLES = ['empirical', 'theoretical', 'adversarial'] as const

export interface FanoutState {
  input: string
  /** Send args 注入：每个并行任务的视角。 */
  angle: string | undefined
  /** reducer 追加归并：全部并行任务完成后为完整数组。 */
  hypotheses: string[]
}

const FanoutAnnotation = {
  input: Annotation<string>,
  angle: Annotation<string | undefined>,
  hypotheses: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
}

export interface FanoutComputePorts {
  readonly generate: (angle: string, input: string) => Promise<string>
}

export function createHypothesisFanoutGraph(
  ports: FanoutComputePorts,
  compileOptions?: { checkpointer?: BaseCheckpointSaver },
) {
  const workflow = new StateGraph({ stateSchema: Annotation.Root(FanoutAnnotation) })
    .addNode('seed', () => ({}))
    .addNode('generate', async (state: FanoutState) => ({
      hypotheses: [await ports.generate(state.angle ?? '', state.input)],
    }))
    .addEdge(START, 'seed')
    .addConditionalEdges('seed', (state: FanoutState) =>
      HYPOTHESIS_ANGLES.map((angle) => new Send('generate', { input: state.input, angle })),
    )
    .addEdge('generate', END)

  return workflow.compile({
    ...(compileOptions?.checkpointer ? { checkpointer: compileOptions.checkpointer } : {}),
  })
}

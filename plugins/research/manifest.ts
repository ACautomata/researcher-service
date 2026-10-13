// 科研工作流插件 manifest（853 §3.1 定形 · #909 骨架票）：id=research（显示名「科研工作流」）、
// run.kind='research'（事件族 research_run.* 派生源）、单工具、4 命令、configSchema 单键
// RESEARCH_MODEL（可选——缺省 = owner 默认链 primary；零其余 env 键：阈值 = 代码常量
// values.ts、桶档位 = 参数、凭证全走 owner provider 面）。实现体在 server.ts。
//
// 启用语义沿 #752 §4.2 既有面零新代码：默认未启用、目录一键启用、per-run 快照、禁用不中断
// 进行中 run、历史回放不受影响。前端面（ResearchRunCard/投影归约）归 [#873·7] 前端票。

import { definePlugin } from '../../server/src/plugins/api'
import { RESEARCH_PROGRESS_STAGES } from './graph'
import {
  RESEARCH_TOOL_NAME,
  INPUT_TEXT_MAX,
  researchToolParameters,
  executeResearchWorkflow,
  INGEST_USAGE,
  DISCOVER_USAGE,
  HYPOTHESIZE_USAGE,
  EXPERIMENT_USAGE,
  ingestCommandHandler,
  discoverCommandHandler,
  hypothesizeCommandHandler,
  experimentCommandHandler,
} from './server'

export const researchToolDescription =
  '科研工作流单入口：intent routing over four fixed research workflows. Slots: workflow (explicit: ingest|discover|hypothesize|experiment — omit to let the graph classify intent), topic (research topic), question (research question), source_paths (lab file paths), buckets (hypothesize opt-in generation buckets: ablation|metric|assumption-challenge — only pass when the user explicitly asks for these extra angles), phase (experiment collect call only). Low-confidence or off-scope requests return a clarify result asking the user to pick a workflow.'

export default definePlugin({
  id: 'research',
  name: '科研工作流',
  description: '科研工作流：单入口意图路由四流程——知识库深度构建 / 科学问题可信发现 / 科学假说自主生成 / 实验自主设计与执行',
  version: '0.1.0',
  run: { kind: 'research' },
  tools: [
    {
      name: RESEARCH_TOOL_NAME,
      description: researchToolDescription,
      category: 'domain', // 不进审批三层漏斗（#752 §3；一条执行面 = 一处审计/事件族/配额）
      parameters: researchToolParameters,
      promptSnippet:
        'run one of four fixed research workflows (ingest a paper into the wiki / discover questions from a paper / generate hypotheses / design & run experiments) from a single entry',
      promptGuidelines: [
        `When the user expresses a research request (paper intake, finding questions, research ideas, experiment design), call ${RESEARCH_TOOL_NAME} with topic/question slots organized from the user's request; omit workflow to let the entry graph classify the intent.`,
        'Pass workflow explicitly only when the user picks a command-like flow or replies to a clarify question; source_paths must be /lab/ paths the user referenced.',
        'A clarify result ({status:"clarify", candidates, question}) means the request was ambiguous: relay the candidates to the user in natural language, then re-call with the chosen workflow.',
        'For hypothesize, pass the buckets slot ONLY when the user explicitly requests extra generation angles (ablation/metric/assumption-challenge); never invent bucket values on your own.',
        'For experiment, source_paths must be a critic page (critics/<slug>.md) or idea card page (idea-cards/<slug>.md) at least one. The plan is always human-reviewed via an approval card (up to 3 revision rounds) before execution; on approval, immediately execute the spec in the sandbox (long commands via nohup + log polling, single-command 120s limit), write result files to the declared /lab/ deliverable paths, then call again with phase=\'collect\' and the spec path to reconcile and produce the experiment report page.',
      ],
      // progressStages 白名单（853 §6.1 四流程节点名并集）：#910 落入口面 5 值 + W1/W2
      // 流程节点 11 值、#911 增 W3 节点 4 值、#912 增 W4 节点 7 值（preflight/design/
      // spec/audit/plan-review/collect/summarize——其余重名已含；plan-review = 白名单内
      // 唯一非节点名值，853 §6.1 解读点 D）。
      progressStages: RESEARCH_PROGRESS_STAGES,
      execute: executeResearchWorkflow,
    },
  ],
  commands: [
    // 用法片段引 server.ts 用法常量单源（PR #917 review r1 S 新4：与命令面 failUsage 双写归一）。
    { name: 'ingest', description: `知识库深度构建：把 PDF 精读整理入库 wiki（用法：${INGEST_USAGE}）`, handler: ingestCommandHandler },
    { name: 'discover', description: `科学问题可信发现：从一篇论文审稿式找出问题与研究缺口（用法：${DISCOVER_USAGE}，正文 ≤${INPUT_TEXT_MAX} 字符）`, handler: discoverCommandHandler },
    { name: 'hypothesize', description: `科学假说自主生成：生成新的研究想法、方向与假说（用法：${HYPOTHESIZE_USAGE}）`, handler: hypothesizeCommandHandler },
    { name: 'experiment', description: `实验自主设计与执行：设计验证实验并真实执行（用法：${EXPERIMENT_USAGE}）`, handler: experimentCommandHandler },
  ],
  configSchema: {
    env: [
      {
        name: 'RESEARCH_MODEL',
        required: false,
        description: '意图分类与流程节点 LLM 模型 id（面板级可选 pin；缺省 = owner 默认链 primary 模型）',
      },
    ],
  },
})

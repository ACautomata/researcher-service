// run 域常量（#777 · #747 C 节 / A 节）。单一来源：事件截断上限、默认 recursion limit。
// 供 projector（截断）、runService（recursionLimit）、测试复用。

// tool.end details 截断上限（#747 C 节「details ≤4KB 截断+截断标记」——按 UTF-8 字节计）。
export const TOOL_DETAILS_MAX_BYTES = 4096

// tool.start input 截断上限（#747 C 节 attachmentsJson v1「input ≤1k 截断」同语义事件面）。
export const TOOL_INPUT_MAX_BYTES = 1024

// 默认 recursionLimit（#724 PoC 实测值 500；RunServiceDeps 可覆盖——图深度护栏，
// GraphRecursionError → run.failed{errorKind:'recursion_limit'}，story 10。config 层
// RUNNER_RECURSION_LIMIT 的 env 缺省亦复用本值——默认值单一来源）。
export const DEFAULT_RECURSION_LIMIT = 500

// 图实例缓存上限（RunService 护栏——超限整表清，重建成本 = 一次 createDeepAgent 编译；
// 正确性由缓存键保证，此处只防长期运行退化）。
export const GRAPH_CACHE_MAX_INSTANCES = 64

// 错误分类 cause 链剥离深度（MiddlewareError 包装层数实测的护栏值——链更深按 infra 兜底）。
export const CAUSE_CHAIN_MAX_DEPTH = 8

// 截断标记字段名（事件 payload 上布尔位；有值即表示已截断——不伪造省略号进内容，
// 消费方按标记渲染「已截断」态，attachmentsJson v1 同语义）。
export const TRUNCATED_FLAG = 'truncated'

// HITL 默认决策（PoC 实测 payload 形态）：resume 命令未显式给 decisions 时的单一来源
//（构造面默认值 + 执行面 fallback 同源——两处分叉即构造/执行行为分叉）。
// ⚠ fail-open 缺省：缺省 = 自动 approve。V1 无审批面（interruptPolicyFor 未接线）无实害；
// #783 审批漏斗接入时此缺省须改为必填——审批时代静默放行是安全事故面。
export const DEFAULT_RESUME_DECISIONS = { decisions: [{ type: 'approve' }] } as const

// V1 leader 系统提示（最小闭环面；#787 commands/skills 官方目录注入扩展，#789 wiki 工具面扩展）。
export const LEADER_SYSTEM_PROMPT = [
  '你是天津大学科研智能体平台的研究助手。',
  '文件树双根：/wiki/（用户知识库，读写）与 /lab/（你的工作沙箱，读写）。',
  '工具：ls / read_file / write_file / edit_file / glob / grep / execute。',
  '逐步用工具完成任务，不要凭空假设文件内容；回答使用用户语言。',
].join('\n')

// 审批三层漏斗常量（#783 · 729 规格 / ADR 0015）。单一来源：护栏数字、工具类别映射表、
// 路径前缀集、升级来源枚举、judge 政策文本（版本化 markdown）。供 rules（规则层）、judge、
// funnel（中间件）、runService（状态机）与测试复用。
//
// 显式非目标（729 §1.4）：名单 admin 可配——V1 硬编码为代码常量 + 测试锁定，变更随发版走。

// ---------------------------------------------------------------------------
// 护栏数字（729 附录 B 汇总）
// ---------------------------------------------------------------------------

// judge 输入预算（token）——字符换算按 2 chars/token（CJK 保守：中文 ≈1.5-2 chars/token，
// 取 2 保证不超 8k 上限；换算函数在 judge.ts）。
export const JUDGE_USER_INPUT_BUDGET_TOKENS = 2000
export const JUDGE_PRIOR_CALL_BUDGET_TOKENS = 1000
export const JUDGE_CURRENT_CALL_BUDGET_TOKENS = 1000
export const JUDGE_INPUT_TOTAL_BUDGET_TOKENS = 8000
/** token → 字符换算因子（judge 输入截断面唯一换算处）。 */
export const JUDGE_CHARS_PER_TOKEN = 2

// 之前工具调用回喂条数（729 §2.2：最近 N=10 条按时间序）。
export const JUDGE_PRIOR_CALLS_MAX = 10

// per-run judge 调用上限（729 §2.5）：超限升级人工。
export const JUDGE_MAX_CALLS_PER_RUN = 20

// 同 hash（工具名 + 规范化参数）reject 次数上限：≥3 次不再回喂，直接升级人工（729 §2.6）。
export const REPEAT_REJECT_ESCALATE_AT = 3

// 升级审批超时（729 §3.3 / story 15）：48h → run 标记 suspended（非终态，可 resume/abort）。
export const APPROVAL_TIMEOUT_MS = 48 * 60 * 60 * 1000

// judge 理由长度上限（729 §2.5：≤100 字中文，面向 agent 的纠正建议）。超长截断。
export const APPROVAL_REASON_MAX_CHARS = 100

// 审批卡摘要字段截断（toolCall 摘要 / actionRequests 参数摘要，字节上限——事件 payload 面）。
export const APPROVAL_SUMMARY_MAX_BYTES = 1024

// ---------------------------------------------------------------------------
// 工具类别映射表（729 §1.5——映射机制本票定稿；工具名以 deepagents 内建工具面实测锁定，
// #737 工具面定稿后扩充。未列入者一律走灰区 → judge）。
// ---------------------------------------------------------------------------

// 文件类工具：路径白名单（§1.2）。字面路径参数名实测锁定（deepagents FilesystemMiddleware）：
// read_file/write_file/edit_file 用 file_path，ls/glob/grep 用 path（S1 用例经真实工具面锁定）。
export const FILE_TOOLS: readonly string[] = ['ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep']
// 文件类工具的字面路径参数候选名（双形态并收——deepagents 升级参数改名时测试红，不静默漏判）。
export const FILE_PATH_PARAM_NAMES: readonly string[] = ['file_path', 'path']

// exec 类工具：命令黑名单（§1.3）。
export const EXEC_TOOLS: readonly string[] = ['execute']
// exec 工具的命令参数名。
export const EXEC_COMMAND_PARAM_NAME = 'command'

// 网络类工具 V1 无内建（#728 出网放行 + 审计；不进白名单）——将来加入时归「无规则层」类。

// ---------------------------------------------------------------------------
// 路径白名单前缀集（729 §1.2 V1）：normalizeFilePath 语义归一化后做前缀匹配。
// `/tmp` 是沙箱 scratch 合法空间；wiki/lab 两段式 root 语义与 files API 一致（#728）。
// 存储形态为「去根斜杠后的段前缀」（'lab/'），匹配时先剥调用侧绝对路径的根斜杠。
// ---------------------------------------------------------------------------
export const PATH_WHITELIST_PREFIXES: readonly string[] = ['wiki/', 'lab/', 'tmp/']
/** 前缀集的裸根形态（'lab' = lab 树根本身，视为命中——列树根等价于 ls /lab）。 */
export const PATH_WHITELIST_ROOTS: readonly string[] = ['wiki', 'lab', 'tmp']

// ---------------------------------------------------------------------------
// 命令黑名单（729 §1.3 V1 四条）——名单小而硬：漏网有 judge 政策①兜底，误拦直接拒死
// 用户体验。规则 id 是审计行 reason 的规则标识（测试锁定）。
// ---------------------------------------------------------------------------
export const SHELL_RULE_RM = 'rm-root-recursive'
export const SHELL_RULE_DEVICE_WRITE = 'device-write'
export const SHELL_RULE_FORK_BOMB = 'fork-bomb'
export const SHELL_RULE_CONTAINER_ESCAPE = 'container-escape'

// rm 递归删除的受保护目标族（§1.3 #1：/ 、/root、/home、/lab、/wiki、/* 根级展开）。
// 存储为剥根斜杠后的段（'' = 根本身）；匹配时对目标做同形归一（去尾 '/'、去尾 '/*'）。
export const RM_PROTECTED_TARGETS: readonly string[] = ['', 'root', 'home', 'lab', 'wiki']

// shell 词法解析递归深度上限（命令替换/子壳嵌套护栏——超深按未命中放行，防构造嵌套炸弹）。
export const SHELL_PARSE_MAX_DEPTH = 8

// fork bomb 已知模式正则（§1.3 #3）：bash `:(){ :|:& };:` 族 + Windows 批处理 `%0|%0` 族。
// 匹配对象 = 原始命令字符串（fork bomb 是跨 token 的语法形态，词法拆解后不可判定）。
export const FORK_BOMB_PATTERNS: readonly RegExp[] = [
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;?\s*:/, // :(){ :|:& };: 族
  /%0\s*\|\s*%0/, // %0|%0 族（批处理自复制）
]

// 容器逃逸标记（§1.3 #4）：docker socket 访问 + nsenter。
export const DOCKER_SOCK_MARKERS: readonly string[] = ['/var/run/docker.sock', '/run/docker.sock']
export const CONTAINER_ESCAPE_COMMANDS: readonly string[] = ['nsenter']

// 设备写命令名（§1.3 #2）：mkfs 家族按前缀匹配（mkfs / mkfs.ext4 / mkfs.vfat …）。
export const DEVICE_WRITE_COMMANDS: readonly string[] = ['dd', 'fdisk', 'sfdisk', 'parted']

// ---------------------------------------------------------------------------
// 升级通道（729 §3）
// ---------------------------------------------------------------------------

// 升级触发源（EscalationItem.source，729 §3.4 四值）。
export type EscalationSource = 'cautious-mode' | 'judge-limit' | 'repeat-reject' | 'judge-malformed'

// 升级事件/interrupt 载荷的判别标记：RunService 据此把「审批升级 interrupt」与 deepagents
// 内建 interruptOn（V1 测试注入面，载荷形状不同）区分开——只有本漏斗的 interrupt 触发
// approval.requested 事件与 48h 计时。
export const APPROVAL_INTERRUPT_KIND = 'tool-approval'
export const APPROVAL_INTERRUPT_V = 1

// 审批域事件类型（#747 C 节事件目录定稿名）。
export const APPROVAL_EVENT_REQUESTED = 'approval.requested'
export const APPROVAL_EVENT_RESOLVED = 'approval.resolved'

// ---------------------------------------------------------------------------
// judge 政策（729 §2.4 / 附录 A 初稿——列拒四类，之外一律 approve）。
// 版本化 markdown：改政策 = 改此文本 + 发版（PoC 实测后调优）。
// ---------------------------------------------------------------------------
export const JUDGE_POLICY_VERSION = 'v1'

export const JUDGE_POLICY_MARKDOWN = `你是工具调用审批判定器。对 agent 即将发起的工具调用给出 approve 或 reject 判定。

## 输入

- user_input：用户本轮输入（已截断）
- prior_tool_calls：之前至多 10 条工具调用及结果，按时间序（各已截断）
- current_call：当前待判定的工具调用（工具名 + 参数）

## 政策（列拒——只拒以下四类，其余一律 approve）

1. system_destruction（系统破坏）：rm 递归删除根/系统目录；设备写（dd of=/dev/*、mkfs、fdisk）；fork bomb；容器逃逸（docker.sock、nsenter）。
2. data_exfiltration（数据外送）：把 wiki/lab 树的内容发送、上传或粘贴到外部目的地——curl/wget 外发本地文件内容、向外部端点 POST 本地数据。
3. persistence_backdoor（持久化后门）：建立跨会话存活的执行机制——cron、systemd unit、shell rc 文件、SSH authorized_keys。
4. credential_access（凭证访问）：读取环境变量中的密钥（LLM_API_KEY 等）、~/.ssh/、加密 key 相关路径。

## 判定规则

- 命中政策任一类 → decision="reject"，policy_class 填命中类，reason 给一句话纠正方向（≤100 字，中文，面向 agent 可执行）。
- 未命中 → decision="approve"，policy_class=null，reason=""。
- 不得以「与任务无关」「可能不必要」为由 reject——agent 的规划自由不在你的职权内。
- 不确定时倾向 approve。

## 输出（严格 JSON，不要输出任何其他内容）

{
  "decision": "approve" | "reject",
  "policy_class": "system_destruction" | "data_exfiltration" | "persistence_backdoor" | "credential_access" | null,
  "reason": "reject 时 ≤100 字中文纠正建议；approve 时空字符串"
}`

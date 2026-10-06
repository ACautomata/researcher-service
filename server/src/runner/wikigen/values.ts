// wiki 治理生成双路径常量（#790 · #747 G 节 wiki 三通道②③）。
// 单一来源：teammate kind 值、openwiki HostSessionManager host id、冲突信箱 kind、
// 生命周期驱动提示、wiki_run 域事件名、镜像目录前缀。供 mirror（落地副本）、
// lifecycleTools（生命周期工具）、runService（teammate 装配）与 wiki/updateRun（独立 run）
// 复用。
//
// 三通道背景：通道①常驻检索+轻写（#789 落地）；本模块服务②chat 内 wiki-update teammate
// （落地副本执行模型）与③面板「更新 wiki」独立 run（runNativeRepositoryGeneration 完整边界）。

import { OPEN_WIKI_DIR } from 'openwiki/dist/config/constants.js'

// openwiki 子目录名（deep-import 单一来源——openwiki 布局常量，不自造字符串）
export { OPEN_WIKI_DIR as WIKI_OPENWIKI_DIR }

// wiki-update teammate 的持久 kind（teammates.kind 列值；generic = 其余 teammate 缺省）。
export const WIKI_UPDATE_TEAMMATE_KIND = 'wiki-update'

// HostSessionManager host id（protocol.isValidHostId：小写字母/数字/连字符）——记入
// openwiki 生成元数据 producer 面的身份标识。
export const WIKI_UPDATE_HOST_ID = 'panel-wiki-update'

// base-hash 冲突时 leader 信箱邮件 kind（TeammateService.sendMail）——冲突中止不静默覆盖，
// 邮件是父会话时间线上的用户可见通知面。
export const WIKI_CONFLICT_MAIL_KIND = 'wiki-conflict'

// 控制面临时镜像目录前缀（mkdtemp；与 #789 检索镜像 wiki-mirror- 区分——生成镜像带 git 根）。
export const WIKI_GENERATION_TMP_PREFIX = 'wiki-gen-'

// 镜像根的源语料目录（pull 时对容器树非隐藏文件的只读快照副本）：openwiki claims 证据
// （repo://<path>）必须解析到仓库内 openwiki/ 之外的真实文件——容器树全部映射进 openwiki/
// 后无源可引。sources/ = 页面 pre-update 快照，双职责：证据锚（repo://sources/<页相对路径>）
// + planner/worker 的只读源视图。不入推回范围。
export const WIKI_MIRROR_SOURCES_DIR = 'sources'

// 生命周期驱动提示（kind=wiki-update 的 teammate system prompt 追加段）：begin→submit_plan→
// next_page→原生 fs 写页→submit_page 循环→finish 收尾的纪律 + 「写面=治理副本、finish 才落
// 容器、冲突会中止」语义告知。没有它，task 全凭模型自由发挥，产品可用性无着落。
//
// 路径映射语义（模型必须知道）：生命周期计划页路径形如 openwiki/concepts/x.md；fs 写工具
// 以 /wiki/concepts/x.md 寻址同一文件（/wiki 根即 openwiki 子树内容——#789 检索镜像同布局）。
export const WIKI_UPDATE_TEAMMATE_PROMPT = [
  'You are a wiki-update teammate: your task is to update the user\'s knowledge wiki using the OpenWiki lifecycle tools.',
  '',
  'Discipline:',
  '1. Call openwiki_begin with mode "update" first; use the returned runId in every later lifecycle call.',
  '2. Call openwiki_submit_plan with the pages that need work, then openwiki_next_page to fetch page jobs one at a time.',
  '3. For each page job: write or edit the page with the file tools, then call openwiki_submit_page with the job id.',
  '   A plan page path "openwiki/<group>/<name>.md" is addressed by the file tools as "/wiki/<group>/<name>.md" — they are the same file.',
  '   Write valid OKF frontmatter (type/title/description/tags) and keep prose in the wiki\'s language.',
  '   openwiki_submit_page requires at least one material Claim for new or substantively revised pages.',
  '   Claim evidence must reference an existing snapshot file under "sources/" (e.g. repo://sources/<group>/<name>.md — the pre-update copy of a wiki page).',
  '4. When every page job is complete, call openwiki_finish exactly once. finish performs base-change detection and publishes your work to the real wiki.',
  '5. If the real wiki changed while you were working, finish reports a conflict result and nothing is written — report that outcome to the leader instead of retrying.',
  '',
  'Semantics: the files you read and write are a private working copy of the wiki; only finish publishes it. An interrupted or failed run publishes nothing. Do not use /lab during a wiki update.',
].join('\n')

// wiki_run 域事件名（#747 C 节事件目录 · 通道③独立 run 的 SSE 面）。debug 类事件不落 SSE
//（映射面丢弃），finished 由执行体构造（outcome 三值）——不来自 OpenWikiRunEvent。
export const WIKI_RUN_PROGRESS = 'wiki_run.progress'
export const WIKI_RUN_TEXT = 'wiki_run.text'
export const WIKI_RUN_TOOL_START = 'wiki_run.tool_start'
export const WIKI_RUN_TOOL_END = 'wiki_run.tool_end'
export const WIKI_RUN_FINISHED = 'wiki_run.finished'

// wiki_run.finished 的 outcome 值集：completed（推回落容器）/ conflict（base-hash 冲突，
// 弃镜像不推回）/ failed（异常，中断即作废）。
export type WikiRunOutcome = 'completed' | 'conflict' | 'failed'

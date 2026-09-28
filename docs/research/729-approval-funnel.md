# 729 自动审批三层漏斗规格

> Wayfinder 票 [#729](https://github.com/ACautomata/researcher-service/issues/729)，map：[#734 LangGraph agent runtime 替代 OpenClaw](https://github.com/ACautomata/researcher-service/issues/734)。
> 根决策 [#722](https://github.com/ACautomata/researcher-service/issues/722) 已钉三层漏斗方向（规则层确定性前置 → LLM judge 固定输入 → 罕用人工升级，全量审计入 TextTrace）；本文档定全部细节。工具名映射表占位，待 [#737](https://github.com/ACautomata/researcher-service/issues/737) 工具面定稿后回填。
> 状态：grilling 会话定稿（2026-09-28，两轮 16 决策全录见票 resolution）。

## 0. 关键张力与裁决

### 0.1 vs ADR 0014「审批卡终态不留痕」

ADR 0014 的不留痕是「网关无权威存储、审计不可得」的妥协。新架构集中式控制面是审批回路的**唯一权威**，审计可得性无条件成立 → 全量审计取代不留痕，[ADR 0015](../adr/0015-approval-full-audit-trace.md) 显式 supersede 0014 的留痕裁决。旧 OpenClaw 栈的渲染行为维持现状至退役，不在本规格范围。

### 0.2 vs #728「沙箱 V1 出网放行」

网络层（沙箱 bridge 出网）V1 放行 + 审计；judge 政策②「数据外送」是**内容层**闸门（拦「把 wiki/lab 内容送往外部目的地」的语义行为）。两层分工：网络层管通断，judge 管内容。规格不重复定义网络策略。

### 0.3 vs 根决策 #722 原文「仅 wiki/workspace 树」

#728 已钉 `workspace` 字眼全面退役、files API root 改 `wiki|lab`——本文一律按 **wiki|lab 双树**表述（wiki 容器 `/wiki` 树 + 沙箱 `/lab` 树）。

### 0.4 vs #731「provider 端点白名单」

漏斗规则层的「端点白名单」即 #731 的 LLM provider 端点机制（`provider_endpoints` 表、CRUD origin 精确匹配 + 运行时复验禁 redirect、复验在 LLM 调用出口）。本文档直接引述，不重复定义。agent 工具的网络访问（web.fetch 之类）走 #728 放行 + 审计，**不进**白名单。

## 1. 规则层（确定性前置）

### 1.1 命中语义：三分

| 判定 | 去向 | 成本 |
|------|------|------|
| 黑名单命中 | **直接拒**（终态，不升级人工） | 零 LLM |
| 白名单命中 | **直接放行**（零 LLM 成本，不过 judge） | 零 LLM |
| 未命中（灰区） | 进 judge | 一次 judge 调用 |

「白名单命中直接放行」是刻意的成本裁决：judge 若全员安检，第一层规则退化为摆设，成本上一个量级。安全水位靠白名单收紧保证，judge 是灰区守门员。

### 1.2 路径白名单

- **对象**：只判**文件类工具的字面参数**（调用时可见的 root+path）。exec 命令内部访问的路径规则层看不到（容器内文件系统状态不在调用参数里），由沙箱只读根 + cap_drop ALL + 非 root 兜底（#728 已定）——**不做 exec 内嵌路径的字面扫描**（误报率高且可被拼接/编码绕过）。
- **规范化**：复用 `server/src/files/paths.ts` 的 `normalizeFilePath` 语义——拒 `..` 段、拒绝对路径（root 之外）、拒反斜杠/NUL、折叠 `.` 与空段、512 码点上限。
- **前缀集**（V1）：`wiki/**`、`lab/**`、`/tmp/**`。`/tmp` 是沙箱 scratch 合法空间；wiki/lab 两段式 root 语义与 files API 一致（#728）。
- **匹配**：规范化后做前缀匹配；命中即白名单放行。

### 1.3 命令黑名单

- **名单制**：根决策已钉黑名单制。V1 名单**小而硬**——宁缺毋滥（漏网有 judge 政策①兜底，误拦直接拒死用户体验）。
- **V1 名单**（四条）：
  1. `rm` 携带 `-r|-R` 且目标 ∈ {`/`, `/root`, `/home`, `/lab`, `/wiki`, `/*` 根级展开}
  2. 设备写：`dd of=/dev/*`、`mkfs.*`、`fdisk`/`sfdisk`/`parted`
  3. fork bomb 模式：`:(){ :|:& };:` 族（`:|:`、`%0|%0` 等已知模式正则）
  4. 容器逃逸：访问 `/var/run/docker.sock`、`nsenter`
- **匹配语义**：shell 词法解析（`shell-quote` 类 tokenizer），管道 `|`、命令替换 `$( )`/`` ` ` ``、`;`/`&&`/`||` 递归拆成**简单命令**逐一判定「命令名 + 危险 flag 组合」——纯子串匹配否决（`grep "rm -rf"` 不该被拦）。
- **网络外送不拦**：#728 V1 出网放行 + 审计已钉；外送的语义防控在 judge 政策②。

### 1.4 配置面

名单（命令黑名单条目、路径前缀集）V1 **硬编码为代码常量 + 测试锁定**，不做 admin 可配（DB 表 + 管理面）——变更频率低（随发版走），admin 可配引入「配错谁兜底」的新审计问题。**显式非目标**：admin 可配名单。

### 1.5 工具类别映射表（占位，#737 回填）

| 工具类别 | 挂接规则 | 具体工具名 |
|----------|----------|------------|
| 文件类（读/写/删 wiki\|lab） | 路径白名单（§1.2） | *待 #737 回填* |
| exec 类（沙箱命令执行） | 命令黑名单（§1.3） | *待 #737 回填* |
| 网络类（web.fetch 等） | 无规则层；出网放行 + 审计（#728） | *待 #737 回填* |
| wiki 编辑类（OpenWiki 工具面） | 路径白名单（§1.2，wiki 树） | *待 #737 回填* |

映射机制本文定稿；工具名以 #737 为准。

## 2. LLM judge

### 2.1 触发与位置

仅灰区调用进 judge（§1.1 三分）。judge 是漏斗第二层，位于规则层之后、升级通道之前。

### 2.2 输入契约（根决策固定，不含模型自身推理输出）

| 组成 | 来源 | 截断预算 |
|------|------|----------|
| 用户本轮输入 | run 的首条 user message | 2k tokens |
| 之前的工具调用 + 结果 | 最近 N=**10** 条，按时间序；各含调用摘要 + 结果摘要 | 各 1k tokens |
| 当前待判定调用 | 工具名 + 规范化参数 | 1k tokens |
| **总计** | | **≤8k tokens** |

- **不喂历史 judge 判定与理由**：灰区历史调用的判定不随输入回灌——防锚定（前 reject 诱导后 reject），也省 token。
- 工具结果中的中间推理痕迹（若工具返回模型生成内容）按原文截断喂入，不做特殊剥离——「不含模型自身推理输出」约束的是**主 agent 的 thinking**，已天然不在此输入面。

### 2.3 输出契约

- 结构化 JSON：`{ decision: "approve"\|"reject", policy_class: 四类之一\|null, reason: string }`（schema 见附录 A）
- 温度 0；JSON mode + zod 校验。
- **校验失败重试一次**（回灌校验错误）；再失败 fail-closed → 升级人工（schema 坏不是 agent 的错，不直接 reject）。

### 2.4 政策：列拒四类（版本化 markdown 注入 prompt）

**列拒**（只拒列明的四类，之外一律 approve）——误拦让 agent 瘫痪的成本远高于漏拦（有黑名单 + 审计兜底）：

1. **系统破坏**：rm -rf 族、设备写、fork bomb、容器逃逸（黑名单漏网兜底）
2. **数据外送**：把 wiki/lab 树内容发送/上传/粘贴到外部目的地（curl/wget 外发本地内容、向外部端点 POST 本地数据）——V1 网络放行的内容层闸门（§0.2）
3. **持久化后门**：cron、systemd unit、shell rc 文件、SSH authorized_keys 等跨会话存活机制
4. **凭证访问**：env 密钥（`LLM_API_KEY` 等）、`~/.ssh/`、加密 key 相关路径

政策全文以版本化 markdown 维护（附录 A 初稿），注入 judge system prompt；改政策 = 改文档 + 发版。

### 2.5 模型与成本

- **独立小模型**：haiku 4.5 级，与主模型解耦（主模型切换不影响审批水位）。
- per-run judge 调用上限 **20 次**：超限 → 升级人工（升级通道第一级真实触发源）。
- 理由 ≤100 字中文，面向 agent 的纠正建议（保证可回喂、可审计、成本可算）。

### 2.6 reject 回喂与重试防护

- reject 以 `ToolMessage`（错误 + judge 理由）回主 agent 循环，agent 可修正意图重新发起**不同**调用。
- 同 hash（工具名 + 规范化参数）reject **≥3 次** → 不再回喂，直接升级人工。换姿势（改参数/换工具）重新过漏斗，不计次锁死。

## 3. 升级通道

### 3.1 触发源（默认趋零，三开关）

| 触发源 | 条件 | 处置 |
|--------|------|------|
| 谨慎模式（cautious） | 用户会话级开启：全灰区进人工 | 用户自选，`users.approvalMode` |
| judge 超限 | 单 run judge 调用 >20 次 | 自动升级 |
| 重复拒绝 | 同 hash reject ≥3 次 | 自动升级 |
| judge 输出畸形 | schema 重试后再败 | 自动升级（fail-closed） |

规则层黑名单命中**不升级**（直接拒，终态）。默认（standard 模式）零强制人工。

### 3.2 并发形态

- judge 调用互相独立 → **并行**（无依赖，串行白加延迟）。
- 人工升级**串行**：一个 run 同时只挂一个 interrupt（先 pending 先弹，后续灰区调用等前一个落定再过漏斗）；ApprovalDock 现有 seq 队列形态天然支持。
- per-run 独立：用户多会话并发 run 的审批互不阻塞、无共享状态。

### 3.3 阻塞形态与超时

- LangGraph interrupt/resume（#723 已钉一等公民）：run 挂起等 ApprovalCard 落定。
- 超时 **48h** → run 标记 `suspended`（非 failed）；用户回来可 resume 或 abort（abort 为终态）。
- 审批挂起**不算**沙箱闲置：30min 停沙箱（#728）与审批挂起互不干扰。
- `suspended` 在会话列表可见（区别于 failed）。

### 3.4 ApprovalCard 复用面

| 面 | 裁决 |
|----|------|
| UI 骨架 | **全复用**：ApprovalDock + 卡片 + pending→resolving→resolved 状态机 + 120 字摘要 + 详情展开 |
| props | 重定义：`{ escalation: EscalationItem }`，`EscalationItem = { id, source: 'cautious-mode'\|'judge-limit'\|'repeat-reject'\|'judge-malformed', toolCall 摘要, judgeReason? }` |
| decision 枚举 | **砍 `allow-always`**：规则学习破坏规则层确定性，V2 再说 |
| 数据源 | 网关直连 WS → 控制面 WS（根决策已钉控制面成为 chat WS 提供者） |
| 留痕 | 落定即入 `tool_approval_logs`（§4），卡片本身落定即撤的交互不变（ADR 0014 渲染行为在新 runtime 延续，语义由「不留痕」转「留痕在审计表」） |

### 3.5 谨慎模式

- 落 `users.approvalMode: standard|cautious` 列（User 表加列，有 `mustChangePassword` 先例）；跨设备跟随。
- 前端 ChatHeader 加切换；默认 standard。
- cautious 下灰区 = 规则层未命中白名单的调用（黑名单仍直接拒，不升级）。

## 4. 审计

### 4.1 新表 `tool_approval_logs`（traceLogs 域）

不扩展 `text_trace_logs`：现有表是「生成内容溯源」（inputText/outputText 全文），审批审计是「工具调用判定轨迹」——不同领域，混表污染两个查询面。

```prisma
enum ToolApprovalLayer  { rule, judge, human }
enum ToolApprovalDecision { allow, deny }

model ToolApprovalLog {
  id             String   @id @default(cuid())
  traceId        String   // 弱关联 text_trace_logs.traceId（#727 接缝）
  runId          String
  userId         String   // 冗余：审计快照跟 user 永久，不随容器删（#727）
  layer          ToolApprovalLayer
  decision       ToolApprovalDecision
  toolName       String
  toolCall       String   // 规范化参数 JSON 快照
  policyClass    String?  // judge reject 的政策类（四类之一）
  reason         String?  // judge 理由 / 人工拒绝理由
  judgeInputHash String?  // judge 输入快照 hash——不存全文，控体积
  latencyMs      Int?
  judgeTokens    Int?     // 输入+输出 token 成本
  createdAt      DateTime @default(now())

  @@index([traceId])
  @@index([userId, createdAt])
  @@map("tool_approval_logs")
}
```

### 4.2 写入路径

判定落定后**同步**写 Prisma（SQLite，ms 级）。审批是安全路径，审计不能丢；BullMQ 单进程模型下队列化没有解耦收益，反而多一条丢消息的缝。**三层全记**：规则层白名单命中行最瘦（`{layer:rule, decision:allow, 规则 id}`，无 judge 字段）——「全量审计」的「全量」即此意。

### 4.3 可见面

- **终端用户**：judge 判定理由可见（透明性：agent 被拒用户看得到为什么）。
- **admin**：全量审计面（含 latencyMs / judgeTokens 成本列）。

## 附录 A：judge prompt 初稿（PoC 前评审版，实测后调）

> 未定稿——成本与误判率待 PoC 实测校准（map fog「judge prompt 调优」）。

````markdown
你是工具调用审批判定器。对 agent 即将发起的工具调用给出 approve 或 reject 判定。

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
}
````

## 附录 B：护栏数字汇总

| 护栏 | 值 | 超限处置 |
|------|----|----------|
| judge 输入预算 | ≤8k tokens/run 调用 | 截断（§2.2） |
| judge 调用 | 20 次/run | 升级人工 |
| 同 hash reject | 3 次/run | 升级人工 |
| 升级审批超时 | 48h | run → suspended |
| 沙箱闲置（#728，正交） | 30min | 停沙箱（审批挂起不算闲置） |

## 附录 C：术语（CONTEXT.md 词条见「审批三层漏斗」「规则层」「judge」「升级通道」）

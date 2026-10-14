# 科研工作流（research）

科研工作流插件把四条固定科研流程接进 chat 会话：**单一入口、意图自动路由、流程互斥**。
你在对话里用自然语言描述科研诉求，或直接敲斜杠命令，插件会把它分派到对应的流程执行。

## 启用

插件默认未启用。在面板插件目录中一键启用后，**新会话**即获得 `research_workflow` 工具与
4 条命令；禁用后新会话不再可见，进行中的运行不受影响，历史回放保持原样。

## 四条流程

| 命令 | 流程 | 适用场景 |
|---|---|---|
| `/ingest` | 知识库深度构建 | 把 `/lab/uploads` 下的论文 PDF 精读整理成结构化笔记页入库 wiki |
| `/discover` | 科学问题可信发现 | 从一篇已有论文中审稿式地找出问题、弱点与研究缺口 |
| `/hypothesize` | 科学假说自主生成 | 生成新的研究想法、方向与假说 |
| `/experiment` | 实验自主设计与执行 | 为明确的问题或想法设计验证实验，并在沙箱中真实执行 |

## 入口与路由

两种触发方式汇聚到同一个执行面：

- **命令直达**：`/ingest /discover /hypothesize /experiment` 显式指定流程，不经过意图分类。
- **自然语言**：直接描述诉求（如「帮我把这篇论文的问题找出来」），主 agent 调用
  `research_workflow` 工具，入口图内的意图分类器自动判定流程；置信度不足时会**反问澄清**
  （列出最可能的候选流程供你选择），不会盲目执行。

```mermaid
flowchart TD
    U["chat 会话<br/>（自然语言或命令）"]

    U -->|"直接描述诉求"| AGENT["主 agent<br/>组织 topic / question"]
    U -->|"/ingest /discover<br/>/hypothesize /experiment"| CMD["命令直达<br/>显式指定 workflow"]

    AGENT --> TOOL["research_workflow 工具"]
    CMD --> TOOL

    TOOL --> G{{"入口图"}}

    G -->|"命令带 workflow（seed 透传）"| R
    G -->|"自然语言（无 workflow）"| C["classify 意图分类<br/>5 值标签 + 置信度"]

    C -->|"高置信 ≥ 0.60"| R["互斥分发<br/>（恰一流程在跑）"]
    C -->|"低置信 < 0.60"| CL["clarify 反问<br/>列出最可能的候选流程"]
    C -->|"不属于科研诉求（none）"| CLN["clarify 如实拒识<br/>请改述需求"]

    CL --> U
    CLN --> U

    R --> W1["ingest<br/>知识库深度构建"]
    R --> W2["discover<br/>科学问题可信发现"]
    R --> W3["hypothesize<br/>科学假说自主生成"]
    R --> W4["experiment<br/>实验自主设计与执行"]

    W1 --> E["产物落 wiki（页面 + claims）<br/>进度经 SSE 实时上报"]
    W2 --> E
    W3 --> E
    W4 --> E
```

### 路由规则速记

- **命令路径恒直达**：命令已显式指定流程，永不触发分类与澄清兜底。
- **seed 透传**：请求中已带 `workflow`（命令 / 你显式指定 / 实验流程的结果收集调用）时，
  跳过分类器直接进入对应流程。
- **多意图输入**：高置信时选首个意图执行，并在结果末尾提示「检测到后续意图 X，可继续发起」。
- **澄清后再发**：回复 clarify 提示时，重新描述诉求或直接说「用 discover 流程」，主 agent
  会带着显式流程重新调用。

## 流程详情

> 已上线：**W1 ingest**（知识库深度构建）、**W2 discover**（科学问题可信发现）、
> **W3 hypothesize**（科学假说自主生成）与 **W4 experiment**（实验自主设计与执行，
> #912 全链含方案人审门禁；审批卡面 #920/#913）。

### W1 `/ingest` 知识库深度构建（七节点链，V1 单篇）

```mermaid
flowchart TD
    S(["/ingest /lab/uploads/论文.pdf"]) --> C["capture<br/>路径前缀 + PDF 形态 + 单篇校验<br/>（确定性）"]
    C -->|"非 /lab/uploads 前缀<br/>URL 来源暂不支持"| F1["明确失败<br/>（诊断回喂）"]
    C --> E["extract<br/>PDF 按页提取文本<br/>（超限明确报错）"]
    E --> CR["create<br/>LLM 生成 11 节论文页<br/>+ claims 结构化提交"]
    CR --> V["validate<br/>11 节标题齐全 / ≥100 行<br/>Results 含具体数字（确定性）"]
    V -->|"不过 → 附诊断<br/>回 create 重试 1 次"| CR
    V -->|"通过"| P["persist<br/>幂等哨兵写入 wiki<br/>（页已存在 = 跳过不覆盖）"]
    P --> VF["verify<br/>回读 11 节哈希对账 + 产物指纹<br/>（幂等跳过路径免对账）"]
    VF --> SM["summary<br/>≤1k + 产物路径"]
```

- 产物：`papers/<kebab-case 标题>.md` 论文页（frontmatter 溯源由核心组装 + Atomic Claims 块）。
- **重跑/断线重放安全**：persist 的幂等哨兵保证同一论文不建重复页；verify 回读对账确认落盘完整。
- 生成质量门：LLM 产出经确定性校验（节结构 / 行数 / Results 数字），不过则带诊断自动重试一次，再不过即明确失败。

### W2 `/discover` 科学问题可信发现（九节点链）

```mermaid
flowchart TD
    S(["/discover 研究问题<br/>[papers/论文页.md]"]) --> RI["resolveInputs<br/>定位论文页（检索 / 路径钉定）<br/>papers/ 前缀白名单"]
    RI -->|"论文页不存在"| CL["clarify 出口<br/>提示先 /ingest（产物串联）"]
    RI --> L["load<br/>按 11 节锚回读论文页"]
    L --> EX["extract<br/>LLM 12 节实验深度提取"]
    EX --> V1["validate¹<br/>12 节 checklist<br/>+ 三态标注禁语扫描"]
    V1 -->|"不过 → 附诊断<br/>回 extract 重试 1 次"| EX
    V1 --> CR["critic<br/>LLM §0–§7 审稿式分析<br/>+ 候选问题 2–4 带优先级"]
    CR --> V2["validate²<br/>H1 + 机读标签位置<br/>+ 候选 2–4（确定性）"]
    V2 -->|"不过 → 附诊断<br/>回 critic 重试 1 次"| CR
    V2 --> EG["evidenceGate<br/>证据引用存在性回查<br/>（确定性）"]
    EG --> P["persist<br/>critic 页 + 候选问题 claims"]
    P --> SM["summary<br/>产物路径 + 候选存活<br/>+ 剔除清单（不静默，不截断）"]
```

- 产物：`critics/<slug>.md` critic 页（§0–§7 + `type: critique` 机读标签 + 验证候选问题进 Atomic Claims）。
- **证据可溯源**：候选问题的每条证据引用（本论文页节锚 / 其他 wiki 页 / 上传件 / 描述性引用）
  逐一回查，不可溯源的引用被剔除——剔除清单完整进 summary，本身就是溯源信息。
- 两个校验节点检查对象不同（extract 12 节 vs critic §0–§7 + H1/机读标签位置），分别把关各自生成质量。

### W3 `/hypothesize` 科学假说自主生成（八节点链 + Send[] 桶扇出）

```mermaid
flowchart TD
    S(["/hypothesize 研究主题<br/>[papers/论文页.md …]（可多篇，跨论文）"]) --> RI["resolveInputs<br/>papers/ 前缀白名单 + 存在性回查"]
    RI -->|"论文页缺失 / 形态不符"| CL1["clarify 出口<br/>提示先 /ingest（产物串联）"]
    RI --> CP["contextPack<br/>集中检索 + Brief 10 字段<br/>（缺失字段写 ASSUMPTION 继续）<br/>16k token 预算构建时裁一次：<br/>证据按等级降序 + 页级节选 + Brief 恒保全"]
    CP -->|"裁剪后零证据条目"| CL2["clarify 出口（证据不足）<br/>不生成泛化 idea"]
    CP -->|"证据充足"| FAN{{"Send[] 桶扇出（图内并行）<br/>5 固定桶：gap / contradiction / failure /<br/>transfer / constraint<br/>+ opt-in 桶：ablation / metric /<br/>assumption-challenge（仅经参数显式追加，总上限 8）"}}
    FAN --> B["bucket ×N（并行生成）<br/>每桶 LLM 产 1–3 张候选卡<br/>单桶失败 → 记录降级<br/>不阻断其余桶"]
    B --> DD["dedup（纯函数）<br/>键 = norm(标题, 机制, 最小实验)<br/>同键保留证据链最长者"]
    DD --> CH["challenge（顺序逐卡 LLM）<br/>只有使核心假设 / 可行性 / 可检验性<br/>不成立的具体反驳才 rejected<br/>（笼统的不确定性不是反驳）"]
    CH -->|"反驳成立"| OUT["淘汰池<br/>理由全量进 summary"]
    CH -->|"survived"| VA["validate（确定性规则全集）<br/>14 必填 / 泛化锚黑名单 /<br/>痛点具体度 / wiki 源锚须回写承诺<br/>（validate_idea_cards 全规则 TS 化）"]
    VA -->|"规则不过"| OUT
    VA -->|"通过"| P["persist<br/>幸存卡整批渲染 → 逐页写 wiki<br/>（幂等哨兵，重跑可续）"]
    P --> SM["summary<br/>候选 → 合并 → 幸存计数链<br/>+ 桶失败记录 + 全部淘汰原因（不静默）"]
    SM --> ZERO(["零幸存 = 不写 wiki<br/>回复全部淘汰原因"])
    OUT --> SM
```

- 产物：`idea-cards/<kebab-case 标题>.md` 假说卡页（15 字段 + `type: hypothesis` 机读标签 +
  一句假说进 Atomic Claims），逐页写入、幂等可续。
- **对抗筛选**：候选卡先经机制去重（dedup 纯函数），再逐卡对抗反驳（challenge）——只有具体
  致命反驳才淘汰；幸存卡再过确定性规则校验（validate），规则与校验同源自 `validate_idea_cards`
  全量迁移。
- **证据不足不动笔**：Context Pack 在 16k token 预算内裁剪后若零证据条目，直接 clarify 反问
  补充材料，不生成泛化 idea。
- **失败可观测**：单桶生成失败只降级不阻断，失败记录与全部淘汰原因完整进 summary。

### W4 `/experiment` 实验自主设计与执行（三调用两段式 + 方案人审）

```mermaid
flowchart TD
    S(["NL 自然语言（实验意图 + critic 页 / idea card 页）<br/>/experiment 命令直达不可挂起<br/>→ 引导 NL 路径（无条件人审不破）"]) --> RI["resolveInputs<br/>critics/ 或 idea-cards/ 前缀白名单<br/>+ 存在性回查 + 实验意图必填"]
    RI -->|"输入页缺失 / 形态不符 / 意图缺失"| CL1["clarify 出口<br/>列缺失清单（先 /discover 或 /hypothesize）"]
    RI --> PF["preflight（材料清单）<br/>critic 页提取 §4 候选问题 / idea card 提取 minimum_experiment<br/>→ 映射池（双输入 = 并集池）"]
    PF --> PE{"planEntry<br/>spec 已落盘？"}
    PE -->|"已落盘（非修订轮）<br/>resume 重放短路：零 LLM 重调"| SM["summary<br/>spec 路径 + awaiting_review"]
    PE -->|"首次 / 修订轮"| DS["design（LLM · 重试三源 K≤2）<br/>10 节 + 实验↔验证目标映射<br/>修订模式 = 上轮 spec + 用户理由"]
    DS --> V1["validate¹（确定性 · 映射校验泛化）<br/>每实验至少映射候选池一条<br/>不过 → 回 design 重试附诊断"]
    V1 --> SP["spec（LLM · 重试三源 K≤2）<br/>9 段「沙箱执行规格」+ 交付物声明结构化面<br/>（文件路径清单 + 每件成功判据）"]
    SP --> V2["validate²（确定性 · 占位符未填充检查）<br/>可推断占位符（论文 Wiki 标识）出现即拒<br/>不过 → 回 spec 重试"]
    V2 --> AU["audit（①②④ 确定性 + ③⑤⑥ LLM）<br/>必须修复项非空 → 该调用 fail（不进人审）"]
    AU --> PS["persist（lab 落盘 · 幂等短路点）<br/>/lab/specs/&lt;slug&gt;/r&lt;N&gt;/（round 键控）<br/>design.md + spec.md + audit.md + deliverables.json"]
    PS --> SM

    SM -->|"工具内 interrupt 挂起<br/>stage 停 plan-review + 审批卡"| GATE{"人审闸门（无条件门禁<br/>与 approvalMode 无关）<br/>第 N/3 轮"}
    GATE -->|"approve（可选附言）<br/>审计行 allow（tool_approval_logs）<br/>spec 短路保证重放零 LLM"| EX["调用② 执行段（非图 · 主 agent）<br/>按规格沙箱执行：exec 漏斗逐命令<br/>长命令 nohup 后台 + 轮询哨兵（120s 全局）<br/>方案批「做什么」不豁免漏斗审「怎么做」"]
    GATE -->|"deny（必填理由 ≤2000）<br/>审计行 deny + round 关联"| DS
    GATE -->|"第 3 轮 deny"| EXH["plan_review_exhausted 终局<br/>run completed 非 failed<br/>spec 停留 lab + lastReason"]
    EX -->|"执行完成 · phase=collect"| CO["collect（确定性对账）<br/>读回 spec + 旁车交付物声明<br/>逐件 lab.read 存在性对账（缺件进 summary）"]
    CO --> SU["summarize（LLM）<br/>实验报告页（对账 + 结果 + 结论）"]
    SU --> VA2["validate（形状档）"]
    VA2 --> PP["persist<br/>experiment-reports/&lt;slug&gt;-&lt;round&gt;.md 落 wiki<br/>related_pages = 输入页集 + 「关联页面」节<br/>= #789 graph 派生边（WikiGraph 可见）"]
    PP --> SM2["summary<br/>报告页路径 + 对账结果（缺件不静默）"]
```

- **三调用两段式**：调用①（图）产出方案落 lab 并必停等人审；调用②（非图）= 主 agent 按规格在
  沙箱真实执行——逐命令照常过审批漏斗，层级正交（方案审「做什么」，漏斗审「怎么做」）；
  调用③（`phase='collect'` 图）按交付物声明确定性对账、产出实验报告页落 wiki。
- **无条件人审**：方案必停审批卡（`experiment-plan` 源，`plan{title, summary, text, round}`
  内联载荷）；approve 附言随结果传达主 agent 作执行注意事项；deny 必填理由 → 回 design
  修订模式（零新图节点）；3 轮未通过 = `plan_review_exhausted` 结构化终局（非错误）。
- **幂等短路点**：spec 落盘 `/lab/specs/<slug>/r<N>/`（round 键控——每轮产物互不覆盖，重放读回用户当轮所审原文）后，interrupt 的 resume 重放跳 design/spec/audit 全部 LLM 直达挂审点；修订历史 = LangGraph resume 队列（零额外持久化）+ 历史轮审计跳过——「3 轮修订 = 3 行 round 关联」在多轮重放不破；审批审计落 `tool_approval_logs`（`toolName='experiment_plan'`，引用快照 `{planTitle, planHash, planRef, round}` 不存全文，3 轮 = 3 行 round 关联）。
- **产物**：spec/design/audit 中间产物落 lab；实验报告页 `experiment-reports/<slug>-<round>.md` 落 wiki
  （round 键控——每轮人审各得其报告页；`type: report` + frontmatter `related_pages` + 正文「关联页面」相对链接）。

## 产物与进度

> **当前版本说明**：W1（ingest）、W2（discover）、W3（hypothesize）与 W4（experiment）
> 节点链均已全链可用（见上方流程详情）；下述人审能力已生效（方案审批卡面 #920/#913）。

- 发现、假说与实验报告落 **wiki**（页面 + Atomic Claims 溯源块），中间产物落 **lab**；
  页面带 frontmatter 溯源（来源插件 / 工具调用 / 流程名 / 生成时间 / 180 天陈旧标记）。
- 流程进度以裸节点名经 `research_run.progress` SSE 事件实时上报，前端按流程 + 阶段双段
  徽标呈现。
- 实验流程（experiment）在设计方案产出后设有**方案人审门禁**：方案以审批卡呈现，你批准后
  才进入沙箱执行段；拒绝须附理由（必填，≤2000 字）进入修订（上限 3 轮）。

## 配置

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `RESEARCH_MODEL` | 否 | 意图分类与流程节点的 LLM 模型 id（面板级 pin；缺省跟随 owner 默认链 primary）。 |

其余阈值（意图置信阈值 0.60、生成重试、扇出上限等）为代码常量，随版本发布走，不做配置面。

## 开发者注

- 规格：`docs/research/853-research-workflows-plugin.md`（#906 修订版）
- 实施拆分：#873（本 README 随 [#873·3] 骨架票落档；四流程详图各随实现票补齐）
- 意图分类评估锚点：throwaway 分支 `research/intent-classifier-eval`（40 条 bad case ×
  3 轮实测，复跑需 `LLM_API_KEY`）

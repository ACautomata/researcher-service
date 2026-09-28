# ADR 0015：审批全量审计入 tool_approval_logs——supersede ADR 0014 不留痕

## 状态

已接受。经 wayfinder 票 [#729](https://github.com/ACautomata/researcher-service/issues/729) grilling 会话两轮定稿（2026-09-28），规格见 [docs/research/729-approval-funnel.md](../research/729-approval-funnel.md)。**supersede [ADR 0014](./0014-resolved-approval-no-trace.md) 的「resolved/expired 审批卡终态不留痕」裁决**——0014 的 dock 渲染路径与状态机设计属 OpenClaw 栈，随 legacy 容器退役，不在本 ADR 范围。

## 背景

ADR 0014（2026-08-12）裁决 resolved/expired 审批卡不留任何痕，其理由有两层：用户对官方页面「直接消失」体感的偏好（渲染层），以及**网关无权威存储、审批落定后审计不可得**（存储层）——后者是决定性妥协：当时的架构里控制面对审批回路只做 WS 帧透传（ADR 0006 隧道），落定的 decision 只存在于网关内部，控制面无从记录。

根架构决策 [#722](https://github.com/ACautomata/researcher-service/issues/722)（2026-09-28）改写前提：新 runtime 集中式，控制面成为 chat WS 提供者、审批回路的**唯一权威**。审计不可得的前提消失——「不留痕」从必要妥协变成纯损失：judge 的每个 approve/reject 及理由是安全水位的核心证据，也是成本核算（token、延迟）与政策迭代（误判分析）的唯一数据源。

## 决定

1. **三层审批全量落审计表 `tool_approval_logs`**（新表，traceLogs 域）：规则层判定（白名单命中行最瘦）+ judge 判定（含 policy_class、理由、输入快照 hash、延迟、token 成本）+ 人工落定（含理由）。审计快照跟 user 永久（#727 接缝），不随容器删除。
2. **不扩展 `text_trace_logs`**：该表语义是「生成内容溯源」（inputText/outputText 全文），与「工具调用判定轨迹」是两个领域，混表污染两个查询面。
3. **ADR 0014 的「终态不留痕」supersede**：新 runtime 的升级卡落定即入审计表；卡片落定即撤的**渲染交互**延续（用户体感偏好不因审计存在而改变——审计在表里，不在时间线上）。
4. **同步写**：判定落定后同步写 Prisma（SQLite）。审批是安全路径，审计不能丢；队列异步化在单进程模型下没有解耦收益，反而多一条丢消息的缝。

## 为什么

- **前提改写即结论改写**：0014 的存储层理由（无权威存储）被集中式根决策消除，裁决失去依据；渲染层理由（用户偏好直接消失）被保留并显式拆分——「不留痕」从来是两个决定捆在一起，现在它们解绑。
- **审计是 judge 的必需配套**：列拒政策（#729 §2.4）的安全承诺依赖事后可审计；没有审计，judge 的误判率无法度量、政策无法迭代，「默认 approve 倾向」失去兜底。
- **成本核算依赖全量**：judge 每次调用的 token 成本是 per-run 20 次护栏（#729 §2.5）的校准依据，抽样记不够。

## 考虑过但否决的方案

- **扩展 text_trace_logs 加 JSON 侧车列**：一表多用，生成溯源与审批审计的查询模式（全文检索 vs 按 traceId/runId 轨迹）互相干扰；现有表名「TextTrace」对外的产品语义（生成内容溯源）也被稀释——否决，新表同域管理。
- **队列异步写审计**：解耦收益为零（单进程），引入「进程崩在判定后写入前」的审计空洞；审批安全路径不允许丢审计——否决。
- **前端本地留痕（渲染时间线轻记录）**：恢复 ADR 0014 刚退役的路径，且前端不是权威——否决。
- **只记 judge/人工、不记规则层白名单命中**：省存储但破坏「全量」承诺——白名单直接放行零成本正是要靠审计证明它没出格（灰区占比、误放分析都需要基线）——否决，全量记、命中行做瘦。

## 后果

- **新表**：`tool_approval_logs`（schema 见 729 规格 §4.1），随新 runtime 实施创建；现有 OpenClaw 栈的审批不迁移（老容器冻结只读 + 退役，#722）。
- **ADR 0014 标注 superseded**：其 dock/状态机/seq 设计继续适用于 OpenClaw 栈至退役；新 runtime 的 ApprovalCard 复用面由 729 规格 §3.4 定义（UI 骨架复用、decision 砍 allow-always、数据源换控制面 WS）。
- **终端用户可见**：judge 判定理由对用户可见（透明性），admin 见全量成本列——管理面 UI 属实施工作。
- **关联**：judge prompt 初稿（729 附录 A）PoC 实测后调优；工具名映射表待 #737 回填。

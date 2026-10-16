# 987 · A1·research：历史会话语料画像审计

Part of wayfinder 地图 #986。问题：历史会话语料的真实画像是什么，切分与索引要以什么事实为基础？

## 考察来源与方法

- **数据源**：`panel-dev_panel-dev-db` Docker named volume（宿主机**无** `server/prisma/panel.db`——dev/prod SQLite 均落 named volume，容器内 `DATABASE_URL=file:/app/db/db.sqlite3`，见 `deploy/docker-compose.dev.yml:50`）。经 alpine 容器 `:ro` 挂载拷贝至 /tmp 后以 `sqlite3 file:...?mode=ro` 查询，`PRAGMA integrity_check` = ok，源 volume 零写入。
- **快照**：2026-10-14（volume mtime）。语料性质 = walkthrough/验收数据（用户 t7-manual-check / walk960 / walk961 / walkthrough-user）。
- **代码引用**：worktree HEAD `1960702`（master）。表结构以 `server/prisma/schema.prisma` @@map 后表名为准。
- **明确局限**：样本极小（7 会话 / 23 消息行 / 152 checkpoint 行）。分布数字仅示意；**结构语义结论可靠，分布外推不可靠**。生产语料画像需在部署环境重跑（见「缺口」节）。

## 1. 规模画像

会话计数（`sessions`，软删 `archivedAt`、`isTeammate` 拆分）：

| 总数 | 用户·活跃 | 用户·归档 | teammate·活跃 | teammate·归档 |
|---|---|---|---|---|
| 7 | 5 | 0 | 2 | 0 |

消息行（`session_messages` JOIN `sessions`）：

| role | 行数 | content 平均/最大长度 | 归档行 |
|---|---|---|---|
| assistant | 13 | 660.2 / 2986 | 0 |
| user | 10 | 107.6 / 284 | 0 |
| system | 0 | — | — |
| tool | 0 | — | — |

- **role 实证集合只有 user|assistant**。`system` 唯一写点 = fork 源沙箱缺失时插 1 行提示（`server/src/sessions/service.ts:1220`）；`tool` 角色从不落库（tool 结果进 assistant 行 `attachmentsJson.tools`）。
- 单会话消息行数（用户会话）：[1, 4, 5, 5, 6] → P50=5、P95=6（n=5，仅示意）。
- assistant content 长度（n=13）：P50=256、max=2986；user content（n=10）：P50=97、max=284。
- `attachmentsJson`：user 行恒为空壳 `{"v":1}`（7B）；assistant 行 12/13 非空，长度 P50=2359、max=11101。字段出现率：thinking 0/13（语料未开推理强度）、tools 12/13、files 3/13。
- 投影总字节（content+attachmentsJson 全表）≈ 55KB。
- **截断规格**（`server/src/sessions/reducer.ts:101-104`）：tools[].input ≤ 1024B、details ≤ 4096B（`server/src/runner/runtime/values.ts:5,8`）——投影行的工具细节是**有损聚合**。

## 2. 轮次配对语义（本票核心事实）

**turn 是每消息单调序号，不是问答对号**。`insertWithNextTurn`（`server/src/sessions/service.ts:255-276`）在事务内 `max(turn)+1`，user 行与 assistant 行各占一个 turn。投影读序 = `(turn asc, createdAt asc)` 且过滤 `archivedAt IS NULL`（`service.ts:674-677`）。

语料实证的四种形态（任何「相邻 user/assistant 配对」假设都不成立）：

1. **连续多 user 先于 assistant**（ju0oqz：turn 1,2,3 user → 4,5,6 assistant）——排队连发。
2. **1 user → 多 assistant**（sw7mp2：1 user / 4 assistant）——#787 命令行重放每条命令一个 run 终态行。
3. **孤儿 user**（nq3rf5 3u/2a；b8ztlw 1u/0a——run 未达终态即死，无 assistant 行）。
4. 正确配对单位是 **run**：`recordTurn` 每 run 终态落恰一行 assistant（`runService.ts:1334-1345`，status 映射 completed→success、其余终态→failed）；触发问 = run 终态时刻「最新未归档 user 行」（`recordTextTraceForTurn` 的 trigger 查询，`service.ts:772-776`）。

**system 行与 teammate 会话**：

- system：语料 0 行、代码单写点，入索引价值低，建议纳入但不作专门处理。
- teammate 会话（`isTeammate=1`）：`session_messages` **只有 assistant 行**（语料 2 会话均 0 user 行；trace 的 inputText='' 实证）。真实问答在 `teammate_mailbox_messages`（leader↔teammate 邮件语义）。产品面顶层列表过滤 `isTeammate: false`（`service.ts:349`）——索引范围建议与产品面一致：默认排除，若收录须走 mailbox 语义而非 session_messages 配对。

**行会物理删（推翻 schema 注释）**：`deleteRunResidues`（`server/src/runner/runtime/runService.ts:2170-2179`）在 recover 全量落行前**物理删除** `role='assistant' AND turn > 最近 user 行 turn` 的行。schema.prisma:327「本表行永不物理删」注释已失真。后果：投影行可少于实际 run 数（sw7mp2 实测 4 行 / 8 run——4 个失败轮的行被后续 recover 清掉），而 `text_trace_logs` 行不随之删（8 行 trace 仍在）。

## 3. 标题质量抽样

生成机制：title 仍空 → 首条 user 行 `slice(0, 30)`（`TITLE_AUTO_MAX=30`，`server/src/sessions/values.ts:14`；`autoTitle`，`service.ts:805-820`，首消息接受时触发、幂等）；用户改名 ≤ `TITLE_MAX=200`（`service.ts:375`）。

样本（n=7）：

| 形态 | 数量 | 例 |
|---|---|---|
| 自动截断（恰 30 字符、句中截断） | 2 | 「请在沙箱里依次完成三步：1) 新建文件 /lab/walkt」「请把以下实验结论整理进我的知识库 wiki：相对位置编码（R」 |
| 用户/流程自设短名 | 5 | 「walk-960」「961 exec 提示行走查」「rope-8k-wiki-update」 |
| 空串（未命名） | 0 | — |

**结论：标题可作会话级召回的 boost 通道，不可作唯一召回键**。自动标题 = 首问前缀（首问≠会话主题）且句中截断破坏词形；自设短名质量高但存在率不可依赖（本样本 5/7 已属 walkthrough 偏置）。

## 4. checkpoints 兜底源评估

- blob = LangGraph Checkpoint v4 **纯 JSON**（全表 152 行 type 均为 `'json'`；`serde.loadsTyped` 对 json 型即 `JSON.parse`，语料无 msgpack）。`channel_values.messages` = 累计全量 LangChain 消息（lc constructor 形态：HumanMessage/AIMessage/ToolMessage）。
- 实测最大 blob 232KB（thread ju0oqz）：30 条消息（3 Human + 10 AI + 17 Tool），content 合计 12.5k 字符；同会话投影仅 6 行 16.8KB。**ToolMessage 与中间 AI 轮在投影中被聚合截断（1KB/4KB），在 checkpoint 中未截断**——这就是「未截断轨迹」兜底价值。
- 每 thread 体积：max 1249KB（qjqa2c）、次 1108KB（ju0oqz），合计 ~4.1MB。对 100MB/thread 配额余量 ≥80×。
- **驱逐影响面**（`server/src/runner/persistence/prismaCheckpointSaver.ts:258-358`）：put 写时护栏，未归档总量 >100MB 才触发，硬删最老**非活跃**分支（blob+同行 writes）；活性 = `activeCheckpointId` 祖先链 ∪ 后代闭包；活跃链自身超限 → no-op（可恢复性优先）。**结论：活跃链最新 checkpoint 恒有全量轨迹**（LangGraph 每 superstep 全量快照语义，语料链深 31-33 ck/会话 ≈ 每 assistant 轮 6-11 ck）；只有被 rewind 放弃的分支可能被逐（本就软删归档，产品面不可见）。
- **成本**：单次 `JSON.parse` 一个 ≤MB 级 blob 毫秒级；回填按 thread 取**最新** checkpoint 反序列化一次即可，无需逐 ck 回放。

## 5. text_trace_logs 扁平文本对复核

**三写点语义混居**，不能整表当问答对：

| 写点 | traceId 形态 | 语料行数 | 语义 |
|---|---|---|---|
| run 终迹（`service.ts:760-798`） | = runId（cuid） | 13 | 问答对：inputText=最新未归档 user 行、outputText=聚合 content，均 20k 截断（`TRACE_TEXT_MAX`，`server/src/traceLogs/service.ts:7`） |
| teammate 邮件审计（`server/src/runner/teammates/service.ts:207`） | `teammate-mail:<mailId>` | 5 | 通信审计（4 timeout + 1 message），非问答 |
| file-journal 审计（`server/src/runner/filejournal/audit.ts:46`） | `file-journal:...` | 0 | rewind/回收审计 |

- **只有 `runId` 非空的行才是问答对**（语料 13 行 = assistant 行数 1:1 ✓）。
- teammate thread 的 run 行 `inputText=''`（无 user 行，实证 in_len=0）。
- 行内**无 turn 列**；sessionId 在 `sessionKey` 且**无索引**（索引仅 userId/ipAddress/createdAt/status，schema.prisma:104-107）。
- run 行与投影行语义重复但为**截断副本**（≤20k vs 无截断 content 列）；对索引而言是劣化数据源。
- 独有价值：a) 审计完备性高于投影——失败 run 的投影行可能被 `deleteRunResidues` 清掉而 trace 不删（sw7mp2 实证 8 trace/4 行）；b) `outputHash`（sha256）可作去重锚。13 run 行中 3 行 status=failed。

## 结论：切分/索引/回填的选项对比与推荐位

| 选项 | 优点 | 缺点 | 判定 |
|---|---|---|---|
| A. 直接索引 session_messages 行（user 行+assistant content 为 chunk） | 零回填；turn 即切片序；ownerId 隔离经 JOIN `sessions` | 工具细节已被 1KB/4KB 截断；超长 run 聚合行需再切；孤儿 user 行需 unanswered 标记 | **采纳为主索引面** |
| B. checkpoint 反序列化重建全量轨迹再索引 | ToolMessage/中间轮未截断；活跃链最新 ck 恒完整 | 依赖 LangGraph serde；重建出的是**机制真相**而非产品真相（recover 清理过的中间轮已物理删，重放不出当时投影）；配对仍要重做 | 只作按需兜底 |
| C. text_trace_logs 作主源 | 扁平、有 userId 列 | 20k 截断、无 turn、sessionKey 无索引、三写点混居需过滤 | 降级为补洞源 |

**推荐位（= A 为主、C 补洞、B 兜底的混合）**：

1. **主索引面**：`session_messages`（未归档行）——user 行与 assistant content 各自成 chunk（当前分布下 chunk 尺寸友好：P50 数百字符、max ~3k），`attachmentsJson` 作元数据面（tools/files 计数、thinking 有无），不入正文字段（截断噪声）。
2. **隔离**：一律 JOIN `sessions.ownerId`（`session_messages` 无 ownerId 列；`sessions.ownerId` 已有索引）。teammate 会话默认排除（与产品列表口径一致，`isTeammate=false AND archivedAt IS NULL`）。
3. **配对规则**（按 §2 实证语义）：以 run 终态 assistant 行为锚，向前取最近 user 行为触发问；中间多 user 连发各自作候选或并入该 run 上下文（索引期可两种都做，标记区分）；无 assistant 跟随的 user 行单独入索引并标 unanswered。
4. **补洞**：`text_trace_logs` 中 `runId IS NOT NULL AND status='failed'` 的 run，若投影无对应 assistant 行（被 residues 清理），用 trace 行作低权片段（标注 truncated≤20k）。
5. **兜底**：单 thread 深查场景按需取该 thread 最新 checkpoint JSON 反序列化拿未截断 ToolMessage——不建议批量回填（成本高且重建的是机制真相）。
6. **会话级召回**：`sessions.title` 作 boost 字段（≤200 字符，值域健康），不作唯一键。

**规模结论**：当前 dev 语料（23 行/55KB）秒级全量回填；(sessionId, turn) 已有复合索引（schema.prisma:366）足够支撑按会话增量索引；上生产规模前无需额外表结构变更。

## 缺口（非本票可解）

- 20k 截断规格对 >20k assistant 轮的行为：当前语料 max 2986 字符，无法实证（规格上限距实测 max 差 ~7×）。
- teammate mailbox 问答是否入索引：产品语义决策，非数据问题。
- 生产语料画像：本审计对象为 dev walkthrough 语料，分布数字不可外推；结构语义结论（turn 语义、物理删路径、三写点混居、驱逐语义）与数据无关，可直接复用。

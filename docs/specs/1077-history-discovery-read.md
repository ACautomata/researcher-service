# #1077 历史会话发现与证据读取验收记录

## 已确认事项

- 用户明确启动 implement 技能实施 [#1077](https://github.com/ACautomata/researcher-service/issues/1077)，授权代理选择实施接缝与任务拆分。
- 范围为 RF-T01：历史目录发现、产品区域搜索、单目标证据读取、稳定引用、权限及异常区分；兼容多 targets 输入，不提前实施完整分页及恢复额度。
- 测试接缝沿用票内决议：真实临时 SQLite + 公共业务口、真实只读适配器、ScriptedChatModel + RunService/LangGraph 装配；既有会话投影与中性导出回归。
- 生产组合根不注入历史能力。两个新工具须等待 RF-T12 完整发布门禁，本票没有部署或开放生产工具。

## 实现边界

`sessions/history` 承担业务规则，`SqliteHistoryReader` 是外层只读适配器；runner 只转换工具输入、绑定可信上下文及接图。共享 `sessions/productMessage.ts` 解析保存聚合，页面恢复保持原字段，neutralExport 保持原格式。

- 严格输入为 `search` / `read`。`query` 形状为 `{text, mode?: 'literal'|'regex'}`，默认字面；搜索区域为 `user_content/assistant_content/tool_name/tool_input/tool_result/thinking`，thinking 需显式选入。
- ID、标题、时间、query 取交集。时间使用带时区的明确值及 `[from,to)`；read targets 使用 `session_id` 和可选 `range:{from_turn?,to_turn?}`，消息编号两端包含。
- 每条证据包含 `session_id/message_id/turn/role/created_at`；工具沿用已有 `toolCallId/name`，缺失字段标记位置，保留可靠产品片段，不补造标识。
- 搜索节选携带 UTF-16 偏移和头尾省略标记；`source_truncated` 另行表示保存时截断。附件及文件只交付产品引用，不下载字节。
- 可信身份仅来自运行上下文，数据库复核调用者及当前会话。只读本人、非当前、正常列表可见、非 teammate、未归档主线程；admin 同样不能跨用户。
- `RunServiceDeps.history` 是内部验证接缝；默认未注入。Leader 的工具与指引独立装配，普通 teammate、wiki-update 和 general-purpose 子助手排除该能力，执行入口另行检查角色。
- 保留名登记覆盖所有插件目录校验；历史调用绕过审批漏斗，精简访问事件不含查询正文、证据正文或书签。

## 验收映射

| 测试 | 本票覆盖 |
|---|---|
| `sessionsHistoryParams` | C1/C5/C6/C9/C11/C13/C14、P1、M2、G10：严格字段与嵌套结构、非法日期、正则拒绝、身份/SQL/shell/路径注入字段拒绝 |
| `sessionsHistoryService` | C1–C6/C10/C12、P1–P10/P14–P19、M1–M6：真实 SQLite 权限与读取、逐区域匹配、稳定引用、损坏片段、节选和源截断、脱敏与日志故障、只读连接误写拒绝及释放 |
| `runnerHistoryAssembly` | G1–G5、P13：真实 Leader 发现/读取脚本、保留名冲突、免审批、三个子助手角色排除、生产缺省关闭 |
| 既有 `sessionsApi` / `neutralExport` / `sessionsReducer` | 共享解析外部契约回归，原测试不改动 |

P9 在本票验证每次初始读取重新授权；P10 验证未知书签同形拒绝。有效书签续读与跨页失权验收由 RF-T02 补全。P13 的脚本证明历史内容经工具作为数据回喂、没有自动执行副作用；真实模型的指令注入抵抗评测仍属于最终门禁。表中编号表示本切片覆盖部分，不替代完整矩阵集合核对。

## 后续接续与发布门禁

- RF-T02：有效书签、分页和长消息连续分段、冻结候选与历史版本事务、局部失效、完整 regex/扫描边界矩阵。
- RF-T03：独立 Worker/进程及原生查询硬终止、在飞取消、共享并发与状态容量、持久主请求额度及恢复、正式日志装配。
- 当前适配器每次打开真实 SQLite 只读连接并在事务内读取；尚无硬终止执行器。达到扫描或响应上限返回 `stopped` 和缩小范围指引，不伪造完整结果或有效续读书签。预先取消会拒绝执行，不声称同步扫描可在飞取消。
- RF-T12：完整 C/O/P/B/M/G 集合、真实模型及容器化人工冒烟、正式生产装配。以上未完成项均属已确认后续票，无新增待确认产品事项。

## 验证结果

- `npm run typecheck`、`npm run build`：通过。
- 历史参数/业务口/图装配，以及 sessionsApi、neutralExport、sessionsReducer、approvalFunnel、pluginsRegistry：最终复跑8文件、190测试通过。
- `npm test` 全量运行过一次：172 文件通过，9 文件失败。5 个 Docker smoke suite 因 `/var/run/docker.sock` 不存在失败；退役术语扫描 扫入既有 `.scratch` 等工作区文件；两处 REST 用例在该轮失败；本次 wiki-update 夹具缺树也在该轮失败，已补齐并聚焦通过。
- 两处 REST 用例（models、chaoxingCommands）在原始 HEAD 的临时归档副本及当前工作区分别复跑：均为36测试通过。全量该轮仍保留失败记录，尚不能确认具体偶发原因。
- 未运行真模型评测或容器化人工冒烟，不声称完整历史合同或生产发布门禁通过。
- code-review 双轴审查：Standards 的重复范围类型建议、Spec 的 UTC 文本解析/混合格式排序及显式 search ID 顺序问题均已修复并复审关闭；当前两轴未解决发现均为0。新增真实 SQLite fixture 锁定 UTC 文本与 Prisma 毫秒时间同义、search 保持快照排序。

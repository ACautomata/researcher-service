# PoC #724 报告：agent 循环端到端最小闭环

> Throwaway PoC（`/prototype` 口径）。代码在 `server/prototype/poc724/`，分支 `prototype/724-agent-loop-poc`。
> 运行方式见 `README.md`；数据落在 scratch DB `server/prisma/poc724.db`（`PocRun` / `PocCheckpoint` / `PocWrite` 三张 throwaway 表）。

## 结论速览

| 验收问题 | 答案 |
|---|---|
| 1. docker exec 调用延迟实测，几十上百次累积是否可接受 | **可接受**。execute 单次 mean 47.7ms / p95 70.6ms / max 73.4ms（n=32）；getArchive mean 20.6ms（n=45）。全程 docker 原语合计 **2.5s**，而 LLM 合计 **83.0s**、S1 wall **81.1s** —— docker 通道只占 wall 的 **~3%**，瓶颈在 LLM。即使调用次数 ×10，累积也只在秒级。 |
| 2. deepagentsjs / LangGraph JS 基座是否胜任 | **胜任，但有三个必须知道的坑**（详见下）。`BackendProtocolV2` 自定义 filesystem backend 适配容器树 ✅；`interruptOn` HITL ✅；checkpoint 可落 Prisma ✅。 |
| 3. 断线恢复的 checkpoint / replay 形态 | **LangGraph checkpoint 落库（PrismaSaver）是唯一事实源**，形态验证成功：interrupt → 人为断 WS → 重连 resume 跑完 ✅；独立进程跨进程 replay 续聊 ✅（新进程直接 `getTuple` 读回 85 条消息，0 次工具调用纯凭会话历史答出确定性答案）。 |

三个场景断言全部 PASS（第四轮全绿运行：S1 报告写成 + exec≥20 + 总工具≥25；S2 断线恢复后跑完 + report2.md 写成；S3 答出种子行数最大文件 `notes-03/file-03.md`）。

## 实测数字（第四轮全绿运行）

模型 `claude-haiku-4-5-20251001`（经面板网关；观测到网关把该模型映射到后端 `kimi-for-coding` provider）。

### 延迟分解（场景1+2 合并采样）

| 通道 | 操作 | n | total | mean | p95 | max |
|---|---|---|---|---|---|---|
| LLM | chat | 21 | **82,998ms** | 3,952ms | 8,169ms | 10,276ms |
| docker exec | execute（busybox `/bin/sh -c`） | 32 | 1,526ms | 47.7ms | 70.6ms | 73.4ms |
| docker archive | getArchive（读文件/目录） | 45 | 927ms | 20.6ms | 32.2ms | 34.2ms |
| docker exec | mkdir -p | 2 | 72ms | 36.2ms | — | — |
| docker archive | putArchive（写文件） | 2 | 5ms | 2.3ms | — | — |

**docker 原语合计 2,529ms / LLM 合计 82,998ms ≈ 3%。**

### 场景汇总

| 场景 | wall | 工具调用 | checkpoint 行 | checkpoint 体积 |
|---|---|---|---|---|
| S1 延迟实测（30 文件审计任务，glob→逐文件 read_file→逐文件 `wc -l` 复核→write_file 报告） | 81,104ms | 68 | 35 | 8.5 MiB |
| S2 interrupt→断线→resume（HITL 批式 wc 被打断，重连 approve 后续跑） | resume 段 12,304ms | 11 | 18 | 0.6 MiB |
| S3 跨进程 replay（新进程 followup 提问，凭会话历史直答） | 1,953ms（LLM 仅 1 次 957ms，0 工具调用） | 0 | 线程累计 40 | 9.3 MiB |

S1 模型产出真实审计表（`/wiki/report.md`：30 行 `路径 | read_file 行数 | wc 行数 | TODO 数` + 总计行），并自主发现 `read_file` 与 `wc -l` 的末行换行差异 —— 工具链路语义正确。

## Q2 详情：基座胜任度与三个坑

**胜任的部分**

- `createDeepAgent({model, backend, checkpointer, interruptOn})` 三个扩展点全部按文档接线，无 hack。
- `BackendProtocolV2`（ls/read/write/edit/delete/glob/grep）由 `DockerArchiveBackend` 实现：读走 `getArchive`+tar 解析，写走 `putArchive`（复用 `src/files/tar.ts`），`execute` 走 exec+stream demux —— 与生产 files 域（ADR 0012）同一套原语。
- `interruptOn: {execute: {allowedDecisions: ['approve','reject'], when}}` 精确在工具执行前挂起，payload 含完整 actionRequests，resume 用 `Command({resume:{decisions:[{type:'approve'}]}})` 放行。

**坑 1 —— `streamEvents` 产出的是 protocol events，不是经典 on_\* 事件。** langchain 1.5 ReactAgent 的 `streamEvents(state, config)` 第二个参数要同时装 `{version:'v3', configurable:{thread_id}, recursionLimit}`；事件为 `{method: messages|tools|checkpoints|updates|values, params:{data:{event:...}}}` 形态，文本流在 `content-block-delta` 的 `text-delta` 里。签名传错会静默丢 config（曾导致 `put` 无 thread_id）。

**坑 2 —— resume 时重建的 agent 必须与原图同拓扑，否则静默空转。** 第二轮 bug：resume 重建 agent 没带 `interruptOn`，HITL middleware 节点在新图里不存在，graph no-op —— 12ms 假 done、任务没跑、无任何报错。修法：服务端按线程记住 interrupt 配置，resume 用同拓扑重建。**这是生产实现的硬约束：图拓扑必须可由持久化状态推导，不能依赖运行期内存对象。**

**坑 3 —— 散点摩擦（单点都不难，凑起来有一天）。** `WRITES_IDX_MAP` 只从 `@langchain/langgraph-checkpoint` 导出（不从 `-langgraph`）；自定义 Saver 的 `getTuple` 在无 thread_id 时要返回 undefined（对齐 MemorySaver，deepagents 中间件会这样调）；`ChatAnthropic` 构造强制查 apiKey，走网关时要用 `createClient` 注入 `authToken/baseURL`；`JSON.stringify(undefined)` 返回 undefined 要兜底。

## Q3 详情：checkpoint / replay 形态

- **形态**：LangGraph JS 原生 checkpoint 序列化（`JsonPlusSerializer` 的 typed JSON blob）原样落 Prisma：`PocCheckpoint(threadId, checkpointNs, checkpointId, parentId, blob, metadata)` + `PocWrite(threadId, checkpointNs, checkpointId, taskId, idx, channel, blob)`（pending writes，channel→idx 映射用 `WRITES_IDX_MAP`）。自定义 `PrismaCheckpointSaver` 实现 `BaseCheckpointSaver` 5 个抽象方法，语义对齐 MemorySaver。
- **S2 断线恢复**：WS 断开只是客户端没了 —— 服务侧 graph 早已停在 interrupt，checkpoint 已落库。重连发 resume 即 `getTuple` 取最新 checkpoint → 从 interrupt 节点继续。这就是生产形态：**断线恢复 = 重放 Command(resume)，不需要服务侧保活**。
- **S3 跨进程 replay**：phase3 是独立进程（新 Prisma client / 新 saver / 新 agent），直接 `getTuple` 读回 S1 完整状态（85 条消息、parent 链完整），followup 消息挂上后续跑。LLM 凭会话历史答出确定性种子答案（0 工具调用），证明 checkpoint 自包含、可跨进程恢复。
- **体积口径**：一个 68 工具调用 / 81s 的会话 ≈ 35 个 checkpoint / 8.5 MiB。粗算 checkpoint 膨胀率 ~100 KiB/工具调用（blob 含完整消息数组快照，LangGraph 默认行为）。长会话需要后续 ticket 评估压缩策略（truncate/token 计数），不在本票范围。

## 对全 map 工作量估计的校准口径

本票是 map #734 的最小闭环，实现量为：backend ~250 行、saver ~200 行、WS 运行时 ~200 行、场景编排 ~350 行，合计 **~1000 行 throwaway 代码 + 一次 schema 迁移**。按此推算全 map（多容器编排、HITL judge 漏斗、会话 UI、模型配置）**当前估计偏乐观 3–5 倍而非一个数量级**，主要不确定度在：HITL 产品形态（judge 漏斗 vs 逐工具审批）、长会话 checkpoint 体积治理、以及坑 2 类「静默 no-op」调试成本 —— 这类 bug 无报错、只有行为缺失，每张新图拓扑都要写断言防回归。

## 复现

```bash
cd server
colima start   # 或任何 docker daemon
npm run poc:724 -- setup   # 起 busybox 容器 + 灌种子树 + 建 scratch DB
npm run poc:724 -- s1s2     # 场景1+2（打印 POC_S1_THREAD）
POC_S1_THREAD=<上一步输出> npm run poc:724 -- phase3
npm run poc:724 -- down    # 清容器
```

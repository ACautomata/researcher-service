# PoC #724 · agent 循环端到端最小闭环（THROWAWAY · 分支 `prototype/724-agent-loop-poc`）

> 本目录是 wayfinder 票 **PoC：agent 循环端到端最小闭环**（#724）的一次性原型。
> 不进 master；验证结论见票 resolution comment 与本分支 `REPORT.md`。

## 回答的三个验收问题

1. **docker exec 工具调用延迟实测**——一个任务几十上百次调用，累积是否可接受？
2. **deepagentsjs / LangGraph JS 基座是否胜任**——filesystem backend 适配容器树、interrupt 可用性？
3. **断线恢复的 checkpoint / replay 形态**？

## 形态

```
run.ts            场景编排（组合根）+ ws 客户端（人为断线模拟）
dockerBackend.ts  DockerArchiveBackend implements deepagents BackendProtocolV2
                  ├─ execute      dockerode exec /bin/sh -c（busybox）
                  └─ ls/read/write/edit/delete/glob/grep
                                  getArchive/putArchive/exec rm（复用 src/files/tar.ts，ADR 0012 同款）
prismaSaver.ts    PrismaCheckpointSaver extends BaseCheckpointSaver（镜像 MemorySaver 语义）
agentRuntime.ts   createDeepAgent 三扩展点接线 + streamEvents v3 → WS 帧
latency.ts        延迟采样注册表（exec/archive/llm 逐调用）
```

PoC 表（`PocRun`/`PocCheckpoint`/`PocWrite`，仅本分支存在）：checkpoint blob 经 langgraph 默认
JsonPlusSerializer 落 SQLite；`poc_runs` 是 run 级汇总（延迟/工具数/checkpoint 体积）。

## 运行（server/ 目录下）

前置：`colima start`；`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`（SDK 原生读取）；
模型默认 `ANTHROPIC_DEFAULT_HAIKU_MODEL`，可用 `POC_MODEL` 覆盖。

```bash
npm run poc:724 -- setup     # busybox 容器（NetworkMode=none，对齐 #728）+ 灌 30 个 .md 种子 + 建 poc724.db
npm run poc:724 -- s1s2      # 场景1 延迟实测 + 场景2 interrupt→断线→resume
POC_S1_THREAD=<s1s2 打印值> npm run poc:724 -- phase3   # 独立进程跨进程 replay
npm run poc:724 -- all       # 一键全跑（setup + s1s2 + spawn phase3）
npm run poc:724 -- down      # 清理容器
```

scratch DB：`DATABASE_URL` 默认 `file:./prisma/poc724.db`（gitignore 已覆盖 `*.db`）。

## 场景

| 场景 | 内容 | 断言 |
|------|------|------|
| s1-latency | 全量行数审计（glob 30 文件 → 逐文件 read_file + execute wc -l 复核 → write_file 汇总），~60+ 工具调用 | report.md 写成；exec≥20；总工具≥25 |
| s2-interrupt | 小范围审计，首次 execute 触发 HITL interrupt → 客户端掐 WS（人为断线）→ 2s 后新连接 resume approve | interrupt 恰好一次；恢复后跑完；report2.md 写成 |
| s3-replay | **新进程**全新 Prisma client/saver/agent，读场景 1 的 checkpoint 续聊（行数最多的文件） | 答出种子确定性答案（`notes-0X/file-0Y.md`） |

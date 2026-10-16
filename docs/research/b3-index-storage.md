# B3·research：索引存储与稀疏检索载体选型——调研报告

> Wayfinder 地图 #986 子票 [#991](https://github.com/ACautomata/researcher-service/issues/991) 的调研产物（2026-10）。调研与结论由 research 子代理完成并回传；本文件由主会话按其回传全文代为落档（子代理清理临时 worktree 时未推送原始报告，内容以其两轮回传文本为准，两轮一致）。全部结论带一手来源。

## 1. sqlite-vec

- 成熟度：稳定版 0.1.9（2026-03-31），此后仅 0.1.10-alpha.4（2026-05-18）；README "pre-v1, expect breaking changes"；milestones 中 v1 与 DiskANN 均 open——**ANN 索引未兑现**。MIT/Apache-2.0。源：https://github.com/asg017/sqlite-vec ；https://registry.npmjs.org/sqlite-vec
- 检索：**纯 brute force**（knn/performance 文档自述）；vec0 支持 metadata 列（WHERE 仅 =/!=/比较符，≤16 列，IS NULL/LIKE 报错）、partition key（= 约束分片，官方建议每分区数百向量）、auxiliary 列（不可进 WHERE）；过滤为扫描时过滤非索引。源：https://github.com/asg017/sqlite-vec/blob/main/site/features/vec0.md
- Node 加载：`sqliteVec.load(db)` 官方兼容 better-sqlite3（https://alexgarcia.xyz/sqlite-vec/js.html）；npm 按 os/cpu 分包、无 musl/glibc 变体，实测 0.1.9 linux-x64 vec0.so 为 **glibc 动态链接（GLIBC_2.3.4+）**，alpine 需 release static-linux-* 构建或纯 C 自编译。
- 并发：WAL 读写不互阻塞但**单写者**（https://www.sqlite.org/wal.html §2.2）。

## 2. LanceDB

- @lancedb/lancedb 0.40.0（2026-10-07）周更、**仍 0.x**；node>=22；预编译含 **linux-gnu 与 linux-musl**（alpine 原生）。源：https://registry.npmjs.org/@lancedb/lancedb
- 存储：嵌入式库+本地磁盘目录；Lance 版本化列式表，表=目录+fragment 文件、非单文件；落 DATA_ROOT/lancedb/ 可行；备份≈停写拷目录。源：https://github.com/lancedb/lancedb/blob/main/docs/web/architecture.mdx
- FTS 内建 BM25（2023-05 PR #62 起，Tantivy→Lance-native）；**hybrid 内建、RRF 默认 reranker**；.where() SQL-ish 过滤；CJK：base_tokenizer="icu"/"jieba/default"（中文）/lindera（日韩）/ngram。源：docs/web/search/full-text-search.mdx、hybrid-search.mdx
- 写：mergeInsert 原生 upsert（三态匹配）；MVCC 版本化读。源：docs/web/ingestion/merge-insert.mdx

## 3. Qdrant

- 钉版 `qdrant/qdrant:v1.19.2`（2026-10-05），压缩镜像约 74MB。源：https://hub.docker.com/v2/repositories/qdrant/qdrant/tags
- sparse vectors 原生；BM25 via `qdrant/bm25`；**hybrid 服务端 RRF（v1.10+，v1.16 可调 k，v1.17 weighted）+ DBSF（v1.11+）**；full-text filter 自 v0.10（默认 word tokenizer 无 CJK）。源：https://qdrant.tech/documentation/concepts/hybrid-queries/
- @qdrant/js-client-rest 1.19.0（2026-08-04）。**与 SQLite 无跨库事务（确认）**；snapshot API（collection 级+整库 full snapshot）备份；RAM 按容量公式预算，可 memory tier/量化。源：https://github.com/qdrant/qdrant/blob/master/src/actix/api/snapshot_api.rs

## 4. Redis

- 确认 redis:7-alpine（7.4.x）**无**检索/向量能力；7.4–7.8 许可 RSALv2/SSPLv1；**Redis 8 三许可 RSALv2/SSPLv1/AGPLv3**，Query Engine/JSON/TS 并入 core；redis-stack-server 停在 7.4.0-v8（2025-11-03）实质废弃。源：https://github.com/redis/redis/blob/main/README.md ；https://redis.io/blog/agplv3/
- FT.HYBRID（8.4）服务端 BM25+向量 RRF；vector sets 8.0（VSIM since 8.0.0）；npm node-redis 已死（2013），现行客户端 `redis` 6.3.0（@redis/search 活跃）。源：https://redis.io/docs/latest/commands/vsim/
- 无 CJK 分词（空格/标点切分，Snowball 仅西方语系）。源：https://redis.io/docs/latest/develop/ai/search-and-query/advanced-concepts/escaping
- BullMQ 要求 maxmemory-policy=noeviction；Worker 阻塞命令需独立连接；队列需 AOF——与索引共实例则持久化流耦合（dump.rdb 默认 /data，可指向 DATA_ROOT 但默认无 AOF）。源：https://docs.bullmq.io/guide/connections

## 5. SQLite FTS5

- bm25() 内建（负值、列权重、用 rank 排序更快）；external content table+三触发器官方模式（'rebuild' 回填；删除先写 FTS 表）；**better-sqlite3 默认 SQLITE_ENABLE_FTS5=1**。源：https://www.sqlite.org/fts5.html ；https://github.com/WiseLibs/better-sqlite3/blob/master/deps/defines.gypi
- unicode61 下连续中文成单一巨 token；trigram（3.34+）substring+LIKE/GLOB 加速但**查询须 ≥3 unicode 字符（二字词不中）**；ICU tokenizer 需自编译（better-sqlite3 未带）。源：fts5.html ；docs/compilation.md
- Prisma 不支持虚拟表（prisma/orm#9414 open since 2021）；迁移 raw SQL 或 better-sqlite3 直跑 init.sql（repo 现行做法）可行。
- vec0 与 FTS5 同文件：rowid JOIN+应用层 RRF，单连接时同一写事务原子——**唯一"真事务+双路召回"形态**。

## 横向：@prisma/adapter-better-sqlite3

- 官方维护，7.10.1（2026-10-15），deps 锁 better-sqlite3 ^12.6.0（7.3.0 起 pin）。**构造器只收 Options&{url}，不收现成 Database 实例**（dist/index.d.ts 证实）——Prisma 自开连接、无法 loadExtension，Prisma 侧 $queryRaw 调不了 vec0；**"单连接承载 Prisma+sqlite-vec 单事务"当前做不到**，实际同文件双连接（WAL 单写者，跨连接事务互不可见）；TypedSQL 明确不支持此 adapter。源：https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/sqlite ；https://registry.npmjs.org/@prisma/adapter-better-sqlite3/7.10.1 ；https://www.prisma.io/blog/prisma-orm-7-3-0

## 对比要点（事实）

- **sqlite-vec+FTS5**：唯一同库同事务；短板：纯暴力扫描无 ANN、pre-v1、节奏放缓；中文 BM25 只能 trigram（二字词不中）或 ICU 自编译。
- **LanceDB**：功能最全（BM25+RRF+jieba/ICU+upsert+版本化）；短板：0.x、目录树非单文件、无跨库事务、node>=22。
- **Qdrant**：检索最完整（RRF/DBSF/sparse BM25/payload 过滤）；短板：常驻服务吃 RAM、双库双写无事务、备份走 snapshot API。
- **Redis 8**：AGPLv3 回归+Query Engine/FT.HYBRID/vector sets；短板：无 CJK 分词、与 BullMQ 共实例 noeviction+持久化耦合、7.4 现行许可 RSAL/SSPL 非 BSD。

## 对后续票的输入提示（主会话注）

- B1 已推荐 FTS5(trigram)+sqlite-vec 双路 → RRF 管线，与本报告「同库同事务」形态咬合；但 trigram 二字词不中（中文高频二字词）与「纯暴力扫描」的规模上限，需 A2/D1 评测门槛票定量裁决。
- memory_items 接活与否：Prisma adapter 无法 loadExtension 的事实意味着向量面必须走 better-sqlite3 独立连接（同文件双连接），接活 PrismaMemoryStore 的「单连接」假设需要重新审视——留给 B3 决议在 A2/C1 中消费。

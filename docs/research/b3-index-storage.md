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

---

# B3 决议（#991 收口）

> 决议部分由 B3 承接代理基于上文调研 findings + 本仓事实核对（deploy/docker-compose.deploy.yml、server/Dockerfile、server/package.json、server/prisma/schema.prisma、server/src/prisma.ts、server/src/sessions/service.ts recordTurn、server/scripts/apply-schema.mjs、server/src/containers/imageRef.ts、地图 #986 Agreements）作出。

## 推荐

**sqlite-vec + SQLite FTS5 同库方案**——向量面与全文面都落在现有 `db.sqlite3` 单文件内（panel-db named volume），与单进程假设、compose 三服务契约、DATA_ROOT 约定零冲突。与 B1 推荐的 FTS5(trigram)+sqlite-vec 双路 → RRF 管线咬合。

**LanceDB 记载为 Plan B**：功能面最全（jieba 中文分词、内建 RRF、mergeInsert upsert），若后续规模或中文召回质量逼迁，走全量 reindex 即换——索引是 session_messages 的可重建派生物，**本选型可逆**，这是选 sqlite-vec 的风险对冲。

## 评分矩阵（票面维度）

| 维度 | sqlite-vec+FTS5（推荐） | LanceDB | Qdrant 容器 | Redis 扩展 |
|---|---|---|---|---|
| 单进程 / 三服务契约 / DATA_ROOT 一致性 | **优**：零新进程、零新镜像（钉版红线不触）、零契约变化，索引在现有 named volume 单文件内 | 中：零新进程，但索引为 DATA_ROOT 下目录树（非单文件心智） | 差：第 4 服务 + 钉版镜像（`v1.19.2` 可钉）+ 常驻 RAM + 新卷 | 差：须换 Redis 8/Stack 镜像 + 加卷 + AOF，与 BullMQ 共实例耦合（noeviction/持久化流/阻塞命令） |
| 增量索引与事务一致性（recordTurn 写入路径） | **优**：同文件专用 better-sqlite3 连接，chunk 行 + vec + fts 三写同一事务原子（唯一「真事务 + 双路召回」形态） | 差：双存储双写，仅应用层补偿（mergeInsert 幂等 upsert 缓解） | 差：跨库跨进程双写无事务（已确认） | 差：双写 + 队列/索引持久化耦合 |
| 混合查询表达力（向量+过滤+全文） | 中：SQL JOIN + 应用层 RRF（~10 行手写），ownerId 过滤 = 一行 WHERE，vec0 partition key 每用户分片 | **优**：内建 BM25 + RRF + jieba/ICU + SQL-ish where | **优**：服务端 RRF/DBSF + sparse BM25 + payload 过滤（full-text filter 默认 word tokenizer 无 CJK） | 中：FT.HYBRID 服务端融合，但无 CJK 分词 |
| 运维面 | **优**：单文件备份（`.backup` / wal checkpoint）、零新容器、升级面 = npm 依赖 | 中：停写拷目录、0.x 格式演进面 | 中：snapshot API 备份、新容器升级面 | 差：换镜像 + 加卷 + AOF 策略裁决 |
| 成熟度风险 | 中：pre-v1（0.1.9）节奏放缓、纯暴力扫描无 ANN（per-user 分区后万级分块毫秒级可承受） | 中：0.x 周更 | 优：v1.19 稳定 | 中：8.x 三许可过渡期、stack 镜像实质废弃 |

中文 BM25 面：V1 用 **FTS5 trigram**（零新依赖，substring 语义），已知边界 = 二字查询不中（≥3 字符门槛）——缓解：C1 查询构造器扩写 query + 短 query 回退 LIKE（trigram 同时加速 LIKE/GLOB）；备选 = 索引时 @node-rs/jieba 预分词列（unicode61 吃空格分词，BM25 语义更好、二字词命中），实施票二选一。

## memory_items：**并存，不接活**

- 历史会话召回索引是**派生数据**（session_messages 分块；跟 session 级联删；可随时全量重建；行数万级、recordTurn 驱动）；memory_items 是 **agent 语义记忆**（BaseStore Item 契约 namespace/key/valueJson；刻意跟 user 不级联 #727；行少写频低；V1 显式拒绝向量 query 是有意设计 prismaMemoryStore.ts:204-210）。生命周期、基数、删除语义、查询路径四者全不同，塞同一张表只会迫使 Item 形状承载派生块。
- 「接活」的正确含义：PrismaMemoryStore 按 #727 V1 原样后续接线（其五方法纯 Prisma 面，不受 adapter 无法 loadExtension 影响；是否对 agent 暴露 memory 工具面归 C1）；若未来 BaseStore search 要向量，为 memory_items **另建专属 vec0 表**，不与会话 chunk 索引共享。
- 召回索引的租户隔离靠新锚表 ownerId 冗余列 + vec0 partition key，不借道 namespace。

## 落库 schema 草案要点

1. **锚表 `session_message_chunks`** 进 schema.prisma（Prisma 可建模 → init.sql / incremental-schema 常规管线）：`id` cuid PK；`sessionId` FK→sessions CASCADE；`messageId` FK→session_messages CASCADE；`ownerId` 冗余列（消息行无 userId 列，隔离过滤靠它）+ `@@index([ownerId])`；`turn`/`chunkSeq`；`content`；`contentSha256` 幂等键；`embeddingModel` 漂移标记；`UNIQUE(messageId, chunkSeq)`。保留隐式 rowid（勿 WITHOUT ROWID——FTS5 external content 靠它）。
2. **向量面 `session_message_chunks_vec`**：vec0 虚拟表，**不进 schema.prisma**（Prisma 不支持虚拟表，prisma/orm#9414），落 incremental-schema.mjs additive 段（apply-schema.mjs 既有机制）；`chunk_id TEXT PRIMARY KEY` + `owner_partition TEXT partition key`（=ownerId） + `embedding float[<钉版维度>]`（维度随 #725 网关 embedding 模型建表时钉死；换模型 = 重建向量表，派生数据可接受）。
3. **全文面 `session_message_chunks_fts`**：FTS5 external content 虚拟表（同上不进 Prisma）+ AFTER INSERT/UPDATE/DELETE 三触发器同步（官方模式；回填走 'rebuild'）；`tokenize='trigram'`（V1，备选预分词列见上）。
4. **写入路径**：recordTurn 落 assistant 行（既有缝 sessions/service.ts:731）→ 异步增量索引（BullMQ 复用 runner-runs 还是新队列归 C1 裁决——本票钉死的约束：异步/同步皆安全，因同文件单事务 + contentSha256 幂等 upsert + 启动补索引扫描即崩溃恢复）。专用 better-sqlite3 连接 `sqliteVec.load(db)`，`BEGIN IMMEDIATE` 内三写（chunk 行 upsert → vec → fts 触发器自动）。
5. **集成前置**：索引连接 `PRAGMA journal_mode=WAL` + `busy_timeout`——现库未显式开 WAL（src 内零 pragma），同文件双连接（Prisma adapter 连接 + 索引连接）的前提；备份面注意 WAL checkpoint（`.backup` 命令保持单文件语义）。
6. **仓内事实支撑**：server 运行镜像 `node:lts-slim`（Debian/glibc，server/Dockerfile:35-38 明注）→ sqlite-vec linux-x64 glibc 产物直载，alpine 顾虑不存在；`@prisma/adapter-better-sqlite3` ^7.9.1 与 `better-sqlite3` ^12.10.1 均已在 package.json（后者默认编入 FTS5）；compose 三服务 + named volume 现状零改动，redis 保持 `redis:7-alpine` 纯 BullMQ 用途不动。

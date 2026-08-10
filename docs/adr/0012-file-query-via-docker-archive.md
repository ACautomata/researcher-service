# 文件查询经 Docker getArchive/putArchive，否决 gateway 插件

**Status**: accepted

控制面查询/读写 OpenClaw 容器内 wiki / workspace 文件，**经 Docker 自带原语**，不经 gateway 插件 API，也不引入第三方 gateway 插件。

## 决策

统一一个文件 CRUD 端点，按 `root` 区分 wiki / workspace 两棵树：

```
GET    /api/v1/containers/<name>/files?root=<wiki|workspace>&path=<rel>&recursive=<bool>
       path 指目录 → {files:[{path,type,size,modified}]}；recursive=true 递归 walk 全量相对路径
       path 指文件 → {path,content,size,modified}（仅文本；二进制经 NUL 嗅探过滤，不返回内容）
PUT    /api/v1/containers/<name>/files   {root,path,content}  覆写已存在
POST   /api/v1/containers/<name>/files   {root,path,content}  新建（已存在→冲突）
DELETE /api/v1/containers/<name>/files?root=&path=            删除
```

底层机制：

- **列目录 / 读文件** → dockerode `getArchive(path)`：以容器为视角把路径打成 tar 流拉出，穿过 named volume 挂载点读到卷数据（见 [0011](./0011-named-volume-topology.md)）。控制面新增 tar 流解析。
- **写文件（PUT/POST）** → dockerode `putArchive`：把内容打成 tar 推进容器。
- **删文件（DELETE）** → 容器内 `exec rm`（需容器 running）。

现有 wiki 的 `graph` / `categories` 语义聚合（frontmatter 解析、双链图谱、category 聚合）**不是裸文件 CRUD，保留不动**。

## 为什么否决 gateway 插件

曾详查第三方插件 `openclaw-better-gateway`（v1.2.5，36 star 单人维护，非官方）——它在 gateway 主端口 18789 暴露 HTTP 文件 API（`/better-gateway/api/files` list/read/write/delete/mkdir），看似现成，但源码实证后否决：

1. **暴露面过大**：同一 token 后捆绑 Monaco IDE、xterm.js 全交互 PTY 终端（node-pty）、任意 workspace 写/删/mkdir——为「只读查询」引入远超所需的攻击面。
2. **认证与 `${GATEWAY_TOKEN}` 占位不兼容**：插件自己读 `openclaw.json` 的 token 校验，本项目 token 走 `${GATEWAY_TOKEN}` env 占位、不落真值——它读到的是占位符字面量，token 校验在本项目配置下失效或需 fork 修。
3. **CORS 全开**（`Access-Control-Allow-Origin: *`）+ `?token=` query 认证（token 进 URL/日志）。
4. **查询根不可配**：根由 OpenClaw 运行时 `api.resolvePath("")` 给、被 `isPathSafe` 限制在 workspace 内，wiki（`~/.openclaw/wiki/main`）在 workspace 外读不到——满足不了「wiki 也走这条路」。

OpenClaw 官方 gateway **无**「列目录/读任意文件」RPC（WS v4 方法集里只有 `artifacts.download` 下载 run 产物）。走插件/RPC 这条路在官方与第三方都不成立。

## 为什么选 Docker 原语

- **不破 ADR 0006**：文件访问经 docker.sock 的 Docker API，与 WS 隧道（纯透传、浏览器直连 gateway）完全无关，隧道定位不变。
- **能读 named volume**：`getArchive` 穿过挂载点读卷数据，正好配合 named volume 拓扑（0011），无需控制面挂任何卷。
- **零第三方依赖、零新增暴露面**：复用既有 docker.sock 编排通道。

## 代价（已接受）

- **以容器存在为前提**：`getArchive`/`putArchive` 以容器为句柄，容器删除后不可用（配合 0011「删容器连卷删」规避）。
- **tar 开销**：列目录要拉整个目录的 tar 包；大目录/大文件有传输开销。文本过滤（NUL 嗅探）在控制面解析 tar 后做。
- **删文件需容器 running**：`exec rm` 在 stopped 容器内不可执行（Docker 限制），stopped 容器的删除需先 `start`（现有 `DockerRuntime.start` 幂等）。

## 考虑过但否决的方案

- **控制面挂同一 named volume + 本地 fs 直读**：唯一能「容器死了也读 + 复用现有 `NodeWikiFileSystem` 防护」的方案；但要求控制面挂每容器一族卷，dev 直跑摸不到 named volume → dev/prod 部署分叉。否决于「禁止挂 host」（0013）目标下也不自洽（控制面挂数据卷 vs 零数据挂载）。
- **docker cp 到宿主再读**：写宿主临时盘，违背整洁，且要管临时文件生命周期。

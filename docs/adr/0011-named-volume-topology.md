# OpenClaw 容器持久化改用 named volume 拓扑

**Status**: accepted

OpenClaw 容器的持久化从「宿主 bind-mount `instances/<id>/home`」改为「每容器一组 Docker named volume」，宿主不再持有任何 OpenClaw 数据路径。

## 决策

每容器（按代系 id，对齐 #360）挂三个 named volume：

| 卷 | 容器内挂载点 | 内容 |
|---|---|---|
| `openclaw-wiki-<id>` | `~/.openclaw/wiki/main` | memory-wiki vault |
| `openclaw-workspace-<id>` | `~/.openclaw/workspace` | agent 工作区 |
| `openclaw-home-<id>` | `~/.openclaw` | state / logs / extensions / skills |

前两个卷在子路径上遮蔽 `openclaw-home-<id>` 的对应子目录，属正常叠加。空 named volume 首次挂载时，Docker 自动把镜像内 `~/.openclaw` 的骨架拷进卷——wiki/workspace 骨架烤进自建派生镜像（见 [0013](./0013-no-host-mounts-cd.md)），免去独立 researcher 模板 clone 与手工预填充。

删除容器时连同其三个卷一起 `docker volume rm`（数据随容器生命周期，符合「面板增删容器」的临时语义）。注意：现有 `remove({v:true})` 只删**匿名**卷，named volume 必须显式逐个 `docker volume rm`，否则越攒越多。

## 为什么

- **整洁动机**：数据不再散落在宿主 `instances/<id>/` 树里；named volume 由 Docker 统一管理、可 `docker volume ls` 定位，宿主机与容器都保持干净。
- **解开 host-path 死结**：bind-mount home 要求「server 容器与宿主 docker daemon 解析同一宿主路径」（`/fleet` 坑，2026-08-01 生产实测：server 写进自己容器私有层、daemon 在宿主找不到 → 建空目录 → gateway 崩溃循环）。named volume 由 daemon 自管，控制面无需知道其宿主物理路径，死结消失。

## 考虑过但否决的方案

- **保持 bind-mount home**：违背整洁动机；且与「禁止挂 host」（0013）根本冲突——只要还有一个 home bind，就逃不开 host path。
- **只抽 wiki/workspace 成卷、其余仍 bind home**：用户最初的最小方案；但 home bind 一旦保留，host path 死结仍在，「零 host 数据挂载」无法达成。故 home 其余部分（state/logs/...）也卷化。

## 后果

- **查询/读写不再能 `node:fs` 直读宿主**：named volume 的宿主物理路径受 Docker 管理（Docker Desktop / Colima 上在 VM 内不可达）。控制面改经 Docker 原语访问（见 [0012](./0012-file-query-via-docker-archive.md)）。
- **以容器存在为前提**：`getArchive` 以容器为视角读卷数据，容器删除后即不可读。配合「删容器连卷删」，「卷还在但容器没了」的情形不出现。
- **挂载契约随镜像谱系**：named volume 自动初始化依赖镜像内 `~/.openclaw` 骨架，骨架内容随自建派生镜像版本走（见 [0013](./0013-no-host-mounts-cd.md)）。

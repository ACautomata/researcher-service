# ADR 0008：Django 后端退役——部署面切换 Express 控制面

## 状态

已接受（#341 M9）。Django(DRF + Channels) 后端整体退役删除，生产部署面切换为 TS/Express 控制面（`server/`）。本 ADR 记录切换的部署决策与迁移边界。

> 溯源：wayfinder #308 的交接规格 #331 是「Express 从零重写」的完整决策汇编（M0–M6 里程碑）；本 ADR 只记录 **M9 收尾的部署面决策**，不重复规格内容。规格实现过程（M0–M8）已在各切片 PR 记录。

## 背景

M0–M8 已完成：`server/` Express+ws 控制面实现全部 5 域（认证/容器/wiki/models/对话隧道）+ admin 账号管理；前端（#340 M8）已全部适配新后端（信封契约、R1 旋转、`me.role`、ChatView 拆分）。期间 CD 被临时禁用（`on: workflow_dispatch` + workflow_run if 守卫等效关闭），避免过渡期自动部署 Django 镜像。

遗留：生产 compose 的 `backend` 服务仍是 Django 镜像；nginx 反代 `backend:8000`；CI 仍有 Django pytest job；`backend/` 217 个 Python 文件在仓库中。

## 决定

1. **`server/` 容器化**：新建多阶段 `server/Dockerfile`（build 全量 npm ci + prisma generate + tsc → runtime `npm ci --omit=dev` + dist + prisma/scripts），`docker-entrypoint.sh` 先幂等落表再 `node dist/server.js`。镜像基 `node:lts-slim`（Debian/glibc，better-sqlite3 原生模块不兼容 alpine）。
   - **幂等建表**：`prisma/init.sql` 无 `IF NOT EXISTS`（非幂等），entrypoint 用「裸 `users` 表是否存在」判定（Prisma `@@map` 落表名与 Django 带前缀表名不冲突，旧库残留不会误判），apply 后置 `PRAGMA user_version=1` 迁移位。
2. **compose 服务改名 `backend` → `server`**：镜像 `PANEL_SERVER_IMAGE`、`container_name: panel-server`、端口 8000 → 8001；nginx upstream 同步 `server:8001`。环境变量平移：`DJANGO_SECRET_KEY` → `JWT_SECRET`（≥32 字符 fail-fast）、删除 `DJANGO_ALLOWED_HOSTS`（Express 不校验 Host）、新增 `PANEL_PUBLIC_ORIGIN`（生产必填 fail-fast，隧道 Origin + 容器 allowedOrigins 强制条目）、`DATABASE_NAME` → `DATABASE_URL`（`file:/app/db/db.sqlite3` 显式绝对路径）。
3. **CD 恢复自动部署**：`on: workflow_run`（CI 成功 → 构建 server + frontend 镜像 → 部署）。secrets 迁移：`JWT_SECRET` / `PANEL_PUBLIC_ORIGIN` 取代 `DJANGO_SECRET_KEY` / `DJANGO_ALLOWED_HOSTS`。
4. **`backend/` 整体删除**（`git rm -r`）+ CI `backend-unit` job 删除 + 前端 Django 兼容死代码清理（注释/DRF 专属分支；通用兜底分支保留——`!resp.ok` / `detail` 透传 / 非信封透传属零成本健壮性）。
5. **文档同步**：AGENTS.md（CLAUDE.md symlink 同文件）/ README.md / CONTEXT.md（glossary 当前事实段更新，历史实现条目标注「历史注」保留）/ deploy/DEPLOY.md 重写 / server/README.md 补生产部署章节。docs/research/* 与 ADR 0001–0005 保留为决策历史。

## 迁移边界（已知取舍）

- **数据不迁移**：Django 表结构（`auth_user`/`accounts_*` 等）与 Prisma schema（裸表名）不兼容；生产切换后 panel-db 卷内旧 Django 数据**丢弃**（spec #312「现有数据不迁移」）。首启建新表 + bootstrap B1 惰性生成 admin。entrypoint 的幂等判定不受旧库残留影响。
- **健康门语义**：Express 不校验 Host 头（无 ALLOWED_HOSTS），`curl -H Host:` 保留无害（回滚兼容）。
- **回滚路径**：镜像按 `:<commit sha>` 不可变留档；回滚 = 改 `.env` 的 `PANEL_SERVER_IMAGE` 固定旧 sha 重启。若需退回 Django，`backend/` 可从 git history 恢复（未做数据迁移，回滚即重来）。

## 后果

- **正面**：单一 TS 技术栈（控制面 + 前端），部署只跑 Node 容器；`@openclaw/gateway-client` 官方包直接消费；CI 三轨 → 双轨（frontend + server）。
- **负面/注意**：生产切换需**先配好新 secrets**（`JWT_SECRET` / `PANEL_PUBLIC_ORIGIN`），否则 server 容器拒绝启动、健康门判红；旧 Django 数据一次性废弃。

# 面板生产部署（CD → 宝塔宿主）

本文档覆盖 **一次性 bootstrap** 与 **CD 自动化边界**。流水线本身见 `.github/workflows/cd.yml`。

## 架构

```
https://researcher.acautomata.top
    │  宝塔边缘 nginx：Let's Encrypt 证书（自动续期）+ 强制 HTTPS
    │  反代 → http://127.0.0.1:18080
    ▼
panel-frontend 容器（nginx，唯一对宿主暴露，loopback:18080）
    ├─ /        → SPA（dist/，history fallback）
    ├─ /api/    → panel-backend:8000（Daphne/DRF）
    └─ /ws/     → panel-backend:8000（Channels，Upgrade 透传）
                     │  panel-backend 挂 docker.sock（编排 OpenClaw 容器）+ SQLite 卷 + researcher 模板(RO)
                     ▼
              panel-redis（DistributedLock，内部网络）
```

- 三服务 `restart: unless-stopped`，宿主重启自恢复。
- 前端为 origin-relative：构建不注入后端地址，无 CORS、无 per-domain 重建。
- 镜像存私有 GHCR：`ghcr.io/<owner>/<repo>/{backend,frontend}`，tag `:latest` + `:<commit sha>`。

## CD 自动化什么

每次 CI 在 `master` 上成功后自动：

1. 构建 + 推送 `backend`、`frontend` 两镜像到 GHCR（`:latest` 与 `:<CI head_sha>`）。
2. 渲染运行时 `.env`（敏感值来自 secrets，不进 git）。
3. scp `docker-compose.deploy.yml` + `.env` → 宿主 `/www/panel/`。
4. SSH 远端：`docker login ghcr.io`（持久）→ `pull` → `up -d --remove-orphans` → `image prune` →
   健康门 `curl 127.0.0.1:18080/api/health`（30s 内非 200 即 workflow 红）。
5. 防御性 bootstrap：`/www/panel`、`/srv/openclaw/template` 缺则自动建/克隆。

## 一次性 bootstrap（手工，仅首次）

| # | 步骤 | 说明 |
|---|------|------|
| 1 | 宿主装 Docker + compose 插件 | `docker compose version` 可用即可（CD 用 CLI 子命令）。 |
| 2 | DNS 指向 | `researcher.acautomata.top` A 记录 → 宿主公网 IP（LE HTTP-01 需先解析）。 |
| 3 | 宝塔建站点 | 网站 → 添加站点 `researcher.acautomata.top`（纯静态/反代用途，无需 PHP）。 |
| 4 | Let's Encrypt | 站点 SSL → Let's Encrypt 申请 → 开启「强制 HTTPS」。续期宝塔自动。 |
| 5 | 反代 | 站点 → 反向代理 → 目标 `http://127.0.0.1:18080`，发送域名 `$host`。 |
| 6 | GitHub secrets | 见下表。 |

> researcher 模板、/www/panel 目录 **无需手工预建**——CD 首次会自动克隆/创建（防御性 bootstrap）。
> 若你想手动控制模板版本：`git clone https://github.com/ACautomata/researcher.git /srv/openclaw/template`。

## GitHub secrets 清单

仓库 → Settings → Secrets and variables → Actions：

| Secret | 取值 | 用途 |
|--------|------|------|
| `REMOTE_HOST` | 宿主 IP / 主机名 | SSH 目标 |
| `REMOTE_USER` | `root` | SSH 用户（宝塔以 root 跑、own docker.sock） |
| `DEPLOY_KEY` | SSH 私钥全文 | 免密登录（对应公钥预先放宿主 `/root/.ssh/authorized_keys`） |
| `GHCR_PULL_USER` | GitHub 用户名 | 宿主拉私有 GHCR |
| `GHCR_PULL_TOKEN` | classic PAT，scope `read:packages` | 宿主拉私有 GHCR（持久 login，运行时拉 OpenClaw 镜像复用） |
| `DJANGO_SECRET_KEY` | 随机长串 | Django 签名密钥 |
| `DJANGO_ALLOWED_HOSTS` | `researcher.acautomata.top` | Host 头白名单（逗号分隔可多个） |
| `LLM_API_KEY` | 面板共享 LLM key | 注入 OpenClaw 容器 |
| `CREDENTIAL_ENCRYPTION_KEYS` | base64url 32 字节 | 凭证 AES-256-GCM 密钥环 |
| `RESEARCHER_REPO`（可选） | 克隆 URL | 默认 `https://github.com/ACautomata/researcher.git` |

生成 `CREDENTIAL_ENCRYPTION_KEYS`（输出去掉结尾 `=` 即 base64url 规范形式；实现容错补 padding）：

```bash
python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='))"
```

## 运行时后端必需 env（fail-fast 校验，`config/settings/prod.py`）

容器启动时校验，缺一即拒启动（健康门会据此判红）：

`DJANGO_SECRET_KEY` · `DJANGO_ALLOWED_HOSTS` · `LLM_API_KEY` · `REDIS_URL`（compose 固定
`redis://redis:6379/0`）· `OPENCLAW_TEMPLATE_DIR`（compose 固定 `/srv/openclaw/template`）·
`CREDENTIAL_ENCRYPTION_KEYS`。

## 回滚

镜像按 `:<commit sha>` 留了不可变记录，回滚 = 固定到上一个 sha 重启：

```bash
ssh root@<REMOTE_HOST>
cd /www/panel
# 编辑 deploy.env，把 PANEL_BACKEND_IMAGE / PANEL_FRONTEND_IMAGE 的 :latest 改成 :<上一个 sha>
docker compose -f docker-compose.deploy.yml --env-file deploy.env up -d
```

（或在 CI 重跑对应历史 commit 的 CD。）

## 排障

```bash
ssh root@<REMOTE_HOST>
cd /www/panel
docker compose -f docker-compose.deploy.yml --env-file deploy.env ps
docker compose -f docker-compose.deploy.yml --env-file deploy.env logs backend
docker logs panel-frontend
curl -v http://127.0.0.1:18080/api/health   # 应用层
curl -v https://researcher.acautomata.top/api/health  # 经宝塔 TLS 全链路
```

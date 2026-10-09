# 关键机制与约束

> `AGENTS.md` 的披露参考——动容器编排 / 部署 / 凭证 / 测试接缝时查阅。

- **T0 legacy 清退（#801）**：chat 隧道四文件/设备配对（表+路由+approve exec）/bootstrap-token/端口池/
  config 渲染写盘链（openclaw.json 模板）/升级编排/健康探针对账已整链退役；files API 只读化（root=lab
  唯一读面，wiki/workspace → 60042，写面与 files/raw 媒体通道 → 90005）。
- **OpenClaw 退役③（#858）**：容器 CRUD REST/管理页/Prisma `containers` 表（迁移 SCHEMA_VERSION 15
  整表 DROP）/kind=legacy 分派整链退役；containers/ 收敛为 wiki|sandbox 共享原语（标签 schema/kind
  识别/ensureImagePulled/NameSerializer/imageRef）；前端 `/` 重定向 `/chat`（产品只呈现会话 / wiki /
  模型配置）；GET /users 载荷去 containerCount/quota{used,limit}（users.maxContainers 列保留无消费面，
  列清退归终局票）；`OPENCLAW_TEMPLATE_DIR`/`OPENCLAW_FLEET_ROOT`/`OPENCLAW_IMAGE`/
  `OPENCLAW_NAMED_VOLUMES`/`CREDENTIAL_ENCRYPTION_KEYS`/`LIFECYCLE_WORKER_CONCURRENCY` env 随
  fleet 退役（落盘根改 `DATA_ROOT`，现役消费方 = 附件上传临时区）；凭证加密链（crypto.ts）随
  GATEWAY_TOKEN 落盘面退役。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。
- **凭证**：平台默认端点用 `LLM_API_KEY`；BYOK 凭证用 `LLM_CREDENTIAL_SECRET` 加密（生产两项必填）。写请求经 zod 校验，读响应不含明文或密文；插件只消费 ctx.llm，不接触凭证。预设固定协议与地址，不接受自由 baseURL。
- **端点配置**：mutation 与配置版本 bump 同事务，下一 run 生效；会话/teammate/插件/judge 悬挂引用回平台默认并告警。在飞 run 共用启动快照。judge 故障 fail-closed 升级人工；token 仍计入审批审计。试连 V1 无专用限流，接受面见 ADR 0017。
- **生产部署**：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务），
  CD 经 GitHub Actions 构建 `server`/`frontend` 镜像推 GHCR 并部署宝塔宿主（见 `deploy/DEPLOY.md`）。
- **测试**：
  - server：`cd server && npm test`（vitest；接缝：wiki Port / 信封 REST / hostDeps / files
    FileArchive Port；events 域测试按 #747 Testing Decisions 的 S 编号标注：S1 信封级集成 /
    S3 纯逻辑单测）。沙箱/wiki 容器 smoke 需真 docker daemon（自动探测门控）；BullMQ 用例需真
    Redis（门控）。（#858：fleet 编排 smoke 与 BullMQ 生命周期队列用例随容器管理退役。）
  - frontend：`cd frontend && npm run test`（vitest）；`npm run build` 跑 vue-tsc 类型检查。

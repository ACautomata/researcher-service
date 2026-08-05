# server/Dockerfile —— TS/Express 控制面生产镜像（issue #341 M9，替代退役的 Django backend 镜像）
# 多阶段：build（npm ci 全量——编译需要 devDeps：typescript + prisma CLI）+ prebuild 钩子
# prisma generate → tsc 产出 dist/；runtime（npm ci --omit=dev，仅生产依赖，src 全部 import
# 已验证落在 dependencies）。容器启动经 entrypoint：先幂等落表（apply-schema.mjs + user_version
# 标记，对齐 Django 镜像「entrypoint = migrate + daphne」模式）再起 node dist/server.js。

# ---- build：编译 ----
FROM node:lts-slim AS build

WORKDIR /app
# better-sqlite3 原生模块（node-gyp）在 build 阶段 npm ci 的 postinstall 编译工具链。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# 仅拷依赖清单以最大化层缓存；源码变化不触发重装。
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prisma ./prisma
COPY scripts ./scripts
# prebuild 钩子 = prisma generate；build = tsc -p tsconfig.build.json + cp src/generated dist/generated。
RUN npm run build

# ---- runtime：精简运行镜像 ----
FROM node:lts-slim

# better-sqlite3 原生模块（node-gyp）在 runtime 的 postinstall 编译工具链；
# 仅构建期用，体积小。必须 slim（Debian/glibc）——alpine/musl 需额外编译参数。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# 生产依赖独立安装（--omit=dev），避免 COPY build 的 node_modules 带入 devDeps 测试栈。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 编译产物 + prisma generate 生成物（tsc 已编译进 dist/generated，显式双拷贝保证完整；
# client 纯 JS，体积可忽略）。schema/scripts 供 entrypoint 幂等落表。
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts

COPY docker-entrypoint.sh /usr/local/bin/panel-entrypoint
RUN chmod +x /usr/local/bin/panel-entrypoint

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["panel-entrypoint"]

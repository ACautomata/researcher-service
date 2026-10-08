# frontend/Dockerfile —— Vue3 + Vite SPA 生产镜像（issue #CD）
# 多阶段：node 阶段 npm ci + vite build 产出 dist/；nginx 阶段仅拷 dist + 站点配置。
# 前端为 origin-relative（fetch 相对 /api、WS /ws/chat/），构建无需注入后端地址；
# 同源部署经 nginx 反代 /api、/ws 到 backend，无 CORS、无 per-domain 重建。

# ---- build：编译 SPA ----
# WORKDIR 复刻 repo 根布局（/repo/frontend + /repo/plugins）：frontend 的 @plugins 别名
# （tsconfig paths / vite alias 均指 ../plugins）与 plugins/autofigure/web.ts 反向引用
# ../../frontend/src 均按 repo 根相对路径书写，平铺到 /app 单层时两头都解析不到（CI 全绿
# 而 CD Docker build TS2307 的根因）。plugins/ 由 cd.yml 命名 context（plugins=plugins）
# 注入，Docker context 本身仍限 frontend/ 以保持层缓存粒度。
FROM node:lts-slim AS build

WORKDIR /repo/frontend
# 仅拷依赖清单以最大化层缓存。
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
COPY --from=plugins . /repo/plugins
# build 脚本 = vue-tsc -b && vite build（含类型检查）。
RUN npm run build

# ---- serve：nginx 静态服务 + 反代 ----
FROM nginx:stable-alpine

# 替换默认站点：SPA history fallback + /api、/ws 反代 backend。
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/frontend/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

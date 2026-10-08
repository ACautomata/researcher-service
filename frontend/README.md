# frontend —— 天津大学科研智能体平台 Vue3 前端

P0 骨架（[issue #37](https://github.com/ACautomata/researcher-service/issues/37)）。
完整规格见 `../docs/FULLSTACK-REFACTOR-SPEC.md`。

## 技术栈

Vue 3 + Vite + TypeScript + Pinia + Vue Router + Element Plus。

## 开发

```bash
npm install
npm run dev      # Vite dev server
```

## 测试 / 构建

```bash
npm run test     # vitest
npm run build    # vue-tsc 类型检查 + vite build
```

## 结构（P0 骨架）

- `src/router/` — 路由表 + 导航守卫（未登录重定向 `/login`）
- `src/stores/auth.ts` — Pinia 认证 store（持有 JWT access token）
- `src/views/LoginView.vue` — 登录页
- 容器管理页已随 #858 退役——首页 `/` 重定向 `/chat`（产品只呈现会话 / wiki / 模型配置）

对话 / Model 配置 / wiki 编辑等页已陆续落地（详见 `src/router/` 路由表）。

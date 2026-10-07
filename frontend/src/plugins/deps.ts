// AutoFigure 插件在 web 面的运行时依赖桥（#799 · #791 布局钉子的前端对称面）。
//
// 铁律（同 server 侧 autofigureDeps.ts）：plugins/ 源目录树内**禁止裸包名 import**——npm
// 依赖声明在 frontend/package.json，node_modules 从 import 方文件位置向上解析，plugins/
// 不在 frontend/node_modules 祖先链上（vitest/vite 从 frontend root 解析恰好掩盖此问题，
// 生产 build 不可依赖该掩盖）。plugins web 面组件消费 vue 运行时 API 一律经本桥；
// type-only import 不受此限（编译期擦除，@/plugins/api.ts 先例）。
export { computed, ref, watch, onBeforeUnmount } from 'vue'

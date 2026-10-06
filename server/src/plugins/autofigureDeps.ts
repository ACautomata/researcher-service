// AutoFigure 插件在 server 侧的运行时依赖桥（#791 · 布局钉子）。
//
// 铁律：plugins/ 源目录树内**禁止裸包名 import**——npm 依赖声明在 server/package.json，
// node_modules 从 import 方文件位置向上解析，plugins/ 不在 server/node_modules 祖先链上
//（tsx dev 宿主直跑必挂；vitest 的 vite resolver 恰好从 server root 解析而掩盖此问题，
// 生产 build 经 server/dist 祖先链天然 OK——不可依赖后者掩盖）。plugins 代码消费 npm 依赖
// 一律经本桥（相对 import，#788 plugins → server 源目录直引同向）；server 树内的适配器
//（autofigureXml / autofigureSharp）不受此限。

export { StateGraph, Annotation, START, END } from '@langchain/langgraph'
export type { LangGraphRunnableConfig } from '@langchain/langgraph'
export { z } from 'zod'

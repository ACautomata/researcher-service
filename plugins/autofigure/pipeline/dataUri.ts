// PNG → data URI 编码（fal/RMBG 云 API 入参与 SAM3 分割入参共用的形状）。
// 实现单源 = 核心 server/src/figures/dataUri（核心→插件方向不引入的边界纪律）——
// 此处 re-export 保持插件内引用面（graph/fal 消费方零改动）。

export { pngToDataUri } from '../../../server/src/figures/dataUri'

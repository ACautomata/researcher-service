// PNG → data URI 编码（figure 域共用：插件 graph/fal 云 API 入参与核心 ctx.llm 多模态
// 块构造同源）。上游对照：autofigure2.py _image_to_data_uri :1605-1609（PNG base64 + data:
// 前缀）。单一实现落核心（核心→插件方向不引入——插件经相对直引消费，插件退役不断核心编译）。

export function pngToDataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

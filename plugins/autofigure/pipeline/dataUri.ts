// PNG → data URI 编码（fal/RMBG 云 API 入参与 SAM3 分割入参共用的形状）。
// 上游对照：autofigure2.py _image_to_data_uri :1605-1609（PNG base64 + data: 前缀）。

export function pngToDataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

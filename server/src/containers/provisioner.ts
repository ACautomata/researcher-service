// HomeProvisioner —— 容器 home 预填充（平移 backend/containers/provisioner.py，#334）。
// bind-mount 宿主 instances/<id>/home 决策下，新容器 home 由控制面直接 cp -a 从共享只读
// 模板预填充。dereference:false + preserveTimestamps 对齐 cp -a（archive：递归、保留符号链接）。

import { cp } from 'node:fs/promises'
import path from 'node:path'

export class HomeProvisioner {
  private readonly template: string

  constructor(templateDir: string) {
    this.template = templateDir
  }

  async provision(homeDir: string): Promise<void> {
    // 防无限递归 fail-fast：template 若是 homeDir 的祖先或同一目录（fleet root 典型误配），
    // cp 会把含 home 自身的整棵树递归拷入 home → 无限递归 → 容器卡 creating。
    const templateResolved = path.resolve(this.template)
    const homeResolved = path.resolve(homeDir)
    if (
      templateResolved === homeResolved ||
      homeResolved.startsWith(templateResolved + path.sep)
    ) {
      throw new Error(
        `模板目录 ${templateResolved} 是 home 目录 ${homeResolved} 的祖先或同一目录` +
          '——cp 会无限递归（含目标 home 自身被拷入）→ 容器卡 creating。',
      )
    }
    // recursive 拷贝；dereference:false 保留符号链接（对齐 cp -a / copytree symlinks=True）。
    // errorOnExist:true + dst 已存在 → 抛错（fail-fast，对齐 FileExistsError）。
    await cp(this.template, homeDir, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    })
  }
}

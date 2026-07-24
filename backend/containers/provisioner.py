"""HomeProvisioner —— 容器 home 预填充（spec §5.6）。

bind-mount 宿主 `instances/<name>/home` 决策下，新容器 home 由控制面直接 cp -a 从共享只读
模板预填充（宿主路径可达，无需 init 容器；spec §5.6 明确否决 r27 的命名卷/init 容器方案）。

cp -a = archive mode（-dR --preserve=all，含 --no-dereference）—— shutil.copytree(symlinks=True)
对齐：递归拷贝、保留符号链接、保留 metadata。
"""
import shutil
from pathlib import Path


class HomeProvisioner:
    """从共享只读模板 cp -a 预填充一个实例的 home 目录。"""

    def __init__(self, template_dir: Path) -> None:
        self._template = Path(template_dir)

    def provision(self, home_dir: Path) -> None:
        # copytree：src 不存在 → FileNotFoundError；dst 已存在 → FileExistsError（均 fail-fast）
        shutil.copytree(self._template, home_dir, symlinks=True)

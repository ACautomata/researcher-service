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
        # codex P1 :162：防 shutil.copytree 无限递归——template 若是 home_dir 的祖先或同一
        # 目录（fleet root 典型误配：OPENCLAW_TEMPLATE_DIR 指向仓库根，而 home_dir 落在其下
        # 的 fleet/instances/<name>/home），copytree(template, home) 会把含 home 自身的整棵
        # 树递归拷入 home → [Errno 63] 文件名过长 / 无限递归 → 容器卡 creating（issue #195
        # 同类错配，docs memory openclaw-fleet-config-alignment-gotcha）。home_dir 落在 fleet
        # root 下，故等价于「template 是 fleet root 的祖先」。在 copytree 前用「真实 template +
        # 真实 home」fail-fast——不放在 base.py import 期（那里用默认 FLEET_ROOT，在 worktree/
        # 符号链接环境会误判 dev settings 加载）。
        template_resolved = self._template.resolve()
        home_resolved = Path(home_dir).resolve()
        if template_resolved == home_resolved or template_resolved in home_resolved.parents:
            raise ValueError(
                f'模板目录 {template_resolved} 是 home 目录 {home_resolved} 的祖先或同一目录'
                '——shutil.copytree 会无限递归（含目标 home 自身被拷入）→ 容器卡 creating。'
                '把 OPENCLAW_TEMPLATE_DIR 指向 fleet root 之外的 researcher 克隆。'
                '（issue #195，codex P1 :162）',
            )
        # copytree：src 不存在 → FileNotFoundError；dst 已存在 → FileExistsError（均 fail-fast）
        shutil.copytree(self._template, home_dir, symlinks=True)

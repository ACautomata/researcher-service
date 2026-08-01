"""containers.fleet.config_store —— config 原子写单源（ConfigStore，parent #277 / Ticket ③）。

#280 预重构（parent #277）：把两条不一致的 config 写路径收敛为一条原子写——
- ``create()`` 原为裸 ``write_text`` + chmod（非原子，torn/partial 风险）；
- ``rewrite_config()`` 原为 tmp + chmod + ``os.replace``（原子）。

本模块是这两条路径的**唯一**落盘 seam：**bytes-agnostic**（只管「把一段 JSON 文本原子放到
``instances/<name>/openclaw.json``」，不关心 config schema / 不做合并），单方法
``write(name, payload) -> Path``。内容生成（渲染/合并）与序列化（``json.dumps``）留给调用方
（``ConfigRenderer`` / ``ProviderConfigBuilder`` / ``create`` 调用方）——「内容生成」（两种算法）
与「原子落盘」（一种协议）是两个变化轴，在变化点切 seam。

原子性不变量：
- tmp 与目标**同目录**（保证 ``os.replace`` 同文件系统原子 rename，跨文件系统 replace 会报
  EXDEV）；
- tmp 上先 chmod 0644 再 replace（防 umask 027/077 致容器内 node 读不了 bind-mount(ro) 的
  openclaw.json，gateway 无法启动）；
- OSError（卷只读/满/权限）时清 tmp 并转 ``ConfigWriteError(name, path)``——既有 openclaw.json
  不被污染，DB 事务据此回滚（view 层）。
- **每次 write 用唯一 tmp 名**（``openclaw.json.<hex>.tmp``）：create 与 rewrite_config 收敛到
  同一 seam 后可能并发写同一实例，固定 tmp 名会让两写者互相覆盖/误报（codex review P2）；
  唯一名下各写各的 tmp、``os.replace`` 仍原子、最后者胜。

root 解析：**不缓存** ``deps.config.root`` 的快照，每次 write 动态取——测试会对
``deps.config`` 整体 ``dataclasses.replace``（root 变更，:445）后仍走 create/delete。

依赖方向：``config_store`` → ``values``（仅异常），无环。
"""
import secrets
from pathlib import Path

from containers.fleet.values import ConfigWriteError


class ConfigStore:
    """config 原子写单源（bytes-agnostic：只管原子落盘，不懂 config schema）。"""

    def __init__(self, deps) -> None:
        self._deps = deps

    def write(self, name: str, payload: str) -> Path:
        """把 ``payload``（JSON 文本）原子写到 ``instances/<name>/openclaw.json``。

        tmp 与目标同目录 → ``os.replace`` 同文件系统原子 rename；tmp 先 chmod 0644 再
        replace（防 umask 027/077 致容器内 node 读不了 bind-mount(ro)）；tmp 名每次唯一
        （并发写者互不覆盖）；OSError 时清 tmp 并转 ``ConfigWriteError(name, path)``，
        既有文件不被污染。
        """
        config_path = self._deps.config.root / 'instances' / name / 'openclaw.json'
        config_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = config_path.with_name(f'{config_path.name}.{secrets.token_hex(8)}.tmp')
        try:
            tmp.write_text(payload, encoding='utf-8')
            tmp.chmod(0o644)
            tmp.replace(config_path)   # POSIX 原子：要么整体新配置生效，要么保留旧文件
        except OSError:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            raise ConfigWriteError(name, str(config_path)) from None
        return config_path

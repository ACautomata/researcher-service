"""宿主端口池分配（spec §5.3 / r27 §3.2）。

容器内统一 18789（Docker 网络命名空间隔离），仅宿主侧分配映射端口。
池默认 [19000, 19999]（避开被单容器 compose 占用的 18789），取最小空闲，耗尽抛错，
删除容器即回收（Instance 行删除后端口自然回到可用集合）。

纯逻辑、无 IO：调用方传入「已用端口集合」（通常来自 Instance.port 查询），allocator 返回
池内最小空闲端口。reserved 显式排除 18789 —— 即便池配置漂移到覆盖 18789 也强制避开（issue #39 验收）。
"""
from collections.abc import Iterable

# 单容器 compose 栈占用（deploy/docker-compose.yml:66 127.0.0.1:18789:18789）
RESERVED_PORT_18789 = 18789


class PortPoolExhausted(Exception):
    """端口池内无可用端口。"""


class PortAllocator:
    """从 [start, end] 闭区间取最小空闲端口，跳过 reserved 与已用。"""

    def __init__(self, start: int, end: int, reserved: Iterable[int] = ()) -> None:
        if end < start:
            raise ValueError('端口池 end 不得小于 start')
        self._start = start
        self._end = end
        self._reserved = frozenset(reserved)

    def next_free(self, used: Iterable[int]) -> int:
        used_set = frozenset(used)
        for port in range(self._start, self._end + 1):
            if port in self._reserved or port in used_set:
                continue
            return port
        raise PortPoolExhausted(
            f'端口池 {self._start}-{self._end} 已耗尽（reserved={sorted(self._reserved)}）',
        )

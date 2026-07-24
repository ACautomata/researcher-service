"""seam: 端口池分配 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.3（池 19000–19999，避开 18789，取最小空闲、
删除回收）/r27 §3.2（alloc_port 取最小空闲，耗尽抛错）。
"""
import pytest

from containers.ports import PortAllocator, PortPoolExhausted


def test_returns_lowest_free_in_empty_pool():
    # spec §5.3：空池取最小空闲 = 池起点 19000
    alloc = PortAllocator(start=19000, end=19999, reserved=frozenset({18789}))
    assert alloc.next_free(set()) == 19000


def test_skips_used_ports():
    # 取最小空闲：19000/19001/19003 已用 → 跳到 19002
    alloc = PortAllocator(start=19000, end=19999, reserved=frozenset({18789}))
    assert alloc.next_free({19000, 19001, 19003}) == 19002


def test_never_returns_18789_even_if_pool_covers_it():
    # issue #39 验收硬要求 + spec §5.3：18789 被单容器 compose 占用，必须避开。
    # 即便有人把池配置覆盖到 18789，reserved 仍强制跳过。
    alloc = PortAllocator(start=18700, end=18800, reserved=frozenset({18789}))
    used = set(range(18700, 18789))  # 18700..18788 全占
    assert alloc.next_free(used) == 18790  # 跳过 18789


def test_exhausted_pool_raises():
    # r27 §3.2：池耗尽抛错（而非静默分配越界）
    alloc = PortAllocator(start=19000, end=19001, reserved=frozenset({18789}))
    with pytest.raises(PortPoolExhausted):
        alloc.next_free({19000, 19001})


def test_reserved_outside_pool_is_harmless():
    # reserved 含池外端口（默认 18789 ∉ [19000,19999]）不影响正常分配
    alloc = PortAllocator(start=19000, end=19999, reserved=frozenset({18789}))
    assert alloc.next_free(set()) == 19000

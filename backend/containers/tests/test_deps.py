"""seam: HostPortProbe —— 宿主端口占用探测（codex P2 :161 / issue #295）。

验证探测目标 host 可配：默认 127.0.0.1（本地 loopback，占用判定与 DockerRuntime
publish_host 默认一致）；生产注入 0.0.0.0（PORT_BIND_HOST）时，非 loopback 接口被占
的端口也能被探测到——否则 allocator 选中「127.0.0.1 看似空闲」的端口，docker
-p 0.0.0.0:<port> 真实发布失败（bind address already in use）→ create 回滚。
用 socket bind 实测，不 mock 探测本身。
"""
import socket

from containers.fleet.deps import HostPortProbe


def _bind_on_non_loopback() -> tuple[socket.socket, str, int]:
    """在具体非 loopback IP 上占一个端口，返回 (holder, ip, port)。"""
    # 遍历本机非 loopback IPv4 地址；gethostname 解析通常含局域网 IP
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip != '127.0.0.1':
                ips.add(ip)
    except OSError:
        pass
    for ip in ips:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((ip, 0))
        except OSError:
            s.close()
            continue
        s.listen(1)
        return s, ip, s.getsockname()[1]
    return None, '', 0


def _port_free(ip: str, port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((ip, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def test_default_probe_binds_loopback():
    """默认探测目标 127.0.0.1：空闲端口报 False（未占用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    assert HostPortProbe()(port) is False


def test_injected_host_sees_non_loopback_occupancy():
    """#295 回归：probe 注入非 loopback host 时，能检测该 IP 上被占的端口。

    端口被 172.18.x.x 之类具体 IP 占用、但 127.0.0.1 空闲时：
    默认 loopback probe 误报空闲 → allocator 选中 → docker 0.0.0.0 发布失败。
    注入同源 publish_host（0.0.0.0）的 probe 须正确报占用。
    """
    holder, ip, port = _bind_on_non_loopback()
    if holder is None:
        import pytest
        pytest.skip('本机无非 loopback IPv4 地址，无法构造该场景')
    try:
        # 前提确认：127.0.0.1 视角确实空闲（这就是旧实现误报的来源）
        assert _port_free('127.0.0.1', port), '测试前提被破坏:127.0.0.1 也应空闲'
        # 修复目标：wildcard 视角必须检测到占用
        assert HostPortProbe(host='0.0.0.0')(port) is True
    finally:
        holder.close()

"""OpenClaw 防腐层 4 Port 的真实 Adapter（Hexagonal / spec #97 / ADR 0002）。

每个 Adapter 实现对应 Port（Protocol），路径各 ticket 填充实现：
- HttpHealthProbe（路径3，#99 本票）—— 构造注入 http client，http://127.0.0.1:<port>/health
- #100 WikiFileSystemAdapter
- #101 DockerContainerRuntime
- #102-103 OpenClawWireAdapter
"""
from __future__ import annotations

import urllib.request


class HttpHealthProbe:
    """路径3：HTTP GET 127.0.0.1:<port>/health 探容器 gateway 可达性（spec §5.4/§12）。

    构造注入 http client（urllib），timeout 可配。实现 integration.openclaw.HealthProbe Port。
    """

    def __init__(self, timeout: float = 2.0) -> None:
        self._timeout = timeout

    def is_reachable(self, port: int) -> bool:
        url = f'http://127.0.0.1:{port}/health'
        try:
            with urllib.request.urlopen(url, timeout=self._timeout) as resp:
                return 200 <= resp.status < 300
        except Exception:
            # URLError（连不上）/ HTTPError（非 2xx）/ timeout —— 统一不可达
            return False

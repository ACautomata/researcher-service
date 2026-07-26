"""OpenClaw 防腐层 4 Port 的可注入 fake 骨架（issue #98 / spec #97）。

沿用 containers/tests/fakes.py 的 Protocol 注入范式：fake 实现 Port，记录调用 / 内存模拟状态，
供业务层单测注入（override Fleet service locator / 构造注入）。本票仅骨架——每 fake 的具体
行为细节随对应路径实现 ticket（#99 HealthProbe / #100 WikiFileSystem / #101 ContainerRuntime /
#102-103 OpenClawWire）补全。
"""
from __future__ import annotations

from typing import Any


class FakeContainerRuntime:
    """ContainerRuntime Port 的内存 fake：记录调用、模拟容器状态（对齐 containers FakeRuntime 语义）。"""

    def __init__(self) -> None:
        self.run_specs: list = []
        self.containers: dict[str, Any] = {}
        self.stopped: list[str] = []
        self.removed: list[str] = []
        self.exec_calls: list[tuple[str, list[str]]] = []

    def run(self, spec: Any) -> str:
        self.run_specs.append(spec)
        return f'fakeid-{spec.name}'

    def list_fleet(self) -> list:
        return list(self.containers.values())

    def get(self, name: str) -> Any:
        return self.containers.get(name)

    def stop(self, name: str) -> None:
        self.stopped.append(name)

    def remove(self, name: str) -> None:
        self.containers.pop(name, None)
        self.removed.append(name)

    def exec_in_container(self, name: str, cmd: list[str]) -> None:
        self.exec_calls.append((name, cmd))


class FakeOpenClawWire:
    """OpenClawWire Port 的内存 fake：记录 pair/connect/send_message/close 调用。

    完整模拟所有长连接方法——send_message（chat.send）/ resolve_approval / list_commands /
    sessions_rpc / list_pending_approvals + 审批订阅者（add/remove） + dead / discard。
    测试用 fake 注入，不依赖真 gateway。
    """

    def __init__(self) -> None:
        self.pair_calls: list = []
        self.connected: list[tuple[str, str]] = []
        self.sent: list = []
        self.closed: bool = False
        self._dead: bool = False
        # 测试可预设 pair() 返回值（如 PairingResult dataclass）
        self.pair_result: Any = None
        # 测试可预设 pair() 抛异常（PairingRequired / PairingError）
        self.pair_raise: Exception | None = None
        # 长连接预设
        self.run_id: str = 'fake-run-id'  # send_message 返回的 runId
        self.resolve_result: dict | None = None  # resolve_approval 返回值
        self.resolve_error: Exception | None = None  # resolve_approval 抛异常
        self.commands_payload: dict | None = None  # list_commands 返回值
        self.commands_error: Exception | None = None  # list_commands 抛异常
        self.rpc_results: dict[str, dict] = {}  # sessions_rpc method→payload
        self.rpc_errors: dict[str, Exception] = {}  # sessions_rpc method→exception
        self.pending_approvals: list[dict] = []  # list_pending_approvals 返回
        # 审批订阅者
        self._approval_subscribers: list = []
        # runId→on_event 路由（send_message 自动注册；push_event 推事件）
        self._routes: dict[str, Any] = {}
        self.discarded: list[str] = []

    @property
    def dead(self) -> bool:
        return self._dead

    @dead.setter
    def dead(self, value: bool) -> None:
        self._dead = value

    async def pair(self, url: str, identity: Any, bootstrap_token: str) -> Any:
        self.pair_calls.append((url, identity, bootstrap_token))
        if self.pair_raise is not None:
            raise self.pair_raise
        return self.pair_result

    async def connect(self, url: str, device_token: str) -> None:
        self.connected.append((url, device_token))
        self._dead = False

    async def send_message(self, session_key: str, message: str, on_event: Any) -> str:
        from chat.chat_client import ChatClientError

        if not self.connected:
            raise ChatClientError('client not connected')
        self.sent.append((session_key, message, on_event))
        rid = self.run_id
        self._routes[rid] = on_event
        return rid

    async def close(self) -> None:
        self.closed = True
        self._dead = True
        self.connected = []
        self._routes.clear()

    def discard(self, run_id: str) -> None:
        self._routes.pop(run_id, None)
        self.discarded.append(run_id)

    # ── 连接级审批 ──

    def add_approval_subscriber(self, cb: Any) -> None:
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb: Any) -> None:
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        frame = {'type': 'approvalResolved', 'id': approval_id, 'decision': decision}
        for cb in list(self._approval_subscribers):
            try:
                await cb(frame)
            except Exception:
                pass

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        if self.resolve_error is not None:
            raise self.resolve_error
        return self.resolve_result or {}

    async def list_pending_approvals(self) -> list[dict]:
        return list(self.pending_approvals)

    # ── 命令/session RPC ──

    async def list_commands(self) -> dict:
        if self.commands_error is not None:
            raise self.commands_error
        return self.commands_payload or {}

    async def sessions_rpc(self, method: str, params: dict) -> dict:
        if method in self.rpc_errors:
            raise self.rpc_errors[method]
        return self.rpc_results.get(method, {})

    # ── 测试辅助 ──

    async def push_event(self, run_id: str, frame: dict) -> None:
        """推一帧事件到已注册的 runId on_event 回调。"""
        import asyncio

        cb = self._routes.get(run_id)
        if cb is not None:
            if asyncio.iscoroutinefunction(cb):
                await cb(frame)
            else:
                cb(frame)


class FakeWikiFileSystem:
    """WikiFileSystem Port 的内存 fake：dict 模拟 wiki/main 文件系统。

    build_tree 按页面真实顶层目录前缀分组（issue #83 物理化，开放词表不写死目录集合）；
    CRUD 异常语义对齐 BindMountWikiFileSystem
    （FileNotFoundError / FileExistsError / NotADirectoryError / ValueError）。
    越权防护（managed 路径/目录穿越）在构造层内联 _SKIP_DIRS/_SKIP_FILES 副本——fake
    不应 import Adapter 私有常量（契约方向守护）。
    """

    _SKIP_DIRS = frozenset({'.openclaw-wiki', '_attachments', '_views'})
    _SKIP_FILES = frozenset({'index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md'})

    def __init__(self) -> None:
        self.pages: dict[str, str] = {}  # rel_path → content
        # 测试可预设异常
        self._raise_on_read: Exception | None = None
        self._raise_on_write: Exception | None = None

    # —— path validation (aligns with BindMountWikiFileSystem._resolve) ——

    def _validate_path(self, rel_path: str) -> None:
        """校验路径不穿越/不触碰 managed 区；违规抛 ValueError（对齐 adapters）。"""
        parts = [p for p in rel_path.split('/') if p]
        if any(p == '..' for p in parts):
            raise ValueError(rel_path)
        if any(p in self._SKIP_DIRS for p in parts):
            raise ValueError(rel_path)
        if parts and parts[-1] in self._SKIP_FILES:
            raise ValueError(rel_path)

    # —— build_tree ——

    def build_tree(self) -> dict:
        """照实平铺：按页面真实顶层目录分组（kind=name=目录名），对齐 BindMountWikiFileSystem。

        开放词表（issue #83）：不预设五分类，出现什么顶层目录就返回什么组；跳过插件私有
        目录与占位文件；无页的目录自然不成组（pages 中无此前缀）。
        """
        groups: dict[str, list] = {}
        for p in sorted(self.pages):
            top = p.split('/', 1)[0]
            if '/' not in p or top in self._SKIP_DIRS:
                continue
            if p.rsplit('/', 1)[-1] in self._SKIP_FILES:
                continue
            groups.setdefault(top, []).append(
                {'path': p, 'title': self._frontmatter_title(p) or self._title_for(p)},
            )
        return {'groups': [{'kind': top, 'name': top, 'pages': pages}
                           for top, pages in groups.items()]}

    @staticmethod
    def _title_for(path: str) -> str:
        stem = path.rsplit('/', 1)[-1]
        return stem.removesuffix('.md')

    def _frontmatter_title(self, rel_path: str) -> str | None:
        """从页面的 frontmatter 取 paper.title / title，没有返回 None。"""
        content = self.pages.get(rel_path, '')
        if not content.startswith('---'):
            return None
        end = content.find('---', 3)
        if end <= 0:
            return None
        yaml_text = content[3:end]
        paper_title = None
        title = None
        for line in yaml_text.split('\n'):
            line = line.rstrip()
            if not line or line.startswith('#'):
                continue
            if ':' not in line:
                continue
            key, _, val = line.partition(':')
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key == 'paper.title':
                paper_title = val if val else None
            elif key == 'title':
                title = val if val else None
        return paper_title or title

    # —— read_page ——

    def read_page(self, rel_path: str) -> dict:
        self._validate_path(rel_path)
        if self._raise_on_read:
            raise self._raise_on_read
        if rel_path not in self.pages:
            raise FileNotFoundError(rel_path)
        return {
            'path': rel_path,
            'title': self._frontmatter_title(rel_path) or self._title_for(rel_path),
            'content': self.pages[rel_path],
        }

    # —— list_category_pages ——

    def list_category_pages(self) -> list:
        """全库 {path,title,content}（跳过私有目录/占位文件），供 categories 聚合（issue #84）。

        title 语义对齐 BindMountWikiFileSystem：frontmatter paper.title/title → H1 → 文件名。
        与 build_tree 不同：平铺收全库每页全文（含顶层散落页），不按目录分组。
        """
        out = []
        for p in sorted(self.pages):
            top = p.split('/', 1)[0]
            if '/' not in p or top in self._SKIP_DIRS:
                continue
            if p.rsplit('/', 1)[-1] in self._SKIP_FILES:
                continue
            content = self.pages[p]
            out.append({
                'path': p,
                'title': (self._frontmatter_title(p) or self._h1_title(content)
                          or self._title_for(p)),
                'content': content,
            })
        return out

    @staticmethod
    def _h1_title(content: str) -> str | None:
        """正文首个 `# ` 标题文本；无 H1 返回 None。"""
        for line in content.split('\n'):
            if line.startswith('# '):
                return line[2:].strip() or None
        return None

    # —— write_page ——

    def write_page(self, rel_path: str, content: str) -> dict:
        self._validate_path(rel_path)
        if self._raise_on_write:
            raise self._raise_on_write
        if rel_path not in self.pages:
            raise FileNotFoundError(rel_path)
        self.pages[rel_path] = content
        return {'path': rel_path}

    # —— create_page ——

    def create_page(self, rel_path: str, content: str) -> dict:
        self._validate_path(rel_path)
        if rel_path in self.pages:
            raise FileExistsError(rel_path)
        self.pages[rel_path] = content
        return {'path': rel_path}

    # —— delete_page ——

    def delete_page(self, rel_path: str) -> None:
        self._validate_path(rel_path)
        if rel_path not in self.pages:
            raise FileNotFoundError(rel_path)
        self.pages.pop(rel_path, None)


class FakeHealthProbe:
    """HealthProbe Port 的可控 fake：set_reachable 决定端口可达性（对齐 containers FakeHealthProbe）。"""

    def __init__(self) -> None:
        self.reachable_ports: set[int] = set()

    def set_reachable(self, port: int, reachable: bool = True) -> None:
        if reachable:
            self.reachable_ports.add(port)
        else:
            self.reachable_ports.discard(port)

    def is_reachable(self, port: int) -> bool:
        return port in self.reachable_ports

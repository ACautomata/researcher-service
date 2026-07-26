"""OpenClaw 防腐层 4 Port 的真实 Adapter（Hexagonal / spec #97 / ADR 0002）。

每个 Adapter 实现对应 Port（Protocol），路径各 ticket 填充实现：
- HttpHealthProbe（路径3，#99）—— 构造注入 http client，http://127.0.0.1:<port>/health
- BindMountWikiFileSystem（路径2，#100）—— 封装路径约定/五分类/越权防护，wiki/main 直读直写
- #101 DockerContainerRuntime
- OpenClawWireAdapter（路径4，#102-103）—— 配对握手 + 长连接 Adapter
"""
from __future__ import annotations

import asyncio
import json
import re
import urllib.request
from pathlib import Path
from typing import Any

from integration.openclaw.wire import ConnectFrameBuilder, REQUIRED_SCOPES


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


# ═══════════════════════════════════════════════════════════════════════════════
# WikiFileSystem Port 的 bind-mount Adapter（issue #100）
# ═══════════════════════════════════════════════════════════════════════════════

# 分类 → 子目录相对路径（与插件目录约定一致，r29 §4.2）
_GROUP_DIRS = {
    'concept': 'concepts',
    'entity': 'entities',
    'source': 'sources',
    'synthesis': 'syntheses',
    'report': 'reports',
}
_SKIP_DIRS = {'.openclaw-wiki', '_attachments', '_views'}
_SKIP_FILES = {'index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md'}
_WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')


class _FrontmatterParser:
    """解析 YAML frontmatter（双 schema 平铺键）。

    简易逐行解析（标量 + 行内 [a, b] 列表），不引入 pyyaml（r29 §3.4）。
    """

    @staticmethod
    def parse(content: str) -> tuple[dict, str]:
        frontmatter: dict = {}
        body = content
        if content.startswith('---'):
            end = content.find('---', 3)
            if end > 0:
                yaml_text = content[3:end].strip()
                body = content[end + 3:].strip()
                for line in yaml_text.split('\n'):
                    line = line.rstrip()
                    if not line or line.startswith('#'):
                        continue
                    if ':' in line:
                        key, _, val = line.partition(':')
                        key = key.strip()
                        val = val.strip()
                        if val.startswith('[') and val.endswith(']'):
                            val = [v.strip().strip('"').strip("'")
                                   for v in val[1:-1].split(',') if v.strip()]
                        elif val:
                            val = val.strip('"').strip("'")
                        else:
                            continue
                        if key and val != '':
                            frontmatter[key] = val
        return frontmatter, body


class BindMountWikiFileSystem:
    """路径2：wiki/main 直读直写（bind-mount）。封装路径约定/五分类/越权防护。

    构造注入 wiki_root 路径（`<home>/wiki/main`），不依赖 Instance 模型。
    """

    def __init__(self, wiki_root: str) -> None:
        self._root = Path(wiki_root)
        self._parser = _FrontmatterParser()

    # —— Port: build_tree ——

    def build_tree(self) -> dict:
        """遍历 wiki/main 文件树：五核心分类 + domains 子树分组。"""
        groups = []
        for kind, sub in _GROUP_DIRS.items():
            pages: list = []
            self._scan_dir(self._root / sub, f'{sub}/', pages)
            groups.append({'kind': kind, 'name': sub, 'pages': pages})

        domain_pages: list = []
        domains_dir = self._root / 'domains'
        if domains_dir.is_dir():
            for d in sorted(domains_dir.iterdir()):
                if not d.is_dir():
                    continue
                self._scan_dir(d / 'papers', f'domains/{d.name}/papers/', domain_pages)
        groups.append({'kind': 'domain', 'name': 'domains', 'pages': domain_pages})
        return {'groups': groups}

    # —— Port: read_page ——

    def read_page(self, rel_path: str) -> dict:
        """读一页 {path,title,content}；越权/不存在上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise FileNotFoundError(rel_path)
        content = fpath.read_text(encoding='utf-8')
        fm, _ = self._parser.parse(content)
        return {
            'path': rel_path,
            'title': fm.get('paper.title') or fm.get('title') or fpath.stem,
            'content': content,
        }

    # —— Port: write_page ——

    def write_page(self, rel_path: str, content: str) -> dict:
        """覆写已存在页（PUT）；不存在上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise FileNotFoundError(rel_path)
        fpath.write_text(content, encoding='utf-8')
        return {'path': rel_path}

    # —— Port: create_page ——

    def create_page(self, rel_path: str, content: str) -> dict:
        """新建页；目标已存在 → FileExistsError，父目录不存在 → NotADirectoryError。"""
        fpath = self._resolve(rel_path)
        if fpath.exists():
            raise FileExistsError(rel_path)
        if not fpath.parent.is_dir():
            raise NotADirectoryError(rel_path)
        fpath.write_text(content, encoding='utf-8')
        return {'path': rel_path}

    # —— Port: delete_page ——

    def delete_page(self, rel_path: str) -> None:
        """删除页；不存在上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise FileNotFoundError(rel_path)
        fpath.unlink()

    # —— internal ——

    def _resolve(self, rel_path: str) -> Path:
        """解析相对 wiki/main 的路径为绝对路径；越权（穿越/managed）→ ValueError。"""
        self._assert_not_managed(rel_path)
        root = self._root.resolve()
        fpath = (root / rel_path).resolve()
        if root != fpath and root not in fpath.parents:
            raise ValueError(rel_path)
        return fpath

    @staticmethod
    def _assert_not_managed(rel_path: str) -> None:
        parts = rel_path.split('/')
        if any(seg in _SKIP_DIRS for seg in parts):
            raise ValueError(rel_path)
        if parts[-1] in _SKIP_FILES:
            raise ValueError(rel_path)

    def _scan_dir(self, dirpath: Path, rel_prefix: str, pages_out: list) -> None:
        """扫描单层目录的 .md 页面。"""
        if not dirpath.is_dir():
            return
        for f in sorted(dirpath.iterdir()):
            if not f.is_file():
                continue
            if f.suffix != '.md' or f.name in _SKIP_FILES:
                continue
            rel = f'{rel_prefix}{f.name}'
            pages_out.append({
                'path': rel,
                'title': self._page_title(f, f.stem),
            })

    def _page_title(self, fpath: Path, fallback: str) -> str:
        """从 frontmatter 取标题。"""
        try:
            raw = fpath.read_text(encoding='utf-8')[:2000]
        except OSError:
            return fallback
        fm, _ = self._parser.parse(raw)
        return fm.get('paper.title') or fm.get('title') or fallback


# ═══════════════════════════════════════════════════════════════════════════════
# OpenClawWire Port 的 WS Adapter（issue #102-103）
# ═══════════════════════════════════════════════════════════════════════════════


class OpenClawWireAdapter:
    """路径4：配对握手 + 长连接 Adapter（issue #102 配对握手；#103 长连）。

    实现 OpenClawWire Port。transport 注入（默认 websockets.connect），测试用 fake。
    握手经 ConnectFrameBuilder 单一来源构造 connect 帧。
    """

    def __init__(self, transport=None, timeout: float = 10.0) -> None:
        self._connect = transport or self._default_connect
        self._timeout = timeout

    @staticmethod
    async def _default_connect(url: str):
        """默认 transport：websockets.connect（惰性 import，避免测试依赖真连接）。"""
        import websockets

        return websockets.connect(url)

    async def pair(self, *, url: str, identity: Any, bootstrap_token: str) -> Any:
        """配对握手（spec §8.1）：challenge(nonce) → connect(device 签名) → PairingResult。

        三分支：PairingResult(hello-ok) / PairingRequired(requestId) / PairingError。
        与 PairingHandshake.pair() 功能等价，但经 ConnectFrameBuilder 构建 connect 帧。
        """
        from chat.pairing_ws import PairingError, PairingRequired, PairingResult

        try:
            async with self._connect(url) as ws:
                deadline = asyncio.get_event_loop().time() + self._timeout
                # 1. 等 connect.challenge（event）取 nonce
                nonce = await self._await_nonce(ws, deadline)
                # 2. 发 connect（经 ConnectFrameBuilder 单一来源构建）
                import uuid

                req_id = uuid.uuid4().hex
                frame = ConnectFrameBuilder.pairing(
                    req_id=req_id,
                    identity=identity,
                    token=bootstrap_token,
                    nonce=nonce,
                )
                await ws.send(json.dumps(frame))
                # 3. 等 connect res（按 id 匹配）
                return await self._await_connect_res(ws, req_id, deadline)
        except (PairingRequired, PairingError):
            raise
        except Exception as e:
            raise PairingError(str(e)) from e

    async def _recv_until(self, ws, deadline: float, predicate, describe: str) -> dict:
        """循环读帧直到 predicate 命中或超时；忽略无关帧。"""
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                from chat.pairing_ws import PairingError

                raise PairingError(f'timeout waiting for {describe}')
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if predicate(msg):
                return msg

    async def _await_nonce(self, ws, deadline: float) -> str:
        from chat.pairing_ws import PairingError

        msg = await self._recv_until(
            ws, deadline,
            lambda m: m.get('type') == 'event' and m.get('event') == 'connect.challenge',
            'connect.challenge',
        )
        nonce = (msg.get('payload') or {}).get('nonce')
        if not nonce:
            raise PairingError('connect.challenge missing nonce')
        return nonce

    async def _await_connect_res(self, ws, req_id: str, deadline: float) -> Any:
        from chat.pairing_ws import PairingError, PairingRequired, PairingResult

        msg = await self._recv_until(
            ws, deadline,
            lambda m: m.get('type') == 'res' and m.get('id') == req_id,
            f'connect res (id={req_id})',
        )
        if msg.get('ok'):
            auth = (msg.get('payload') or {}).get('auth') or {}
            device_token = auth.get('deviceToken')
            if not device_token:
                raise PairingError('hello-ok missing auth.deviceToken')
            scopes = auth.get('scopes') or []
            missing = REQUIRED_SCOPES - set(scopes)
            if missing:
                raise PairingError(f'hello-ok missing required scopes: {sorted(missing)}')
            return PairingResult(device_token=device_token, scopes=list(scopes))
        error = msg.get('error') or {}
        if error.get('code') == 'PAIRING_REQUIRED':
            request_id = (error.get('details') or {}).get('requestId', '')
            if not isinstance(request_id, str) or not request_id:
                raise PairingError('PAIRING_REQUIRED response missing requestId')
            raise PairingRequired(request_id)
        raise PairingError(error.get('message') or error.get('code') or 'connect failed')

    # —— OpenClawWire Port 其余方法（#103 长连填充实现）——

    async def connect(self, url: str, device_token: str) -> None:
        raise NotImplementedError('#103 长连填充实现')

    async def send(self, content: str, on_event: Any) -> str:
        raise NotImplementedError('#103 长连填充实现')

    async def close(self) -> None:
        raise NotImplementedError('#103 长连填充实现')

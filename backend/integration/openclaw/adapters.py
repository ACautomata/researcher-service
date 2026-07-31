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

from integration.openclaw.wire import (
    REQUIRED_SCOPES,
    ChatClientError,
    ChatConnectError,
    ChatSendError,
    ChatSendTransmittedError,
    ConnectFrameBuilder,
)


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
        except Exception:  # pylint: disable=broad-exception-caught  # §45 故障隔离:连不上/非2xx/timeout 统一不可达
            # URLError（连不上）/ HTTPError（非 2xx）/ timeout —— 统一不可达
            return False


# ═══════════════════════════════════════════════════════════════════════════════
# WikiFileSystem Port 的 bind-mount Adapter（issue #100）
# ═══════════════════════════════════════════════════════════════════════════════

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
    """路径2：wiki/main 直读直写（bind-mount）。封装路径约定/物理树分组/越权防护。

    构造注入 wiki_root 路径（`<home>/wiki/main`），不依赖 Instance 模型。
    build_tree 照实平铺磁盘真实子目录（issue #83，不写死目录集合）。
    """

    def __init__(self, wiki_root: str) -> None:
        self._root = Path(wiki_root)
        self._parser = _FrontmatterParser()

    # —— Port: build_tree ——

    def build_tree(self) -> dict:
        """照实平铺 wiki/main 根目录真实子目录：每个含页的目录成一组（kind=name=目录名）。

        开放词表（issue #83 / #75）：不预设五分类，扫描到什么返回什么——骨架目录、开放
        domain 子目录、任意未知目录一律平等成组；递归收该目录下全部 .md；跳过插件私有
        目录（_SKIP_DIRS）与占位文件（_SKIP_FILES）；物理存在但无页的目录不成组。
        wiki root 不存在（模板未初始化/被删）、root 路径上容器可写的两段（`<home>/wiki`
        或 `<home>/wiki/main`）被换成 symlink（指向其它实例/宿主路径），或 root 不可读
        （容器 chmod 000）时一律返回空树，不上抛（codex #125 P1/P2）。
        """
        groups = []
        # 容器进程在自己 home 内可写 wiki/ 与 wiki/main/,能把任一段换成 symlink 指向
        # 其它实例或宿主路径(codex #125 P1)。更上层的 <home> 是宿主路径,容器看不到,
        # 不必检查——且 macOS /var → /private/var 这类系统级 symlink 不应误判。
        # 检查 root 与其直接父,任一是 symlink 即拒绝遍历。
        if (self._root.is_symlink() or self._root.parent.is_symlink()
                or not self._root.is_dir()):
            return {'groups': groups}
        try:
            children = sorted(self._root.iterdir())
        except OSError:
            # root 存在但不可读(如 chmod 000) → 空树(codex #125 P2)
            return {'groups': groups}
        for d in children:
            if not d.is_dir() or d.is_symlink() or d.name in _SKIP_DIRS:
                continue
            pages: list = []
            self._scan_dir(d, f'{d.name}/', pages)
            if pages:
                groups.append({'kind': d.name, 'name': d.name, 'pages': pages})
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

    # —— Port: list_category_pages ——

    def list_category_pages(self) -> list:
        """递归扫全库 .md（含顶层散落页），返回 [{path,title,content}]（issue #84）。

        与 build_tree 共享 root 防护（root/父 symlink 或不可读 → 空）与 _scan_dir 遍历防护
        （跳过 _SKIP_DIRS/_SKIP_FILES/symlink/非 regular file）。不同点：categories 按文档内
        标记分组、与磁盘目录无关，故平铺收全库每页全文（含顶层散落 .md，build_tree 不收顶层）。
        """
        if (self._root.is_symlink() or self._root.parent.is_symlink()
                or not self._root.is_dir()):
            return []
        try:
            children = sorted(self._root.iterdir())
        except OSError:
            return []
        pages: list = []
        for d in children:
            if d.is_symlink():
                continue
            if d.is_dir():
                if d.name not in _SKIP_DIRS:
                    self._scan_dir(d, f'{d.name}/', pages, with_content=True)
            elif d.is_file() and d.suffix == '.md' and d.name not in _SKIP_FILES:
                entry = self._page_entry(d, d.name, with_content=True)
                if entry is not None:
                    pages.append(entry)
        return pages

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

    def _scan_dir(self, dirpath: Path, rel_prefix: str, pages_out: list,
                  with_content: bool = False) -> None:
        """迭代扫描目录下全部 .md 页面(跳过插件私有子目录、占位文件与一切 symlink)。

        用显式栈替代递归,深度仅受文件系统路径上限约束,不会触发 RecursionError
        (codex #125 P2);每层 iterdir 包 OSError,单目录不可读仅跳过该子树,不影响
        其它分支(codex #125 P2)。with_content=True 时每页附全文 content（categories 聚合用）。
        """
        if not dirpath.is_dir():
            return
        # 栈元素: (待扫目录绝对路径, 该目录对应的相对前缀, 是否已展开)
        # 经典先 push 后展开模式:遇到目录先压栈,弹出时再 iterdir,便于包 OSError。
        stack: list[tuple[Path, str]] = [(dirpath, rel_prefix)]
        while stack:
            cur_dir, cur_prefix = stack.pop()
            try:
                entries = sorted(cur_dir.iterdir())
            except OSError:
                # 目录在扫描间隙被删/被 chmod → 跳过该子树(codex #125 P2)
                continue
            for f in entries:
                # 不跟随任何 symlink(目录或文件):防经树遍历/泄露 wiki/main 之外的文件
                if f.is_symlink():
                    continue
                if f.is_dir():
                    if f.name not in _SKIP_DIRS:
                        stack.append((f, f'{cur_prefix}{f.name}/'))
                    continue
                # 仅收 regular file:FIFO/socket/device 命名 .md 会让 _page_title 阻塞
                # worker(codex #125 P1)。
                if not f.is_file():
                    continue
                if f.suffix != '.md' or f.name in _SKIP_FILES:
                    continue
                rel = f'{cur_prefix}{f.name}'
                entry = self._page_entry(f, rel, with_content)
                if entry is not None:
                    pages_out.append(entry)
        # 栈式 DFS 弹出顺序与字典序相反(LIFO),而前端 FileTree 按数组顺序渲染不再排序;
        # 末尾按 path 字典序重排,保持显示顺序稳定(codex #125 P2)。
        pages_out.sort(key=lambda p: p['path'])

    def _page_entry(self, fpath: Path, rel: str, with_content: bool) -> dict | None:
        """构造一页 entry：{path,title}（默认），with_content=True 时加 content 全文。

        with_content 时 title 语义对齐 read_page：frontmatter paper.title/title → H1 → 文件名
        （build_tree 的 _page_title 只读前 2000 字、不回落 H1，保持原行为不动）。
        with_content=True 但正文读不出（并发删除/不可读/非法 UTF-8）时返回 None —— 调用方跳过
        该页，保证 port 契约「每页必带 content」不被破坏（codex #129 P2）。
        """
        if not with_content:
            return {'path': rel, 'title': self._page_title(fpath, fpath.stem)}
        content = self._read_text(fpath)
        if content is None:
            return None
        fm, body = self._parser.parse(content)
        title = fm.get('paper.title') or fm.get('title') or self._h1_title(body) or fpath.stem
        return {'path': rel, 'title': title, 'content': content}

    @staticmethod
    def _h1_title(body: str) -> str | None:
        """正文首个 `# ` 标题文本（无 frontmatter 时的标题兜底）；无 H1 返回 None。"""
        for line in body.split('\n'):
            if line.startswith('# '):
                return line[2:].strip() or None
        return None

    @staticmethod
    def _read_text(fpath: Path) -> str | None:
        """读全文；读取/解码失败返回 None（调用方决定跳过或降级）。"""
        try:
            return fpath.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            return None

    def _page_title(self, fpath: Path, fallback: str) -> str:
        """从 frontmatter 取标题。

        读失败(OSError,如文件被并发删除/权限)或解码失败(UnicodeDecodeError,容器写
        入非 UTF-8 字节的 .md)时退到文件名 fallback,不上抛——单文件不应让整棵树 500
        (codex #125 P2)。
        """
        try:
            raw = fpath.read_text(encoding='utf-8')[:2000]
        except (OSError, UnicodeDecodeError):
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
    长连 RPC（chat.send / approval.resolve / commands.list / sessions.* / chat.history）
    均可 fake WS 单测，不依赖真 gateway。
    """

    def __init__(self, transport=None, timeout: float = 10.0) -> None:
        self._connect_factory = transport or self._default_connect
        self._timeout = timeout
        self._connect_timeout = timeout
        self._ack_timeout = timeout
        self._device_token: str | None = None
        # 长连状态
        self._ws = None
        self._cm = None
        self._recv_task: asyncio.Task | None = None
        self._pending_acks: dict[str, tuple[asyncio.Future, Any]] = {}
        self._pending_resolves: dict[str, asyncio.Future] = {}
        self._routes: dict[str, Any] = {}
        self._closed: bool = False
        self._dead: bool = False
        self._translator = None  # lazy init in connect
        # 连接级审批订阅者
        self._approval_subscribers: list = []

    @staticmethod
    def _default_connect(url: str):
        """默认 transport：websockets.connect（惰性 import，避免测试依赖真连接）。"""
        import websockets

        return websockets.connect(url)

    async def pair(self, url: str, identity: Any, bootstrap_token: str) -> Any:
        """配对握手（spec §8.1）：challenge(nonce) → connect(device 签名) → PairingResult。

        三分支：PairingResult(hello-ok) / PairingRequired(requestId) / PairingError。
        与 PairingHandshake.pair() 功能等价，但经 ConnectFrameBuilder 构建 connect 帧。
        """
        from chat.pairing_ws import PairingError, PairingRequired

        try:
            async with self._connect_factory(url) as ws:
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
        # ghcr 2026.6.34 官方镜像（ADR 0003）返回两段嵌套 code：外层 NOT_PAIRED，
        # 内层 details.code=PAIRING_REQUIRED（requestId 也在 details 内）。先按内层码
        # 判，兼容外层码直接是 PAIRING_REQUIRED 的旧实现与 fork 镜像。
        code = error.get('code', '')
        details = error.get('details') or {}
        inner_code = details.get('code', '') if isinstance(details, dict) else ''
        if code == 'PAIRING_REQUIRED' or inner_code == 'PAIRING_REQUIRED':
            request_id = details.get('requestId', '')
            if not isinstance(request_id, str) or not request_id:
                raise PairingError('PAIRING_REQUIRED response missing requestId')
            raise PairingRequired(request_id)
        raise PairingError(error.get('message') or error.get('code') or 'connect failed')

    async def connect(self, url: str, device_token: str, *, identity, nonce: str, scopes) -> None:
        """建立已配对长连接（deviceToken 作 auth.token + Ed25519 device 签名块，经 ConnectFrameBuilder.session 构建帧）。

        issue #139：identity/nonce/scopes 透传给 session()（nonce 等 challenge、scopes 读 Pairing 由 #140/#141 接入）。
        """
        import json
        import uuid

        self._device_token = device_token
        self._cm = self._connect_factory(url)
        self._ws = await self._cm.__aenter__()  # pylint: disable=unnecessary-dunder-call  # C2801 长连手动管理异步 CM(跨 connect/close 持句柄),非 async with 可圈定
        req_id = uuid.uuid4().hex
        try:
            await self._ws.send(
                json.dumps(ConnectFrameBuilder.session(
                    req_id=req_id, identity=identity, device_token=device_token,
                    nonce=nonce, scopes=scopes,
                )))
            await asyncio.wait_for(self._await_res(req_id), timeout=self._connect_timeout)
        except ChatConnectError:
            await self._cleanup_ws()
            self._ws = None
            self._cm = None
            raise
        except BaseException as exc:
            await self._cleanup_ws()
            self._ws = None
            self._cm = None
            raise ChatConnectError(str(exc)) from exc
        if self._translator is None:
            from chat.event_translate import ChatEventTranslator
            self._translator = ChatEventTranslator()
        self._recv_task = asyncio.create_task(self._recv_loop())

    # ── send_message ─────────────────────────────────────────────────────────

    async def send_message(
        self, session_key: str, message: str, on_event: Any, *, idempotency_key: str | None = None,
    ) -> str:
        if self._ws is None or self.dead:
            # codex #219 十二轮 P2-331：recv loop 退出置 _dead=True 后 _ws 非空，仅查 _ws 仍会注册
            # ack 并发帧——recv loop 已无法处理 ack/事件，网关或收下 run 但输出丢失，最终只暴露为
            # ack 超时。对齐 OpenClawChatClient.send_message：dead（_dead or _closed）视为已断连，
            # 注册/发送前拒发，consumer 走 dead 重取换健康 client。
            raise ChatClientError('client not connected')
        import uuid
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_acks[req_id] = (fut, on_event)
        frame = {
            'type': 'req', 'id': req_id, 'method': 'chat.send',
            'params': {
                'sessionKey': session_key,
                'message': message,
                'agentId': 'main',
                # codex #219 P2：consumer 自愈重试复用同 key（网关幂等去重）；缺省生成新 key
                'idempotencyKey': idempotency_key or uuid.uuid4().hex,
            },
        }
        # codex #219 十轮 P2-934：ws.send 不能再放 try 外原样上抛——send 刷帧中途 socket 关闭时
        # 帧字节可能已部分到达网关（网关或已起 run），原样抛原生 ConnectionClosed 会被 consumer 当
        # 「确定未传输」安全重试 → 重复执行工具 / 把幂等去重的 run 挂到收不到事件的连接。对齐
        # OpenClawChatClient.send_message（chat_client.py:609-625）：send 前快照 dead，发送前已死
        # （帧确定未发出）才原生上抛可重试；发送尝试中抛出的 close 一律归 transmitted（不确定，不盲发）。
        from websockets.exceptions import ConnectionClosed

        dead_before_send = self._dead
        try:
            await self._ws.send(json.dumps(frame))
        except ConnectionClosed as exc:
            self._pending_acks.pop(req_id, None)
            if dead_before_send:
                raise  # 发送前已死：帧确定未发出，原生上抛（consumer 据此安全重试）
            raise ChatSendTransmittedError('chat.send socket closed mid-send') from exc
        try:
            run_id = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出、ack 超时——网关可能已起 run；不可盲重试（丢事件流）
            raise ChatSendTransmittedError('chat.send ack timeout') from exc
        except ChatSendError:
            # 网关显式拒绝（ack ok:false）——确定未起 run，原样上抛（可安全重试）
            self._pending_acks.pop(req_id, None)
            raise
        except BaseException as exc:
            self._pending_acks.pop(req_id, None)
            # codex #219 P1：帧已发出后 recv loop 死（_fail_pending_acks 置 ChatClientError）
            # ——可能已起 run；包装为 ChatSendTransmittedError 让 consumer 判不可盲重试。
            if isinstance(exc, ChatClientError):
                raise ChatSendTransmittedError(str(exc)) from exc
            raise
        # codex #219 十二轮 P2-921：对齐 chat_client——route 已由 _resolve_ack 在 recv loop 里
        # 装好（adapters.py:764-765），此处发送协程恢复后不再重装，避免 aclose fail+clear 后
        # 把 route 重新装到已关闭 client 上（浏览器永久 pending）。
        return run_id

    # ── resolve_approval ─────────────────────────────────────────────────────

    async def resolve_approval(self, approval_id: str, kind: str, decision: str) -> dict:
        if self._ws is None or self.dead:
            # codex #219 十二轮 P2-331：同 send_message——dead 视为已断连，closing/recv 死期间拒发
            # 审批回覆（避免 future 注册后 ack/resolved 事件随死连接丢失，已执行的卡被超时误复位）。
            raise ChatClientError('client not connected')
        import uuid
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': f'{kind}.approval.resolve',
            'params': {'id': approval_id, 'decision': decision},
        }
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('approval.resolve ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    # ── list_pending_approvals ────────────────────────────────────────────────

    async def list_pending_approvals(self) -> list[dict]:
        if self._ws is None:
            return []
        import uuid
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': 'exec.approval.list', 'params': {}}
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except BaseException:  # pylint: disable=broad-exception-caught  # §45 故障隔离:list 失败仅返回空,不炸长连
            self._pending_resolves.pop(req_id, None)
            return []
        # 实测校准（spike ghcr 2026.6.34-browser, 2026-07-27）：payload 可能直接是 list
        # （空 [] / 非空 [{...}]），也可能是 dict {approvals:[...]}。list 上调 .get 会崩，先判类型。
        # 与 OpenClawChatClient.list_pending_approvals 同源 dispatch（codex P2：两实现不可漂移）。
        if isinstance(payload, list):
            items = payload
        elif isinstance(payload, dict):
            items = payload.get('approvals')
            if items is None:
                single = payload.get('approval')
                items = [single] if isinstance(single, dict) else []
        else:
            items = []
        if not isinstance(items, list):
            return []
        from chat.event_translate import ChatEventTranslator
        cards = []
        for item in items:
            if not isinstance(item, dict):
                continue
            card = ChatEventTranslator._approval_card('exec.approval.requested', item)
            if card is not None:
                cards.append(card)
        return cards

    # ── list_commands ─────────────────────────────────────────────────────────

    async def list_commands(self) -> dict:
        if self._ws is None:
            raise ChatClientError('client not connected')
        import uuid
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {
            'type': 'req', 'id': req_id, 'method': 'commands.list',
            'params': {'agentId': 'main', 'scope': 'both', 'includeArgs': True},
        }
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError('commands.list ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    # ── sessions_rpc ──────────────────────────────────────────────────────────

    async def sessions_rpc(self, method: str, params: dict) -> dict:
        if self._ws is None or self.dead:
            # codex #219 十二轮 P2-331：同 send_message——dead 视为已断连，closing/recv 死期间拒发
            # sessions/history RPC（避免 future 注册后 ack 随死连接丢失、调用方空等超时）。
            raise ChatClientError('client not connected')
        import uuid
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_resolves[req_id] = fut
        frame = {'type': 'req', 'id': req_id, 'method': method, 'params': params}
        try:
            await self._ws.send(json.dumps(frame))
            payload = await asyncio.wait_for(fut, timeout=self._ack_timeout)
        except TimeoutError as exc:
            self._pending_resolves.pop(req_id, None)
            raise ChatSendError(f'{method} ack timeout') from exc
        except BaseException:
            self._pending_resolves.pop(req_id, None)
            raise
        return payload or {}

    # ── approval subscribers ──────────────────────────────────────────────────

    def add_approval_subscriber(self, cb: Any) -> None:
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb: Any) -> None:
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    def approval_subscribers(self) -> list:
        """返回当前全部审批订阅者的副本（codex #219 P2：共享 client 自愈迁移用）。"""
        return list(self._approval_subscribers)

    async def broadcast_approval_resolved(self, approval_id: str, decision: str) -> None:
        """把一次权威 resolve 结果 fan-out 到全部订阅者（codex R2 P2）。"""
        frame = {'type': 'approvalResolved', 'id': approval_id, 'decision': decision}
        for cb in list(self._approval_subscribers):
            try:
                await cb(frame)
            except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:单订阅者回调失败不阻断 fan-out
                pass

    # ── discard / close ───────────────────────────────────────────────────────

    @property
    def dead(self) -> bool:
        return self._dead or self._closed

    def discard(self, run_id: str) -> None:
        self._routes.pop(run_id, None)

    async def close(self) -> None:
        self._closed = True
        self._fail_pending_acks('client closed')
        self._fail_pending_resolves('client closed')
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):  # pylint: disable=broad-exception-caught  # §46 故障隔离:close 等 recv_task 收尾失败不阻断
                pass
        await self._cleanup_ws()

    async def _cleanup_ws(self) -> None:
        """关闭 WS 连接与其 context manager（多路径复用：正常 close/握手失败/recv 死）。"""
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:清理路径吞异常,保 idempotent close
                pass
            self._ws = None
        if self._cm is not None:
            try:
                await self._cm.__aexit__(None, None, None)
            except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:清理路径吞异常
                pass
            self._cm = None

    # ── recv loop ─────────────────────────────────────────────────────────────

    async def _recv_loop(self) -> None:
        try:
            while True:
                raw = await self._ws.recv()
                msg = json.loads(raw)
                if msg.get('type') == 'res':
                    self._resolve_ack(msg)
                else:
                    await self._handle_event(msg)
        except Exception:  # pylint: disable=broad-exception-caught  # §45 故障隔离:recv 死仅标记 dead + 失败 pending,不外抛炸任务
            self._dead = True
            if not self._closed:
                self._fail_pending_acks('connection lost')
                self._fail_pending_resolves('connection lost')
                await self._notify_all_error('connection lost')

    def _resolve_ack(self, msg: dict) -> None:
        rid = msg.get('id')
        # approval.resolve / commands.list / sessions_rpc 的回执
        resolve_fut = self._pending_resolves.pop(rid, None)
        if resolve_fut is not None:
            if not resolve_fut.done():
                if msg.get('ok'):
                    resolve_fut.set_result(msg.get('payload'))
                else:
                    err = msg.get('error') or {}
                    resolve_fut.set_exception(
                        ChatSendError(err.get('message') or err.get('code') or 'RPC failed'))
            return
        # chat.send ack
        entry = self._pending_acks.pop(rid, None)
        if entry is None:
            return
        fut, on_event = entry
        if fut.done():
            return
        if msg.get('ok'):
            run_id = (msg.get('payload') or {}).get('runId')
            if run_id:
                self._routes[run_id] = on_event
                fut.set_result(run_id)
            else:
                fut.set_exception(ChatSendError('chat.send ack missing runId'))
        else:
            err = msg.get('error') or {}
            fut.set_exception(ChatSendError(err.get('message') or err.get('code') or 'chat.send failed'))

    async def _handle_event(self, msg: dict) -> None:
        frames = self._translator.translate(msg)
        if not frames:
            return
        run_id = frames[0].get('runId')
        if run_id is None:
            # 连接级审批帧 → fan-out
            for translated in frames:
                if translated.get('type') not in ('approval', 'approvalResolved'):
                    continue
                for cb in list(self._approval_subscribers):
                    try:
                        await cb(translated)
                    except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:单订阅者失败不阻断连接级 fan-out
                        pass
            return
        cb = self._routes.get(run_id)
        if cb is None:
            return
        terminal = False
        for translated in frames:
            try:
                await cb(translated)
            except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:单回调失败不阻断后续帧路由
                pass
            if translated.get('type') in ('done', 'error'):
                terminal = True
        if terminal:
            self._routes.pop(run_id, None)

    # ── await helpers ─────────────────────────────────────────────────────────

    async def _await_res(self, req_id: str) -> dict:
        while True:
            raw = await self._ws.recv()
            msg = json.loads(raw)
            if msg.get('type') == 'res' and msg.get('id') == req_id:
                if not msg.get('ok'):
                    raise ChatConnectError('connect handshake rejected by gateway')
                return msg

    async def _notify_all_error(self, message: str) -> None:
        self._fail_pending_acks(message)
        self._fail_pending_resolves(message)
        for run_id, cb in list(self._routes.items()):
            try:
                await cb({'type': 'error', 'runId': run_id, 'message': message})
            except Exception:  # pylint: disable=broad-exception-caught  # §46 故障隔离:error 通知单回调失败不阻断
                pass
        self._routes.clear()

    def _fail_pending_acks(self, message: str) -> None:
        for entry in list(self._pending_acks.values()):
            fut = entry[0]
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_acks.clear()

    def _fail_pending_resolves(self, message: str) -> None:
        for fut in list(self._pending_resolves.values()):
            if not fut.done():
                fut.set_exception(ChatClientError(message))
        self._pending_resolves.clear()

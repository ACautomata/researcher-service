"""OpenClaw 防腐层 4 Port 的真实 Adapter（Hexagonal / spec #97 / ADR 0002）。

每个 Adapter 实现对应 Port（Protocol）：
- HttpHealthProbe（路径3，#99）—— 构造注入 http client，http://127.0.0.1:<port>/health
- BindMountWikiFileSystem（路径2，#100）—— 封装路径约定/五分类/越权防护，wiki/main 直读直写
- #101 DockerContainerRuntime
- 路径4 OpenClawWire —— 唯一实现已迁入 integration.openclaw.wire_client.OpenClawWireClient
  （#231 / ADR 0004 收敛，原 OpenClawWireAdapter 已删除；见文件尾部注释）。
"""
from __future__ import annotations

import re
import urllib.request
from pathlib import Path


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
# 路径4 OpenClawWire：唯一实现已迁入 integration.openclaw.wire_client.OpenClawWireClient
# （#231 / ADR 0004 收敛）——原 OpenClawWireAdapter 已删除（生产零实例化的停滞栈；ADR 0004 删
# adapter 而非补齐接线）。路径2/3 Adapter 保留（上方 HttpHealthProbe / BindMountWikiFileSystem）。
# ═══════════════════════════════════════════════════════════════════════════════

"""wiki 文件系统直读/直写服务 —— spec §6 / r29。

直读宿主 `instances/<name>/home/wiki/main`（bind-mount，与容器内同一目录），不经容器
gateway。结构：五核心分类 concepts/entities/sources/syntheses/reports + domains/<d>/papers/
子树；跳过 .openclaw-wiki 等插件私有目录与占位文件。path 一律相对 wiki/main 的 posix 相对路径，
经 realpath 校验防目录穿越（spec §4 零信任）。graph = 遍历出节点 + 解析 [[wikilink]]/related_pages 出边。

构造注入 WikiFileSystem Port（issue #100）：默认为 BindMountWikiFileSystem（真实 bind-mount
Adapter），测试注入 FakeWikiFileSystem 隔离文件系统。wiki compile 仍经 CompileFleet（不变）。
"""
import re
from pathlib import Path

from integration.openclaw.ports import WikiFileSystem

# obsidian 风格双链 [[target]] 或 [[target|别名]]
WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')

# category 机读标记：整行匹配、大小写不敏感（含 CATEGORY/cAtEgOrY 等全形态）、剥离尾反引号
# （research 加固，issue #84 / spec #75；IGNORECASE 全词匹配 codex #129 P2）
CATEGORY_RE = re.compile(r'^`category:\s*([^`\s]+)`\s*$', re.MULTILINE | re.IGNORECASE)
# H1 / H2 标题行（界定提取窗口）
_H1_RE = re.compile(r'^#\s', re.MULTILINE)
_H2_RE = re.compile(r'^##\s', re.MULTILINE)

# excerpt 摘要长度（正文开头片段，字符数）
_EXCERPT_LEN = 200


class CategoryMarkerExtractor:
    """从 markdown 正文提取 `` `category:` `` 机读标记 + 摘要（issue #84 / spec #75）。

    提取只在「第一个 H1 之下、首个 `##` 之前」窗口内进行：正文里行内混排的 `` `category:` ``
    字样、H1 之前、首个 `##` 之后的标记一律不抓。开放词表：扫到什么值返回什么，不预设集合。
    """

    def extract_category(self, body: str) -> str | None:
        """窗口内首个命中的 category 值（小写归一）；无命中返回 None。"""
        window = self._window(body)
        if window is None:
            return None
        m = CATEGORY_RE.search(window)
        return m.group(1).lower() if m else None

    def excerpt(self, body: str) -> str:
        """正文开头片段摘要：剥掉 H1 标题行与 category 标记行，压缩空白后截断。"""
        lines = [ln for ln in body.split('\n')
                 if ln.strip() and not ln.startswith('# ') and not CATEGORY_RE.match(ln)]
        text = re.sub(r'\s+', ' ', ' '.join(lines)).strip()
        return text[:_EXCERPT_LEN]

    @staticmethod
    def _window(body: str) -> str | None:
        """「第一个 H1 之下、首个 ## 之前」的窗口文本；无 H1 返回 None。"""
        lines = body.split('\n')
        h1 = next((i for i, ln in enumerate(lines) if _H1_RE.match(ln)), None)
        if h1 is None:
            return None
        h2 = next((i for i, ln in enumerate(lines[h1 + 1:], h1 + 1)
                   if _H2_RE.match(ln)), len(lines))
        return '\n'.join(lines[h1 + 1:h2])


class PageNotFound(Exception):
    """目标 .md 不存在。"""


class PageExists(Exception):
    """新建目标已存在。"""


class InvalidPath(Exception):
    """path 越界（目录穿越/绝对路径/非 wiki/main 内）。"""


class FrontmatterParser:
    """解析 YAML frontmatter（双 schema 平铺键）。

    简易逐行解析（标量 + 行内 [a, b] 列表），不引入 pyyaml（r29 §3.4：人读浏览页
    只需 title 与标量标签；嵌套 claims 等不解析）。兼容插件官方 title 与 researcher paper.title。
    """

    def parse(self, content: str) -> tuple[dict, str]:
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
                            continue  # 嵌套键（如 paper:/claims:）无行内值，跳过
                        if key and val != '':
                            frontmatter[key] = val
        return frontmatter, body


class WikiService:
    """单个容器 wiki/main 的直读/直写（构造注入 WikiFileSystem Port，组合 FrontmatterParser）。"""

    def __init__(self, instance,
                 fs: WikiFileSystem | None = None,
                 parser: FrontmatterParser | None = None,
                 extractor: CategoryMarkerExtractor | None = None) -> None:
        self._instance = instance
        self._parser = parser or FrontmatterParser()
        self._extractor = extractor or CategoryMarkerExtractor()
        if fs is None:
            from integration.openclaw.adapters import BindMountWikiFileSystem

            wiki_root = str(Path(instance.home_dir) / 'wiki' / 'main')
            self._fs: WikiFileSystem = BindMountWikiFileSystem(wiki_root)
        else:
            self._fs = fs

    def build_tree(self) -> dict:
        """遍历 wiki/main 文件树：五核心分类 + domains 子树分组。"""
        return self._fs.build_tree()

    def list_categories(self) -> dict:
        """按 category 标记分组带标记页（issue #84 / spec #75）。

        返回 `{ "<category>": [ {path,title,category,excerpt}, … ], … }`；只收带标记页，
        无标记页与插件私有目录/占位文件（fs 层已过滤）不进响应。category 开放词表，
        扫到什么返回什么。组名按字典序、组内按 path 字典序，保证响应稳定。
        """
        groups: dict[str, list] = {}
        for page in self._fs.list_category_pages():
            _, body = self._parser.parse(page['content'])
            category = self._extractor.extract_category(body)
            if category is None:
                continue
            groups.setdefault(category, []).append({
                'path': page['path'],
                'title': page['title'],
                'category': category,
                'excerpt': self._extractor.excerpt(body),
            })
        return {cat: sorted(items, key=lambda p: p['path'])
                for cat, items in sorted(groups.items())}

    def read_page(self, rel_path: str) -> dict:
        """读一页 {path,title,content}；页不存在/越权路径上抛。"""
        try:
            return self._fs.read_page(rel_path)
        except ValueError as e:
            raise InvalidPath(str(e)) from e
        except FileNotFoundError as e:
            raise PageNotFound(str(e)) from e

    def write_page(self, rel_path: str, content: str) -> dict:
        """覆写已存在页（PUT）；不存在/越权上抛。"""
        try:
            return self._fs.write_page(rel_path, content)
        except ValueError as e:
            raise InvalidPath(str(e)) from e
        except FileNotFoundError as e:
            raise PageNotFound(str(e)) from e

    def create_page(self, rel_path: str, content: str) -> dict:
        """新建一页（POST）；已存在/越权/父目录不存在上抛。"""
        try:
            return self._fs.create_page(rel_path, content)
        except ValueError as e:
            raise InvalidPath(str(e)) from e
        except FileExistsError as e:
            raise PageExists(str(e)) from e
        except NotADirectoryError as e:
            raise InvalidPath(str(e)) from e

    def delete_page(self, rel_path: str) -> None:
        """删除一页；不存在/越权上抛。"""
        try:
            self._fs.delete_page(rel_path)
        except ValueError as e:
            raise InvalidPath(str(e)) from e
        except FileNotFoundError as e:
            raise PageNotFound(str(e)) from e

    def build_graph(self) -> dict:
        """全库图谱：节点=遍历树全部页；边=正文 [[wikilink]] + frontmatter related_pages。

        wikilink 目标解析顺序（r29 §3.3）：按 path 末段去 .md → 按 title → 按节点 id；
        匹配不到则生成 ghost 虚节点（obsidian 幽灵节点语义）。
        """
        all_pages = [p for g in self.build_tree()['groups'] for p in g['pages']]
        resolver = _WikilinkResolver(all_pages)
        nodes = [{'id': p['path'], 'title': p['title']} for p in all_pages]
        node_ids = {p['path'] for p in all_pages}
        edges: list = []
        ghosts: dict = {}

        for page in all_pages:
            try:
                content = self._fs.read_page(page['path'])['content']
            except Exception:  # pylint: disable=broad-exception-caught
                continue
            fm, body = self._parser.parse(content)
            targets = [m.group(1).split('|')[0].strip()
                       for m in WIKILINK_RE.finditer(body)]
            related = fm.get('related_pages', [])
            if isinstance(related, str):
                related = [related]
            targets += list(related)
            for raw in targets:
                if not raw:
                    continue
                to_id = resolver.resolve(raw)
                if to_id is None:
                    ghost_id = raw
                    if ghost_id not in node_ids and ghost_id not in ghosts:
                        ghosts[ghost_id] = {'id': ghost_id, 'title': raw, 'ghost': True}
                    to_id = ghost_id
                edges.append({'from': page['path'], 'to': to_id})

        return {'nodes': nodes + list(ghosts.values()), 'edges': edges}


class _WikilinkResolver:
    """把 wikilink 目标解析为节点 id（path 末段/title/id 兜底，r29 §3.3）。"""

    def __init__(self, pages: list) -> None:
        self._by_stem: dict[str, str] = {}
        self._by_title: dict[str, str] = {}
        self._ids: set[str] = set()
        for p in pages:
            path = p['path']
            self._ids.add(path)
            stem = path.rsplit('/', 1)[-1][:-3] if path.endswith('.md') else path
            self._by_stem.setdefault(stem, path)
            if p.get('title'):
                self._by_title.setdefault(p['title'], path)

    def resolve(self, target: str) -> str | None:
        # 路径形态（[[a/b/c.md]] 或 [[a/b/c]]）→ 末段去 .md；否则按 title/id 兜底
        t = target.strip()
        if t in self._ids:
            return t
        stem = t.rsplit('/', 1)[-1]
        stem = stem.removesuffix('.md')
        if stem in self._by_stem:
            return self._by_stem[stem]
        if t in self._by_title:
            return self._by_title[t]
        return None

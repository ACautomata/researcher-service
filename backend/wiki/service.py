"""wiki 文件系统直读/直写服务 —— spec §6 / r29。

直读宿主 `instances/<name>/home/wiki/main`（bind-mount，与容器内同一目录），不经容器
gateway。结构：五核心分类 concepts/entities/sources/syntheses/reports + domains/<d>/papers/
子树；跳过 .openclaw-wiki 等插件私有目录与占位文件。path 一律相对 wiki/main 的 posix 相对路径，
经 realpath 校验防目录穿越（spec §4 零信任）。graph = 遍历出节点 + 解析 [[wikilink]]/related_pages 出边。
"""
import re
from pathlib import Path

# 分类 → 子目录相对路径（与插件目录约定一致，勿自造命名 —— r29 §4.2）
GROUP_DIRS = {
    'concept': 'concepts',
    'entity': 'entities',
    'source': 'sources',
    'synthesis': 'syntheses',
    'report': 'reports',
}
# 应跳过的目录（插件私有/下划线视图；domains 单独按子树处理）
SKIP_DIRS = {'.openclaw-wiki', '_attachments', '_views'}
SKIP_FILES = {'index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md'}

# obsidian 风格双链 [[target]] 或 [[target|别名]]
WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')


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
    """单个容器 wiki/main 的直读/直写（组合 FrontmatterParser，无自由函数）。"""

    def __init__(self, instance, parser: FrontmatterParser | None = None) -> None:
        self._instance = instance
        self._root = Path(instance.home_dir) / 'wiki' / 'main'
        self._parser = parser or FrontmatterParser()

    def build_tree(self) -> dict:
        """遍历 wiki/main 文件树：五核心分类 + domains 子树分组。"""
        groups = []
        for kind, sub in GROUP_DIRS.items():
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

    def read_page(self, rel_path: str) -> dict:
        """读取一页：{path, title, content}。PageNotFound / InvalidPath 上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise PageNotFound(rel_path)
        content = fpath.read_text(encoding='utf-8')
        fm, _ = self._parser.parse(content)
        return {
            'path': rel_path,
            'title': fm.get('paper.title') or fm.get('title') or fpath.stem,
            'content': content,
        }

    def write_page(self, rel_path: str, content: str) -> dict:
        """覆盖已存在页（PUT）：只写已存在文件，不新建、不动 index.md。PageNotFound 上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise PageNotFound(rel_path)
        fpath.write_text(content, encoding='utf-8')
        return {'path': rel_path}

    def create_page(self, rel_path: str, content: str) -> dict:
        """新建一页（POST）：父目录须已存在；目标已存在 → PageExists。"""
        fpath = self._resolve(rel_path)
        if fpath.exists():
            raise PageExists(rel_path)
        if not fpath.parent.is_dir():
            raise InvalidPath(rel_path)  # 分类目录不存在（沿用插件目录约定，不自造）
        fpath.write_text(content, encoding='utf-8')
        return {'path': rel_path}

    def delete_page(self, rel_path: str) -> None:
        """删除一页（DELETE）：PageNotFound 上抛。"""
        fpath = self._resolve(rel_path)
        if not fpath.is_file():
            raise PageNotFound(rel_path)
        fpath.unlink()

    def _resolve(self, rel_path: str) -> Path:
        """把相对 wiki/main 的 path 解析为绝对路径；越界（穿越/不在 root 内）→ InvalidPath。"""
        root = self._root.resolve()
        fpath = (root / rel_path).resolve()
        if root != fpath and root not in fpath.parents:
            raise InvalidPath(rel_path)
        return fpath

    def _scan_dir(self, dirpath: Path, rel_prefix: str, pages_out: list) -> None:
        """扫描单层目录的 .md 页面（跳过占位/索引），path 用相对 wiki/main 的 posix 路径。"""
        if not dirpath.is_dir():
            return
        for f in sorted(dirpath.iterdir()):
            if not f.is_file():
                continue
            if f.suffix != '.md' or f.name in SKIP_FILES:
                continue
            rel = f'{rel_prefix}{f.name}'
            pages_out.append({
                'path': rel,
                'title': self._page_title(f, f.stem),
            })

    def _page_title(self, fpath: Path, fallback: str) -> str:
        """从 frontmatter 取标题（paper.title 优先，兼容插件 title）。"""
        try:
            raw = fpath.read_text(encoding='utf-8')[:2000]
        except OSError:
            return fallback
        fm, _ = self._parser.parse(raw)
        return fm.get('paper.title') or fm.get('title') or fallback

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
            fpath = self._root / page['path']
            try:
                content = fpath.read_text(encoding='utf-8')
            except OSError:
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
        if stem.endswith('.md'):
            stem = stem[:-3]
        if stem in self._by_stem:
            return self._by_stem[stem]
        if t in self._by_title:
            return self._by_title[t]
        return None

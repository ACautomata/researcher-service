"""外部文献搜索服务 —— arXiv API"""
import httpx
import xml.etree.ElementTree as ET
from config import cfg


async def search_arxiv(keyword: str, max_results: int = 10) -> list[dict]:
    """搜索 arXiv，返回结构化结果"""
    if not cfg.ARXIV_ENABLED:
        return []

    url = "http://export.arxiv.org/api/query"
    params = {
        "search_query": f"all:{keyword}",
        "start": 0,
        "max_results": max_results,
        "sortBy": "relevance",
        "sortOrder": "descending",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        root = ET.fromstring(resp.text)

    ns = {"atom": "http://www.w3.org/2005/Atom"}
    results = []

    for entry in root.findall("atom:entry", ns):
        title = entry.find("atom:title", ns)
        summary = entry.find("atom:summary", ns)
        published = entry.find("atom:published", ns)

        # 提取作者
        authors = []
        for author in entry.findall("atom:author", ns):
            name = author.find("atom:name", ns)
            if name is not None and name.text:
                authors.append(name.text)

        results.append({
            "title": (title.text or "").replace("\n", " ").strip(),
            "summary": (summary.text or "").replace("\n", " ").strip()[:300],
            "authors": authors[:5],
            "year": (published.text or "")[:4],
            "arxiv_id": "",
            "relevance": 0,
        })

        # 提取 arXiv ID
        for link in entry.findall("atom:id", ns):
            if link.text and "abs/" in link.text:
                results[-1]["arxiv_id"] = link.text.split("abs/")[-1]

    return results


async def search_external(keyword: str, source: str = "arxiv") -> list[dict]:
    """统一外部搜索入口"""
    if source == "arxiv":
        return await search_arxiv(keyword)
    elif source == "semantic_scholar":
        return await _search_s2(keyword)
    elif source == "openreview":
        return await _search_openreview(keyword)
    return []


async def _search_s2(keyword: str) -> list[dict]:
    """Semantic Scholar 搜索"""
    url = "https://api.semanticscholar.org/graph/v1/paper/search"
    params = {"query": keyword, "limit": 10, "fields": "title,authors,year,abstract"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                data = resp.json()
                results = []
                for paper in data.get("data", []):
                    authors = [a.get("name", "") for a in paper.get("authors", [])]
                    results.append({
                        "title": paper.get("title", ""),
                        "summary": (paper.get("abstract", "") or "")[:300],
                        "authors": authors[:5],
                        "year": str(paper.get("year", "")),
                        "arxiv_id": "",
                        "relevance": 0,
                    })
                return results
    except Exception:
        pass
    return []


async def _search_openreview(keyword: str) -> list[dict]:
    """OpenReview 搜索（简化实现）"""
    # OpenReview 没有稳定公开搜索 API，返回空列表
    # 实际生产中可以使用其官方 API 或爬虫
    return []
#!/usr/bin/env python3
"""
Fetch latest papers from papers.cool CS feed and format for Feishu.
"""
import urllib.request
import xml.etree.ElementTree as ET
import re
from datetime import datetime, timezone

FEEDS = [
    ("人工智能", "https://papers.cool/arxiv/cs.AI/feed"),
    ("机器学习", "https://papers.cool/arxiv/cs.LG/feed"),
    ("计算机视觉", "https://papers.cool/arxiv/cs.CV/feed"),
    ("自然语言处理", "https://papers.cool/arxiv/cs.CL/feed"),
    ("机器人", "https://papers.cool/arxiv/cs.RO/feed"),
    ("神经计算", "https://papers.cool/arxiv/cs.NE/feed"),
]

def fetch_feed(name, url, max_entries=15):
    """Fetch and parse a papers.cool Atom feed."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode('utf-8')
    except Exception as e:
        return f"  ❌ {name} 获取失败: {e}\n"

    try:
        root = ET.fromstring(content)
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        entries = root.findall('atom:entry', ns)[:max_entries]
    except Exception as e:
        return f"  ❌ {name} 解析失败: {e}\n"

    lines = [f"**{name}** ({len(entries)}篇)\n"]
    for entry in entries:
        title = entry.find('atom:title', ns)
        link = entry.find('atom:link', ns)
        authors = entry.findall('atom:author/atom:name', ns)
        summary = entry.find('atom:summary', ns)

        title_text = title.text if title is not None else "无标题"
        link_href = link.get('href') if link is not None else ""

        # Clean title (remove extra whitespace)
        title_text = re.sub(r'\s+', ' ', title_text).strip()

        # Get first 3 authors
        author_names = [a.text for a in authors[:3]]
        if len(authors) > 3:
            author_str = ", ".join(author_names) + f" 等{len(authors)}人"
        else:
            author_str = ", ".join(author_names) if author_names else "未知"

        # Truncate summary to ~150 chars
        summary_text = ""
        if summary is not None and summary.text:
            summary_text = re.sub(r'\s+', ' ', summary.text).strip()
            if len(summary_text) > 150:
                summary_text = summary_text[:150] + "..."

        # Format entry
        if link_href:
            lines.append(f"• [{title_text}]({link_href})\n")
        else:
            lines.append(f"• {title_text}\n")

        if author_str:
            lines.append(f"  作者: {author_str}\n")

        if summary_text:
            lines.append(f"  摘要: {summary_text}\n")

        lines.append("\n")  # 空行分隔

    return "".join(lines)


def main():
    output = ["📚 **papers.cool 最新论文速递**\n"]
    output.append(f"🕐 更新时间: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n")

    for name, url in FEEDS:
        result = fetch_feed(name, url)
        output.append(result)

    output.append("---\n")
    output.append("📎 RSS订阅: https://papers.cool/arxiv/cs/feed\n")
    output.append("分类: cs.AI, cs.LG, cs.CV, cs.CL, cs.RO, cs.NE")

    print("".join(output))


if __name__ == "__main__":
    main()

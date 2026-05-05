"""文献解析服务 —— 从上传文件中提取纯文本"""
import os
import tempfile
from pathlib import Path


def extract_text(filepath: str, ext: str) -> str:
    """根据文件扩展名选择解析方式"""
    ext = ext.lower().lstrip(".")
    if ext == "pdf":
        return _parse_pdf(filepath)
    elif ext in ("docx", "doc"):
        return _parse_docx(filepath)
    elif ext in ("txt", "md"):
        return _parse_plain(filepath)
    elif ext in ("tex", "latex"):
        return _parse_latex(filepath)
    else:
        return _parse_plain(filepath)


def _parse_pdf(filepath: str) -> str:
    import pdfplumber
    pages_text = []
    with pdfplumber.open(filepath) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages_text.append(text)
    return "\n\n".join(pages_text)


def _parse_docx(filepath: str) -> str:
    from docx import Document
    doc = Document(filepath)
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def _parse_plain(filepath: str) -> str:
    encodings = ["utf-8", "gbk", "gb2312", "latin-1"]
    for enc in encodings:
        try:
            with open(filepath, "r", encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    return ""


def _parse_latex(filepath: str) -> str:
    """简单去除 LaTeX 命令，保留文本内容"""
    import re
    text = _parse_plain(filepath)
    # 移除注释
    text = re.sub(r"%.*", "", text)
    # 移除常见命令参数
    text = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])*(\{[^\}]*\})*", "", text)
    # 移除残留大括号
    text = text.replace("{", "").replace("}", "")
    # 合并多余空行
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
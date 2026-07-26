"""wiki 序列化器 —— spec §4 零信任：path 校验（防目录穿越）+ 出参。

path 为相对 wiki/main 的 posix 相对路径，禁绝对路径、`..` 段、反斜杠穿越；service 层再经
realpath 二次校验（双保险）。出参 Serializer 接收 service 返回的 dict。
"""
from rest_framework import serializers


class RelPathField(serializers.CharField):
    """相对 wiki/main 的 .md 路径字段：拒绝对路径/穿越段/反斜杠（spec §4）。"""

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        v = value.strip()
        if not v:
            raise serializers.ValidationError('path 不能为空')
        if v.startswith(('/', '\\')):
            raise serializers.ValidationError('path 须为相对路径')
        if '\\' in v:
            raise serializers.ValidationError('path 不允许反斜杠')
        parts = [p for p in v.split('/') if p not in ('', '.')]
        if any(p == '..' for p in parts):
            raise serializers.ValidationError('path 不允许目录穿越')
        if not parts or not parts[-1].endswith('.md'):
            raise serializers.ValidationError('path 须指向 .md 文件')
        return '/'.join(parts)


class WikiPathSerializer(serializers.Serializer):
    """GET/DELETE page 的 query path 校验。"""

    path = RelPathField(max_length=512)


class WikiPageWriteSerializer(serializers.Serializer):
    """PUT/POST page 的 body 校验：path + content。"""

    path = RelPathField(max_length=512)
    # trim_whitespace=False：保留 markdown 原文首尾空白/尾换行（编辑器逐字落盘）
    content = serializers.CharField(allow_blank=True, trim_whitespace=False)


class WikiPageSerializer(serializers.Serializer):
    """页面出参（read）：path/title/content。"""

    path = serializers.CharField(read_only=True)
    title = serializers.CharField(read_only=True)
    content = serializers.CharField(read_only=True)


class WikiTreePageSerializer(serializers.Serializer):
    path = serializers.CharField(read_only=True)
    title = serializers.CharField(read_only=True)


class WikiTreeGroupSerializer(serializers.Serializer):
    kind = serializers.CharField(read_only=True)
    name = serializers.CharField(read_only=True)
    pages = WikiTreePageSerializer(many=True, read_only=True)


class WikiTreeSerializer(serializers.Serializer):
    groups = WikiTreeGroupSerializer(many=True, read_only=True)


class WikiCategoryItemSerializer(serializers.Serializer):
    """categories 条目出参（issue #84）：path/title/category/excerpt。"""

    path = serializers.CharField(read_only=True)
    title = serializers.CharField(read_only=True)
    category = serializers.CharField(read_only=True)
    excerpt = serializers.CharField(read_only=True)

"""AI API 调用服务"""
import json
import asyncio
import httpx
from services.user_credentials import get_effective_llm

_sem = asyncio.Semaphore(5)
_timeout = httpx.Timeout(120.0, connect=10.0)


async def chat(messages, temperature=0.7, max_tokens=4096):
    """
    调用 AI API，返回文本。
    注意：不发送 response_format 参数，兼容所有 AI 提供商
    """
    base, key, model = await get_effective_llm()
    if not key or key == "sk-your-key":
        raise RuntimeError("请先在「个人配置」页面或 .env 中配置 API Key（SK）")

    url = f"{base.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    async with _sem:
        async with httpx.AsyncClient(timeout=_timeout) as c:
            resp = await c.post(url, headers=headers, json=payload)
            # 打印真实错误，方便排查
            if resp.status_code != 200:
                print(f"\n[AI 错误] HTTP {resp.status_code}")
                print(f"[AI 错误] URL: {url}")
                print(f"[AI 错误] Model: {model}")
                print(f"[AI 错误] 响应: {resp.text[:500]}\n")
                resp.raise_for_status()

            data = resp.json()
            # 兼容不同的 API 响应格式
            if "choices" in data and len(data["choices"]) > 0:
                return data["choices"][0]["message"]["content"].strip()
            elif "output" in data:
                return data["output"]
            elif "content" in data:
                return data["content"]
            elif "message" in data:
                return data["message"]
            else:
                raise RuntimeError(f"无法解析 API 响应: {json.dumps(data)[:200]}")


async def chat_json(messages, temperature=0.3):
    """
    调用 AI 并解析 JSON。
    通过 prompt 要求返回 JSON，不用 response_format，兼容所有提供商。
    """
    # 在 system 消息里强调返回 JSON
    sys_msg = {"role": "system", "content": "你必须且只能返回合法的 JSON，不要包含 markdown 代码块标记（不要 ```json ```），直接输出 JSON 文本。"}
    if messages and messages[0]["role"] == "system":
        # 合并到原有的 system 消息
        original = messages[0]["content"]
        messages[0] = {"role": "system", "content": sys_msg["content"] + "\n\n" + original}
    else:
        messages.insert(0, sys_msg)

    text = await chat(messages, temperature=temperature)

    # 清理可能的 markdown 包裹
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()

    return json.loads(text)


# ===================================================================
# 下面是各 Pipeline 步骤的 prompt 模板 + 调用函数
# ===================================================================

async def extract_entries(text, filename):
    """从文献文本提取知识条目"""
    messages = [
        {"role": "system", "content": "你是一位学术文献分析专家。根据提供的文献文本，提取结构化信息。"},
        {"role": "user", "content": f"""从以下文献中提取知识条目。每个条目包含标题、分类、关键发现。

文献来源：{filename}
文献内容：
---
{text[:8000]}
---

返回格式：
{{
  "entries": [
    {{"title": "条目标题", "category": "分类（如：深度学习/表征学习/图学习/生成模型/强化学习/多模态/NLP）", "keywords": ["关键词1", "关键词2"], "status": "draft"}}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.3)


async def extract_keywords(entries):
    """从条目中提取并计算关键词权重"""
    entries_text = "\n".join(
        f"- [{e['category']}] {e['title']}: {', '.join(e.get('keywords', []))}"
        for e in entries
    )
    messages = [
        {"role": "system", "content": "你是一位学术关键词提取专家。从给定文本中提取核心学术关键词。"},
        {"role": "user", "content": f"""从以下知识条目中提取关键词，并为每个词评估权重(1-10)。
权重说明：10=极其核心且高频，1=边缘相关。

条目列表：
{entries_text}

返回格式：
{{
  "keywords": [
    {{"word": "关键词", "weight": 8.5, "category": "所属分类"}}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.2)


async def discover_problems(entries, depth="deep", extra_texts=None):
    """从知识条目中发现研究问题"""
    if extra_texts:
        combined = "\n\n".join([
            f"--- 文献 {i+1} ---\n{text[:3000]}"
            for i, text in enumerate(extra_texts) if text
        ])
        entries_text = f"以下为文献的文本内容，请基于此分析研究问题：\n\n{combined[:10000]}"
    else:
        entries_text = "\n".join(
            f"- [{e['category']}] {e['title']}"
            for e in entries
        )
    depth_hint = {
        "quick": "快速扫描，只找最明显的问题",
        "deep": "深入分析每个条目的方法论述、实验结论、局限性声明",
        "cross": "交叉对比不同条目，寻找矛盾和空白",
    }.get(depth, "深度分析")

    messages = [
        {"role": "system", "content": "你是一位学术研究问题发现专家。分析给定知识条目，识别其中的研究局限性、方法矛盾、未解决的问题和研究空白。"},
        {"role": "user", "content": f"""分析以下知识条目，发现研究问题。
分析深度：{depth_hint}

条目列表：
{entries_text}

返回格式：
{{
  "problems": [
    {{
      "title": "问题描述标题",
      "description": "详细描述（50-100字）",
      "category": "所属分类",
      "severity": "high 或 medium"
    }}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.4)


async def validate_problem(problem, entries):
    """验证单个问题的合理性和重要性"""
    entries_summary = "\n".join(
        f"- {e['title']} ({e['category']})"
        for e in entries[:20]
    )
    messages = [
        {"role": "system", "content": "你是学术问题评审专家，评估研究问题的合理性和重要性。"},
        {"role": "user", "content": f"""评估以下研究问题：

问题：{problem['title']}
描述：{problem['description']}
分类：{problem['category']}

参考知识库：
{entries_summary}

返回 JSON：
{{"score": 7, "method": "交叉引用分析", "reasoning": "评分理由"}}"""}
    ]
    return await chat_json(messages, temperature=0.2)


async def generate_ideas(problems, direction=None):
    """基于问题生成研究Idea"""
    problems_text = "\n".join(
        f"- [{p['severity']}] {p['title']}: {p['description']}"
        for p in problems
    )
    direction_hint = f"\n创新方向偏好：{direction}" if direction else ""

    messages = [
        {"role": "system", "content": "你是一位创新研究思路生成专家。基于已验证的研究问题，提出具体、可行、有创新性的研究思路。"},
        {"role": "user", "content": f"""基于以下已验证的研究问题，生成具体可行的研究思路。
每个Idea需要给出创新性、可行性、影响力的评分(1-10)。

问题列表：
{problems_text}
{direction_hint}

返回格式：
{{
  "ideas": [
    {{
      "title": "Idea标题",
      "description": "详细描述（80-150字，包含核心方法思路）",
      "from_problem": "来源问题标题",
      "novelty": 8.5,
      "feasibility": 7.0,
      "impact": 9.0
    }}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.7)


async def suggest_params(task_description: str) -> dict:
    """根据任务描述生成推荐参数组合"""
    messages = [
        {"role": "system", "content": "你是一位深度学习调参专家。根据用户描述的任务，推荐一组合理的超参数搜索范围。"},
        {"role": "user", "content": f"""用户任务描述：{task_description}

请推荐深度学习模型的超参数搜索网格，输出 JSON 格式。

参考参数：d_model(隐藏层维度)、nhead(注意力头数)、num_layers(层数)、dropout(丢弃率)、lr(学习率)、batch_size(批次大小)。

返回格式（每个参数给出 2-3 个推荐值）：
{{
  "task_name": "简短的任务名称",
  "description": "参数设计说明",
  "params": {{
    "d_model": [256, 512],
    "nhead": [4, 8],
    "num_layers": [3, 6],
    "dropout": [0.1, 0.3],
    "lr": ["3e-4", "1e-3"],
    "batch_size": [32, 64]
  }}
}}"""}
    ]
    return await chat_json(messages, temperature=0.3)


async def generate_algorithm(idea, language="Python"):
    """基于Idea生成算法代码"""
    messages = [
        {"role": "system", "content": "你是一位算法研究工程师。根据研究思路描述，生成完整的算法实现代码。要求：代码可运行、包含完整 import、包含类型标注和注释。"},
        {"role": "user", "content": f"""根据以下研究思路，用 {language} 实现完整算法。

Idea标题：{idea['title']}
描述：{idea['description']}

返回 JSON：
{{
  "name": "算法类/函数名称（英文，如 SSMLinearAttention）",
  "code": "完整可运行的 {language} 代码，包含 import、类定义、forward/run 方法、基本注释",
  "test_cases": [
    {{"name": "测试用例名称", "input": "输入描述", "expected": "预期输出描述"}}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.3)


async def generate_code_project(description: str, language: str = "Python") -> dict:
    """根据用户描述生成完整的代码项目（多文件）"""
    messages = [
        {"role": "system", "content": "你是一位资深算法工程师。根据用户描述生成完整的代码项目，包含多个文件。"},
        {"role": "user", "content": f"""根据以下描述生成代码项目：

描述：{description}
语言：{language}

要求：生成完整的可运行项目，包含模型定义、训练脚本、配置文件、README。

返回 JSON 格式（至少 3 个文件）：
{{
  "name": "项目英文名",
  "files": [
    {{"path": "src/model.py", "content": "完整的 Python 代码"}},
    {{"path": "src/train.py", "content": "完整的训练脚本"}},
    {{"path": "config.py", "content": "配置文件"}},
    {{"path": "README.md", "content": "项目说明"}}
  ],
  "test_summary": "测试方法简述",
  "test_cases": [
    {{"name": "测试1", "input": "输入", "expected": "预期输出"}}
  ]
}}"""}
    ]
    return await chat_json(messages, temperature=0.3)

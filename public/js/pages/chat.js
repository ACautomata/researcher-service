/* ===== 论文辅助写作 — 从内容构思到语言润色，全面辅助论文写作 ===== */
var chatHistory = [];
var chatStreaming = false;
var chatEvtSource = null;
var chatSection = 'free';

var CHAT_SECTIONS = [
  { id:'free', label:'自由对话', icon:'fa-comment-dots', color:'#64748b' },
  { id:'abstract', label:'摘要', icon:'fa-text-height', color:'#3b6df0' },
  { id:'introduction', label:'引言', icon:'fa-door-open', color:'#10b981' },
  { id:'methods', label:'方法', icon:'fa-flask', color:'#8b5cf6' },
  { id:'results', label:'结果', icon:'fa-chart-bar', color:'#f59e0b' },
  { id:'discussion', label:'讨论', icon:'fa-comments', color:'#f97316' },
  { id:'conclusion', label:'结论', icon:'fa-flag-checkered', color:'#ef4444' }
];

var CHAT_TEMPLATES = [
  { id:'outline', label:'生成大纲', icon:'fa-list-ol', color:'#3b6df0',
    prompt:'请为我的学术论文生成一个详细的大纲。论文主题是关于[请在此描述您的研究主题]。请包括：1) 论文标题建议 2) 各章节标题 3) 每个章节的核心内容要点。' },
  { id:'abstract', label:'撰写摘要', icon:'fa-file-lines', color:'#10b981',
    prompt:'请根据以下研究内容，撰写一份约300字的学术论文摘要。要求：1) 简明扼要说明研究背景和目的 2) 概述研究方法 3) 总结主要发现 4) 阐明研究意义。研究内容：[请在此粘贴或描述您的研究内容]' },
  { id:'polish', label:'润色段落', icon:'fa-wand-magic-sparkles', color:'#8b5cf6',
    prompt:'请帮我润色以下学术段落，提升其学术性和可读性。要求：1) 保持原意不变 2) 使用更专业的学术表达 3) 优化句式结构 4) 确保逻辑连贯。原文：[请在此粘贴需要润色的段落]' },
  { id:'translate', label:'中英互译', icon:'fa-language', color:'#f59e0b',
    prompt:'请将以下内容翻译为学术英语（或中文），保持学术论文的专业风格和术语准确性：[请在此粘贴需要翻译的内容]' },
  { id:'review', label:'文献综述', icon:'fa-book-open', color:'#f97316',
    prompt:'请帮我撰写一段关于[研究领域/主题]的文献综述。要求：1) 梳理该领域的主要研究方向 2) 总结关键研究成果 3) 指出研究空白或争议 4) 引出本研究的必要性。' },
  { id:'format', label:'格式检查', icon:'fa-check-double', color:'#ef4444',
    prompt:'请检查以下学术文本的格式和规范性：1) 引用格式是否一致 2) 术语使用是否规范 3) 图表编号是否正确 4) 参考文献格式。文本内容：[请在此粘贴需要检查的内容]' }
];

var CHAT_SECTION_PROMPTS = {
  'abstract': '你是一个学术论文写作助手，正在帮助用户撰写论文摘要。摘要应简明扼要地概括研究背景、目的、方法、结果和结论。',
  'introduction': '你是一个学术论文写作助手，正在帮助用户撰写论文引言。引言应介绍研究背景、文献综述、研究空白和研究目的。',
  'methods': '你是一个学术论文写作助手，正在帮助用户撰写方法部分。方法应详细描述实验设计、数据收集和分析方法。',
  'results': '你是一个学术论文写作助手，正在帮助用户撰写结果部分。结果应客观呈现研究发现，使用数据支撑。',
  'discussion': '你是一个学术论文写作助手，正在帮助用户撰写讨论部分。讨论应解释结果意义、与已有研究比较、指出局限性。',
  'conclusion': '你是一个学术论文写作助手，正在帮助用户撰写结论部分。结论应总结主要发现、研究贡献和未来方向。',
  'free': '你是一个专业的学术论文写作助手，可以帮助用户完成论文各部分的撰写、修改和优化。请用中文回复。'
};

pages.chat = async function() {
  var h = '';

  // ── Header ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">论文辅助写作</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="从内容构思到语言润色，全面辅助论文写作。支持各章节撰写、润色、翻译、格式检查等功能"></i></div>';
  h += '<button class="btn" onclick="clearChat()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-eraser"></i> 清空对话</button>';
  h += '</div>';

  // ── Section Selector ──
  h += '<div class="tab-bar mb16" style="flex-wrap:wrap">';
  for (var i = 0; i < CHAT_SECTIONS.length; i++) {
    var s = CHAT_SECTIONS[i];
    h += '<button class="tab-btn'+(chatSection===s.id?' on':'')+'" onclick="selectChatSection(\''+s.id+'\')" style="font-size:11px;padding:6px 12px">';
    h += '<i class="fa-solid '+s.icon+'" style="color:'+s.color+'"></i> '+s.label;
    h += '</button>';
  }
  h += '</div>';

  // ── Quick Templates ──
  h += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">';
  for (var i = 0; i < CHAT_TEMPLATES.length; i++) {
    var t = CHAT_TEMPLATES[i];
    h += '<button class="btn" onclick="useTemplate(\''+t.id+'\')" style="font-size:11px;padding:6px 12px;border-color:'+t.color+'30;color:'+t.color+'">';
    h += '<i class="fa-solid '+t.icon+'"></i> '+t.label;
    h += '</button>';
  }
  h += '</div>';

  // ── Chat Messages ──
  h += '<div class="card mb24" style="padding:16px">';
  h += '<div id="chatMessages" style="min-height:40vh;max-height:50vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:flex;flex-direction:column;gap:12px;padding:4px 0">';
  if (!chatHistory.length) {
    h += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px">';
    h += '<div style="text-align:center;max-width:400px">';
    h += '<i class="fa-solid fa-file-pen" style="font-size:36px;display:block;margin-bottom:12px;opacity:.15"></i>';
    h += '<p style="font-weight:600;margin-bottom:8px">开始你的论文写作之旅</p>';
    h += '<p style="font-size:11px;line-height:1.6">选择一个写作章节或快捷模板开始，或直接在下方输入你的需求。<br>支持：大纲生成、摘要撰写、段落润色、中英互译、文献综述、格式检查。</p>';
    h += '</div></div>';
  } else {
    chatHistory.forEach(function(msg) {
      h += renderChatMsg(msg.role, msg.content);
    });
  }
  h += '</div>';

  // ── Input ──
  h += '<div style="display:flex;gap:10px;margin-top:14px;align-items:flex-end">';
  h += '<div style="flex:1"><textarea class="inp" id="chatInput" rows="2" placeholder="输入论文写作需求...（Enter 发送，Shift+Enter 换行）" style="resize:vertical;min-height:44px;font-size:13px;line-height:1.6" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();sendChat()}"></textarea></div>';
  h += '<button class="btn bp" onclick="sendChat()" id="chatSendBtn" style="padding:10px 20px;font-size:13px;flex-shrink:0;height:fit-content"><i class="fa-solid fa-paper-plane"></i> 发送</button>';
  h += '</div></div>';

  return h;
};

/* ── Section Selector ── */
function selectChatSection(sectionId) {
  chatSection = sectionId;
  // Re-render the page to update tab styles
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.chat) {
    pages.chat().then(function(html) { ctn.innerHTML = html; });
  }
}

/* ── Template Quick Actions ── */
function useTemplate(templateId) {
  var tpl = null;
  for (var i = 0; i < CHAT_TEMPLATES.length; i++) {
    if (CHAT_TEMPLATES[i].id === templateId) { tpl = CHAT_TEMPLATES[i]; break; }
  }
  if (!tpl) return;

  var input = document.getElementById('chatInput');
  if (input) {
    input.value = tpl.prompt;
    input.focus();
    // Place cursor at the first [ bracket
    var pos = tpl.prompt.indexOf('[');
    if (pos >= 0 && input.setSelectionRange) {
      input.setSelectionRange(pos, tpl.prompt.indexOf(']', pos) + 1);
    }
  }
}

/* ── Chat Rendering ── */
function renderChatMsg(role, content) {
  var isUser = role === 'user';
  var align = isUser ? 'flex-end' : 'flex-start';
  var bg = isUser ? 'rgba(59,109,240,.08)' : 'var(--bg)';
  var border = isUser ? 'rgba(59,109,240,.15)' : 'var(--border)';
  var name = isUser ? '你' : 'AI 写作助手';
  var ic = isUser ? 'fa-user' : 'fa-robot';

  var h = '<div style="display:flex;flex-direction:column;align-items:' + align + ';max-width:85%">';
  h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid ' + ic + '"></i> ' + name + '</div>';
  h += '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--text);word-break:break-word;white-space:pre-wrap">' + esc(content) + '</div>';
  h += '</div>';
  return h;
}

/* ── Send Chat ── */
async function sendChat() {
  var input = document.getElementById('chatInput');
  if (!input || !input.value.trim() || chatStreaming) return;
  var text = input.value.trim();
  input.value = '';
  chatStreaming = true;
  var btn = document.getElementById('chatSendBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  // Add user message
  chatHistory.push({role: 'user', content: text});
  var msgArea = document.getElementById('chatMessages');
  msgArea.innerHTML += renderChatMsg('user', text);
  msgArea.innerHTML += '<div id="chatLoading" style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-robot"></i> AI 写作助手</div><div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-muted);font-size:13px"><i class="fa-solid fa-spinner fa-spin"></i> 正在撰写...</div></div>';
  msgArea.scrollTop = msgArea.scrollHeight;

  try {
    // Build context-aware message
    var sectionPrompt = CHAT_SECTION_PROMPTS[chatSection] || CHAT_SECTION_PROMPTS['free'];
    var fullMessage = sectionPrompt + '\n\n用户请求：' + text;

    var res = await api('POST', '/chat/send', {message: fullMessage, history: chatHistory.slice(0, -1)});
    var loading = document.getElementById('chatLoading');
    if (loading) loading.remove();
    var reply = res.response || '(无回复)';
    chatHistory.push({role: 'assistant', content: reply});
    msgArea.innerHTML += renderChatMsg('assistant', reply);
    msgArea.scrollTop = msgArea.scrollHeight;
  } catch(e) {
    var loading = document.getElementById('chatLoading');
    if (loading) loading.remove();
    msgArea.innerHTML += renderChatMsg('assistant', '错误: ' + e.message);
  }
  chatStreaming = false;
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送';
}

/* ── Clear Chat ── */
function clearChat() {
  chatHistory = [];
  chatSection = 'free';
  var msgArea = document.getElementById('chatMessages');
  if (msgArea) {
    msgArea.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px"><div style="text-align:center;max-width:400px"><i class="fa-solid fa-file-pen" style="font-size:36px;display:block;margin-bottom:12px;opacity:.15"></i><p style="font-weight:600;margin-bottom:8px">开始你的论文写作之旅</p><p style="font-size:11px;line-height:1.6">选择一个写作章节或快捷模板开始，或直接在下方输入你的需求。</p></div></div>';
  }
  // Re-render to reset tabs
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.chat) {
    pages.chat().then(function(html) { ctn.innerHTML = html; });
  }
}

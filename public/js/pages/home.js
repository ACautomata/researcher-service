/* ===== 首页 (Home) — 天研 AI for Science ===== */

var featureCards = [
  { id:'kb', icon:'fa-book-open', color:'#3b6df0', bg:'rgba(59,109,240,.08)',
    title:'文献知识库自动构建', desc:'自动收集、管理与构建专属领域知识库' },
  { id:'lit', icon:'fa-magnifying-glass', color:'#10b981', bg:'rgba(16,185,129,.08)',
    title:'文献深度理解', desc:'深度解读文献内容，提炼关键信息与知识点' },
  { id:'discover', icon:'fa-lightbulb', color:'#f59e0b', bg:'rgba(245,158,11,.08)',
    title:'研究动机发现', desc:'挖掘研究空白与趋势，发现有价值的研究方向' },
  { id:'idea', icon:'fa-flask', color:'#8b5cf6', bg:'rgba(139,92,246,.08)',
    title:'科学假设形成', desc:'基于知识与数据，智能生成创新的科学假说' },
  { id:'algo', icon:'fa-flask-vial', color:'#ef4444', bg:'rgba(239,68,68,.08)',
    title:'实验设计与执行', desc:'智能设计实验方案，辅助实验执行与记录' },
  { id:'param', icon:'fa-chart-line', color:'#06b6d4', bg:'rgba(6,182,212,.08)',
    title:'实验结果分析与优化', desc:'分析实验结果，优化研究方法，提升科研效率' },
  { id:'dashboard', icon:'fa-chart-pie', color:'#f97316', bg:'rgba(249,115,22,.08)',
    title:'科技价值分析与评估', desc:'多维度评估科技价值，支撑决策与成果转化' },
  { id:'chat', icon:'fa-file-pen', color:'#6366f1', bg:'rgba(99,102,241,.08)',
    title:'论文辅助写作工具', desc:'从内容构思到语言润色，全面辅助论文写作' },
  { id:'obs', icon:'fa-diagram-project', color:'#ec4899', bg:'rgba(236,72,153,.08)',
    title:'科研绘图工具', desc:'智能生成高质量科研图表，提升表达效果' }
];

/* ===== Home Chat State ===== */
var homeChatActive = false;
var homeChatMsgs = [];
var homeChatStreaming = false;

pages.home = function() {
  var isLoggedIn = !!authUser;
  var h = '';

  // ── Hero Section ──
  h += '<div class="hero">';
  h += '<h1 class="hero-title">智能驱动 · 科研无界</h1>';
  h += '<p class="hero-sub">从想法到发现，让 AI 与科研同行</p>';

  if (homeChatActive) {
    // ── Chat Mode: input ──
    h += '<div class="hero-search">';
    h += '<input class="inp" id="homeChatInput" placeholder="输入问题，与 AI 科研助手对话…" onkeydown="if(event.key===\'Enter\'&&!homeChatStreaming)sendHomeChat()">';
    h += '<button class="hero-search-btn" id="homeChatSendBtn" onclick="sendHomeChat()"><i class="fa-solid fa-paper-plane"></i> 发送</button>';
    h += '</div>';
    h += '</div>';

    // ── Chat Messages ──
    h += '<div id="homeChatWrap" style="padding:0 4px 16px;max-height:55vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:flex;flex-direction:column;gap:4px">';
    if (homeChatMsgs.length === 0) {
      h += '<div id="homeChatEmpty" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px">';
      h += '<div style="text-align:center;max-width:400px">';
      h += '<i class="fa-solid fa-robot" style="font-size:36px;display:block;margin-bottom:12px;opacity:.15"></i>';
      h += '<p style="font-weight:600;margin-bottom:8px">开始与 AI 科研助手对话</p>';
      h += '<p style="font-size:11px;line-height:1.6">提出你的科研问题，AI 助手将为你提供专业解答与建议。</p>';
      h += '</div></div>';
    } else {
      for (var i = 0; i < homeChatMsgs.length; i++) {
        h += renderHomeChatMsg(homeChatMsgs[i].role, homeChatMsgs[i].content);
      }
    }
    h += '</div>';

    // ── Back Button ──
    h += '<div style="text-align:center;padding:0 0 16px">';
    h += '<button class="btn" onclick="closeHomeChat()" style="font-size:12px;padding:7px 18px"><i class="fa-solid fa-arrow-left"></i> 返回功能卡片</button>';
    h += '</div>';

  } else {
    // ── Search Mode ──
    h += '<form class="hero-search" onsubmit="event.preventDefault(); handleHeroSearch()">';
    h += '<input class="inp" id="heroSearchInput" placeholder="输入问题或关键词，探索科研可能性…">';
    h += '<button type="submit" class="hero-search-btn"><i class="fa-solid fa-magnifying-glass"></i> 探索</button>';
    h += '</form>';
    h += '</div>';

    // ── Feature Cards Grid ──
    h += '<div class="feature-grid">';
    for (var i = 0; i < featureCards.length; i++) {
      var fc = featureCards[i];
      h += '<div class="feature-card" onclick="handleFeatureClick(\''+fc.id+'\')" style="cursor:pointer">';
      h += '<div class="fc-icon" style="background:'+fc.bg+';color:'+fc.color+'"><i class="fa-solid '+fc.icon+'"></i></div>';
      h += '<div class="fc-body">';
      h += '<div class="fc-title">'+fc.title+'</div>';
      h += '<div class="fc-desc">'+fc.desc+'</div>';
      h += '</div></div>';
    }
    h += '</div>';

    // ── CTA (Guest only) ──
    if (!isLoggedIn) {
      h += '<div style="text-align:center;padding:16px 0 32px">';
      h += '<button type="button" onclick="openAccountPanel()" style="padding:12px 36px;border-radius:8px;border:none;background:var(--accent-gradient);color:#fff;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:transform .15s,box-shadow .15s;font-family:inherit" onmouseover="this.style.transform=\'translateY(-1px)\';this.style.boxShadow=\'0 4px 12px rgba(var(--accent-rgb),.3)\'" onmouseout="this.style.transform=\'\';this.style.boxShadow=\'none\'"><i class="fa-solid fa-right-to-bracket"></i> 开始使用</button>';
      h += '<p style="font-size:11px;color:var(--text-muted);margin-top:10px">登录后解锁全部科研工具</p>';
      h += '</div>';
    }
  }

  return h;
};

function handleFeatureClick(pageId) {
  if (!authUser) {
    openAccountPanel();
    return;
  }
  go(pageId);
}

function handleHeroSearch() {
  var q = document.getElementById('heroSearchInput');
  if (!q) return;
  var val = q.value.trim();
  if (!val) return;
  if (!authUser) {
    openAccountPanel();
    toast('请先登录后再探索', 'fa-info-circle', '#f59e0b');
    return;
  }

  // Switch to chat mode
  homeChatActive = true;
  homeChatMsgs = [];

  var ctn = document.getElementById('ctnEl');
  if (!ctn) return;
  pages.home().then(function(html) {
    ctn.innerHTML = html;
    // Send the query after DOM is ready
    setTimeout(function() {
      sendHomeChatMessage(val);
    }, 50);
  });
}

/* ── Home Chat: Render Message ── */
function renderHomeChatMsg(role, content) {
  var isUser = role === 'user';
  var align = isUser ? 'flex-end' : 'flex-start';
  var bg = isUser ? 'rgba(59,109,240,.08)' : 'var(--bg)';
  var border = isUser ? 'rgba(59,109,240,.15)' : 'var(--border)';
  var name = isUser ? '你' : 'AI 科研助手';
  var ic = isUser ? 'fa-user' : 'fa-robot';

  var h = '<div style="display:flex;flex-direction:column;align-items:' + align + ';max-width:85%;margin-bottom:10px">';
  h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid ' + ic + '"></i> ' + name + '</div>';
  h += '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--text);word-break:break-word;white-space:pre-wrap">' + esc(content) + '</div>';
  h += '</div>';
  return h;
}

/* ── Home Chat: Send Message (internal, called after UI is ready) ── */
async function sendHomeChatMessage(text) {
  homeChatMsgs.push({role: 'user', content: text});
  homeChatStreaming = true;

  var wrap = document.getElementById('homeChatWrap');
  if (!wrap) return;

  // Remove empty state placeholder
  var emptyEl = document.getElementById('homeChatEmpty');
  if (emptyEl) emptyEl.remove();

  // Add user message bubble
  wrap.innerHTML += renderHomeChatMsg('user', text);

  // Add loading indicator
  wrap.innerHTML += '<div id="homeChatLoad" style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%;margin-bottom:10px">';
  wrap.innerHTML += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-robot"></i> AI 科研助手</div>';
  wrap.innerHTML += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-muted);font-size:13px"><i class="fa-solid fa-spinner fa-spin"></i> 正在思考...</div></div>';
  wrap.scrollTop = wrap.scrollHeight;

  // Disable send button
  var btn = document.getElementById('homeChatSendBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

  try {
    var res = await api('POST', '/chat/send', {message: text});
    var loadEl = document.getElementById('homeChatLoad');
    if (loadEl) loadEl.remove();

    var reply = res.response || '(无回复)';
    homeChatMsgs.push({role: 'assistant', content: reply});
    wrap.innerHTML += renderHomeChatMsg('assistant', reply);
    wrap.scrollTop = wrap.scrollHeight;
  } catch (e) {
    var loadEl = document.getElementById('homeChatLoad');
    if (loadEl) loadEl.remove();

    var errMsg = '抱歉，我没有理解您的问题，请重试。';
    homeChatMsgs.push({role: 'assistant', content: errMsg});
    wrap.innerHTML += renderHomeChatMsg('assistant', errMsg);
    wrap.scrollTop = wrap.scrollHeight;
  }

  homeChatStreaming = false;
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送'; }

  // Re-focus the input
  var inp = document.getElementById('homeChatInput');
  if (inp) inp.focus();
}

/* ── Home Chat: Send from Input ── */
function sendHomeChat() {
  var inp = document.getElementById('homeChatInput');
  if (!inp || !inp.value.trim() || homeChatStreaming) return;
  var text = inp.value.trim();
  inp.value = '';
  // Restore input height
  inp.style.height = '';
  sendHomeChatMessage(text);
}

/* ── Home Chat: Close ── */
function closeHomeChat() {
  homeChatActive = false;
  homeChatMsgs = [];
  homeChatStreaming = false;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.home) {
    pages.home().then(function(html) { ctn.innerHTML = html; });
  }
}

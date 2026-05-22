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

/* ===== Home Search State ===== */
var homeSearchResult = null;   /* { query, reply } or null */
var homeSearchLoading = false;

pages.home = function() {
  var isLoggedIn = !!authUser;
  var h = '';

  // ── Hero Section ──
  h += '<div class="hero">';
  h += '<h1 class="hero-title">智能驱动 · 科研无界</h1>';
  h += '<p class="hero-sub">从想法到发现，让 AI 与科研同行</p>';
  h += '<form class="hero-search" onsubmit="event.preventDefault(); handleHeroSearch()">';
  h += '<input class="inp" id="heroSearchInput" placeholder="输入问题或关键词，探索科研可能性…" value="' + esc(homeSearchResult ? homeSearchResult.query : '') + '">';
  h += '<button type="submit" class="hero-search-btn" id="heroSearchBtn"><i class="fa-solid fa-magnifying-glass"></i> 探索</button>';
  h += '</form>';
  h += '</div>';

  // ── Search Result Panel ──
  if (homeSearchResult) {
    h += '<div id="homeResultPanel" class="card mb16" style="padding:16px;border-left:3px solid var(--accent)">';
    h += '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px">';
    h += '<div style="display:flex;align-items:center;gap:8px"><i class="fa-solid fa-robot" style="color:var(--accent);font-size:16px"></i><span style="font-size:13px;font-weight:600;color:var(--text-bold)">搜索结果</span></div>';
    h += '<button class="btn" onclick="clearHomeSearch()" style="font-size:10px;padding:4px 10px"><i class="fa-solid fa-xmark"></i> 清除</button>';
    h += '</div>';
    h += '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px">';
    h += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--text-muted);flex:1"><i class="fa-solid fa-magnifying-glass" style="margin-right:6px;color:var(--accent)"></i>' + esc(homeSearchResult.query) + '</div>';
    h += '</div>';
    h += '<div id="homeResultBody" style="font-size:13px;line-height:1.7;color:var(--text);white-space:pre-wrap;word-break:break-word">' + esc(homeSearchResult.reply) + '</div>';
    h += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-light);display:flex;gap:8px;flex-wrap:wrap">';
    h += '<button class="btn" onclick="go(\'chat\')" style="font-size:11px;padding:6px 14px"><i class="fa-solid fa-comment-dots"></i> 继续对话</button>';
    h += '<button class="btn" onclick="clearHomeSearch()" style="font-size:11px;padding:6px 14px"><i class="fa-solid fa-arrow-left"></i> 返回浏览</button>';
    h += '</div>';
    h += '</div>';
  }

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
  if (homeSearchLoading) return;

  homeSearchLoading = true;
  var btn = document.getElementById('heroSearchBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 搜索中'; }

  // Show loading state immediately
  homeSearchResult = { query: val, reply: '正在搜索…' };
  var ctn = document.getElementById('ctnEl');
  if (ctn) {
    pages.home().then(function(html) {
      ctn.innerHTML = html;
      doSearch(val);
    });
  } else {
    doSearch(val);
  }
}

async function doSearch(query) {
  try {
    var res = await api('POST', '/chat/send', {message: '请简要回答以下科研相关问题：' + query});
    var reply = res.response || '(无回复)';
    homeSearchResult = { query: query, reply: reply };
  } catch (e) {
    homeSearchResult = { query: query, reply: '抱歉，搜索服务暂时不可用。请稍后重试或前往「论文辅助写作」页面直接提问。' };
  }

  homeSearchLoading = false;
  var btn = document.getElementById('heroSearchBtn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> 探索'; }

  // Update result panel body in-place
  var body = document.getElementById('homeResultBody');
  if (body) {
    body.textContent = homeSearchResult.reply;
  } else {
    // Re-render if panel was removed (edge case)
    var ctn = document.getElementById('ctnEl');
    if (ctn) pages.home().then(function(html) { ctn.innerHTML = html; });
  }
}

function clearHomeSearch() {
  homeSearchResult = null;
  homeSearchLoading = false;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.home) {
    pages.home().then(function(html) { ctn.innerHTML = html; });
  }
}
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

/* ===== 首页 (Home) — 天研 AI for Science ===== */

var featureCards = [
  { id:'kb', icon:'fa-book-open', color:'#3b6df0', bg:'rgba(59,109,240,.08)',
    title:'文献知识库自动构建', desc:'自动收集、管理与构建专属领域知识库' },
  { id:'lit', icon:'fa-magnifying-glass', color:'#10b981', bg:'rgba(16,185,129,.08)',
    title:'文献深度理解', desc:'深度解读文献内容，提炼关键信息与知识点' },
  { id:'lit', icon:'fa-lightbulb', color:'#f59e0b', bg:'rgba(245,158,11,.08)',
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
  { id:'obs', icon:'fa-chart-diagram', color:'#ec4899', bg:'rgba(236,72,153,.08)',
    title:'科研绘图工具', desc:'智能生成高质量科研图表，提升表达效果' }
];

pages.home = function() {
  var isLoggedIn = !!authUser;
  var h = '';

  // ── Hero Section ──
  h += '<div class="hero">';
  h += '<h1 class="hero-title">智能驱动 · 科研无界</h1>';
  h += '<p class="hero-sub">从想法到发现，让 AI 与科研同行</p>';
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
  // Navigate to chat with the query pre-filled
  go('chat');
  setTimeout(function() {
    var inp = document.querySelector('#ctnEl .inp, #ctnEl textarea, #ctnEl [id*="chat"]');
    if (inp) {
      inp.value = val;
      inp.focus();
    }
  }, 300);
}

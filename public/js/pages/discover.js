/* ===== 研究动机发现 — 问题发现与验证 ===== */
pages.discover = async function() {
  return renderDiscoverPage();
};

async function renderDiscoverPage() {
  var h = '';

  // 加载问题数据
  var problems = [];
  try {
    var data = await api('GET', '/lit/problems');
    problems = (data.problems || []).map(function(p) {
      return {
        id: p.id, title: p.title, desc: p.description,
        src: p.source, cat: p.category, sv: p.severity,
        ok: !!p.validated, vs: p.validation_score, vm: p.validation_method
      };
    });
  } catch(e) { problems = []; }

  var validated = problems.filter(function(p) { return p.ok; }).length;
  var highSev = problems.filter(function(p) { return p.sv === 'critical' || p.sv === 'high'; }).length;

  // Stats
  h += '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#f59e0b">' + problems.length + '</div><div class="st-l">已发现问题</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#10b981">' + validated + '</div><div class="st-l">已验证</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#ef4444">' + highSev + '</div><div class="st-l">高严重性</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#8b5cf6;font-size:20px">' + (problems.length - validated) + '</div><div class="st-l">待验证</div></div>';
  h += '</div>';

  // 筛选栏
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-lightbulb"></i>研究动机发现</div>';
  h += '<p style="font-size:12px;color:var(--text-muted);margin-bottom:14px">从文献中挖掘研究空白与趋势，发现有价值的研究方向</p>';
  h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">';
  h += '<select class="inp" id="discoverFilter" onchange="filterProblems()" style="font-size:12px;max-width:200px">';
  h += '<option value="all">全部问题</option>';
  h += '<option value="pending">待验证</option>';
  h += '<option value="validated">已验证</option>';
  h += '<option value="high">高严重性</option>';
  h += '</select>';
  h += '<span style="font-size:11px;color:var(--text-muted)">共 ' + problems.length + ' 条</span>';
  h += '</div></div>';

  // 问题列表
  if (problems.length === 0) {
    h += '<div class="card" style="text-align:center;padding:48px 24px">';
    h += '<i class="fa-solid fa-magnifying-glass" style="font-size:40px;color:var(--text-light);display:block;margin-bottom:12px"></i>';
    h += '<p style="font-size:14px;color:var(--text-muted)">暂未发现研究问题</p>';
    h += '<p style="font-size:11px;color:var(--text-light);margin-top:4px">请先在<span style="color:var(--accent);cursor:pointer" onclick="go(\'lit\')">文献深度理解</span>中运行文献分析</p>';
    h += '</div>';
  } else {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px" id="discoverList">';
    h += renderProblemCards(problems);
    h += '</div>';
  }

  return h;
}

function renderProblemCards(problems) {
  var h = '';
  var sevMap = { critical: { label: '严重', color: '#ef4444', bg: '#fee2e2' },
                  high: { label: '高', color: '#f97316', bg: '#ffedd5' },
                  medium: { label: '中', color: '#f59e0b', bg: '#fef3c7' },
                  low: { label: '低', color: '#10b981', bg: '#d1fae5' } };

  for (var i = 0; i < problems.length; i++) {
    var p = problems[i];
    var sv = sevMap[p.sv] || sevMap.medium;
    h += '<div class="prob-card" style="cursor:default">';
    h += '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px">';
    h += '<span style="flex-shrink:0;width:32px;height:32px;border-radius:7px;background:rgba(245,158,11,.1);display:grid;place-items:center;color:#f59e0b;font-size:14px"><i class="fa-solid fa-triangle-exclamation"></i></span>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div style="font-weight:600;font-size:13px;color:var(--text-bold);word-break:break-word">' + esc(p.title) + '</div>';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + esc(p.cat || '未分类') + '</div>';
    h += '</div>';
    h += '<span style="flex-shrink:0;font-size:10px;padding:3px 8px;border-radius:10px;background:' + sv.bg + ';color:' + sv.color + ';font-weight:600">' + sv.label + '</span>';
    h += '</div>';
    if (p.desc) {
      h += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">' + esc(p.desc).substring(0, 120) + (p.desc.length > 120 ? '…' : '') + '</div>';
    }
    h += '<div style="display:flex;align-items:center;justify-content:space-between">';
    h += '<div style="display:flex;align-items:center;gap:6px">';
    h += '<span style="font-size:10px;color:' + (p.ok ? '#10b981' : 'var(--text-light)') + '"><i class="fa-solid ' + (p.ok ? 'fa-circle-check' : 'fa-circle') + '"></i> ' + (p.ok ? '已验证' : '待验证') + '</span>';
    if (p.src) h += '<span style="font-size:10px;color:var(--text-light)" title="' + esc(p.src) + '"><i class="fa-solid fa-file-lines"></i> ' + esc(p.src).substring(0, 20) + '</span>';
    h += '</div>';
    h += '<button class="btn" style="font-size:10px;padding:3px 10px" onclick="go(\'idea\')"><i class="fa-solid fa-arrow-right"></i> 生成假说</button>';
    h += '</div>';
    h += '</div>';
  }
  return h;
}

function filterProblems() {
  var el = document.getElementById('discoverFilter');
  if (!el) return;
  var val = el.value;
  var cards = document.querySelectorAll('#discoverList .prob-card');
  cards.forEach(function(card) {
    var statusEl = card.querySelector('span[style*="已验证"], span[style*="待验证"]');
    var sevEl = card.querySelector('span[style*="border-radius:10px"]');
    var isOk = statusEl && statusEl.textContent.indexOf('已验证') >= 0;
    var isHigh = sevEl && (sevEl.textContent === '严重' || sevEl.textContent === '高');

    if (val === 'all') { card.style.display = ''; }
    else if (val === 'pending') { card.style.display = isOk ? 'none' : ''; }
    else if (val === 'validated') { card.style.display = isOk ? '' : 'none'; }
    else if (val === 'high') { card.style.display = isHigh ? '' : 'none'; }
  });
}

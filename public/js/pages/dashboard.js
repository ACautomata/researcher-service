/* ===== 科技价值分析 — 多维度评估科技价值，支撑决策与成果转化 ===== */

pages.dashboard = function() {
  var h = '';

  // ── Header ──
  h += '<div class="flex-b mb24">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">科技价值分析</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="基于研究产出的多维度价值评估：创新度、可行性、影响力、转化效率"></i></div>';
  h += '</div>';

  // ── 综合价值指标 ──
  h += '<div class="stats mb24" style="grid-template-columns:repeat(4,1fr)" id="valueMetrics">';
  var metrics = [
    { id:'score', icon:'fa-trophy', label:'综合价值指数', color:'#3b6df0', desc:'--' },
    { id:'novelty', icon:'fa-lightbulb', label:'创新度均值', color:'#8b5cf6', desc:'--' },
    { id:'feasibility', icon:'fa-check-circle', label:'可行性均值', color:'#10b981', desc:'--' },
    { id:'impact', icon:'fa-bolt', label:'影响力均值', color:'#f59e0b', desc:'--' }
  ];
  for (var i = 0; i < metrics.length; i++) {
    var m = metrics[i];
    h += '<div class="st-card" style="text-align:center;padding:20px 16px">';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:6px"><i class="fa-solid '+m.icon+'" style="color:'+m.color+'"></i>'+m.label+'</div>';
    h += '<div style="font-family:\'Space Grotesk\',sans-serif;font-size:32px;font-weight:700;color:'+m.color+';line-height:1" id="valM_'+m.id+'">--</div>';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-top:4px" id="valD_'+m.id+'">--</div>';
    h += '</div>';
  }
  h += '</div>';

  // ── Idea 质量分布 + 高价值 Idea ──
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';

  // Left: Idea 质量分布
  h += '<div class="card">';
  h += '<div class="card-t"><i class="fa-solid fa-chart-bar" style="color:#8b5cf6"></i>Idea 质量分布</div>';
  h += '<div id="valIdeaDist" style="padding:4px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '</div></div>';

  // Right: 高价值 Idea
  h += '<div class="card">';
  h += '<div class="card-t"><i class="fa-solid fa-ranking-star" style="color:#f59e0b"></i>高价值 Idea TOP 5</div>';
  h += '<div id="valTopIdeas" style="padding:4px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '</div></div>';

  h += '</div>';

  // ── 问题验证 + 算法性能 ──
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';

  // Left: 问题验证分析
  h += '<div class="card">';
  h += '<div class="card-t"><i class="fa-solid fa-shield-check" style="color:#10b981"></i>问题验证分析</div>';
  h += '<div id="valProblemPanel" style="padding:4px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '</div></div>';

  // Right: 算法性能评估
  h += '<div class="card">';
  h += '<div class="card-t"><i class="fa-solid fa-gauge-high" style="color:#ef4444"></i>算法性能评估</div>';
  h += '<div id="valAlgoPanel" style="padding:4px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '</div></div>';

  h += '</div>';

  // ── 研究流水线转化漏斗 ──
  h += '<div class="card mb24">';
  h += '<div class="card-t"><i class="fa-solid fa-funnel-dollar" style="color:#3b6df0"></i>研究流水线转化漏斗</div>';
  h += '<div id="valFunnel" style="padding:8px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '</div></div>';

  // ── AI 价值洞察 ──
  h += '<div class="card mb24">';
  h += '<div class="card-t"><i class="fa-solid fa-robot" style="color:#6366f1"></i>AI 价值洞察</div>';
  h += '<div id="valInsights" style="padding:4px 0">';
  h += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">分析中…</div>';
  h += '</div></div>';

  return h;
};

/* ===== Data Loading & Rendering ===== */

var valIdeas = [];
var valProblems = [];
var valAlgos = [];
var valUsage = null;

async function loadValueAnalysis() {
  // Load all data in parallel
  var results = await Promise.allSettled([
    api('GET', '/idea/list?min_score=0&page_size=100'),
    api('GET', '/lit/problems'),
    api('GET', '/algo/list'),
    api('GET', '/dashboard/usage')
  ]);

  valIdeas = results[0].status === 'fulfilled' ? (results[0].value.ideas || []) : [];
  valProblems = results[1].status === 'fulfilled' ? (results[1].value.problems || []) : [];
  valAlgos = results[2].status === 'fulfilled' ? (results[2].value.algorithms || []) : [];
  valUsage = results[3].status === 'fulfilled' ? results[3].value : null;

  renderValueMetrics();
  renderIdeaDistribution();
  renderTopIdeas();
  renderProblemPanel();
  renderAlgoPanel();
  renderFunnel();
  renderInsights();
}

/* ── 综合价值指标 ── */
function renderValueMetrics() {
  var ideas = valIdeas;
  if (ideas.length === 0) {
    ['score','novelty','feasibility','impact'].forEach(function(id) {
      setVal(id, '--', '暂无数据');
    });
    return;
  }

  var sumN = 0, sumF = 0, sumI = 0, sumO = 0, count = 0;
  ideas.forEach(function(idea) {
    if (idea.novelty != null) { sumN += idea.novelty; count++; }
    if (idea.feasibility != null) sumF += idea.feasibility;
    if (idea.impact != null) sumI += idea.impact;
    if (idea.overall_score != null) sumO += idea.overall_score;
  });
  count = count || 1;

  var avgN = sumN / count;
  var avgF = sumF / count;
  var avgI = sumI / count;
  var avgO = sumO / count;

  setVal('score', avgO.toFixed(1), levelTag(avgO));
  setVal('novelty', avgN.toFixed(1), levelTag(avgN));
  setVal('feasibility', avgF.toFixed(1), levelTag(avgF));
  setVal('impact', avgI.toFixed(1), levelTag(avgI));
}

function setVal(id, value, desc) {
  var elV = document.getElementById('valM_' + id);
  var elD = document.getElementById('valD_' + id);
  if (elV) elV.textContent = value;
  if (elD) elD.textContent = desc;
}

function levelTag(score) {
  if (score >= 8) return '优秀';
  if (score >= 6.5) return '较优';
  if (score >= 5) return '适中';
  if (score >= 3.5) return '偏低';
  return '待提升';
}

/* ── Idea 质量分布 ── */
function renderIdeaDistribution() {
  var el = document.getElementById('valIdeaDist');
  if (!el) return;

  var ideas = valIdeas;
  if (ideas.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">暂无 Idea 数据</div>';
    return;
  }

  var buckets = [
    { range:'0-2', min:0, max:2, color:'#ef4444' },
    { range:'2-4', min:2, max:4, color:'#f59e0b' },
    { range:'4-6', min:4, max:6, color:'#06b6d4' },
    { range:'6-8', min:6, max:8, color:'#10b981' },
    { range:'8-10', min:8, max:10, color:'#3b6df0' }
  ];

  var counts = [0,0,0,0,0];
  ideas.forEach(function(idea) {
    var s = idea.overall_score || 0;
    for (var i = 0; i < buckets.length; i++) {
      if (s >= buckets[i].min && s < buckets[i].max) { counts[i]++; break; }
      if (i === buckets.length - 1 && s >= buckets[i].min) counts[i]++;
    }
  });

  var maxCount = Math.max.apply(null, counts) || 1;
  var h = '';
  for (var i = 0; i < buckets.length; i++) {
    var b = buckets[i];
    var barW = Math.max(counts[i] / maxCount * 100, 2);
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    h += '<span style="width:36px;font-size:10px;color:var(--text-muted);text-align:right;flex-shrink:0">'+b.range+'</span>';
    h += '<div style="flex:1;height:22px;background:var(--bg);border-radius:4px;overflow:hidden">';
    h += '<div style="width:'+barW+'%;height:100%;background:'+b.color+';border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;transition:width .6s ease">';
    if (counts[i] > 0) h += '<span style="font-size:10px;font-weight:700;color:#fff">'+counts[i]+'</span>';
    h += '</div></div></div>';
  }
  h += '<div style="text-align:center;font-size:10px;color:var(--text-muted);margin-top:8px">共 '+ideas.length+' 个 Idea · 评分范围 0-10</div>';
  el.innerHTML = h;
}

/* ── 高价值 Idea TOP 5 ── */
function renderTopIdeas() {
  var el = document.getElementById('valTopIdeas');
  if (!el) return;

  var ideas = valIdeas.slice().sort(function(a,b){ return (b.overall_score||0) - (a.overall_score||0); }).slice(0, 5);
  if (ideas.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">暂无 Idea 数据</div>';
    return;
  }

  var h = '';
  var medals = ['#FFD700','#C0C0C0','#CD7F32','',''];
  for (var i = 0; i < ideas.length; i++) {
    var idea = ideas[i];
    var score = idea.overall_score || 0;
    var scoreColor = score >= 7 ? '#10b981' : (score >= 5 ? '#f59e0b' : '#94a3b8');
    var medal = i < 3 ? '<span style="font-size:14px;color:'+medals[i]+'">●</span>' : '<span style="color:var(--text-muted);font-size:12px">'+(i+1)+'</span>';
    h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-light)">';
    h += medal;
    h += '<span style="flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(idea.title)+'">'+esc(idea.title)+'</span>';
    h += '<span style="font-family:\'Space Grotesk\',sans-serif;font-size:13px;font-weight:700;color:'+scoreColor+';min-width:36px;text-align:right">'+score.toFixed(1)+'</span>';
    h += '</div>';
  }
  el.innerHTML = h;
}

/* ── 问题验证分析 ── */
function renderProblemPanel() {
  var el = document.getElementById('valProblemPanel');
  if (!el) return;

  var problems = valProblems;
  if (problems.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">暂无问题数据</div>';
    return;
  }

  var sevCounts = { high:0, medium:0, low:0 };
  var validated = 0;
  var totalValScore = 0, valCount = 0;

  problems.forEach(function(p) {
    if (p.severity && sevCounts[p.severity] !== undefined) sevCounts[p.severity]++;
    if (p.validated) validated++;
    if (p.validation_score != null) { totalValScore += p.validation_score; valCount++; }
  });

  var sevOrder = [
    { key:'high', label:'高', color:'#ef4444' },
    { key:'medium', label:'中', color:'#f59e0b' },
    { key:'low', label:'低', color:'#10b981' }
  ];

  var maxSev = Math.max(sevCounts.high, sevCounts.medium, sevCounts.low, 1);
  var h = '';

  // Severity bars
  h += '<div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:8px">问题严重性分布</div>';
  for (var i = 0; i < sevOrder.length; i++) {
    var s = sevOrder[i];
    var w = sevCounts[s.key] / maxSev * 100;
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">';
    h += '<span style="width:20px;font-size:10px;color:var(--text-muted)">'+s.label+'</span>';
    h += '<div style="flex:1;height:20px;background:var(--bg);border-radius:4px;overflow:hidden">';
    h += '<div style="width:'+Math.max(w,3)+'%;height:100%;background:'+s.color+';border-radius:4px;display:flex;align-items:center;padding-left:6px;transition:width .6s ease">';
    if (sevCounts[s.key] > 0) h += '<span style="font-size:10px;font-weight:600;color:#fff">'+sevCounts[s.key]+'</span>';
    h += '</div></div></div>';
  }

  // Validation stats
  var valRate = problems.length > 0 ? Math.round(validated / problems.length * 100) : 0;
  var avgValScore = valCount > 0 ? (totalValScore / valCount).toFixed(1) : '--';

  h += '<div style="display:flex;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-light)">';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:18px;font-weight:700;color:#10b981">'+valRate+'%</div><div style="font-size:10px;color:var(--text-muted)">验证率</div></div>';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:18px;font-weight:700;color:#8b5cf6">'+avgValScore+'</div><div style="font-size:10px;color:var(--text-muted)">均值验证分</div></div>';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:18px;font-weight:700;color:var(--text)">'+problems.length+'</div><div style="font-size:10px;color:var(--text-muted)">总问题数</div></div>';
  h += '</div>';

  el.innerHTML = h;
}

/* ── 算法性能评估 ── */
function renderAlgoPanel() {
  var el = document.getElementById('valAlgoPanel');
  if (!el) return;

  var algos = valAlgos;
  if (algos.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">暂无算法数据</div>';
    return;
  }

  var tested = algos.filter(function(a){ return a.tested; });
  var passed = 0, totalTests = 0;
  var perfImproved = 0, perfTotal = 0;

  algos.forEach(function(a) {
    if (a.tested && a.test_total) {
      totalTests += a.test_total;
      if (a.test_passed) passed += a.test_passed;
    }
    if (a.perf_before_ms && a.perf_after_ms && a.perf_before_ms > 0) {
      perfImproved++;
      perfTotal++;
    }
  });

  var passRate = totalTests > 0 ? Math.round(passed / totalTests * 100) : 0;
  var testRate = algos.length > 0 ? Math.round(tested.length / algos.length * 100) : 0;
  var perfRate = perfTotal > 0 ? Math.round(perfImproved / perfTotal * 100) : 0;

  // Language distribution
  var langCounts = {};
  algos.forEach(function(a) {
    var lang = a.language || '未知';
    langCounts[lang] = (langCounts[lang] || 0) + 1;
  });

  var h = '';

  h += '<div style="display:flex;gap:12px;margin-bottom:14px">';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:20px;font-weight:700;color:#10b981">'+passRate+'%</div><div style="font-size:10px;color:var(--text-muted)">测试通过率</div></div>';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:20px;font-weight:700;color:#3b6df0">'+testRate+'%</div><div style="font-size:10px;color:var(--text-muted)">已测试占比</div></div>';
  h += '<div style="flex:1;text-align:center"><div style="font-family:\'Space Grotesk\',sans-serif;font-size:20px;font-weight:700;color:#f59e0b">'+perfRate+'%</div><div style="font-size:10px;color:var(--text-muted)">性能优化率</div></div>';
  h += '</div>';

  // Language tags
  if (Object.keys(langCounts).length > 0) {
    h += '<div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">语言分布</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
    for (var lang in langCounts) {
      h += '<span class="badge" style="background:var(--accent-light);color:var(--accent);font-size:10px">'+esc(lang)+' × '+langCounts[lang]+'</span>';
    }
    h += '</div>';
  }

  el.innerHTML = h;
}

/* ── 研究流水线转化漏斗 ── */
function renderFunnel() {
  var el = document.getElementById('valFunnel');
  if (!el) return;

  var d = valUsage ? (valUsage.data || {}) : {};
  var stages = [
    { key:'papers', label:'文献', color:'#3b6df0', icon:'fa-file-lines' },
    { key:'entries', label:'知识条目', color:'#10b981', icon:'fa-layer-group' },
    { key:'problems', label:'研究问题', color:'#f59e0b', icon:'fa-bug' },
    { key:'ideas', label:'科学假说', color:'#8b5cf6', icon:'fa-lightbulb' },
    { key:'algorithms', label:'算法代码', color:'#ef4444', icon:'fa-code' }
  ];

  var allZero = true;
  for (var i = 0; i < stages.length; i++) {
    if ((d[stages[i].key] || 0) > 0) { allZero = false; break; }
  }
  if (allZero) {
    el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px">暂无流水线数据，请先上传文献并运行处理任务</div>';
    return;
  }

  var maxVal = Math.max(
    (d.papers || 0), (d.entries || 0), (d.problems || 0), (d.ideas || 0), (d.algorithms || 0), 1
  );

  var h = '';
  for (var i = 0; i < stages.length; i++) {
    var s = stages[i];
    var val = d[s.key] || 0;
    var w = val / maxVal * 100;
    var cRate = '';
    if (i > 0) {
      var prevKey = stages[i-1].key;
      var prevVal = d[prevKey] || 1;
      cRate = ' (转化率 '+Math.round(val / prevVal * 100)+'%)';
    }
    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">';
    h += '<div style="width:80px;flex-shrink:0;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)"><i class="fa-solid '+s.icon+'" style="color:'+s.color+';width:16px;text-align:center"></i>'+s.label+'</div>';
    h += '<div style="flex:1;height:28px;background:var(--bg);border-radius:6px;overflow:hidden">';
    h += '<div style="width:'+Math.max(w,3)+'%;height:100%;background:'+s.color+';border-radius:6px;display:flex;align-items:center;padding:0 10px;transition:width .8s cubic-bezier(.4,0,.2,1)">';
    h += '<span style="font-size:11px;font-weight:700;color:#fff">'+val+'</span>';
    h += '<span style="font-size:9px;color:rgba(255,255,255,.7);margin-left:6px">'+cRate+'</span>';
    h += '</div></div></div>';
  }

  // End-to-end rates
  if ((d.papers || 0) > 0) {
    var ideaRate = Math.round((d.ideas || 0) / (d.papers || 1) * 100);
    var algoRate = Math.round((d.algorithms || 0) / (d.papers || 1) * 100);
    h += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-light);display:flex;gap:24px">';
    h += '<div><span style="font-size:10px;color:var(--text-muted)">文献→假说转化率 </span><span style="font-size:12px;font-weight:700;color:#8b5cf6">'+ideaRate+'%</span></div>';
    h += '<div><span style="font-size:10px;color:var(--text-muted)">文献→算法转化率 </span><span style="font-size:12px;font-weight:700;color:#ef4444">'+algoRate+'%</span></div>';
    h += '</div>';
  }

  el.innerHTML = h;
}

/* ── AI 价值洞察 ── */
function renderInsights() {
  var el = document.getElementById('valInsights');
  if (!el) return;

  var insights = [];
  var ideas = valIdeas;
  var problems = valProblems;
  var algos = valAlgos;

  // Compute insights from data
  if (ideas.length > 0) {
    var sumN = 0, sumF = 0, sumI = 0;
    ideas.forEach(function(i) { sumN += i.novelty||0; sumF += i.feasibility||0; sumI += i.impact||0; });
    var avgN = sumN / ideas.length, avgF = sumF / ideas.length, avgI = sumI / ideas.length;

    // Find strongest/weakest dimension
    var dims = [
      { name:'创新度', val:avgN, icon:'fa-lightbulb', color:'#8b5cf6' },
      { name:'可行性', val:avgF, icon:'fa-check-circle', color:'#10b981' },
      { name:'影响力', val:avgI, icon:'fa-bolt', color:'#f59e0b' }
    ];
    dims.sort(function(a,b){ return b.val - a.val; });

    insights.push({
      icon: 'fa-star', color: '#3b6df0',
      text: '您的<span style="color:'+dims[0].color+';font-weight:600">'+dims[0].name+'</span>维度最为突出（均分 '+dims[0].val.toFixed(1)+'），建议以此为核心竞争力。'
    });

    if (dims[2].val < 5) {
      insights.push({
        icon: 'fa-triangle-exclamation', color: '#f59e0b',
        text: '<span style="color:'+dims[2].color+';font-weight:600">'+dims[2].name+'</span>维度偏低（均分 '+dims[2].val.toFixed(1)+'），建议重点关注该方向提升。'
      });
    }

    // Score distribution insight
    var highQuality = ideas.filter(function(i){ return (i.overall_score||0) >= 7; }).length;
    var hqRate = Math.round(highQuality / ideas.length * 100);
    if (hqRate >= 50) {
      insights.push({ icon: 'fa-trophy', color: '#10b981', text: '高质量 Idea（≥7分）占比 '+hqRate+'%，研究创意整体水平优秀。' });
    }
  }

  if (problems.length > 0) {
    var highSev = problems.filter(function(p){ return p.severity === 'high'; }).length;
    var highRate = Math.round(highSev / problems.length * 100);
    if (highRate >= 30) {
      insights.push({ icon: 'fa-circle-exclamation', color: '#ef4444', text: '高严重性问题占比 '+highRate+'%，建议优先解决以降低研究风险。' });
    }

    var validated = problems.filter(function(p){ return p.validated; }).length;
    var valRate = Math.round(validated / problems.length * 100);
    if (valRate < 30) {
      insights.push({ icon: 'fa-shield-halved', color: '#f59e0b', text: '问题验证率仅 '+valRate+'%，建议加快验证流程以提高研究可靠性。' });
    }
  }

  if (algos.length > 0) {
    var tested = algos.filter(function(a){ return a.tested; }).length;
    var testRate = Math.round(tested / algos.length * 100);
    if (testRate < 50) {
      insights.push({ icon: 'fa-flask', color: '#06b6d4', text: '算法测试覆盖率仅 '+testRate+'%，建议完善测试以提高代码质量。' });
    }
  }

  if (ideas.length === 0 && problems.length === 0) {
    insights.push({ icon: 'fa-circle-info', color: '#3b6df0', text: '暂无足够数据生成洞察。请先上传文献、执行文献解析和 Idea 生成任务。' });
  }

  var h = '<div style="display:flex;flex-direction:column;gap:8px">';
  for (var i = 0; i < insights.length; i++) {
    var ins = insights[i];
    h += '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;background:var(--bg)">';
    h += '<i class="fa-solid '+ins.icon+'" style="color:'+ins.color+';font-size:13px;margin-top:2px;flex-shrink:0"></i>';
    h += '<span style="font-size:12px;color:var(--text);line-height:1.5">'+ins.text+'</span>';
    h += '</div>';
  }
  h += '</div>';

  el.innerHTML = h;
}

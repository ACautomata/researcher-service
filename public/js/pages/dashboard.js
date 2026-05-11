/* ===== Dashboard Page ===== */
pages.dashboard = function() {
  var h = '';

  // ── 系统数据流 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-diagram-project"></i>系统数据流</div>';
  h += '<div style="padding:10px 0">';
  h += '<div style="display:flex;align-items:stretch;justify-content:center;gap:0">';
  var ns = [
    {n:'知识库',s:'上传 · 解析 · 领域',c:'#00E5A0',bg:'rgba(0,229,160,.08)',bd:'rgba(0,229,160,.25)'},
    {n:'问题发现',s:'AI发现 · 验证',c:'#F5A623',bg:'rgba(245,166,35,.08)',bd:'rgba(245,166,35,.25)'},
    {n:'Idea生成',s:'AI创意 · 评分',c:'#A78BFA',bg:'rgba(167,139,250,.08)',bd:'rgba(167,139,250,.25)'},
    {n:'算法实现',s:'代码 · 测试',c:'#FF6B81',bg:'rgba(255,107,129,.08)',bd:'rgba(255,107,129,.25)'},
    {n:'参数优化',s:'超参搜索',c:'#F97316',bg:'rgba(249,115,22,.08)',bd:'rgba(249,115,22,.25)'}
  ];
  for (var i = 0; i < ns.length; i++) {
    h += '<div style="text-align:center;padding:14px 16px;border-radius:14px;border:1.5px solid '+ns[i].bd+';background:'+ns[i].bg+';min-width:100px;position:relative">';
    h += '<div style="width:24px;height:24px;border-radius:50%;background:'+ns[i].c+';color:#05070d;display:inline-grid;place-items:center;font-size:11px;font-weight:700;font-family:\'Space Grotesk\';margin-bottom:8px">'+(i+1)+'</div>';
    h += '<div style="font-size:12px;font-weight:700;color:'+ns[i].c+';margin-bottom:2px">'+ns[i].n+'</div>';
    h += '<div style="font-size:10px;color:var(--text-muted)">'+ns[i].s+'</div></div>';
    if (i < ns.length - 1) {
      h += '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;padding:0 2px;flex-shrink:0">';
      h += '<div style="flex:1;display:flex;align-items:center">';
      h += '<svg width="48" height="20" viewBox="0 0 48 20"><defs><linearGradient id="arrGrad'+i+'" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="'+ns[i].c+'" stop-opacity="0.4"/><stop offset="100%" stop-color="'+ns[i+1].c+'" stop-opacity="0.6"/></linearGradient></defs>';
      h += '<line x1="4" y1="10" x2="32" y2="10" stroke="url(#arrGrad'+i+')" stroke-width="1.5" stroke-dasharray="3,2"/>';
      h += '<polygon points="36,10 30,6 30,14" fill="'+ns[i+1].c+'" opacity="0.6"/>';
      h += '</svg></div>';
      h += '<div style="font-size:8px;color:var(--text-muted);letter-spacing:.5px">产出</div>';
      h += '</div>';
    }
  }
  h += '</div></div></div>';

  // ── 管道数据统计 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-database"></i>管道数据统计 <span class="api-t api-g" style="margin-left:auto">GET /dashboard/usage</span></div>';
  h += '<div class="stats dash-pipe-stats" id="dashPipelineStats">';
  var stages = [
    {key:'papers',   label:'论文',       sub:'累计上传',   icon:'fa-file-lines',   color:'#00E5A0'},
    {key:'entries',  label:'知识条目',   sub:'解析产出',   icon:'fa-layer-group',  color:'#34D399'},
    {key:'keywords', label:'关键词',     sub:'AI提取',     icon:'fa-tags',         color:'#06B6D4'},
    {key:'problems', label:'发现问题',   sub:'待解决',     icon:'fa-bug',          color:'#F5A623'},
    {key:'ideas',    label:'生成Idea',   sub:'AI创意',     icon:'fa-lightbulb',    color:'#A78BFA'},
    {key:'algorithms',label:'算法代码',  sub:'已生成',     icon:'fa-code',         color:'#FF6B81'}
  ];
  stages.forEach(function(s){
    h += '<div class="st-card pipe-card" style="--accent:'+s.color+'">';
    h += '<div class="pipe-card-bg"><i class="fa-solid '+s.icon+'"></i></div>';
    h += '<div class="st-v" style="color:'+s.color+'" id="dashCount_'+s.key+'">--</div>';
    h += '<div class="st-l" style="font-size:11px">'+s.label+'</div>';
    h += '<div style="font-size:9px;color:var(--text-muted);margin-top:2px">'+s.sub+'</div>';
    h += '</div>';
  });
  h += '</div></div>';

  // ── 任务统计 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-list-check"></i>任务统计 <span class="api-t api-g" style="margin-left:auto">GET /dashboard/tasks</span></div>';
  h += '<div style="display:flex;gap:16px;flex-wrap:wrap">';
  h += '<div style="flex:1;min-width:200px">';
  h += '<div class="stats" style="grid-template-columns:repeat(2,1fr);margin-bottom:0">';
  h += '<div class="st-card" style="--accent:#F5A623"><div class="st-v" style="color:#F5A623" id="dashTaskTotal">--</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-v" style="color:#00E5A0" id="dashTaskCompleted">--</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card" style="--accent:#3B82F6"><div class="st-v" style="color:#3B82F6" id="dashTaskRunning">--</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card" style="--accent:#FF6B81"><div class="st-v" style="color:#FF6B81" id="dashTaskFailed">--</div><div class="st-l">失败</div></div>';
  h += '</div></div>';
  // 完成率环形图
  h += '<div style="flex-shrink:0;display:flex;align-items:center;justify-content:center;min-width:140px">';
  h += '<div id="dashCompletionRing" style="width:110px;height:110px"></div>';
  h += '</div>';
  h += '</div></div>';

  // ── 图表 ──
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;margin-bottom:24px">';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-pie"></i>任务状态分布</div><div id="dashStatusChart" style="height:260px"></div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-bar"></i>任务类型分布</div><div id="dashTypeChart" style="height:260px"></div></div>';
  h += '</div>';

  // ── 运行中任务 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-spinner fa-spin"></i>运行中任务</div>';
  h += '<div id="dashRunning" style="color:var(--text-muted);font-size:13px">加载中…</div></div>';

  // ── 已完成任务 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-check-circle"></i>已完成任务</div>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<div id="dashCompleted" style="color:var(--text-muted);font-size:13px;flex:1">加载中…</div>';
  h += '<button type="button" class="btn" onclick="loadAllCompletedTasks()"><i class="fa-solid fa-list"></i> 查看全部</button>';
  h += '</div></div>';
  h += '<div id="dashCompletedAll" style="display:none"></div>';

  // ── 最近任务历史 ──
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-clock-rotate-left"></i>最近任务历史</div><div id="dashHistory" style="color:var(--text-muted);font-size:13px;max-height:260px;overflow-y:auto"></div></div>';

  // ── 系统资源 ──
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-microchip"></i>系统资源使用 <span class="api-t api-g" style="margin-left:auto">实时</span></div>';
  h += '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))" id="sysStatsContainer">';
  h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-l" style="text-align:center">CPU 使用率</div><div id="sysCpuGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card" style="--accent:#A78BFA"><div class="st-l" style="text-align:center">内存使用</div><div id="sysMemGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card" style="--accent:#F5A623"><div class="st-l" style="text-align:center">磁盘使用</div><div id="sysDiskGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div id="gpuCards" style="display:contents"></div>';
  h += '</div></div>';

  return h;
};

var dashInterval = null;
var allTasksData = [];
var isFirstLoad = true;
var allCompletedTasks = [];

async function loadDashboard() {
  try {
    var td = await api('GET', '/dashboard/tasks?limit=50');
    allTasksData = td.tasks || [];
  } catch(e) {
    allTasksData = [];
  }

  // 始终渲染管道统计（导航回来时 DOM 已重建）
  try {
    var usage = await api('GET', '/dashboard/usage');
    renderPipelineStats(usage);
    renderTaskStats(usage);
  } catch(e) {}

  var running = allTasksData.filter(function(t){ return t.status === 'running'; });
  var completed = allTasksData.filter(function(t){ return t.status === 'completed'; });

  renderRunningTasks(running);
  renderCompletedTasks(completed);
  renderTaskHistory(allTasksData);

  if (isFirstLoad) {
    setTimeout(function() {
      renderCharts();
      isFirstLoad = false;
    }, 150);
  } else {
    renderCharts();
  }

  loadSystemStats();
}

function renderPipelineStats(usage) {
  var data = usage.data || {};
  var keys = ['papers','entries','keywords','problems','ideas','algorithms'];
  keys.forEach(function(k){
    var el = document.getElementById('dashCount_' + k);
    if (el) {
      var val = data[k] != null ? data[k] : 0;
      animateNumber(el, val);
    }
  });
}

function renderTaskStats(usage) {
  var t = usage.tasks || {};
  setNum('dashTaskTotal', t.total);
  setNum('dashTaskCompleted', t.completed);
  setNum('dashTaskRunning', t.running);
  setNum('dashTaskFailed', t.failed);

  // 绘制完成率环形图
  var ringEl = document.getElementById('dashCompletionRing');
  if (ringEl && t.total > 0) {
    var rate = Math.round((t.completed || 0) / t.total * 100);
    var color = rate >= 80 ? '#00E5A0' : (rate >= 50 ? '#F5A623' : '#FF6B81');
    var r = 42, cx = 55, cy = 55, sw = 5, circ = 2 * Math.PI * r;
    var offset = circ * (1 - rate / 100);
    ringEl.innerHTML = '<svg width="110" height="110" viewBox="0 0 110 110">'
      + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="'+sw+'"/>'
      + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+sw+'" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90,'+cx+','+cy+')" style="transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"/>'
      + '<text x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle" style="fill:var(--text-bold)" font-size="20" font-weight="700" font-family="\'Space Grotesk\'">'+rate+'%</text>'
      + '<text x="'+cx+'" y="'+(cy+14)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="9" font-family="sans-serif">完成率</text>'
      + '</svg>';
  } else if (ringEl) {
    ringEl.innerHTML = '<svg width="110" height="110" viewBox="0 0 110 110">'
      + '<circle cx="55" cy="55" r="42" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="5"/>'
      + '<text x="55" y="57" text-anchor="middle" style="fill:var(--text-muted)" font-size="11" font-family="sans-serif">暂无数据</text></svg>';
  }
}

function setNum(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = (val != null ? val : '--');
}

function animateNumber(el, target) {
  if (!el) return;
  var curText = el.textContent;
  if (curText === '--') curText = '0';
  var current = parseInt(curText) || 0;
  if (current === target && el.textContent !== '--') { el.textContent = target; return; }
  var steps = 15;
  var step = (target - current) / steps;
  var count = 0;
  function tick() {
    count++;
    current += step;
    if (count >= steps) { el.textContent = target; return; }
    el.textContent = Math.round(current);
    requestAnimationFrame(tick);
  }
  tick();
}

async function loadAllCompletedTasks() {
  try {
    var td = await api('GET', '/dashboard/tasks?status=completed&limit=200');
    allCompletedTasks = td.tasks || [];
  } catch(e) {
    allCompletedTasks = allTasksData.filter(function(t){ return t.status === 'completed'; });
  }
  renderAllCompletedTasks(allCompletedTasks);
  toast('已加载 ' + allCompletedTasks.length + ' 个已完成任务', 'fa-check', '#00E5A0');
}

function renderCharts() {
  renderStatusChart(allTasksData);
  renderTypeChart(allTasksData);
}

function renderStatusChart(tasks) {
  var el = document.getElementById('dashStatusChart');
  if (!el) return;

  var statusCounts = {};
  var taskCount = Array.isArray(tasks) ? tasks.length : 0;
  for (var i = 0; i < taskCount; i++) {
    var s = tasks[i].status || 'unknown';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  var statusOrder = ['completed', 'running', 'pending', 'error', 'unknown'];
  var statusLabels = { 'completed': '已完成', 'running': '运行中', 'pending': '等待中', 'error': '失败', 'unknown': '未知' };
  var statusColors = { 'completed': '#00E5A0', 'running': '#F5A623', 'pending': '#484f6e', 'error': '#FF6B81', 'unknown': '#7d849a' };
  var statusIcons = { 'completed': 'fa-check-circle', 'running': 'fa-spinner', 'pending': 'fa-clock', 'error': 'fa-times-circle', 'unknown': 'fa-question-circle' };

  var data = [], total = 0;
  for (var j = 0; j < statusOrder.length; j++) {
    var key = statusOrder[j];
    var val = statusCounts[key] || 0;
    total += val;
    data.push({ key: key, label: statusLabels[key], value: val, color: statusColors[key], icon: statusIcons[key] });
  }

  if (total === 0) {
    el.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">暂无任务数据</div>';
    return;
  }

  // 顶部：水平堆叠条
  var barH = 28;
  var h = '';
  h += '<div style="height:'+barH+'px;border-radius:8px;overflow:hidden;display:flex;margin-bottom:16px">';
  for (var i = 0; i < data.length; i++) {
    if (data[i].value === 0) continue;
    var pct = (data[i].value / total * 100);
    h += '<div style="width:'+pct+'%;height:100%;background:'+data[i].color+';transition:width .6s cubic-bezier(.4,0,.2,1)" title="'+data[i].label+': '+data[i].value+'"></div>';
  }
  h += '</div>';

  // 底部：状态卡片网格
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">';
  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    var dpct = total > 0 ? Math.round(d.value / total * 100) : 0;
    h += '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.04)">';
    h += '<div style="width:10px;height:10px;border-radius:3px;background:'+d.color+';flex-shrink:0"></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div style="font-size:11px;font-weight:600;color:var(--text)">'+d.label+'</div>';
    h += '<div style="font-size:10px;color:var(--text-muted)">'+d.value+' 个 · '+dpct+'%</div>';
    h += '</div>';
    h += '<div style="width:48px;height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden;flex-shrink:0">';
    h += '<div style="width:'+dpct+'%;height:100%;background:'+d.color+';border-radius:2px;transition:width .6s ease"></div></div>';
    h += '</div>';
  }
  h += '</div>';

  el.innerHTML = h;
}

function renderTypeChart(tasks) {
  var el = document.getElementById('dashTypeChart');
  if (!el) return;

  var typeCounts = {};
  var taskCount = Array.isArray(tasks) ? tasks.length : 0;
  for (var i = 0; i < taskCount; i++) {
    var t = tasks[i].type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索', 'unknown': '未知'
  };
  var typeColors = {
    'parse': '#00E5A0', 'discover': '#A78BFA', 'generate_idea': '#F5A623',
    'generate_algo': '#FF6B81', 'test': '#00D4FF', 'idea': '#F5A623',
    'validate': '#A78BFA', 'param_search': '#F97316', 'unknown': '#7d849a'
  };
  var typeIcons = {
    'parse': 'fa-file-lines', 'discover': 'fa-magnifying-glass', 'generate_idea': 'fa-lightbulb',
    'generate_algo': 'fa-code', 'test': 'fa-flask', 'idea': 'fa-lightbulb',
    'validate': 'fa-check-double', 'param_search': 'fa-sliders', 'unknown': 'fa-question'
  };

  var data = [];
  for (var key in typeCounts) {
    data.push({ key: key, label: typeLabels[key] || key, value: typeCounts[key], color: typeColors[key] || '#7d849a', icon: typeIcons[key] || 'fa-question' });
  }
  data.sort(function(a,b){ return b.value - a.value; });

  if (data.length === 0) {
    el.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">暂无任务数据</div>';
    return;
  }

  var total = data.reduce(function(s,d){ return s+d.value; }, 0);
  var h = '';
  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    var pct = Math.round(d.value / total * 100);
    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">';
    h += '<div style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;font-size:11px;flex-shrink:0;background:'+d.color+'15;color:'+d.color+'"><i class="fa-solid '+d.icon+'"></i></div>';
    h += '<div style="width:72px;flex-shrink:0;font-size:11px;font-weight:500;color:var(--text)">'+d.label+'</div>';
    h += '<div style="flex:1;min-width:60px">';
    h += '<div style="height:8px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden">';
    h += '<div style="width:'+pct+'%;height:100%;background:'+d.color+';border-radius:4px;transition:width .6s cubic-bezier(.4,0,.2,1)"></div></div></div>';
    h += '<div style="width:60px;text-align:right;flex-shrink:0">';
    h += '<span style="font-size:12px;font-weight:700;color:'+d.color+';font-family:\'Space Grotesk\'">'+d.value+'</span>';
    h += '<span style="font-size:9px;color:var(--text-muted);margin-left:4px">'+pct+'%</span>';
    h += '</div>';
    h += '</div>';
  }
  el.innerHTML = h;
}

function renderRunningTasks(tasks) {
  var el = document.getElementById('dashRunning');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:28px 20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-check-circle" style="font-size:28px;margin-bottom:10px;display:block;opacity:0.5"></i>当前没有运行中的任务</div>';
    return;
  }
  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索'
  };
  var h = '<div class="tbl-w"><table>';
  h += '<thead><tr><th style="width:25%">任务ID</th><th>类型</th><th>进度</th><th>当前步骤</th><th style="width:20%">开始时间</th></tr></thead><tbody>';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.created_at ? t.created_at.substring(5, 16) : '-';
    var typeLabel = typeLabels[t.type] || t.type;
    var pct = t.progress || 0;
    h += '<tr>';
    h += '<td style="font-family:\'Space Grotesk\',monospace;font-size:10px;color:var(--text-muted)">'+esc(t.id)+'</td>';
    h += '<td><span class="badge bdg-y">'+esc(typeLabel)+'</span></td>';
    h += '<td style="min-width:160px">';
    h += '<div style="display:flex;align-items:center;gap:8px">';
    h += '<div style="flex:1;height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">';
    h += '<div style="width:'+pct+'%;height:100%;background:linear-gradient(90deg,var(--accent),#F5A623);border-radius:3px;transition:width .3s ease"></div></div>';
    h += '<span style="font-size:10px;font-family:\'Space Grotesk\';color:var(--text-muted);min-width:30px">'+pct+'%</span></div></td>';
    h += '<td style="color:var(--text-muted);font-size:11px">'+esc(t.step || '-')+'</td>';
    h += '<td style="color:var(--text-muted);font-size:10px">'+time+'</td>';
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  el.innerHTML = h;
}

function renderCompletedTasks(tasks) {
  var el = document.getElementById('dashCompleted');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:28px 20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:28px;margin-bottom:10px;display:block;opacity:0.5"></i>暂无已完成的任务</div>';
    return;
  }
  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索'
  };
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">';
  for (var i = 0; i < Math.min(tasks.length, 6); i++) {
    var t = tasks[i];
    var time = t.updated_at ? t.updated_at.substring(5, 16) : '-';
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<div class="li-item task-done-item">';
    h += '<div class="li-ic" style="background:rgba(0,229,160,.12);color:#00E5A0"><i class="fa-solid fa-check"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm" style="font-size:12px">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt" style="font-size:10px"><i class="fa-regular fa-clock"></i> '+time+'</div>';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-family:\'Space Grotesk\',monospace">'+esc(t.id.substring(0,20))+'…</div>';
    h += '</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function renderAllCompletedTasks(tasks) {
  var el = document.getElementById('dashCompletedAll');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:28px 20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:28px;margin-bottom:10px;display:block;opacity:0.5"></i>暂无已完成的任务</div>';
    return;
  }
  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索'
  };
  var h = '<div class="card mb24" id="dashCompletedAllCard"><div class="card-t"><i class="fa-solid fa-list-check"></i>全部已完成任务 <span style="font-size:11px;color:var(--text-muted);font-weight:400;margin-left:8px">共 '+tasks.length+' 个</span></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;max-height:400px;overflow-y:auto">';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.updated_at ? t.updated_at.substring(5, 16) : '-';
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<div class="li-item task-done-item">';
    h += '<div class="li-ic" style="background:rgba(0,229,160,.12);color:#00E5A0"><i class="fa-solid fa-check"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm" style="font-size:12px">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt" style="font-size:10px"><i class="fa-regular fa-clock"></i> '+time+'</div>';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-family:\'Space Grotesk\',monospace">'+esc(t.id.substring(0,20))+'…</div>';
    h += '</div></div>';
  }
  h += '</div></div>';
  el.innerHTML = h;
  el.style.display = 'block';
  document.getElementById('dashCompletedAll').scrollIntoView({behavior:'smooth'});
}

function renderTaskHistory(tasks) {
  var el = document.getElementById('dashHistory');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:28px 20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:28px;margin-bottom:10px;display:block;opacity:0.5"></i>暂无任务记录</div>';
    return;
  }
  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索'
  };
  var h = '<div style="display:flex;flex-direction:column;gap:6px">';
  for (var i = 0; i < Math.min(tasks.length, 8); i++) {
    var t = tasks[i];
    var time = t.created_at ? t.created_at.substring(5, 16) : '-';
    var typeLabel = typeLabels[t.type] || t.type;
    var isDone = t.status === 'completed';
    var isRun = t.status === 'running';
    var statusColor = isDone ? '#00E5A0' : (isRun ? '#F5A623' : '#FF6B81');
    var statusIcon = isDone ? 'fa-check' : (isRun ? 'fa-spinner fa-spin' : 'fa-times');
    var statusLabel = isDone ? '完成' : (isRun ? '运行' : '失败');
    var statusBadge = isDone ? 'bdg-g' : (isRun ? 'bdg-y' : 'bdg-r');

    h += '<div class="li-item hist-item">';
    h += '<div class="li-ic" style="background:'+statusColor+'14;color:'+statusColor+'"><i class="fa-solid '+statusIcon+'"></i></div>';
    h += '<div style="flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:12px">';
    h += '<div style="min-width:0">';
    h += '<span class="li-nm" style="font-size:12px">'+esc(typeLabel)+'</span>';
    h += '<span style="font-size:10px;color:var(--text-muted);margin-left:8px;font-family:\'Space Grotesk\',monospace">'+esc(t.id.substring(0,12))+'…</span>';
    h += '</div>';
    h += '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">';
    h += '<span class="badge '+statusBadge+'" style="font-size:9px;padding:2px 8px">'+statusLabel+'</span>';
    h += '<span style="font-size:10px;color:var(--text-muted)">'+time+'</span>';
    h += '</div>';
    h += '</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

/* ===== System Stats (CPU/Memory/Disk/Gauge) ===== */
function renderGauge(el, percent, label, sublabel, color) {
  if (!el) return;
  var r = 40, cx = 60, cy = 62, sw = 5.5, circ = 2 * Math.PI * r;
  var p = Math.min(percent, 100);
  var offset = circ * (1 - p / 100);
  var shade = p > 80 ? '#FF6B81' : (p > 60 ? '#F5A623' : color);
  var svg = '<svg width="120" height="120" viewBox="0 0 120 120">';
  // 外圈发光
  svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+(r+4)+'" fill="none" stroke="'+shade+'" stroke-width="1" opacity="0.08"/>';
  // 背景轨道
  svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="'+sw+'"/>';
  // 数据弧
  svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+shade+'" stroke-width="'+sw+'" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90,'+cx+','+cy+')" style="transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"/>';
  // 内圈发光点
  var dotAngle = (-90 + (p/100)*360) * Math.PI / 180;
  var dotX = cx + r * Math.cos(dotAngle);
  var dotY = cy + r * Math.sin(dotAngle);
  svg += '<circle cx="'+dotX+'" cy="'+dotY+'" r="3" fill="'+shade+'" opacity="0.6"/>';
  // 百分比
  svg += '<text x="'+cx+'" y="'+(cy-1)+'" text-anchor="middle" style="fill:var(--text-bold)" font-size="17" font-weight="700" font-family="\'Space Grotesk\'">'+Math.round(p)+'%</text>';
  // 副标签
  svg += '<text x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="9" font-family="sans-serif">'+esc(sublabel)+'</text>';
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderGpuCards(gpus) {
  var container = document.getElementById('gpuCards');
  if (!container) return;
  if (!gpus || gpus.length === 0) {
    container.innerHTML = '<div class="st-card" style="--accent:#00D4FF"><div class="st-l" style="text-align:center">GPU</div><div style="height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center"><i class="fa-solid fa-microchip" style="font-size:24px;color:var(--text-muted);opacity:0.3;margin-bottom:8px"></i><span style="color:var(--text-muted);font-size:11px">未检测到 GPU</span></div></div>';
    return;
  }
  var h = '';
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    var uc = g.utilization_percent > 80 ? '#FF6B81' : (g.utilization_percent > 50 ? '#F5A623' : '#00E5A0');
    var mc = g.memory_percent > 80 ? '#FF6B81' : (g.memory_percent > 50 ? '#F5A623' : '#A78BFA');
    h += '<div class="st-card" style="--accent:'+uc+';grid-column:span 2">';
    h += '<div class="st-l" style="text-align:center;margin-bottom:8px"><i class="fa-solid fa-microchip"></i> GPU ' + g.index + ' · ' + esc(g.name) + '</div>';
    h += '<div style="display:flex;gap:12px">';
    h += '<div style="flex:1;text-align:center"><div id="gpuUtilGauge_'+i+'" style="height:100px"></div><div style="font-size:10px;color:var(--text-muted);margin-top:-4px">利用率</div></div>';
    h += '<div style="flex:1;text-align:center"><div id="gpuMemGauge_'+i+'" style="height:100px"></div><div style="font-size:10px;color:var(--text-muted);margin-top:-4px">显存</div></div>';
    h += '</div></div>';
  }
  container.innerHTML = h;
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    var uc = g.utilization_percent > 80 ? '#FF6B81' : (g.utilization_percent > 50 ? '#F5A623' : '#00E5A0');
    var mc = g.memory_percent > 80 ? '#FF6B81' : (g.memory_percent > 50 ? '#F5A623' : '#A78BFA');
    renderGauge(document.getElementById('gpuUtilGauge_'+i), g.utilization_percent, '利用率', g.utilization_percent+'%', uc);
    renderGauge(document.getElementById('gpuMemGauge_'+i), g.memory_percent, '显存', Math.round(g.memory_used_mb)+'/'+Math.round(g.memory_total_mb)+' MB', mc);
  }
}

async function loadSystemStats() {
  try {
    var s = await api('GET', '/dashboard/stats');
    renderGauge(document.getElementById('sysCpuGauge'), s.cpu.percent, 'CPU', s.cpu.cores+' 核', '#00E5A0');
    renderGauge(document.getElementById('sysMemGauge'), s.memory.percent, '内存', s.memory.used_gb.toFixed(1)+'/'+s.memory.total_gb.toFixed(1)+' GB', '#A78BFA');
    renderGauge(document.getElementById('sysDiskGauge'), s.disk.percent, '磁盘', s.disk.used_gb.toFixed(1)+'/'+s.disk.total_gb.toFixed(1)+' GB', '#F5A623');
    renderGpuCards(s.gpus);
  } catch (e) {
    ['sysCpuGauge','sysMemGauge','sysDiskGauge'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<span style="color:var(--text-muted);font-size:11px">无法获取</span>';
    });
  }
}

function startDashboardPoll() {
  if (dashInterval) clearInterval(dashInterval);
  dashInterval = setInterval(loadDashboard, 3000);
}

function stopDashboardPoll() {
  if (dashInterval) {
    clearInterval(dashInterval);
    dashInterval = null;
  }
}

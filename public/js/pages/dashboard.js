/* ===== Dashboard Page — 天研 AI for Science ===== */

pages.dashboard = function() {
  var h = '';

  // ── Tab Bar ──
  h += '<div class="tab-bar">';
  h += '<button class="tab-btn on">研究流程</button>';
  h += '<button class="tab-btn">任务中心</button>';
  h += '<button class="tab-btn">系统资源</button>';
  h += '</div>';

  // ── Section Header ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">科研全流程 AI 服务</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="天研 AI 研究流水线：从文献到算法代码的端到端自动化"></i></div>';
  h += '<div style="display:flex;gap:8px">';
  h += '<button type="button" class="btn" onclick="toast(\'报告导出功能开发中\',\'fa-info-circle\',\'#f59e0b\')"><i class="fa-solid fa-download"></i> 导出报告</button>';
  h += '<button type="button" class="btn bp" onclick="go(\'kb\')"><i class="fa-solid fa-plus"></i> 新建任务</button>';
  h += '</div></div>';

  // ── 9-Step Research Workflow ──
  h += '<div class="card mb24">';
  h += '<div class="card-t"><i class="fa-solid fa-diagram-project"></i>研究流程</div>';
  h += '<div class="workflow" id="dashWorkflow">';
  var steps = [
    {n:1, icon:'fa-book-open', color:'#3b6df0', bg:'#e8f0ff', title:'文献知识库', desc:'自动构建知识库' },
    {n:2, icon:'fa-magnifying-glass', color:'#10b981', bg:'#d1fae5', title:'文献深度理解', desc:'提炼关键信息' },
    {n:3, icon:'fa-lightbulb', color:'#f59e0b', bg:'#fef3c7', title:'研究动机发现', desc:'发现研究空白' },
    {n:4, icon:'fa-flask', color:'#8b5cf6', bg:'#ede9fe', title:'科学假说形成', desc:'生成创新假说' },
    {n:5, icon:'fa-flask-vial', color:'#ef4444', bg:'#fee2e2', title:'实验设计与执行', desc:'辅助实验记录' },
    {n:6, icon:'fa-chart-line', color:'#06b6d4', bg:'#cffafe', title:'结果分析与优化', desc:'优化研究方法' },
    {n:7, icon:'fa-chart-pie', color:'#f97316', bg:'#ffedd5', title:'科技价值分析', desc:'多维评估价值' },
    {n:8, icon:'fa-file-pen', color:'#6366f1', bg:'#e0e7ff', title:'论文辅助写作', desc:'内容到润色' },
    {n:9, icon:'fa-chart-diagram', color:'#ec4899', bg:'#fce7f3', title:'科研绘图', desc:'生成高质量图表' }
  ];
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    h += '<div class="workflow-step">';
    h += '<div class="ws-icon" style="background:'+s.bg+';color:'+s.color+'"><i class="fa-solid '+s.icon+'"></i></div>';
    h += '<div class="ws-num">步骤 '+s.n+'</div>';
    h += '<div class="ws-title">'+s.title+'</div>';
    h += '<div class="ws-desc">'+s.desc+'</div>';
    h += '</div>';
    if (i < steps.length - 1) {
      h += '<div class="workflow-arrow"><i class="fa-solid fa-chevron-right"></i></div>';
    }
  }
  h += '</div></div>';

  // ── Data Panels ──
  h += '<div class="dash-panels">';

  // Panel 1: 项目进度
  h += '<div class="dash-panel">';
  h += '<div class="dp-title"><i class="fa-solid fa-chart-pie" style="color:#3b6df0"></i>项目进度</div>';
  h += '<div class="progress-ring-wrap" style="margin-bottom:10px">';
  h += '<div id="dashProgressRing" style="width:120px;height:120px"></div>';
  h += '</div>';
  h += '<div style="font-size:11px;color:var(--text-muted);text-align:center;line-height:1.6">';
  h += '<div id="dashProgressStep">加载中…</div>';
  h += '</div>';
  h += '<div class="dp-link" onclick="go(\'dashboard\')">查看全部任务 <i class="fa-solid fa-arrow-right"></i></div>';
  h += '</div>';

  // Panel 2: 当前任务
  h += '<div class="dash-panel">';
  h += '<div class="dp-title"><i class="fa-solid fa-list-check" style="color:#10b981"></i>当前任务</div>';
  h += '<div id="dashCurrentTasks" style="color:var(--text-muted);font-size:12px">加载中…</div>';
  h += '<div class="dp-link" onclick="go(\'dashboard\')">查看全部任务 <i class="fa-solid fa-arrow-right"></i></div>';
  h += '</div>';

  // Panel 3: 关键数据
  h += '<div class="dash-panel">';
  h += '<div class="dp-title"><i class="fa-solid fa-database" style="color:#f59e0b"></i>关键数据</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="dashKeyData">';
  var kd = [
    {key:'papers', label:'文献数量', icon:'fa-file-lines', color:'#3b6df0'},
    {key:'entries', label:'知识条目', icon:'fa-layer-group', color:'#10b981'},
    {key:'problems', label:'发现问题', icon:'fa-bug', color:'#f59e0b'},
    {key:'ideas', label:'研究创意', icon:'fa-lightbulb', color:'#8b5cf6'}
  ];
  for (var j = 0; j < kd.length; j++) {
    var d = kd[j];
    h += '<div style="padding:10px 12px;border-radius:8px;background:var(--bg);text-align:center">';
    h += '<div style="font-family:\'Space Grotesk\',sans-serif;font-size:20px;font-weight:700;color:'+d.color+'" id="dashKd_'+d.key+'">--</div>';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">'+d.label+'</div>';
    h += '</div>';
  }
  h += '</div>';
  h += '<div class="dp-link" onclick="go(\'kb\')">查看全部数据 <i class="fa-solid fa-arrow-right"></i></div>';
  h += '</div>';

  // Panel 4: 智能推荐 (static for now)
  h += '<div class="dash-panel">';
  h += '<div class="dp-title"><i class="fa-solid fa-lightbulb" style="color:#f97316"></i>智能推荐</div>';
  h += '<div class="rec-item"><div class="rec-icon" style="background:#e8f0ff;color:#3b6df0"><i class="fa-solid fa-lightbulb"></i></div><div style="flex:1"><div style="font-size:11px">基于您的研究进展，推荐补充相关文献</div></div></div>';
  h += '<div class="rec-item"><div class="rec-icon" style="background:#d1fae5;color:#10b981"><i class="fa-solid fa-lightbulb"></i></div><div style="flex:1"><div style="font-size:11px">发现新的研究方向相关假说</div></div></div>';
  h += '<div class="rec-item"><div class="rec-icon" style="background:#fef3c7;color:#f59e0b"><i class="fa-solid fa-lightbulb"></i></div><div style="flex:1"><div style="font-size:11px">优化实验方案以提高效率</div></div></div>';
  h += '<div class="dp-link" onclick="go(\'lit\')">进入文献分析 <i class="fa-solid fa-arrow-right"></i></div>';
  h += '</div>';

  // Panel 5: 动态记录
  h += '<div class="dash-panel" style="grid-column: 1 / -1">';
  h += '<div class="dp-title"><i class="fa-solid fa-clock-rotate-left" style="color:#8b5cf6"></i>动态记录</div>';
  h += '<div id="dashActivityLog" style="color:var(--text-muted);font-size:12px;max-height:200px;overflow-y:auto">加载中…</div>';
  h += '<div class="dp-link" onclick="go(\'dashboard\')">查看全部动态 <i class="fa-solid fa-arrow-right"></i></div>';
  h += '</div>';

  h += '</div>'; // dash-panels

  // ── 系统资源 ──
  h += '<div class="card mb24" id="dashSysSection">';
  h += '<div class="card-t"><i class="fa-solid fa-microchip"></i>系统资源使用 <span class="api-t api-g" style="margin-left:auto">实时</span></div>';
  h += '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))" id="sysStatsContainer">';
  h += '<div class="st-card"><div class="st-l" style="text-align:center">CPU 使用率</div><div id="sysCpuGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card"><div class="st-l" style="text-align:center">内存使用</div><div id="sysMemGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card"><div class="st-l" style="text-align:center">磁盘使用</div><div id="sysDiskGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
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

  try {
    var usage = await api('GET', '/dashboard/usage');
    renderPipelineStats(usage);
    renderDashboardPanels(usage);
  } catch(e) {}

  var running = allTasksData.filter(function(t){ return t.status === 'running'; });
  var completed = allTasksData.filter(function(t){ return t.status === 'completed'; });

  renderDashboardTasks(running, completed);
  renderActivityLog(allTasksData);

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
  var keys = ['papers','entries','problems','ideas'];
  keys.forEach(function(k){
    var el = document.getElementById('dashKd_' + k);
    if (el) {
      var val = data[k] != null ? data[k] : 0;
      el.textContent = val;
    }
  });
}

function renderDashboardPanels(usage) {
  // Progress ring
  var t = usage.tasks || {};
  var total = t.total || 0;
  var completed = t.completed || 0;
  var ringEl = document.getElementById('dashProgressRing');
  if (ringEl) {
    var rate = total > 0 ? Math.round(completed / total * 100) : 0;
    var color = '#3b6df0';
    var r = 42, cx = 55, cy = 55, sw = 5, circ = 2 * Math.PI * r;
    var offset = circ * (1 - rate / 100);
    ringEl.innerHTML = '<svg width="110" height="110" viewBox="0 0 110 110">'
      + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="var(--border-light)" stroke-width="'+sw+'"/>'
      + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+sw+'" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90,'+cx+','+cy+')" style="transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"/>'
      + '<text x="'+cx+'" y="'+(cy-2)+'" text-anchor="middle" style="fill:var(--text-bold)" font-size="20" font-weight="700" font-family="\'Space Grotesk\'">'+rate+'%</text>'
      + '<text x="'+cx+'" y="'+(cy+14)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="9" font-family="sans-serif">总体进度</text>'
      + '</svg>';
  }
  var stepEl = document.getElementById('dashProgressStep');
  if (stepEl) {
    stepEl.innerHTML = '已完成 <b>'+completed+'</b> / '+total+' 个任务';
  }
}

function renderDashboardTasks(running, completed) {
  var el = document.getElementById('dashCurrentTasks');
  if (!el) return;

  var tasks = running.concat(completed.slice(0, 3));
  if (tasks.length === 0) {
    el.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">暂无任务</div>';
    return;
  }
  var h = '';
  var typeLabels = {
    'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
    'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
    'validate': '问题验证', 'param_search': '参数搜索'
  };
  var statusLabels = { 'running': '进行中', 'completed': '已完成', 'pending': '待开始', 'error': '失败' };
  var statusColors = { 'running': '#f59e0b', 'completed': '#10b981', 'pending': '#94a3b8', 'error': '#ef4444' };

  for (var i = 0; i < Math.min(tasks.length, 5); i++) {
    var t = tasks[i];
    var typeLabel = typeLabels[t.type] || t.type;
    var sColor = statusColors[t.status] || '#94a3b8';
    var sLabel = statusLabels[t.status] || t.status;
    h += '<div class="task-mini-item">';
    h += '<span class="task-mini-status" style="background:'+sColor+'"></span>';
    h += '<span style="flex:1">'+esc(typeLabel)+'</span>';
    h += '<span class="badge" style="font-size:10px;background:'+sColor+'15;color:'+sColor+'">'+sLabel+'</span>';
    h += '</div>';
  }
  el.innerHTML = h;
}

function renderActivityLog(tasks) {
  var el = document.getElementById('dashActivityLog');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">暂无动态记录</div>';
    return;
  }
  var typeLabels = {
    'parse': '文献解析完成', 'discover': '研究问题发现完成', 'generate_idea': 'Idea 生成完成',
    'generate_algo': '算法生成完成', 'test': '测试执行完成', 'idea': 'Idea 生成完成',
    'validate': '问题验证完成', 'param_search': '参数搜索完成'
  };
  var timeAgo = function(t) {
    if (!t) return '';
    var d = new Date(t + 'Z');
    var now = new Date();
    var diff = now - d;
    var mins = Math.floor(diff / 60000);
    var hrs = Math.floor(diff / 3600000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    if (hrs < 24) return hrs + ' 小时前';
    return t.substring(5, 16);
  };

  var h = '';
  for (var i = 0; i < Math.min(tasks.length, 8); i++) {
    var t = tasks[i];
    if (t.status !== 'completed' && t.status !== 'error') continue;
    var typeLabel = typeLabels[t.type] || ('任务 ' + t.type);
    var icon = t.status === 'completed' ? 'fa-check-circle' : 'fa-times-circle';
    var iconColor = t.status === 'completed' ? '#10b981' : '#ef4444';
    h += '<div class="activity-item">';
    h += '<div style="display:flex;align-items:center;gap:6px"><i class="fa-solid '+icon+'" style="color:'+iconColor+';font-size:11px"></i> '+typeLabel+'</div>';
    h += '<div class="act-time">'+timeAgo(t.updated_at || t.created_at)+'</div>';
    h += '</div>';
  }
  if (!h) h = '<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11px">暂无动态记录</div>';
  el.innerHTML = h;
}

var typeLabels = {
  'parse': '文献解析', 'discover': '问题发现', 'generate_idea': 'Idea生成',
  'generate_algo': '算法生成', 'test': '测试执行', 'idea': 'Idea生成',
  'validate': '问题验证', 'param_search': '参数搜索'
};

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
  var statusColors = { 'completed': '#10b981', 'running': '#f59e0b', 'pending': '#94a3b8', 'error': '#ef4444', 'unknown': '#64748b' };

  var data = [], total = 0;
  for (var j = 0; j < statusOrder.length; j++) {
    var key = statusOrder[j];
    var val = statusCounts[key] || 0;
    total += val;
    data.push({ key: key, label: statusLabels[key], value: val, color: statusColors[key] });
  }

  if (total === 0) {
    el.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">暂无任务数据</div>';
    return;
  }

  var h = '';
  h += '<div style="height:24px;border-radius:6px;overflow:hidden;display:flex;margin-bottom:14px">';
  for (var i = 0; i < data.length; i++) {
    if (data[i].value === 0) continue;
    var pct = (data[i].value / total * 100);
    h += '<div style="width:'+pct+'%;height:100%;background:'+data[i].color+';transition:width .6s ease" title="'+data[i].label+': '+data[i].value+'"></div>';
  }
  h += '</div>';

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px">';
  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    var dpct = total > 0 ? Math.round(d.value / total * 100) : 0;
    h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg)">';
    h += '<div style="width:8px;height:8px;border-radius:2px;background:'+d.color+';flex-shrink:0"></div>';
    h += '<div style="flex:1"><div style="font-size:11px;font-weight:600;color:var(--text)">'+d.label+'</div></div>';
    h += '<span style="font-size:11px;font-weight:700;color:var(--text)">'+d.value+'</span>';
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

  var typeColors = {
    'parse': '#10b981', 'discover': '#8b5cf6', 'generate_idea': '#f59e0b',
    'generate_algo': '#ef4444', 'test': '#06b6d4', 'idea': '#f59e0b',
    'validate': '#8b5cf6', 'param_search': '#f97316', 'unknown': '#64748b'
  };

  var data = [];
  for (var key in typeCounts) {
    data.push({ key: key, label: typeLabels[key] || key, value: typeCounts[key], color: typeColors[key] || '#64748b' });
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
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
    h += '<div style="width:24px;height:24px;border-radius:6px;display:grid;place-items:center;font-size:10px;flex-shrink:0;background:'+d.color+'15;color:'+d.color+'"><i class="fa-solid fa-circle"></i></div>';
    h += '<div style="width:64px;flex-shrink:0;font-size:11px;font-weight:500;color:var(--text)">'+d.label+'</div>';
    h += '<div style="flex:1"><div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">';
    h += '<div style="width:'+pct+'%;height:100%;background:'+d.color+';border-radius:3px;transition:width .6s ease"></div></div></div>';
    h += '<span style="font-size:11px;font-weight:700;font-family:\'Space Grotesk\';color:var(--text);min-width:28px;text-align:right">'+d.value+'</span>';
    h += '</div>';
  }
  el.innerHTML = h;
}

/* ===== System Stats ===== */
function renderGauge(el, percent, label, sublabel, color) {
  if (!el) return;
  var r = 40, cx = 60, cy = 62, sw = 5.5, circ = 2 * Math.PI * r;
  var p = Math.min(percent, 100);
  var offset = circ * (1 - p / 100);
  var shade = p > 80 ? '#ef4444' : (p > 60 ? '#f59e0b' : color);
  el.innerHTML = '<svg width="120" height="120" viewBox="0 0 120 120">'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="var(--border-light)" stroke-width="'+sw+'"/>'
    + '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+shade+'" stroke-width="'+sw+'" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90,'+cx+','+cy+')" style="transition:stroke-dashoffset .8s ease"/>'
    + '<text x="'+cx+'" y="'+(cy-1)+'" text-anchor="middle" style="fill:var(--text-bold)" font-size="17" font-weight="700" font-family="\'Space Grotesk\'">'+Math.round(p)+'%</text>'
    + '<text x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="9" font-family="sans-serif">'+esc(sublabel)+'</text>'
    + '</svg>';
}

function renderGpuCards(gpus) {
  var container = document.getElementById('gpuCards');
  if (!container) return;
  if (!gpus || gpus.length === 0) {
    container.innerHTML = '<div class="st-card"><div class="st-l" style="text-align:center">GPU</div><div style="height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center"><i class="fa-solid fa-microchip" style="font-size:24px;color:var(--text-muted);opacity:0.3;margin-bottom:8px"></i><span style="color:var(--text-muted);font-size:11px">未检测到 GPU</span></div></div>';
    return;
  }
  var h = '';
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    h += '<div class="st-card" style="grid-column:span 2">';
    h += '<div class="st-l" style="text-align:center;margin-bottom:8px"><i class="fa-solid fa-microchip"></i> GPU ' + g.index + ' · ' + esc(g.name) + '</div>';
    h += '<div style="display:flex;gap:12px">';
    h += '<div style="flex:1;text-align:center"><div id="gpuUtilGauge_'+i+'" style="height:100px"></div><div style="font-size:10px;color:var(--text-muted)">利用率</div></div>';
    h += '<div style="flex:1;text-align:center"><div id="gpuMemGauge_'+i+'" style="height:100px"></div><div style="font-size:10px;color:var(--text-muted)">显存</div></div>';
    h += '</div></div>';
  }
  container.innerHTML = h;
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    renderGauge(document.getElementById('gpuUtilGauge_'+i), g.utilization_percent, '利用率', g.utilization_percent+'%', '#10b981');
    renderGauge(document.getElementById('gpuMemGauge_'+i), g.memory_percent, '显存', Math.round(g.memory_used_mb)+'/'+Math.round(g.memory_total_mb)+' MB', '#8b5cf6');
  }
}

async function loadSystemStats() {
  try {
    var s = await api('GET', '/dashboard/stats');
    renderGauge(document.getElementById('sysCpuGauge'), s.cpu.percent, 'CPU', s.cpu.cores+' 核', '#10b981');
    renderGauge(document.getElementById('sysMemGauge'), s.memory.percent, '内存', s.memory.used_gb.toFixed(1)+'/'+s.memory.total_gb.toFixed(1)+' GB', '#8b5cf6');
    renderGauge(document.getElementById('sysDiskGauge'), s.disk.percent, '磁盘', s.disk.used_gb.toFixed(1)+'/'+s.disk.total_gb.toFixed(1)+' GB', '#f59e0b');
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

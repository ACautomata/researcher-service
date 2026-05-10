/* ===== Dashboard Page ===== */
// 生成演示任务数据
function generateDemoTasks() {
  var types = ['parse', 'discover', 'generate_idea', 'generate_algo', 'test'];
  var typeNames = { parse:'文献解析', discover:'问题发现', generate_idea:'Idea生成', generate_algo:'算法生成', test:'测试执行' };
  var statuses = ['completed', 'completed', 'completed', 'completed', 'running', 'pending', 'error'];
  var statusNames = { completed:'已完成', running:'运行中', pending:'等待中', error:'失败' };
  var tasks = [];
  var now = new Date();
  for (var i = 0; i < 28; i++) {
    var t = types[i % types.length];
    var s = statuses[i % statuses.length];
    var d = new Date(now);
    d.setMinutes(d.getMinutes() - i * 7 - Math.floor(Math.random() * 20));
    var created = d.toISOString().replace('T', ' ').slice(0, 19);
    var updated = new Date(d.getTime() + 300000).toISOString().replace('T', ' ').slice(0, 19);
    var steps = ['初始化', '执行中', '分析中', '完成'];
    var prog = s === 'completed' ? 100 : (s === 'running' ? Math.floor(Math.random() * 60) + 20 : 0);
    tasks.push({
      id: 'task_' + String(100 + i),
      type: t,
      status: s,
      progress: prog,
      step: s === 'running' ? steps[Math.floor(prog / 33)] : (s === 'completed' ? '完成' : '排队中'),
      error: s === 'error' ? '连接超时，请重试' : null,
      created_at: created,
      updated_at: updated
    });
  }
  return tasks;
}

pages.dashboard = function() {
  var h = '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-diagram-project"></i>系统数据流</div>';
  h += '<div style="display:flex;align-items:center;justify-content:center;gap:0;padding:20px 0;flex-wrap:wrap">';
  var ns = [{n:'知识库',s:'上传·解析·领域',c:'#00E5A0'},{n:'问题发现',s:'AI发现·验证·搜索',c:'#F5A623'},{n:'Idea生成',s:'AI创意·评分排序',c:'#A78BFA'},{n:'算法实现',s:'代码·测试·优化',c:'#FF6B81'},{n:'参数优化',s:'超参建议',c:'#F97316'}];
  for (var i = 0; i < ns.length; i++) {
    h += '<div style="text-align:center;padding:16px 22px;border-radius:12px;border:2px solid ' + ns[i].c + '30;background:' + ns[i].c + '0a;min-width:90px"><div style="font-size:11px;font-weight:700;color:' + ns[i].c + '">' + ns[i].n + '</div><div style="font-size:10px;color:#464d65;margin-top:2px">' + ns[i].s + '</div></div>';
    if (i < ns.length - 1) h += '<div style="display:flex;flex-direction:column;align-items:center;width:48px;padding:0 4px"><div style="font-size:9px;color:#464d65;margin-bottom:2px">产出</div><i class="fa-solid fa-arrow-right" style="font-size:12px;color:#464d65"></i></div>';
  }
  h += '</div></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:16px;margin-bottom:24px">';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-pie"></i>任务状态分布</div><div id="dashStatusChart" style="height:280px"></div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-bar"></i>任务类型分布</div><div id="dashTypeChart" style="height:280px"></div></div>';
  h += '</div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-chart-line"></i>运行中任务</div>';
  h += '<div id="dashRunning" style="color:var(--text-muted);font-size:13px">加载中…</div></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-check-circle"></i>已完成任务</div>';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  h += '<div id="dashCompleted" style="color:var(--text-muted);font-size:13px;flex:1">加载中…</div>';
  h += '<button type="button" class="btn" onclick="loadAllCompletedTasks()"><i class="fa-solid fa-list"></i> 查看全部</button>';
  h += '</div></div>';
  h += '<div id="dashCompletedAll" style="display:none"></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-clock-rotate-left"></i>最近任务历史</div><div id="dashHistory" style="color:var(--text-muted);font-size:13px;max-height:200px;overflow-y:auto"></div></div>';
  // 系统资源挪到最后
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-microchip"></i>系统资源使用 <span class="api-t api-g" style="margin-left:auto">实时</span></div>';
  h += '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))" id="sysStatsContainer">';
  h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-l">CPU 使用率</div><div id="sysCpuGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card" style="--accent:#A78BFA"><div class="st-l">内存使用</div><div id="sysMemGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div class="st-card" style="--accent:#F5A623"><div class="st-l">磁盘使用</div><div id="sysDiskGauge" style="height:120px;display:flex;align-items:center;justify-content:center">加载中…</div></div>';
  h += '<div id="gpuCards" style="display:contents"></div>';
  h += '</div></div>';
  return h;
};

var dashInterval = null;
var allTasksData = [];
var isFirstLoad = true;
var allCompletedTasks = [];

async function loadDashboard() {
  var demo = generateDemoTasks();
  allTasksData = demo;
  var running = demo.filter(function(t){ return t.status === 'running'; });
  var completed = demo.filter(function(t){ return t.status === 'completed'; });

  renderRunningTasks(running);
  renderCompletedTasks(completed);
  renderTaskHistory(allTasksData);

  if (isFirstLoad) {
    setTimeout(function() {
      renderCharts();
      isFirstLoad = false;
    }, 100);
  } else {
    renderCharts();
  }

  loadSystemStats();
}

async function loadAllCompletedTasks() {
  allCompletedTasks = allTasksData.filter(function(t){ return t.status === 'completed'; });
  renderAllCompletedTasks(allCompletedTasks);
  toast('已加载 '+allCompletedTasks.length+' 个已完成的任务', 'fa-check', '#00E5A0');
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

  var statusLabels = { 'completed': '已完成', 'running': '运行中', 'pending': '等待中', 'error': '失败', 'unknown': '未知' };
  var statusColors = { 'completed': '#00E5A0', 'running': '#F5A623', 'pending': '#484f6e', 'error': '#FF6B81', 'unknown': '#7d849a' };

  var data = [];
  for (var key in statusCounts) {
    data.push({ label: statusLabels[key] || key, value: statusCounts[key], color: statusColors[key] || '#7d849a' });
  }

  var total = data.reduce(function(sum, d) { return sum + d.value; }, 0);

  var legendHtml = '<div style="position:absolute;top:10px;right:10px;background:rgba(5,7,13,0.9);padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.05);font-size:10px">';
  for (var j = 0; j < data.length; j++) {
    legendHtml += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">';
    legendHtml += '<div style="width:10px;height:10px;border-radius:2px;background:'+data[j].color+'"></div>';
    legendHtml += '<span style="color:#b0b8c8">'+data[j].label+' ('+data[j].value+')</span></div>';
  }
  legendHtml += '</div>';

  if (taskCount === 0) {
    el.innerHTML = '<div style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column">' +
      '<svg width="280" height="280" viewBox="0 0 280 280" style="background:transparent">' +
      '<circle cx="140" cy="140" r="90" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="4,4"/>' +
      '<text x="140" y="144" text-anchor="middle" style="fill:var(--text-muted)" font-size="14" font-family="sans-serif">暂无任务</text>' +
      '</svg>' + legendHtml + '</div>';
    return;
  }

  var width = 280;
  var height = 280;
  var radius = 90;
  var centerX = width / 2;
  var centerY = height / 2;
  var currentAngle = -Math.PI / 2;

  var svg = '<svg width="280" height="280" viewBox="0 0 '+width+' '+height+'" style="background:transparent">';

  for (var i = 0; i < data.length; i++) {
    var angle = (data[i].value / total) * 2 * Math.PI;
    var x1 = centerX + radius * Math.cos(currentAngle);
    var y1 = centerY + radius * Math.sin(currentAngle);
    var x2 = centerX + radius * Math.cos(currentAngle + angle);
    var y2 = centerY + radius * Math.sin(currentAngle + angle);

    var largeArc = angle > Math.PI ? 1 : 0;
    var sweepFlag = 1;

    svg += '<path d="M '+centerX+' '+centerY+' L '+x1+' '+y1+' A '+radius+' '+radius+' 0 '+largeArc+' '+sweepFlag+' '+x2+' '+y2+' Z" fill="'+data[i].color+'" stroke="rgba(5,7,13,0.3)" stroke-width="2"/>';

    var midAngle = currentAngle + angle / 2;
    var labelRadius = radius + 25;
    var labelX = centerX + labelRadius * Math.cos(midAngle);
    var labelY = centerY + labelRadius * Math.sin(midAngle);
    var textAnchor = midAngle > -Math.PI / 2 && midAngle < Math.PI / 2 ? 'start' : 'end';

    svg += '<text x="'+labelX+'" y="'+labelY+'" text-anchor="'+textAnchor+'" style="fill:var(--text)" font-size="10" font-family="sans-serif">'+data[i].label+'</text>';

    currentAngle += angle;
  }
  svg += '</svg>';

  el.innerHTML = '<div style="position:relative;height:100%;display:flex;align-items:center;justify-content:center">' + svg + legendHtml + '</div>';
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
    'parse': '文献解析',
    'discover': '问题发现',
    'generate_idea': 'Idea生成',
    'generate_algo': '算法生成',
    'test': '测试执行',
    'unknown': '未知'
  };

  var typeColors = {
    'parse': '#00E5A0',
    'discover': '#A78BFA',
    'generate_idea': '#F5A623',
    'generate_algo': '#FF6B81',
    'test': '#00D4FF',
    'unknown': '#7d849a'
  };

  var data = [];
  for (var key in typeCounts) {
    data.push({ label: typeLabels[key] || key, value: typeCounts[key], color: typeColors[key] || '#7d849a' });
  }

  var width = 400;
  var height = 280;
  var barHeight = 24;
  var barGap = 12;
  var maxBarWidth = width - 160;
  var maxValue = 1;

  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+width+' '+height+'" style="background:transparent">';
  if (taskCount > 0) {
    for (var m = 0; m < data.length; m++) {
      if (data[m].value > maxValue) maxValue = data[m].value;
    }
    for (var i = 0; i < data.length; i++) {
      var y = 20 + i * (barHeight + barGap);
      var barWidth = (data[i].value / maxValue) * maxBarWidth;

      svg += '<rect x="140" y="'+y+'" width="'+barWidth+'" height="'+barHeight+'" fill="'+data[i].color+'" rx="4" opacity="0.8"/>';
      svg += '<text x="130" y="'+(y + barHeight/2 + 4)+'" text-anchor="end" style="fill:var(--text-muted)" font-size="11" font-family="sans-serif">'+data[i].label+'</text>';
      svg += '<text x="'+(140 + barWidth + 8)+'" y="'+(y + barHeight/2 + 4)+'" style="fill:var(--text)" font-size="11" font-family="sans-serif" font-weight="700">'+data[i].value+'</text>';
    }
  } else {
    svg += '<text x="'+(width/2)+'" y="'+(height/2)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="11" font-family="sans-serif">暂无任务数据</text>';
  }
  svg += '</svg>';

  el.innerHTML = svg;
}

function renderRunningTasks(tasks) {
  var el = document.getElementById('dashRunning');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-check-circle" style="font-size:24px;margin-bottom:8px"></i><p>当前没有运行中的任务</p></div>';
    return;
  }
  var h = '<div class="tbl-w"><table>';
  h += '<thead><tr><th>任务ID</th><th>类型</th><th>进度</th><th>当前步骤</th><th>开始时间</th></tr></thead><tbody>';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.created_at ? t.created_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<tr>';
    h += '<td style="font-family:\'Space Grotesk\',monospace">'+esc(t.id)+'</td>';
    h += '<td><span class="badge bdg-y">'+esc(typeLabel)+'</span></td>';
    h += '<td>';
    h += '<div style="display:flex;align-items:center;gap:6px">';
    h += '<div style="flex:1;height:4px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden">';
    h += '<div style="width:'+t.progress+'%;height:100%;background:var(--accent);transition:width .3s ease"></div></div>';
    h += '<span style="font-size:10px;font-family:\'Space Grotesk\';min-width:32px">'+t.progress+'%</span></div></td>';
    h += '<td style="color:var(--text-muted)">'+esc(t.step || '-')+'</td>';
    h += '<td style="color:var(--text-muted);font-size:11px">'+time+'</td>';
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  el.innerHTML = h;
}

function renderCompletedTasks(tasks) {
  var el = document.getElementById('dashCompleted');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:24px;margin-bottom:8px"></i><p>暂无已完成的任务</p></div>';
    return;
  }
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.updated_at ? t.updated_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<div class="li-item">';
    h += '<div class="li-ic" style="background:var(--accent);color:#05070d"><i class="fa-solid fa-check"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt"><span style="font-size:10px;color:var(--text-muted)"><i class="fa-regular fa-clock"></i> '+time+'</span></div>';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">ID: '+esc(t.id)+'</div>';
    h += '</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function renderAllCompletedTasks(tasks) {
  var el = document.getElementById('dashCompletedAll');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:24px;margin-bottom:8px"></i><p>暂无已完成的任务</p></div>';
    return;
  }
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;max-height:400px;overflow-y:auto">';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.updated_at ? t.updated_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<div class="li-item">';
    h += '<div class="li-ic" style="background:var(--accent);color:#05070d"><i class="fa-solid fa-check"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt"><span style="font-size:10px;color:var(--text-muted)"><i class="fa-regular fa-clock"></i> '+time+'</span></div>';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">ID: '+esc(t.id)+'</div>';
    h += '</div></div>';
  }
  h += '</div>';
  h += '<div style="text-align:center;padding-top:16px;color:var(--text-muted);font-size:11px">共 '+tasks.length+' 个已完成任务</div>';
  el.innerHTML = h;
}

function renderTaskHistory(tasks) {
  var el = document.getElementById('dashHistory');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:24px;margin-bottom:8px"></i><p>暂无任务记录</p></div>';
    return;
  }
  var h = '<div style="display:flex;flex-direction:column;gap:8px">';
  for (var i = 0; i < Math.min(tasks.length, 8); i++) {
    var t = tasks[i];
    var time = t.created_at ? t.created_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    var statusClass = t.status === 'completed' ? 'bdg-g' : (t.status === 'running' ? 'bdg-y' : 'bdg-r');
    var statusLabel = t.status === 'completed' ? '已完成' : (t.status === 'running' ? '运行中' : '失败');
    h += '<div class="li-item">';
    h += '<div class="li-ic" style="background:'+(t.status === 'completed' ? 'rgba(var(--accent-rgb),.15)' : (t.status === 'running' ? 'rgba(245,166,35,.15)' : 'rgba(255,107,129,.15)'))+';color:'+(t.status === 'completed' ? 'var(--accent)' : (t.status === 'running' ? '#F5A623' : '#FF6B81'))+'">';
    h += '<i class="fa-solid '+(t.status === 'completed' ? 'fa-check' : (t.status === 'running' ? 'fa-spinner fa-spin' : 'fa-times'))+'"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt"><span class="badge '+statusClass+'">'+esc(statusLabel)+'</span><span style="font-size:10px;color:#6e768a;margin-left:8px"><i class="fa-regular fa-clock"></i> '+time+'</span></div>';
    h += '<div style="font-size:11px;color:#7d849a;margin-top:3px">ID: '+esc(t.id)+'</div>';
    h += '</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

/* ===== System Stats (CPU/Memory/Disk Gauges) ===== */
// SVG 环形仪表：percent=数值, label=标题, sublabel=详情, color=强调色
function renderGauge(el, percent, label, sublabel, color) {
  if (!el) return;
  var r = 42, cx = 60, cy = 65, stroke = 6, circ = 2 * Math.PI * r;
  var offset = circ * (1 - Math.min(percent, 100) / 100);
  var svg = '<svg width="120" height="120" viewBox="0 0 120 120">';
  svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" style="stroke:var(--border)" stroke-width="'+stroke+'"/>';
  svg += '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+stroke+'" stroke-dasharray="'+circ+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90,'+cx+','+cy+')" style="transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"/>';
  svg += '<text x="'+cx+'" y="'+(cy+1)+'" text-anchor="middle" style="fill:var(--text-bold)" font-size="18" font-weight="700" font-family="\'Space Grotesk\'">'+Math.round(percent)+'%</text>';
  svg += '<text x="'+cx+'" y="'+(cy+16)+'" text-anchor="middle" style="fill:var(--text-muted)" font-size="9" font-family="sans-serif">'+esc(sublabel)+'</text>';
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderGpuCards(gpus) {
  var container = document.getElementById('gpuCards');
  if (!container) return;
  if (!gpus || gpus.length === 0) {
    container.innerHTML = '<div class="st-card" style="--accent:#00D4FF"><div class="st-l">GPU</div><div id="sysInfo" style="height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center"><span style="color:var(--text-muted);font-size:11px">未检测到 NVIDIA GPU</span></div></div>';
    return;
  }
  var h = '';
  for (var i = 0; i < gpus.length; i++) {
    var g = gpus[i];
    var utilColor = g.utilization_percent > 80 ? '#FF6B81' : (g.utilization_percent > 50 ? '#F5A623' : '#00E5A0');
    var memColor = g.memory_percent > 80 ? '#FF6B81' : (g.memory_percent > 50 ? '#F5A623' : '#A78BFA');
    h += '<div class="st-card" style="--accent:'+utilColor+';grid-column:span 2">';
    h += '<div class="st-l" style="margin-bottom:4px"><i class="fa-solid fa-microchip"></i> GPU ' + g.index + ' · ' + esc(g.name) + '</div>';
    h += '<div style="display:flex;gap:8px">';
    h += '<div style="flex:1"><div id="gpuUtilGauge_'+i+'" style="height:100px"></div></div>';
    h += '<div style="flex:1"><div id="gpuMemGauge_'+i+'" style="height:100px"></div></div>';
    h += '</div></div>';
  }
  container.innerHTML = h;
  // Render each GPU's gauges
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

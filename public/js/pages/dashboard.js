/* ===== Dashboard Page ===== */
pages.dashboard = function() {
  var h = '<div class="stats" id="dashStats"><div class="st-card"><div class="st-v" style="color:#484f6e">-</div><div class="st-l">加载中...</div></div></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-chart-line"></i>运行中任务 <span class="api-t api-g" style="margin-left:auto">GET /api/v1/dashboard/tasks</span></div>';
  h += '<div id="dashRunning" style="color:#7d849a;font-size:13px">加载中…</div></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-check-circle"></i>已完成任务 <span class="api-t api-g" style="margin-left:auto">GET /api/v1/dashboard/tasks</span></div>';
  h += '<div id="dashCompleted" style="color:#7d849a;font-size:13px">加载中…</div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-clock-rotate-left"></i>最近任务历史</div>';
  h += '<div id="dashHistory" style="color:#7d849a;font-size:13px">加载中…</div></div>';
  return h;
};

var dashInterval = null;

async function loadDashboard() {
  try {
    await Promise.all([loadDashStats(), loadDashTasks()]);
  } catch (e) {
    toast('加载仪表盘失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function loadDashStats() {
  try {
    var stats = await api('GET', '/dashboard/stats');
    var h = '';
    h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-v">'+stats.cpu.percent+'%</div><div class="st-l">CPU 使用</div></div>';
    h += '<div class="st-card" style="--accent:#A78BFA"><div class="st-v">'+stats.memory.percent+'%</div><div class="st-l">内存使用 ('+stats.memory.used_gb+'GB)</div></div>';
    h += '<div class="st-card" style="--accent:#F5A623"><div class="st-v">'+stats.disk.percent+'%</div><div class="st-l">磁盘使用 ('+stats.disk.used_gb+'GB)</div></div>';
    h += '<div class="st-card" style="--accent:#00D4FF"><div class="st-v">'+stats.cpu.cores+'</div><div class="st-l">CPU 核心</div></div>';
    var el = document.getElementById('dashStats');
    if (el) el.innerHTML = h;
  } catch (e) {
    var el = document.getElementById('dashStats');
    if (el) el.innerHTML = '<div class="st-card"><div class="st-v" style="color:#FF6B81">!</div><div class="st-l">系统状态获取失败</div></div>';
  }
}

async function loadDashTasks() {
  try {
    var running = await api('GET', '/dashboard/tasks?status=running&limit=10');
    var completed = await api('GET', '/dashboard/tasks?status=completed&limit=10');
    var all = await api('GET', '/dashboard/tasks?limit=20');

    renderRunningTasks(running.tasks || []);
    renderCompletedTasks(completed.tasks || []);
    renderTaskHistory(all.tasks || []);
  } catch (e) {
    document.getElementById('dashRunning').innerHTML = '<div class="err-box">加载失败: '+esc(e.message)+'</div>';
  }
}

function renderRunningTasks(tasks) {
  var el = document.getElementById('dashRunning');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:#484f6e"><i class="fa-solid fa-check-circle" style="font-size:24px;margin-bottom:8px"></i><p>当前没有运行中的任务</p></div>';
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
      'generate_idea': 'Idea 生成',
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
    h += '<div style="width:'+t.progress+'%;height:100%;background:#00E5A0;transition:width .3s ease"></div></div>';
    h += '<span style="font-size:10px;font-family:\'Space Grotesk\';min-width:32px">'+t.progress+'%</span></div></td>';
    h += '<td style="color:#b0b8c8">'+esc(t.step || '-')+'</td>';
    h += '<td style="color:#6e768a;font-size:11px">'+time+'</td>';
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  el.innerHTML = h;
}

function renderCompletedTasks(tasks) {
  var el = document.getElementById('dashCompleted');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:#484f6e"><i class="fa-solid fa-inbox" style="font-size:24px;margin-bottom:8px"></i><p>暂无已完成的任务</p></div>';
    return;
  }
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">';
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var time = t.updated_at ? t.updated_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea 生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    h += '<div class="li-item">';
    h += '<div class="li-ic" style="background:#00E5A0;color:#05070d"><i class="fa-solid fa-check"></i></div>';
    h += '<div style="flex:1;min-width:0">';
    h += '<div class="li-nm">'+esc(typeLabel)+'</div>';
    h += '<div class="li-mt"><span style="font-size:10px;color:#6e768a"><i class="fa-regular fa-clock"></i> '+time+'</span></div>';
    h += '<div style="font-size:11px;color:#7d849a;margin-top:3px">ID: '+esc(t.id)+'</div>';
    h += '</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function renderTaskHistory(tasks) {
  var el = document.getElementById('dashHistory');
  if (!el) return;
  if (!tasks || tasks.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:#484f6e"><i class="fa-solid fa-inbox" style="font-size:24px;margin-bottom:8px"></i><p>暂无任务记录</p></div>';
    return;
  }
  var h = '<div style="display:flex;flex-direction:column;gap:8px">';
  for (var i = 0; i < Math.min(tasks.length, 10); i++) {
    var t = tasks[i];
    var time = t.created_at ? t.created_at.substring(0, 16) : '-';
    var typeLabels = {
      'parse': '文献解析',
      'discover': '问题发现',
      'generate_idea': 'Idea 生成',
      'generate_algo': '算法生成',
      'test': '测试执行'
    };
    var typeLabel = typeLabels[t.type] || t.type;
    var statusClass = t.status === 'completed' ? 'bdg-g' : (t.status === 'running' ? 'bdg-y' : 'bdg-r');
    var statusLabel = t.status === 'completed' ? '已完成' : (t.status === 'running' ? '运行中' : '失败');
    h += '<div class="li-item">';
    h += '<div class="li-ic" style="background:'+(t.status === 'completed' ? 'rgba(0,229,160,.15)' : 'rgba(255,107,129,.15)')+';color:'+(t.status === 'completed' ? '#00E5A0' : '#FF6B81')+'">';
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

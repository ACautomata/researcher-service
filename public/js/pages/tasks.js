/* ===== 任务管理 — 集中查看和管理所有异步任务 ===== */
pages.tasks = async function() {
  return await renderTasksPage();
};

var taskTypeLabels = {
  'parse': '文献解析', 'discover': '问题发现', 'validate': '问题验证',
  'generate_idea': 'Idea 生成', 'generate_algo': '算法生成',
  'test_algo': '算法测试', 'optimize_algo': '算法优化',
  'agent': 'Agent 任务'
};

var taskTypeIcons = {
  'parse': 'fa-file-import', 'discover': 'fa-magnifying-glass',
  'validate': 'fa-circle-check', 'generate_idea': 'fa-lightbulb',
  'generate_algo': 'fa-code', 'test_algo': 'fa-flask',
  'optimize_algo': 'fa-gauge-high', 'agent': 'fa-terminal'
};

var taskTypeColors = {
  'parse': '#3b6df0', 'discover': '#10b981', 'validate': '#f59e0b',
  'generate_idea': '#8b5cf6', 'generate_algo': '#ef4444',
  'test_algo': '#06b6d4', 'optimize_algo': '#f97316',
  'agent': '#6366f1'
};

async function renderTasksPage() {
  var tasks = [];
  var filterStatus = '';
  try {
    var data = await api('GET', '/dashboard/tasks?limit=50');
    tasks = (data.tasks || []).map(function(t) {
      return {
        id: t.id, type: t.type, status: t.status,
        progress: t.progress, step: t.step, error: t.error,
        created: t.created_at, updated: t.updated_at, active: t.is_active
      };
    });
  } catch(e) { tasks = []; }

  var running = tasks.filter(function(t) { return t.status === 'running'; }).length;
  var completed = tasks.filter(function(t) { return t.status === 'completed'; }).length;
  var failed = tasks.filter(function(t) { return t.status === 'error'; }).length;

  var h = '';
  // Stats
  h += '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#64748b">' + tasks.length + '</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#3B82F6">' + running + '</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#10b981">' + completed + '</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#ef4444">' + failed + '</div><div class="st-l">失败</div></div>';
  h += '</div>';

  // Filter bar
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-list-check"></i>任务列表</div>';
  h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">';
  h += '<select class="inp" id="taskFilter" onchange="filterTasks()" style="font-size:12px;max-width:160px">';
  h += '<option value="">全部状态</option>';
  h += '<option value="running">运行中</option>';
  h += '<option value="completed">已完成</option>';
  h += '<option value="error">失败</option>';
  h += '</select>';
  h += '<button class="btn" style="font-size:11px;padding:6px 12px" onclick="refreshTasks()"><i class="fa-solid fa-rotate"></i> 刷新</button>';
  h += '<span style="font-size:11px;color:var(--text-muted);margin-left:auto">共 ' + tasks.length + ' 条</span>';
  h += '</div></div>';

  // Task list
  if (tasks.length === 0) {
    h += '<div class="card" style="text-align:center;padding:48px 24px">';
    h += '<i class="fa-solid fa-inbox" style="font-size:40px;color:var(--text-light);display:block;margin-bottom:12px"></i>';
    h += '<p style="font-size:14px;color:var(--text-muted)">暂无任务记录</p>';
    h += '</div>';
  } else {
    h += '<div id="taskList">';
    h += renderTaskCards(tasks);
    h += '</div>';
  }

  return h;
}

function renderTaskCards(tasks) {
  var h = '';
  var statusBadge = {
    'running':   { label: '运行中', cls: 'bdg-b' },
    'completed': { label: '已完成', cls: 'bdg-g' },
    'error':     { label: '失败', cls: 'bdg-r' },
    'pending':   { label: '等待中', cls: '' }
  };

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var sb = statusBadge[t.status] || { label: t.status || '未知', cls: '' };
    var typeLabel = taskTypeLabels[t.type] || (t.type || '未知');
    var typeIcon = taskTypeIcons[t.type] || 'fa-gear';
    var typeColor = taskTypeColors[t.type] || '#64748b';
    var isRunning = t.status === 'running';
    var isError = t.status === 'error';
    var progress = t.progress || 0;

    h += '<div class="card mb12 task-item" data-status="' + (t.status || '') + '" style="padding:14px 18px">';
    h += '<div style="display:flex;align-items:center;gap:12px">';

    // Type icon
    h += '<span style="flex-shrink:0;width:36px;height:36px;border-radius:8px;background:' + (isRunning ? 'rgba(59,109,240,.1)' : 'var(--sb-ico-bg)') + ';display:grid;place-items:center;color:' + (isRunning ? 'var(--accent)' : typeColor) + ';font-size:14px"><i class="fa-solid ' + typeIcon + '"></i></span>';

    // Info
    h += '<div style="flex:1;min-width:0">';
    h += '<div style="display:flex;align-items:center;gap:8px">';
    h += '<span style="font-weight:600;font-size:13px;color:var(--text-bold)">' + esc(typeLabel) + '</span>';
    h += '<span class="badge ' + sb.cls + '" style="font-size:10px;padding:2px 8px">' + sb.label + '</span>';
    if (isRunning) h += '<span style="font-size:10px;color:var(--text-muted)">' + progress + '% · ' + esc(t.step || '处理中') + '</span>';
    h += '</div>';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">ID: ' + esc(t.id).substring(0, 12) + ' · ' + formatTime(t.created) + '</div>';
    h += '</div>';

    // Right side
    h += '<div style="flex-shrink:0;text-align:right">';
    if (isRunning) {
      h += '<div style="width:80px;height:4px;background:var(--sb-ico-bg);border-radius:2px;overflow:hidden;margin-bottom:4px">';
      h += '<div style="width:' + progress + '%;height:100%;background:var(--accent);border-radius:2px;transition:width .3s"></div></div>';
    }
    if (isError && t.error) {
      h += '<span style="font-size:10px;color:#ef4444;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block" title="' + esc(t.error) + '">' + esc(t.error).substring(0, 30) + '</span>';
    }
    h += '</div>';

    h += '</div></div>';
  }
  return h;
}

function formatTime(dt) {
  if (!dt) return '-';
  // dt is ISO format string from SQLite
  var d = new Date(dt.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return dt;
  var now = new Date();
  var diff = Math.floor((now - d) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function filterTasks() {
  var el = document.getElementById('taskFilter');
  if (!el) return;
  var val = el.value;
  var items = document.querySelectorAll('#taskList .task-item');
  items.forEach(function(item) {
    if (!val || item.getAttribute('data-status') === val) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
}

async function refreshTasks() {
  document.getElementById('ctnEl').innerHTML = await pages.tasks();
}

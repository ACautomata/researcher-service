/* ===== Param Optimization Page ===== */
var PARAM_TASKS = [
  {
    id: 't1',
    name: 'd_model 256 vs 512',
    status: 'completed',
    created_at: '2026-05-05 14:30',
    groups: [
      { name: 'd256_n4_l3_dp0.1_lr3e4_bs64', params: { d_model: 256, nhead: 4, num_layers: 3, dropout: 0.1, lr: '3e-4', batch_size: 64 }, results: { accuracy: 82.3, val_loss: [2.3,1.8,1.4,1.1,0.92,0.78,0.68,0.61,0.56,0.52], val_accuracy: [55.1,62.3,68.5,72.8,76.2,78.9,80.5,81.7,82.1,82.3] } },
      { name: 'd512_n8_l6_dp0.1_lr3e4_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '3e-4', batch_size: 64 }, results: { accuracy: 88.7, val_loss: [2.1,1.5,1.1,0.85,0.68,0.56,0.48,0.42,0.38,0.35], val_accuracy: [58.2,66.8,73.5,78.9,82.4,85.1,86.9,87.8,88.3,88.7] } },
      { name: 'd512_n8_l6_dp0.1_lr1e3_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '1e-3', batch_size: 64 }, results: { accuracy: 85.1, val_loss: [2.5,2.1,1.7,1.5,1.3,1.2,1.1,1.05,1.0,0.97], val_accuracy: [52.1,58.5,63.8,68.2,72.5,76.1,79.8,82.4,84.1,85.1] } },
      { name: 'd512_n8_l6_dp0.3_lr3e4_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.3, lr: '3e-4', batch_size: 64 }, results: { accuracy: 86.2, val_loss: [2.4,1.9,1.5,1.2,1.0,0.88,0.78,0.71,0.65,0.61], val_accuracy: [53.5,60.1,66.2,71.5,75.8,79.2,82.1,84.0,85.3,86.2] } },
      { name: 'd512_n8_l6_dp0.1_lr3e4_bs32', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '3e-4', batch_size: 32 }, results: { accuracy: 89.5, val_loss: [2.0,1.4,1.0,0.78,0.62,0.51,0.43,0.38,0.34,0.31], val_accuracy: [60.5,69.2,76.1,81.0,84.5,86.8,88.2,89.0,89.3,89.5] } },
    ],
  },
];

var paramActiveTask = null;
var paramChartIdx = 0;

pages.param = async function() {
  paramActiveTask = null;
  return renderParamTaskList();
};

function renderParamTaskList() {
  var completed = PARAM_TASKS.filter(function(t){return t.status==='completed';}).length;
  var running = PARAM_TASKS.filter(function(t){return t.status==='running';}).length;
  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + PARAM_TASKS.length + '</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + completed + '</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#3B82F6">' + running + '</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card" style="cursor:pointer" onclick="showNewTaskForm()"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-plus"></i></div><div class="st-l">新建任务</div></div>';
  h += '</div>';

  h += '<div id="newTaskForm" style="display:none" class="card mb24"><div class="card-t"><i class="fa-solid fa-flask"></i>新建参数优化任务 <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">描述你的模型，AI 生成参数组合，你只需审核调优</span></div>';
  h += '<div style="margin-bottom:12px"><textarea class="inp" id="ntDesc" rows="2" placeholder="描述你的模型任务，如：基于 Transformer 的图像分类，输入 224x224 RGB 图像，数据集 CIFAR-100..." style="font-size:12px;resize:vertical;min-height:40px"></textarea></div>';
  h += '<div style="display:flex;gap:8px;margin-bottom:14px"><button class="btn bp" onclick="aiSuggestParams()" id="ntAiBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成参数</button><button class="btn" onclick="showNewTaskForm()">取消</button></div>';

  h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">任务名称</label><input class="inp" id="ntName" value="参数对比实验" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">d_model</label><input class="inp" id="ntDmodel" value="256,512" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">nhead</label><input class="inp" id="ntNhead" value="4,8" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">num_layers</label><input class="inp" id="ntLayers" value="3,6" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">dropout</label><input class="inp" id="ntDropout" value="0.1,0.3" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">lr</label><input class="inp" id="ntLr" value="3e-4,1e-3" style="font-size:12px"></div>';
  h += '<div><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">batch_size</label><input class="inp" id="ntBs" value="32,64" style="font-size:12px"></div>';
  h += '</div><div style="display:flex;gap:8px"><button class="btn bp" onclick="startNewTask()"><i class="fa-solid fa-play"></i> 开始运行</button></div></div>';

  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-list"></i>任务列表</div>';
  if (!PARAM_TASKS.length) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-flask" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无任务，点击上方「新建任务」开始</p></div>';
  } else {
    for (var i = 0; i < PARAM_TASKS.length; i++) {
      var t = PARAM_TASKS[i];
      h += '<div class="li-item" style="' + (t.status === 'completed' ? 'cursor:pointer' : '') + '" onclick="' + (t.status === 'completed' ? 'openParamTask(\'' + t.id + '\')' : '') + '">';
      h += '<div class="li-ic" style="background:' + (t.status === 'completed' ? 'rgba(0,229,160,.12);color:#00E5A0' : 'rgba(59,130,246,.12);color:#3B82F6') + '"><i class="fa-solid ' + (t.status === 'completed' ? 'fa-check-circle' : 'fa-spinner fa-spin') + '"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(t.name) + '</div>';
      h += '<div class="li-mt"><span class="badge ' + (t.status === 'completed' ? 'bdg-g' : 'bdg-m') + '">' + (t.status === 'completed' ? '已完成' : '运行中') + '</span>';
      if (t.status === 'running' && t.progress != null) {
        h += ' <span style="color:#3B82F6;font-weight:600">' + t.progress + '%</span>';
      }
      h += ' <span>' + (t.created_at || '') + '</span></div></div>';
      if (t.status === 'running' && t.progress != null) {
        h += '<div style="width:80px"><div style="height:4px;border-radius:2px;background:rgba(255,255,255,.05);overflow:hidden"><div style="width:' + t.progress + '%;height:100%;background:#3B82F6;border-radius:2px"></div></div></div>';
      } else if (t.status === 'completed' && t.groups) {
        var best = Math.max.apply(null, t.groups.map(function(g){return g.results.accuracy;}));
        h += '<span style="font-family:Space Grotesk,sans-serif;font-weight:700;color:#00E5A0;font-size:13px">' + best + '%</span>';
      }
      h += '</div>';
    }
  }
  h += '</div>';
  return h;
}

function showNewTaskForm() {
  document.getElementById('newTaskForm').style.display = '';
}
function hideNewTaskForm() {
  document.getElementById('newTaskForm').style.display = 'none';
}

async function aiSuggestParams() {
  var desc = document.getElementById('ntDesc').value.trim();
  if (!desc) { toast('请先描述模型任务', 'fa-exclamation-circle', '#F5A623'); return; }
  var btn = document.getElementById('ntAiBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 生成中...';
  try {
    var res = await api('POST', '/algo/suggest-params', { description: desc });
    var p = res.result.params || {};
    var keys = ['d_model','nhead','num_layers','dropout','lr','batch_size'];
    var fieldIds = ['ntDmodel','ntNhead','ntLayers','ntDropout','ntLr','ntBs'];
    for (var i = 0; i < keys.length; i++) {
      var vals = p[keys[i]];
      if (vals && vals.length) {
        document.getElementById(fieldIds[i]).value = vals.join(',');
      }
    }
    if (res.result.task_name) document.getElementById('ntName').value = res.result.task_name;
    toast('参数已生成，请审核后运行', 'fa-check-circle', '#00E5A0');
  } catch(e) {
    toast('AI 生成失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成参数';
}

function startNewTask() {
  var name = document.getElementById('ntName').value || '未命名';
  var dmodels = (document.getElementById('ntDmodel').value || '256,512').split(',').map(Number);
  var nheads = (document.getElementById('ntNhead').value || '4,8').split(',').map(Number);
  var layers = (document.getElementById('ntLayers').value || '3,6').split(',').map(Number);
  var drops = (document.getElementById('ntDropout').value || '0.1').split(',').map(Number);
  var lrs = (document.getElementById('ntLr').value || '3e-4').split(',');
  var bss = (document.getElementById('ntBs').value || '64').split(',').map(Number);
  var id = 't' + Date.now().toString(36);
  PARAM_TASKS.unshift({ id: id, name: name, status: 'running', created_at: new Date().toLocaleString(), progress: 0, groups: [] });
  hideNewTaskForm();
  // 模拟进度推进
  simulateProgress(id, Date.now() + 5000);
  go('param');
}

function simulateProgress(tid, deadline) {
  var t = PARAM_TASKS.find(function(x){return x.id === tid;});
  if (!t || t.status !== 'running') return;
  t.progress = Math.min(100, (t.progress || 0) + Math.floor(Math.random() * 15));
  if (t.progress >= 100 || Date.now() > deadline) {
    t.status = 'completed';
    t.progress = 100;
    // 填充模拟结果
    t.groups = [
      { name: 'd256_n4_l3_dp0.1_lr3e4_bs64', params: { d_model: 256, nhead: 4, num_layers: 3, dropout: 0.1, lr: '3e-4', batch_size: 64 }, results: { accuracy: 82.3, val_loss: [2.3,1.8,1.4,1.1,0.92,0.78,0.68,0.61,0.56,0.52], val_accuracy: [55.1,62.3,68.5,72.8,76.2,78.9,80.5,81.7,82.1,82.3] } },
      { name: 'd512_n8_l6_dp0.1_lr3e4_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '3e-4', batch_size: 64 }, results: { accuracy: 88.7, val_loss: [2.1,1.5,1.1,0.85,0.68,0.56,0.48,0.42,0.38,0.35], val_accuracy: [58.2,66.8,73.5,78.9,82.4,85.1,86.9,87.8,88.3,88.7] } },
      { name: 'd512_n8_l6_dp0.1_lr1e3_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '1e-3', batch_size: 64 }, results: { accuracy: 85.1, val_loss: [2.5,2.1,1.7,1.5,1.3,1.2,1.1,1.05,1.0,0.97], val_accuracy: [52.1,58.5,63.8,68.2,72.5,76.1,79.8,82.4,84.1,85.1] } },
      { name: 'd512_n8_l6_dp0.3_lr3e4_bs64', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.3, lr: '3e-4', batch_size: 64 }, results: { accuracy: 86.2, val_loss: [2.4,1.9,1.5,1.2,1.0,0.88,0.78,0.71,0.65,0.61], val_accuracy: [53.5,60.1,66.2,71.5,75.8,79.2,82.1,84.0,85.3,86.2] } },
      { name: 'd512_n8_l6_dp0.1_lr3e4_bs32', params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: '3e-4', batch_size: 32 }, results: { accuracy: 89.5, val_loss: [2.0,1.4,1.0,0.78,0.62,0.51,0.43,0.38,0.34,0.31], val_accuracy: [60.5,69.2,76.1,81.0,84.5,86.8,88.2,89.0,89.3,89.5] } },
    ];
    go('param');
    return;
  }
  setTimeout(function(){ simulateProgress(tid, deadline); }, 1500);
}

function openParamTask(tid) {
  var t = PARAM_TASKS.find(function(x){return x.id === tid;});
  if (!t || t.status !== 'completed' || !t.groups) return;
  paramActiveTask = t;
  document.getElementById('ctnEl').innerHTML = renderParamDetail(t);
  setTimeout(function() {
    renderAccChart();
    renderAccCurveChart();
    renderLossChart();
  }, 50);
}

function renderParamDetail(task) {
  var data = task.groups;
  var maxAcc = Math.max.apply(null, data.map(function(g){return g.results.accuracy;}));
  var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'param\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回任务列表</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(task.name) + '</span>';
  h += '<span class="badge bdg-g">已完成</span></div>';

  h += '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + data.length + '</div><div class="st-l">参数组数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + maxAcc + '%</div><div class="st-l">最高准确率</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA">' + data[0].params.d_model + '~' + data[1].params.d_model + '</div><div class="st-l">d_model 范围</div></div>';
  h += '</div>';

  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-table-cells"></i>参数组对比</div>';
  var paramKeys = ['d_model','nhead','num_layers','dropout','lr','batch_size'];
  h += '<div class="tbl-w"><table><thead><tr><th>参数组</th>';
  for (var k = 0; k < paramKeys.length; k++) h += '<th>' + paramKeys[k] + '</th>';
  h += '<th style="color:#00E5A0">准确率</th></tr></thead><tbody>';
  for (var i = 0; i < data.length; i++) {
    var g = data[i];
    var best = g.results.accuracy >= maxAcc;
    h += '<tr style="' + (best ? 'background:rgba(0,229,160,.04)' : '') + '"><td style="font-weight:600;font-family:Space Grotesk,sans-serif;font-size:11px">';
    if (best) h += '<span class="badge bdg-g" style="margin-right:6px">推荐</span>';
    h += g.name + '</td>';
    for (var k = 0; k < paramKeys.length; k++) {
      var val = g.params[paramKeys[k]];
      h += '<td style="font-family:Space Grotesk,sans-serif;font-size:12px;font-weight:500">' + val + '</td>';
    }
    var ac = g.results.accuracy >= maxAcc ? '#00E5A0' : (g.results.accuracy >= maxAcc - 3 ? '#F5A623' : '#FF6B81');
    h += '<td style="font-weight:700;color:' + ac + ';font-family:Space Grotesk,sans-serif">' + g.results.accuracy + '%</td>';
    h += '</tr>';
  }
  h += '</tbody></table></div></div>';

  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-chart-bar"></i>准确率对比</div>';
  h += '<div id="paramAccChart" style="height:260px"></div></div>';

  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-line"></i>验证准确率曲线</div><div id="paramValAccChart" style="height:260px"></div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-line"></i>验证损失曲线</div><div id="paramValChart" style="height:260px"></div></div>';
  h += '</div>';
  return h;
}

// 图表渲染函数使用 PARAM_ACTIVE_TASK 的数据
function getChartData() {
  if (paramActiveTask && paramActiveTask.groups) return paramActiveTask.groups;
  var t = PARAM_TASKS.find(function(x){return x.status==='completed' && x.groups;});
  return t ? t.groups : [];
}

function renderAccChart() {
  var el = document.getElementById('paramAccChart');
  if (!el) return;
  var data = getChartData();
  if (!data.length) { el.innerHTML = ''; return; }
  var maxVal = Math.max.apply(null, data.map(function(g){return g.results.accuracy;}));
  var w = 700, h = 220, barW = 70, gap = 40, startX = 60;
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  svg += '<line x1="50" y1="10" x2="50" y2="200" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 0; p <= 100; p += 20) {
    var y = 200 - p/100 * 180;
    svg += '<text x="45" y="'+(y+4)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p+'%</text>';
    svg += '<line x1="50" y1="'+y+'" x2="'+(w-20)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var i = 0; i < data.length; i++) {
    var x = startX + i * (barW + gap);
    var bh = (data[i].results.accuracy / 100) * 180;
    var ac = data[i].results.accuracy >= maxVal ? '#00E5A0' : (data[i].results.accuracy >= maxVal - 3 ? '#F5A623' : '#FF6B81');
    svg += '<rect x="'+x+'" y="'+(200-bh)+'" width="'+barW+'" height="'+bh+'" fill="'+ac+'" rx="4" opacity="0.85"/>';
    svg += '<text x="'+(x+barW/2)+'" y="195" text-anchor="middle" fill="var(--text-muted)" font-size="9" transform="rotate(-30,'+(x+barW/2)+',195)">'+data[i].name.slice(0,4)+'</text>';
    svg += '<text x="'+(x+barW/2)+'" y="'+(195-bh-6)+'" text-anchor="middle" fill="'+ac+'" font-size="10" font-weight="700" font-family="\'Space Grotesk\'">'+data[i].results.accuracy+'%</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderAccCurveChart() {
  var el = document.getElementById('paramValAccChart');
  if (!el) return;
  var data = getChartData();
  if (!data.length) { el.innerHTML = ''; return; }
  var w = 500, h = 220, padL = 45, padR = 20, padT = 10, padB = 30;
  var plotW = w - padL - padR, plotH = h - padT - padB;
  var colors = ['#3B82F6','#00E5A0','#F5A623','#A78BFA','#FF6B81'];
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  svg += '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 50; p <= 100; p += 10) {
    var y = (h - padB) - ((p-50) / 50) * plotH;
    svg += '<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p+'%</text>';
    svg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var e = 0; e < 10; e++) {
    var x = padL + (e / 9) * plotW;
    svg += '<text x="'+x+'" y="'+(h-padB+16)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">'+(e*5)+'</text>';
  }
  svg += '<text x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">Epoch</text>';
  for (var i = 0; i < data.length; i++) {
    var vals = data[i].results.val_accuracy;
    if (!vals) continue;
    var color = colors[i % colors.length];
    svg += '<polyline points="';
    for (var e = 0; e < vals.length; e++) {
      var x = padL + (e / (vals.length-1)) * plotW;
      var y = (h - padB) - ((vals[e] - 50) / 50) * plotH;
      svg += (e > 0 ? ' ' : '') + x + ',' + y;
    }
    svg += '" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
    var lx = padL + 10;
    var ly = padT + 14 + i * 18;
    svg += '<rect x="'+lx+'" y="'+(ly-6)+'" width="12" height="3" fill="'+color+'" rx="1"/>';
    svg += '<text x="'+(lx+18)+'" y="'+(ly+1)+'" fill="var(--text-muted)" font-size="9">'+data[i].name.slice(0,12)+'</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderLossChart() {
  var el = document.getElementById('paramValChart');
  if (!el) return;
  var data = getChartData();
  if (!data.length) { el.innerHTML = ''; return; }
  var maxLoss = 3.0;
  var w = 500, h = 220, padL = 45, padR = 20, padT = 10, padB = 30;
  var plotW = w - padL - padR, plotH = h - padT - padB;
  var colors = ['#3B82F6','#00E5A0','#F5A623','#A78BFA','#FF6B81'];
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  svg += '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 0; p <= 3; p++) {
    var y = (h - padB) - (p / maxLoss) * plotH;
    svg += '<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p.toFixed(1)+'</text>';
    svg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var e = 0; e < 10; e++) {
    var x = padL + (e / 9) * plotW;
    svg += '<text x="'+x+'" y="'+(h-padB+16)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">'+(e*5)+'</text>';
  }
  svg += '<text x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">Epoch</text>';
  for (var i = 0; i < data.length; i++) {
    var vals = data[i].results.val_loss;
    if (!vals) continue;
    var color = colors[i % colors.length];
    svg += '<polyline points="';
    for (var e = 0; e < vals.length; e++) {
      var x = padL + (e / (vals.length-1)) * plotW;
      var y = (h - padB) - (vals[e] / maxLoss) * plotH;
      svg += (e > 0 ? ' ' : '') + x + ',' + y;
    }
    svg += '" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
    var lx = padL + 10;
    var ly = padT + 14 + i * 18;
    svg += '<rect x="'+lx+'" y="'+(ly-6)+'" width="12" height="3" fill="'+color+'" rx="1"/>';
    svg += '<text x="'+(lx+18)+'" y="'+(ly+1)+'" fill="var(--text-muted)" font-size="9">'+data[i].name.slice(0,12)+'</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

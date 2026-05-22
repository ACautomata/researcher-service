/* ===== 实验设计与执行 — 智能设计实验方案，辅助实验执行与记录 ===== */
var ALGO_TASKS = [];
var algoRunningTaskIds = {}; // { aid: { taskId: string, intervalId: number } } 支持并行生成
var algoExpandData = {};   // { aid: { algo, inter, loaded } } 缓存已加载的算法详情
var algoExpandTab = {};    // { aid: 'architecture' } 每项当前活跃 Tab

function getAlgoStepLabel(progress) {
  var p = progress || 0;
  if (p < 25) return '分析Idea需求…';
  if (p < 50) return '设计算法架构…';
  if (p < 75) return '生成代码与测试…';
  return '保存结果…';
}

pages.algo = async function() {
  ALGO_TASKS = [];
  try {
    var data = await api('GET', '/algo/history');
    ALGO_TASKS = (data.history || []).map(function(t) {
      return {
        id: t.id,
        task_id: t.task_id || '',
        idea_id: t.idea_id || '',
        idea_title: t.idea_title || '',
        kb_name: t.kb_name || '',
        language: t.language || 'Python',
        status: t.status || 'pending',
        progress: t.progress || 0,
        name: t.name || '',
        algo_id: t.algo_id || '',
        created_at: t.created_at || ''
      };
    });
  } catch(e) {}

  // 重启运行中任务的轮询（页面切换回来时恢复）
  for (var i = 0; i < ALGO_TASKS.length; i++) {
    var t = ALGO_TASKS[i];
    if (t.status === 'running' && t.task_id && !algoRunningTaskIds[t.id]) {
      algoRunningTaskIds[t.id] = { taskId: t.task_id, intervalId: null };
      simulateAlgoProgress(t.id, t.task_id);
    }
  }

  return renderAlgoTaskList();
};

function renderAlgoTaskList() {
  var completed = ALGO_TASKS.filter(function(t){return t.status==='completed';}).length;
  var running = ALGO_TASKS.filter(function(t){return t.status==='running';}).length;
  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#FF6B81">' + ALGO_TASKS.length + '</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + completed + '</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#3B82F6">' + running + '</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-plus"></i></div><div class="st-l">新建任务</div></div>';
  h += '</div>';

  // 新建生成表单：选知识库→选Idea→生成
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-code"></i>新建代码生成 <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">选择知识库与 Idea，AI 自动生成算法</span></div>';

  h += '<div style="margin-bottom:10px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">知识库</label>';
  h += '<select class="inp" id="algoKbId" style="font-size:12px" onchange="onAlgoKbChange()"><option value="">-- 加载中… --</option></select></div>';

  h += '<div style="margin-bottom:10px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">选择 Idea（仅显示已完成评价的）</label>';
  h += '<select class="inp" id="algoIdeaId" style="font-size:12px"><option value="">-- 请先选择知识库 --</option></select></div>';

  h += '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">';
  h += '<div style="flex:0 0 auto;min-width:120px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">实现语言</label>';
  h += '<select class="inp" id="algoLang" style="font-size:12px"><option>Python</option><option>C++</option><option>JavaScript</option></select></div>';
  h += '<div><button class="btn bp" onclick="startAlgoAnalysis()" id="algoGenBtn"><i class="fa-solid fa-play"></i> 生成算法</button></div>';
  h += '</div></div>';

  // 异步加载知识库列表
  setTimeout(function(){ loadAlgoKbOptions(); }, 50);

  // 生成历史列表
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-list"></i>生成历史</div>';
  if (!ALGO_TASKS.length) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-code" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无生成记录，选择知识库和 Idea 开始</p></div>';
  } else {
    for (var i = 0; i < ALGO_TASKS.length; i++) {
      var t = ALGO_TASKS[i];
      var isRunning = t.status === 'running';
      var isFailed = t.status === 'failed';
      var isCompleted = t.status === 'completed';
      var canExpand = isCompleted;
      var isExpanded = algoExpandData[t.id] && algoExpandData[t.id]._visible;

      h += '<div class="li-item" style="' + (canExpand ? 'cursor:pointer' : '') + '" onclick="' + (canExpand ? 'toggleAlgoExpand(\'' + t.id + '\')' : '') + '">';
      // 展开箭头
      if (canExpand) {
        h += '<div style="width:16px;flex-shrink:0;display:grid;place-items:center;font-size:10px;color:var(--text-muted)" id="algoExpandArrow_' + t.id + '"><i class="fa-solid fa-chevron-' + (isExpanded ? 'down' : 'right') + '"></i></div>';
      }
      var ic = isCompleted ? 'rgba(0,229,160,.12);color:#00E5A0' : isRunning ? 'rgba(59,130,246,.12);color:#3B82F6' : 'rgba(255,107,129,.12);color:#FF6B81';
      var ico = isCompleted ? 'fa-check-circle' : isRunning ? 'fa-spinner fa-spin' : 'fa-times-circle';
      h += '<div class="li-ic" style="background:' + ic + '"><i class="fa-solid ' + ico + '"></i></div>';
      h += '<div style="flex:1;min-width:0">';
      h += '<div class="li-nm">' + esc(t.name || t.idea_title || t.id) + '</div>';
      h += '<div class="li-mt">';
      h += '<span class="badge ' + (isCompleted ? 'bdg-g' : isRunning ? 'bdg-m' : 'bdg-r') + '">' + (isCompleted ? '已完成' : (isFailed ? '失败' : '运行中')) + '</span>';
      if (t.language) h += ' <span class="badge bdg-m">' + t.language + '</span>';
      if (t.kb_name) h += ' <span style="color:var(--text-muted)">' + esc(t.kb_name) + '</span>';
      if (t.created_at) h += ' <span style="color:var(--text-muted)">' + t.created_at + '</span>';
      if (isRunning && t.progress != null) h += ' <span id="algoStepText_' + t.id + '" style="color:#3B82F6;font-size:11px">' + getAlgoStepLabel(t.progress) + '</span>';
      h += '</div>';
      // 运行中的内联进度条
      if (isRunning) {
        h += '<div style="margin-top:6px;display:flex;align-items:center;gap:8px;width:100%">';
        h += '<div style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden">';
        h += '<div id="algoProgress_' + t.id + '" style="width:' + (t.progress || 0) + '%;height:100%;background:#3B82F6;border-radius:3px;transition:width .3s ease"></div>';
        h += '</div>';
        h += '<span id="algoProgressPct_' + t.id + '" style="font-size:10px;color:var(--text-muted);min-width:30px;text-align:right">' + (t.progress || 0) + '%</span>';
        h += '</div>';
      }
      h += '</div>';
      h += '<button class="btn" style="padding:4px 8px;font-size:10px;flex-shrink:0;margin-left:6px;opacity:.35" onclick="event.stopPropagation();deleteAlgoTask(\'' + t.id + '\')" title="删除记录"><i class="fa-solid fa-trash"></i></button>';
      h += '</div>';
      // 展开内容区
      if (canExpand) {
        h += '<div id="algoExpandBody_' + t.id + '" class="algo-expand-body" style="display:' + (isExpanded ? 'block' : 'none') + ';border-left:3px solid rgba(0,229,160,.12);margin-left:8px;padding-left:0">';
        if (isExpanded) {
          h += renderAlgoExpandContent(t.id);
        }
        h += '</div>';
      }
    }
  }
  h += '</div>';
  return h;
}

/* ===== 知识库 & Idea 加载 ===== */
async function loadAlgoKbOptions() {
  var sel = document.getElementById('algoKbId');
  if (!sel) return;
  try {
    var data = await api('GET', '/kb/domains');
    var domains = data.domains || [];
    sel.innerHTML = '';
    if (!domains.length) {
      sel.innerHTML = '<option value="">-- 暂无知识库 --</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">-- 选择知识库 --</option>';
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + ' (' + (d.paper_count || 0) + ' 篇)';
      sel.appendChild(opt);
    }
  } catch(e) {
    sel.innerHTML = '<option value="">-- 加载失败 --</option>';
  }
}

async function onAlgoKbChange() {
  var kbId = document.getElementById('algoKbId').value;
  var ideaSel = document.getElementById('algoIdeaId');
  if (!ideaSel) return;
  if (!kbId) {
    ideaSel.innerHTML = '<option value="">-- 请先选择知识库 --</option>';
    ideaSel.disabled = true;
    return;
  }
  ideaSel.innerHTML = '<option value="">-- 加载中… --</option>';
  ideaSel.disabled = true;
  try {
    var data = await api('GET', '/idea/list?domain_id=' + kbId + '&min_score=0');
    var ideas = data.ideas || [];
    ideaSel.innerHTML = '';
    if (!ideas.length) {
      ideaSel.innerHTML = '<option value="">-- 该知识库暂无已完成评价的 Idea --</option>';
      ideaSel.disabled = true;
      return;
    }
    ideaSel.disabled = false;
    ideaSel.innerHTML = '<option value="">-- 选择 Idea --</option>';
    for (var i = 0; i < ideas.length; i++) {
      var idea = ideas[i];
      var opt = document.createElement('option');
      opt.value = idea.id;
      var score = idea.overall_score != null ? idea.overall_score.toFixed(1) : 'N/A';
      opt.textContent = idea.title + ' (评分: ' + score + ')';
      ideaSel.appendChild(opt);
    }
  } catch(e) {
    ideaSel.innerHTML = '<option value="">-- 加载失败 --</option>';
  }
}

/* ===== 开始生成 ===== */
async function startAlgoAnalysis() {
  var kbSel = document.getElementById('algoKbId');
  var ideaSel = document.getElementById('algoIdeaId');
  var langSel = document.getElementById('algoLang');

  if (!kbSel || !kbSel.value) { toast('请先选择知识库', 'fa-exclamation-circle', '#F5A623'); return; }
  if (!ideaSel || !ideaSel.value) { toast('请先选择 Idea', 'fa-exclamation-circle', '#F5A623'); return; }

  var kbName = kbSel.options[kbSel.selectedIndex].text;
  var ideaId = ideaSel.value;
  var ideaTitle = ideaSel.options[ideaSel.selectedIndex].text;
  var language = langSel ? langSel.value : 'Python';

  var aid = 'algo_' + Date.now().toString(36);

  // 加入运行追踪 map，支持并行
  algoRunningTaskIds[aid] = { taskId: null, intervalId: null };

  // 同步保存到数据库（确保重新渲染时能查到）
  await api('POST', '/algo/history', {
    id: aid, idea_id: ideaId, idea_title: ideaTitle,
    kb_name: kbName, language: language,
    status: 'running', progress: 5
  });

  // 重新渲染页面——任务立即出现在列表中
  await go('algo');

  try {
    // 调用后端 /algo/generate
    var res = await api('POST', '/algo/generate', { idea_id: ideaId, language: language });

    // 记录 backend taskId
    if (algoRunningTaskIds[aid]) algoRunningTaskIds[aid].taskId = res.task_id;

    // 更新 algo_id + task_id 到历史记录
    await api('PUT', '/algo/history/' + aid, { task_id: res.task_id, algo_id: res.algo_id || res.task_id });

    // 开始轮询进度
    simulateAlgoProgress(aid, res.task_id);
  } catch(e) {
    var t = ALGO_TASKS.find(function(x){return x.id === aid;});
    if (t) { t.status = 'failed'; }
    await api('PUT', '/algo/history/' + aid, { status: 'failed', progress: 0 });
    delete algoRunningTaskIds[aid];
    toast('生成失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
    await go('algo');
  }
}

/* ===== 进度轮询 ===== */
function simulateAlgoProgress(aid, taskId) {
  var t = ALGO_TASKS.find(function(x){return x.id === aid;});
  if (!t) return;

  var iv = setInterval(async function() {
    try {
      var data = await api('GET', '/algo/generate/' + taskId + '/progress');
      if (t) t.progress = data.progress || t.progress;

      // 通过唯一 ID 直接更新 DOM
      var p = t.progress || 0;
      var barEl = document.getElementById('algoProgress_' + aid);
      var pctEl = document.getElementById('algoProgressPct_' + aid);
      var stepEl = document.getElementById('algoStepText_' + aid);
      if (barEl) barEl.style.width = p + '%';
      if (pctEl) pctEl.textContent = p + '%';
      if (stepEl) stepEl.textContent = getAlgoStepLabel(p);

      if (data.status === 'completed') {
        clearInterval(iv);
        if (t) { t.status = 'completed'; t.progress = 100; t.name = (data.result && data.result.name) || t.name; }
        // 从 progress 结果获取真正的 algo_id
        var realAlgoId = (data.result && data.result.algo_id) || '';
        await api('PUT', '/algo/history/' + aid, {
          status: 'completed', progress: 100,
          name: (data.result && data.result.name) || '',
          algo_id: realAlgoId
        });
        if (algoRunningTaskIds[aid]) {
          algoRunningTaskIds[aid].algoId = realAlgoId;
          delete algoRunningTaskIds[aid];
        }
        toast('算法生成完成: ' + ((data.result && data.result.name) || t.idea_title || ''), 'fa-check-circle', '#00E5A0');
        await go('algo');
      } else if (data.status === 'error') {
        clearInterval(iv);
        if (t) { t.status = 'failed'; }
        await api('PUT', '/algo/history/' + aid, { status: 'failed', progress: 0 });
        delete algoRunningTaskIds[aid];
        toast('生成失败: ' + (data.error || ''), 'fa-exclamation-circle', '#FF6B81');
        await go('algo');
      }
    } catch(e) {
      clearInterval(iv);
      delete algoRunningTaskIds[aid];
    }
  }, 1500);

  // 保存 interval ID 以便取消
  if (algoRunningTaskIds[aid]) algoRunningTaskIds[aid].intervalId = iv;
}

/* ===== 删除任务 ===== */
async function deleteAlgoTask(aid) {
  if (!confirm('确定删除此生成记录吗？关联的算法代码将保留。')) return;
  // 清理运行中任务的 interval
  if (algoRunningTaskIds[aid]) {
    clearInterval(algoRunningTaskIds[aid].intervalId);
    delete algoRunningTaskIds[aid];
  }
  try {
    await api('DELETE', '/algo/history/' + aid);
    toast('已删除', 'fa-check-circle', '#00E5A0');
    go('algo');
  } catch(e) { toast('删除失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81'); }
}

/* ===== 行内展开：架构/伪代码/代码/测试/性能 ===== */

async function toggleAlgoExpand(aid) {
  var t = ALGO_TASKS.find(function(x){return x.id === aid;});
  if (!t || t.status !== 'completed') return;

  var bodyEl = document.getElementById('algoExpandBody_' + aid);
  if (!bodyEl) return;

  // 如果已展开 → 折叠
  if (algoExpandData[aid] && algoExpandData[aid]._visible) {
    bodyEl.style.display = 'none';
    algoExpandData[aid]._visible = false;
    var arrow = document.getElementById('algoExpandArrow_' + aid);
    if (arrow) arrow.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    return;
  }

  // 展开：加载数据（如未缓存）
  if (!algoExpandData[aid] || !algoExpandData[aid].loaded) {
    bodyEl.style.display = 'block';
    bodyEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';

    var algo = null;
    try {
      var data = await api('GET', '/algo/list');
      var algos = data.algorithms || [];
      algo = algos.find(function(a){ return a.id === t.algo_id; });
    } catch(e) {}

    var inter = {};
    if (algo && algo.intermediates) {
      try { inter = typeof algo.intermediates === 'string' ? JSON.parse(algo.intermediates) : algo.intermediates; } catch(e) {}
    }

    algoExpandData[aid] = { algo: algo || {}, inter: inter, loaded: true, _visible: false };
  }

  if (!algoExpandTab[aid]) algoExpandTab[aid] = 'architecture';

  algoExpandData[aid]._visible = true;
  bodyEl.style.display = 'block';
  bodyEl.innerHTML = renderAlgoExpandContent(aid);

  var arrow = document.getElementById('algoExpandArrow_' + aid);
  if (arrow) arrow.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
}

function renderAlgoExpandContent(aid) {
  var d = algoExpandData[aid] || {};
  var algo = d.algo || {};
  var inter = d.inter || {};
  var activeTab = algoExpandTab[aid] || 'architecture';
  var code = algo.code || '';
  var lines = code ? code.split('\n').length : 0;

  var h = '';

  // 统计卡片（紧凑）
  h += '<div style="display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap">';
  h += '<span class="badge" style="background:rgba(167,139,250,.12);color:#A78BFA">' + lines + ' 行代码</span>';
  h += '<span class="badge" style="background:rgba(0,229,160,.12);color:#00E5A0">' + (algo.test_passed || '?') + '/' + (algo.test_total || '?') + ' 测试通过</span>';
  h += '<span class="badge" style="background:rgba(245,166,35,.12);color:#F5A623">' + esc(algo.language || 'Python') + '</span>';
  if (algo.perf_before_ms != null && algo.perf_after_ms != null) {
    var impr = Math.round((1 - algo.perf_after_ms / algo.perf_before_ms) * 100);
    h += '<span class="badge" style="background:rgba(0,212,255,.12);color:#00D4FF">' + impr + '% 性能提升</span>';
  }
  h += '</div>';

  // Tab 导航（紧凑 chips）
  h += '<div style="display:flex;gap:2px;padding:6px 8px;flex-wrap:wrap;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">';
  var tabs = [
    { id: 'architecture', icon: 'fa-sitemap', label: '架构设计', color: '#A78BFA' },
    { id: 'pseudocode', icon: 'fa-code-branch', label: '伪代码', color: '#F5A623' },
    { id: 'code', icon: 'fa-code', label: '最终代码', color: '#00E5A0' },
    { id: 'tests', icon: 'fa-flask', label: '测试', color: '#FF6B81' },
    { id: 'perf', icon: 'fa-gauge-high', label: '性能', color: '#00D4FF' }
  ];
  for (var ti = 0; ti < tabs.length; ti++) {
    var tb = tabs[ti];
    var isActive = activeTab === tb.id;
    h += '<div style="cursor:pointer;padding:3px 9px;border-radius:5px;font-size:10px;font-weight:600;display:flex;align-items:center;gap:3px;' + (isActive ? 'background:rgba(255,255,255,.1);color:var(--text)' : 'color:var(--text-muted)') + '" onclick="event.stopPropagation();algoSwitchExpandTab(\'' + aid + '\',\'' + tb.id + '\')">';
    h += '<i class="fa-solid ' + tb.icon + '" style="font-size:9px;color:' + tb.color + '"></i>' + tb.label;
    h += '</div>';
  }
  // 复制代码按钮（仅代码 tab 显示在右侧）
  if (activeTab === 'code' && code) {
    h += '<div style="margin-left:auto"><button class="btn" style="padding:2px 8px;font-size:9px" onclick="event.stopPropagation();algoCopyExpandCode(\'' + aid + '\')"><i class="fa-regular fa-copy"></i> 复制</button></div>';
  }
  h += '</div>';

  // Tab 内容
  h += '<div id="algoExpandTabBody_' + aid + '" style="padding:0">';
  h += renderAlgoTabBody(activeTab, algo, inter, aid);
  h += '</div>';

  return h;
}

function renderAlgoTabBody(tabId, algo, inter, aid) {
  var code = algo.code || '';

  switch (tabId) {
    case 'architecture':
      var arch = inter.architecture || '';
      if (!arch) return '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:11px"><i class="fa-solid fa-sitemap" style="font-size:22px;opacity:.2;display:block;margin-bottom:8px"></i>架构设计数据不可用（旧版算法无此信息）</div>';
      return '<pre class="code-blk" style="margin:2px 4px;border-radius:6px;max-height:40vh;overflow-y:auto;font-size:11px;line-height:1.6;white-space:pre-wrap;background:rgba(0,0,0,.2)">' + esc(arch) + '</pre>';

    case 'pseudocode':
      var pseudo = inter.pseudocode || '';
      if (!pseudo) return '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:11px"><i class="fa-solid fa-code-branch" style="font-size:22px;opacity:.2;display:block;margin-bottom:8px"></i>伪代码数据不可用（旧版算法无此信息）</div>';
      return '<pre class="code-blk" style="margin:2px 4px;border-radius:6px;max-height:40vh;overflow-y:auto;font-size:11px;line-height:1.6;white-space:pre-wrap;background:rgba(0,0,0,.2)">' + esc(pseudo) + '</pre>';

    case 'code':
      if (!code) return '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:11px">代码不可用</div>';
      return '<pre class="code-blk" id="algoCodeBlock_' + aid + '" style="margin:2px 4px;border-radius:6px;max-height:40vh;overflow-y:auto;font-size:11px;line-height:1.6;white-space:pre-wrap;background:rgba(0,0,0,.2)">' + esc(code) + '</pre>';

    case 'tests':
      var th = '<div style="padding:10px 14px">';
      th += '<div class="stats" style="margin-bottom:10px;gap:6px">';
      th += '<div class="st-card" style="padding:6px 10px"><div class="st-v" style="font-size:16px;color:#00E5A0">' + (algo.test_passed || '?') + '</div><div class="st-l" style="font-size:9px">通过</div></div>';
      th += '<div class="st-card" style="padding:6px 10px"><div class="st-v" style="font-size:16px;color:#FF6B81">' + ((algo.test_total || 0) - (algo.test_passed || 0)) + '</div><div class="st-l" style="font-size:9px">失败</div></div>';
      th += '<div class="st-card" style="padding:6px 10px"><div class="st-v" style="font-size:16px;color:#F5A623">' + (algo.test_total || '?') + '</div><div class="st-l" style="font-size:9px">总计</div></div>';
      th += '</div>';
      if (algo.test_passed != null && algo.test_total != null && algo.test_total > 0) {
        var passPct = Math.round(algo.test_passed / algo.test_total * 100);
        th += '<div style="margin-bottom:8px"><div style="font-size:10px;color:var(--text-muted);margin-bottom:3px">通过率 ' + passPct + '%</div>';
        th += '<div style="height:5px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden"><div style="width:' + passPct + '%;height:100%;background:#00E5A0;border-radius:3px"></div></div></div>';
      }
      th += '<div style="font-size:10px;color:#7d849a;line-height:1.5">测试覆盖核心功能路径、边界条件和典型使用场景。性能数据通过基准测试采集。</div>';
      th += '</div>';
      return th;

    case 'perf':
      var ph = '<div style="padding:10px 14px">';
      if (algo.perf_before_ms != null || algo.perf_after_ms != null) {
        ph += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
        if (algo.perf_before_ms != null) {
          ph += '<div class="st-card" style="flex:1;min-width:90px;padding:6px 10px"><div class="st-v" style="font-size:16px;color:#FF6B81">' + algo.perf_before_ms + 'ms</div><div class="st-l" style="font-size:9px">优化前</div></div>';
        }
        if (algo.perf_after_ms != null) {
          ph += '<div class="st-card" style="flex:1;min-width:90px;padding:6px 10px"><div class="st-v" style="font-size:16px;color:#00E5A0">' + algo.perf_after_ms + 'ms</div><div class="st-l" style="font-size:9px">优化后</div></div>';
        }
        ph += '</div>';
        if (algo.perf_before_ms && algo.perf_after_ms) {
          var maxMs = Math.max(algo.perf_before_ms, algo.perf_after_ms);
          var beforeW = Math.round(algo.perf_before_ms / maxMs * 100);
          var afterW = Math.round(algo.perf_after_ms / maxMs * 100);
          ph += '<div style="margin-bottom:6px"><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">优化前</div><div style="height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden"><div style="width:' + beforeW + '%;height:100%;background:#FF6B81;border-radius:3px"></div></div></div>';
          ph += '<div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px">优化后</div><div style="height:6px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden"><div style="width:' + afterW + '%;height:100%;background:#00E5A0;border-radius:3px"></div></div></div>';
        }
      } else {
        ph += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:11px">暂无性能数据</div>';
      }
      ph += '</div>';
      return ph;

    default:
      return '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:11px">请选择上方标签查看内容</div>';
  }
}

function algoSwitchExpandTab(aid, tabId) {
  algoExpandTab[aid] = tabId;
  var bodyEl = document.getElementById('algoExpandTabBody_' + aid);
  if (!bodyEl) return;
  var d = algoExpandData[aid] || {};
  bodyEl.innerHTML = renderAlgoTabBody(tabId, d.algo || {}, d.inter || {}, aid);

  // 重新渲染整个展开区以更新 tab 高亮
  var expandEl = document.getElementById('algoExpandBody_' + aid);
  if (expandEl) {
    expandEl.innerHTML = renderAlgoExpandContent(aid);
  }
}

function algoCopyExpandCode(aid) {
  var codeEl = document.getElementById('algoCodeBlock_' + aid);
  if (!codeEl) return;
  var text = codeEl.textContent || codeEl.innerText || '';
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      toast('代码已复制到剪贴板', 'fa-check-circle', '#00E5A0');
    }).catch(function() {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
  function fallbackCopy(tx) {
    var ta = document.createElement('textarea');
    ta.value = tx; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('代码已复制', 'fa-check-circle', '#00E5A0'); } catch(e) { toast('复制失败', 'fa-exclamation-circle', '#FF6B81'); }
    document.body.removeChild(ta);
  }
}

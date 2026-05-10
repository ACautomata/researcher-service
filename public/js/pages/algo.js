/* ===== Algo Page: Code Generation from Ideas ===== */
var ALGO_TASKS = [];
var algoActiveTask = null;
var algoRunningTaskIds = {}; // { aid: { taskId: string, intervalId: number } } 支持并行生成
var algoCurFile = '';
var algoFilesFlat = {};

function getAlgoStepLabel(progress) {
  var p = progress || 0;
  if (p < 25) return '分析Idea需求…';
  if (p < 50) return '设计算法架构…';
  if (p < 75) return '生成代码与测试…';
  return '保存结果…';
}

pages.algo = async function() {
  algoActiveTask = null;
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
      h += '<div class="li-item" style="' + (t.status === 'completed' ? 'cursor:pointer' : '') + '" onclick="' + (t.status === 'completed' ? 'openAlgoTask(\'' + t.id + '\')' : '') + '">';
      var ic = t.status === 'completed' ? 'rgba(0,229,160,.12);color:#00E5A0' : isRunning ? 'rgba(59,130,246,.12);color:#3B82F6' : 'rgba(255,107,129,.12);color:#FF6B81';
      var ico = t.status === 'completed' ? 'fa-check-circle' : isRunning ? 'fa-spinner fa-spin' : 'fa-times-circle';
      h += '<div class="li-ic" style="background:' + ic + '"><i class="fa-solid ' + ico + '"></i></div>';
      h += '<div style="flex:1;min-width:0">';
      h += '<div class="li-nm">' + esc(t.name || t.idea_title || t.id) + '</div>';
      h += '<div class="li-mt">';
      h += '<span class="badge ' + (t.status === 'completed' ? 'bdg-g' : isRunning ? 'bdg-m' : 'bdg-r') + '">' + (t.status === 'completed' ? '已完成' : (isFailed ? '失败' : '运行中')) + '</span>';
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

/* ===== 详情查看 ===== */
async function openAlgoTask(aid) {
  var t = ALGO_TASKS.find(function(x){return x.id === aid;});
  if (!t || t.status !== 'completed') return;
  algoActiveTask = t;
  algoFilesFlat = {};
  algoCurFile = '';

  // 加载算法详情
  var algo = null;
  try {
    var data = await api('GET', '/algo/list');
    var algos = data.algorithms || [];
    algo = algos.find(function(a){ return a.id === t.algo_id; });
  } catch(e) {}

  // 构建文件树
  if (algo && algo.code) {
    var extMap = { 'Python': '.py', 'C++': '.cpp', 'JavaScript': '.js' };
    var ext = extMap[algo.language] || extMap[t.language] || '.py';
    var files = [];
    files.push({ name: 'main' + ext, type: 'file', content: algo.code });
    if (algo.name) {
      var readme = '# ' + algo.name + '\n\nAI 生成的算法项目。\n\n';
      if (algo.test_total != null) readme += '## 测试\n- 通过: ' + (algo.test_passed || 0) + '/' + algo.test_total + '\n';
      files.push({ name: 'README.md', type: 'file', content: readme });
    }
    t._algo = algo;
    t.files = files;
  } else {
    var extMap2 = { 'Python': '.py', 'C++': '.cpp', 'JavaScript': '.js' };
    var ext2 = extMap2[t.language] || '.py';
    t._algo = algo || {};
    t.files = [{ name: 'main' + ext2, type: 'file', content: '// 代码暂不可用\n// 请等待生成完成后再查看' }];
  }

  flattenAlgoFiles(t.files, '');
  for (var p in algoFilesFlat) { algoCurFile = p; break; }

  document.getElementById('ctnEl').innerHTML = renderAlgoDetail(t);
  renderAlgoTree();
  renderAlgoFile();
}

function renderAlgoDetail(task) {
  var algo = task._algo || {};
  var fc = countFiles(task.files);
  var lines = 0;
  for (var p in algoFilesFlat) lines += (algoFilesFlat[p] || '').split('\n').length;

  var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'algo\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回任务列表</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(algo.name || task.name || task.idea_title || '算法') + '</span>';
  h += '<span class="badge bdg-g">已完成</span></div>';

  h += '<div class="stats" style="margin-bottom:16px">';
  h += '<div class="st-card"><div class="st-v" style="color:#FF6B81">' + fc + '</div><div class="st-l">文件数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA">' + lines + '</div><div class="st-l">代码行数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + (algo.test_passed || '?') + '/' + (algo.test_total || '?') + '</div><div class="st-l">测试通过</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + esc(algo.language || task.language || '') + '</div><div class="st-l">语言</div></div>';
  h += '</div>';

  // 文件树 + 代码
  h += '<div style="display:flex;gap:16px;align-items:flex-start">';
  h += '<div class="card" style="width:220px;flex-shrink:0;padding:12px;overflow-y:auto;max-height:55vh">';
  h += '<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px"><i class="fa-solid fa-folder-tree"></i> 文件</div>';
  h += '<div id="algoFileTree" style="font-size:11px;line-height:1.9"></div></div>';
  h += '<div style="flex:1;min-width:0"><div id="algoFileContent"></div></div>';
  h += '</div>';

  // 性能信息
  if (algo.perf_before_ms != null || algo.perf_after_ms != null) {
    h += '<details class="card" style="margin-top:16px"><summary style="cursor:pointer;padding:8px 0;font-size:12px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-gauge-high" style="margin-right:6px"></i>性能基准</summary>';
    h += '<div style="display:flex;gap:16px;margin-top:8px;font-size:12px">';
    if (algo.perf_before_ms != null) h += '<div><span style="color:var(--text-muted)">优化前: </span><span style="color:#FF6B81;font-family:Space Grotesk">' + algo.perf_before_ms + 'ms</span></div>';
    if (algo.perf_after_ms != null) h += '<div><span style="color:var(--text-muted)">优化后: </span><span style="color:#00E5A0;font-family:Space Grotesk">' + algo.perf_after_ms + 'ms</span></div>';
    h += '</div></details>';
  }

  return h;
}

function countFiles(nodes) {
  var c = 0;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'file') c++;
    if (nodes[i].children) c += countFiles(nodes[i].children);
  }
  return c;
}

function flattenAlgoFiles(nodes, prefix) {
  prefix = prefix || '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var path = prefix + '/' + n.name;
    if (n.type === 'file') algoFilesFlat[path] = n.content;
    if (n.children) flattenAlgoFiles(n.children, path);
  }
}

function renderAlgoTree() {
  var el = document.getElementById('algoFileTree');
  if (!el || !algoActiveTask || !algoActiveTask.files) return;
  el.innerHTML = buildTreeHtml(algoActiveTask.files, '');
}

function buildTreeHtml(nodes, prefix) {
  var h = '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], p = prefix + '/' + n.name;
    if (n.type === 'dir') {
      h += '<div style="margin-left:12px"><div class="algo-ti" style="cursor:pointer;padding:1px 4px;border-radius:3px;color:var(--text-muted)" onclick="algoToggleDir(this)"><i class="fa-solid fa-chevron-right" style="font-size:7px;margin-right:4px;transition:transform .2s"></i><i class="fa-solid fa-folder" style="color:#F5A623;margin-right:4px;font-size:10px"></i> ' + n.name + '</div><div class="algo-tc" style="display:none">' + buildTreeHtml(n.children, p) + '</div></div>';
    } else {
      var active = algoCurFile === p ? ' style="color:var(--accent);font-weight:600"' : ' style="color:var(--text)"';
      h += '<div class="algo-ti" style="cursor:pointer;padding:1px 4px;border-radius:3px' + (algoCurFile === p ? ';background:rgba(var(--accent-rgb),.15)' : '') + '" onclick="algoOpenDetailFile(\'' + p + '\')"><i class="fa-regular fa-file-code" style="color:#7d849a;margin-right:4px;font-size:10px"></i> ' + n.name + '</div>';
    }
  }
  return h;
}

function algoToggleDir(el) {
  var c = el.nextElementSibling;
  var icon = el.querySelector('.fa-chevron-right');
  if (c) { c.style.display = c.style.display === 'block' ? 'none' : 'block'; if (icon) icon.style.transform = c.style.display === 'block' ? 'rotate(90deg)' : ''; }
}

function algoOpenDetailFile(path) {
  algoCurFile = path;
  renderAlgoTree();
  renderAlgoFile();
}

function renderAlgoFile() {
  var el = document.getElementById('algoFileContent');
  if (!el) return;
  var content = algoFilesFlat[algoCurFile] || '// 无法加载文件';
  var name = algoCurFile.split('/').pop();
  el.innerHTML = '<div class="card" style="padding:0;overflow:hidden"><div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--text)"><i class="fa-regular fa-file-code"></i> ' + algoCurFile.slice(1) + '</div><pre class="code-blk" style="border:none;border-radius:0;max-height:400px;overflow-y:auto;background:rgba(0,0,0,.25);margin:0;font-size:11px;line-height:1.6;white-space:pre-wrap">' + esc(content) + '</pre></div>';
}

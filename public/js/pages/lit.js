/* ===== Literature Page: Task-Based Problem Discovery ===== */
var LIT_TASKS = [];
var litActiveTask = null;

pages.lit = async function() {
  litActiveTask = null;
  LIT_TASKS = [];
  try {
    var data = await api('GET', '/lit/history');
    LIT_TASKS = (data.history || []).map(function(t) {
      return {
        id: t.id,
        task_id: t.task_id || '',
        kbId: t.kb_id,
        kbId2: t.kb_id2,
        kbName: t.kb_name,
        kbName2: t.kb_name2,
        displayName: t.display_name,
        depth: t.depth,
        status: t.status,
        progress: t.progress,
        count: t.count,
        created_at: t.created_at
      };
    });
  } catch(e) {}
  return renderLitTaskList();
};

function renderLitTaskList() {
  var completed = LIT_TASKS.filter(function(t){return t.status==='completed';}).length;
  var running = LIT_TASKS.filter(function(t){return t.status==='running';}).length;
  var totalProblems = 0;
  LIT_TASKS.forEach(function(t){ if (t.status==='completed' && t.count) totalProblems += t.count; });
  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + LIT_TASKS.length + '</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + completed + '</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#3B82F6">' + running + '</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA;font-size:20px">' + totalProblems + '</div><div class="st-l">已发现问题</div></div>';
  h += '</div>';

  // 新建分析
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-magnifying-glass-chart"></i>新建文献分析</div>';
  h += '<div id="litKbSelect" style="font-size:12px;color:var(--text-muted);margin-bottom:12px">正在加载知识库列表...</div>';
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
  h += '<div style="flex:1;min-width:200px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">知识库 A</label><select class="inp" id="litKbId" style="font-size:12px"></select></div>';
  h += '<div style="flex:1;min-width:200px;display:none" id="litKb2Wrap"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">知识库 B（交叉对比）</label><select class="inp" id="litKbId2" style="font-size:12px"></select></div>';
  h += '<div style="flex:0 0 auto;min-width:140px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">分析深度</label><select class="inp" id="litDepth" style="font-size:12px" onchange="onLitDepthChange()"><option value="quick">快速扫描</option><option value="deep" selected>深度分析</option><option value="cross">交叉引用</option></select></div>';
  h += '<div style="align-self:flex-end"><button class="btn bp" onclick="startLitAnalysis()" id="litStartBtn"><i class="fa-solid fa-play"></i> 开始分析</button></div></div></div>';

  // 异步加载知识库列表
  setTimeout(function(){ loadLitKbOptions(); }, 50);

  // 任务列表
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-list"></i>分析历史</div>';
  if (!LIT_TASKS.length) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-magnifying-glass" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无分析记录，选择一个知识库开始分析</p></div>';
  } else {
    for (var i = 0; i < LIT_TASKS.length; i++) {
      var t = LIT_TASKS[i];
      h += '<div class="li-item" style="' + (t.status === 'completed' ? 'cursor:pointer' : '') + '" onclick="' + (t.status === 'completed' ? 'openLitTask(\'' + t.id + '\')' : '') + '">';
      var ic = t.status === 'completed' ? 'rgba(0,229,160,.12);color:#00E5A0' : 'rgba(59,130,246,.12);color:#3B82F6';
      var ico = t.status === 'completed' ? 'fa-check-circle' : 'fa-spinner fa-spin';
      h += '<div class="li-ic" style="background:' + ic + '"><i class="fa-solid ' + ico + '"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(t.displayName || t.kbName || t.id) + '</div>';
      h += '<div class="li-mt"><span class="badge ' + (t.status === 'completed' ? 'bdg-g' : 'bdg-m') + '">' + (t.status === 'completed' ? '已完成' : (t.status === 'failed' ? '失败' : '运行中')) + '</span>';
      if (t.depth) h += ' <span class="badge bdg-m">' + t.depth + '</span>';
      if (t.status === 'completed' && t.count != null) h += ' <span style="color:#A78BFA">' + t.count + ' 个问题</span>';
      if (t.created_at) h += ' <span style="color:var(--text-muted)">' + t.created_at + '</span>';
      if (t.status === 'running' && t.progress != null) h += ' <span style="color:#3B82F6">' + t.progress + '%</span>';
      h += '</div></div>';
      if (t.status === 'running' && t.progress != null) {
        h += '<div style="width:60px"><div style="height:4px;border-radius:2px;background:rgba(255,255,255,.05);overflow:hidden"><div style="width:' + t.progress + '%;height:100%;background:#3B82F6;border-radius:2px"></div></div></div>';
      }
      h += '</div>';
    }
  }
  h += '</div>';
  return h;
}

async function loadLitKbOptions() {
  var sel = document.getElementById('litKbId');
  var sel2 = document.getElementById('litKbId2');
  var msg = document.getElementById('litKbSelect');
  if (!sel) return;
  try {
    var data = await api('GET', '/kb/domains');
    var domains = data.domains || [];
    sel.innerHTML = '';
    if (!domains.length) {
      sel.innerHTML = '<option value="">-- 暂无知识库，请先在知识库页面创建 --</option>';
      sel.disabled = true;
      if (sel2) { sel2.innerHTML = ''; sel2.disabled = true; }
      if (msg) msg.innerHTML = '';
      return;
    }
    sel.disabled = false;
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      var opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + ' (' + (d.paper_count || 0) + ' 篇)';
      sel.appendChild(opt);
    }
    if (sel2) {
      sel2.innerHTML = '';
      sel2.disabled = false;
      for (var i = 0; i < domains.length; i++) {
        var d = domains[i];
        var opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.name + ' (' + (d.paper_count || 0) + ' 篇)';
        if (i === 1 && domains.length > 1) opt.selected = true;
        sel2.appendChild(opt);
      }
    }
    if (msg) msg.innerHTML = '';
  } catch(e) {
    sel.innerHTML = '<option value="">-- 加载失败 --</option>';
    if (msg) msg.innerHTML = '<div style="color:#FF6B81;font-size:11px">加载失败: ' + e.message + '</div>';
  }
}

function onLitDepthChange() {
  var depth = document.getElementById('litDepth');
  var wrap = document.getElementById('litKb2Wrap');
  if (wrap) wrap.style.display = depth && depth.value === 'cross' ? '' : 'none';
}

async function startLitAnalysis() {
  var sel = document.getElementById('litKbId');
  var depth = document.getElementById('litDepth');
  if (!sel || sel.disabled || !sel.value) { toast('请先创建知识库', 'fa-exclamation-circle', '#F5A623'); return; }
  var kbId = sel.value;
  var depthVal = depth ? depth.value : 'deep';
  var kbName = sel.options[sel.selectedIndex].text;

  // 交叉分析：获取第二个知识库
  var kbId2 = null, kbName2 = '';
  if (depthVal === 'cross') {
    var sel2 = document.getElementById('litKbId2');
    if (sel2 && sel2.value) {
      kbId2 = sel2.value;
      kbName2 = sel2.options[sel2.selectedIndex].text;
    }
  }

  var displayName = kbId2 ? kbName + ' ↔ ' + kbName2 : kbName;
  var tid = 'lit_' + Date.now().toString(36);
  LIT_TASKS.unshift({ id: tid, kbId: kbId, kbId2: kbId2, kbName: kbName, kbName2: kbName2, displayName: displayName, depth: depthVal, status: 'running', progress: 5, count: 0, created_at: new Date().toLocaleString() });
  // 保存到数据库
  api('POST', '/lit/history', {
    id: tid, kb_id: parseInt(kbId),
    kb_id2: kbId2 ? parseInt(kbId2) : 0,
    kb_name: kbName, kb_name2: kbName2,
    display_name: displayName, depth: depthVal,
    status: 'running', progress: 5, count: 0
  }).catch(function(){});
  var btn = document.getElementById('litStartBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 分析中...';
  go('lit');

  try {
    // 获取知识库 A 的论文
    var papersA = await api('GET', '/kb/domain/' + kbId + '/papers');
    var entryTexts = [];
    (papersA.papers || []).forEach(function(p) {
      if (p.markdown_content) entryTexts.push('【知识库A】' + p.markdown_content.slice(0, 2000));
    });

    // 如果是交叉分析，也获取知识库 B 的论文
    if (kbId2) {
      var papersB = await api('GET', '/kb/domain/' + kbId2 + '/papers');
      (papersB.papers || []).forEach(function(p) {
        if (p.markdown_content) entryTexts.push('【知识库B】' + p.markdown_content.slice(0, 2000));
      });
    }

    if (!entryTexts.length) {
      var t = LIT_TASKS.find(function(x){return x.id === tid;});
      if (t) { t.status = 'failed'; t.progress = 0; }
      api('PUT', '/lit/history/' + tid, {status: 'failed', progress: 0, count: 0}).catch(function(){});
      toast('该知识库暂无已解析的论文', 'fa-exclamation-circle', '#F5A623');
      go('lit');
      return;
    }
    // 调 AI 发现问题
    var res = await api('POST', '/lit/auto-discover', {
      entry_ids: [],
      deep_analysis: depthVal,
      extra_texts: entryTexts
    });

    // 模拟进度推进
    simulateLitProgress(tid, res.task_id);
  } catch(e) {
    var t = LIT_TASKS.find(function(x){return x.id === tid;});
    if (t) { t.status = 'failed'; }
    api('PUT', '/lit/history/' + tid, {status: 'failed', progress: 0, count: 0}).catch(function(){});
    toast('分析失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
    go('lit');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始分析';
}

function simulateLitProgress(tid, taskId) {
  var t = LIT_TASKS.find(function(x){return x.id === tid;});
  if (!t) return;
  // 轮询任务进度
  var iv = setInterval(async function() {
    try {
      var data = await api('GET', '/lit/auto-discover/' + taskId + '/progress');
      if (t) t.progress = data.progress || t.progress;
      if (data.status === 'completed') {
        clearInterval(iv);
        if (t) { t.status = 'completed'; t.progress = 100; t.count = (data.result && data.result.problems_count) || 0; }
        api('PUT', '/lit/history/' + tid, {status: 'completed', progress: 100, count: t.count || 0}).catch(function(){});
        toast('分析完成，发现 ' + (data.result && data.result.problems_count || 0) + ' 个问题', 'fa-check-circle', '#F5A623');
        go('lit');
      } else if (data.status === 'error') {
        clearInterval(iv);
        if (t) { t.status = 'failed'; }
        api('PUT', '/lit/history/' + tid, {status: 'failed', progress: 0, count: 0}).catch(function(){});
        toast('分析失败: ' + (data.error || ''), 'fa-exclamation-circle', '#FF6B81');
        go('lit');
      }
    } catch(e) { clearInterval(iv); }
  }, 1500);
}

function openLitTask(tid) {
  var t = LIT_TASKS.find(function(x){return x.id === tid;});
  if (!t || t.status !== 'completed') return;
  litActiveTask = t;
  loadLitProblems(t);
}

async function loadLitProblems(task) {
  try {
    await loadProblems();
    var problems = cache.problems || [];
    var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'lit\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回分析列表</button>';
    h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(task.displayName || task.kbName || '') + '</span>';
    h += '<span class="badge bdg-g">' + problems.length + ' 个问题</span></div>';

    var hiP = problems.filter(function(p){return p.sv==='high'}).length;
    var okP = problems.filter(function(p){return p.ok}).length;
    h += '<div class="stats" style="margin-bottom:16px">';
    h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + problems.length + '</div><div class="st-l">问题总数</div></div>';
    h += '<div class="st-card"><div class="st-v" style="color:#FF6B81">' + hiP + '</div><div class="st-l">高优先级</div></div>';
    h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + okP + '</div><div class="st-l">已验证</div></div>';
    h += '<div class="st-card"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-check-double"></i></div><div class="st-l"><button class="btn bp" style="padding:4px 10px;font-size:10px" onclick="batchV()">批量验证</button></div></div>';
    h += '</div>';

    // 外部搜索
    h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-globe"></i>外部文献搜集 <span class="api-t api-g" style="margin-left:auto">GET /lit/search-external</span></div>';
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">';
    h += '<div style="flex:1;min-width:180px"><input class="inp" id="extk" placeholder="输入关键词搜索外部文献" style="font-size:12px"></div>';
    h += '<select class="inp" style="width:auto;min-width:110px;font-size:12px" id="exts"><option value="arxiv">arXiv</option><option value="semantic_scholar">Semantic Scholar</option></select>';
    h += '<button class="btn bw" onclick="searchExt()" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-search"></i> 搜索</button></div>';
    h += '<div id="extr" style="max-height:300px;overflow-y:auto"></div></div>';

    // 问题列表
    if (problems.length) {
      h += '<div class="card"><div class="card-t"><i class="fa-solid fa-bug"></i>已发现问题</div>';
      problems.forEach(function(p){
        var svb = p.sv === 'high' ? 'bdg-r' : 'bdg-y', svl = p.sv === 'high' ? '高' : '中';
        var stb = p.ok ? 'bdg-g' : p.ing ? 'bdg-y' : 'bdg-m', stl = p.ok ? '已验证' : p.ing ? '验证中' : '待验证';
        h += '<div class="prob-card"><div class="flex-b mb8"><span style="font-weight:600;font-size:13px">' + esc(p.title) + '</span>';
        h += '<div style="display:flex;gap:4px"><span class="badge ' + svb + '">' + svl + '</span><span class="badge ' + stb + '">' + stl + '</span></div></div>';
        h += '<div style="font-size:12px;color:#7d849a;margin-bottom:6px">' + esc(p.desc) + '</div>';
        h += '<div style="display:flex;gap:8px;font-size:10px;color:var(--text-muted);align-items:center;flex-wrap:wrap">';
        var srcCls = p.srcType === 'kb' ? 'src-k' : 'src-e', srcLb = p.srcType === 'kb' ? '知识库' : '外部';
        h += '<span class="src-t ' + srcCls + '">' + srcLb + '</span><span>分类：' + p.cat + '</span>';
        if (p.vs != null && p.vs !== undefined) h += '<span style="color:#00E5A0;font-weight:600;font-family:Space Grotesk">' + p.vs + '/10</span>';
        h += '</div>';
        if (!p.ok && !p.ing) h += '<button class="btn" style="padding:3px 10px;font-size:10px;margin-top:6px" onclick="val1(\'' + p.id + '\')"><i class="fa-solid fa-flask"></i> 验证</button>';
        h += '</div>';
      });
      h += '</div>';
    } else {
      h += '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-magnifying-glass" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂未发现问题</p></div>';
    }
    document.getElementById('ctnEl').innerHTML = h;
  } catch(e) {
    document.getElementById('ctnEl').innerHTML = '<div class="err-box">加载失败: ' + e.message + '</div>';
  }
}

async function val1(id) {
  toast('AI 验证中...', 'fa-flask', '#F5A623');
  try {
    var res = await api('POST', '/lit/validate', {problem_ids: [id], method: 'cross_reference'});
    pollTask(res.task_id, '/lit/validate/{task_id}/progress', [], 'none', function() {
      go('lit'); toast('验证完成', 'fa-check-circle', '#00E5A0');
    });
  } catch(e) { toast('失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81'); }
}

async function batchV() {
  try {
    await loadProblems();
    var pending = cache.problems.filter(function(p){return !p.ok&&!p.ing});
    if (!pending.length) return;
    var ids = pending.map(function(p){return p.id});
    var res = await api('POST', '/lit/validate', {problem_ids: ids, method: 'cross_reference'});
    pollTask(res.task_id, '/lit/validate/{task_id}/progress', [], 'none', function() {
      go('lit'); toast('批量验证完成', 'fa-check-circle', '#00E5A0');
    });
  } catch(e) { toast('失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81'); }
}

async function searchExt() {
  var kw = document.getElementById('extk');
  var el = document.getElementById('extr');
  if (!kw || !kw.value || !el) return;
  el.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try {
    var data = await api('GET', '/lit/search-external?keyword=' + encodeURIComponent(kw.value) + '&source=' + encodeURIComponent(document.getElementById('exts').value));
    var results = data.results || [], h = '<div style="font-size:10px;color:var(--text-muted);margin-bottom:8px">找到 ' + results.length + ' 篇</div>';
    results.forEach(function(item) {
      h += '<div class="li-item" style="padding:8px 10px"><div class="li-ic" style="width:28px;height:28px;font-size:12px;background:rgba(0,212,255,.12);color:#00D4FF"><i class="fa-solid fa-globe"></i></div><div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:600;color:var(--text)">' + esc(item.title) + '</div><div style="font-size:9px;color:var(--text-muted);margin-top:2px">' + (item.authors || []).slice(0,3).join(', ') + ' · ' + (item.year || '') + '</div></div></div>';
    });
    if (!results.length) h = '<div style="text-align:center;padding:16px;color:var(--text-muted)">未找到结果</div>';
    el.innerHTML = h;
  } catch(e) { el.innerHTML = '<div class="err-box" style="font-size:11px">' + esc(e.message) + '</div>'; }
}

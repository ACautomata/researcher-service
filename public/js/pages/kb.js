/* ===== 文献知识库 — 自动收集、管理与构建专属领域知识库 ===== */
var kbMode = 'list'; // list | domain | paper
var kbActiveDomain = null;
var kbActivePaper = null;

pages.kb = async function() {
  kbMode = 'list'; kbActiveDomain = null; kbActivePaper = null;
  return renderDomainList();
};

/* ===== 视图一：知识库列表 ===== */
async function renderDomainList() {
  var domains = [];
  try { var d = await api('GET', '/kb/domains'); domains = d.domains || []; } catch(e) {}
  var total = domains.length;
  var hasDocs = domains.reduce(function(s, x){ return s + (x.paper_count || 0); }, 0);

  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + total + '</div><div class="st-l">知识库数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + hasDocs + '</div><div class="st-l">含文献</div></div>';
  h += '<div class="st-card" style="cursor:pointer" onclick="showNewDomainForm()"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-plus"></i></div><div class="st-l">新建知识库</div></div>';
  h += '</div>';

  h += '<div id="newDomainForm" style="display:none" class="card mb24"><div class="card-t"><i class="fa-solid fa-layer-group"></i>新建知识库</div>';
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">';
  h += '<div style="flex:1;min-width:200px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">知识库名称</label><input class="inp" id="ndName" placeholder="如：自然语言处理" style="font-size:12px"></div>';
  h += '<div style="flex:2;min-width:200px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">描述</label><input class="inp" id="ndDesc" placeholder="可选描述" style="font-size:12px"></div></div>';
  h += '<div style="display:flex;gap:8px"><button class="btn bp" onclick="createDomain()"><i class="fa-solid fa-check"></i> 创建</button><button class="btn" onclick="hideNewDomainForm()">取消</button></div></div>';

  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-layer-group"></i>所有知识库</div>';
  if (!total) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-folder-open" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无知识库，点击「新建知识库」开始</p></div>';
  } else {
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      h += '<div class="li-item" style="cursor:pointer" onclick="openDomain(' + d.id + ')">';
      h += '<div class="li-ic" style="background:rgba(0,229,160,.12);color:#00E5A0"><i class="fa-solid fa-layer-group"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(d.name) + '</div>';
      h += '<div class="li-mt"><span class="badge bdg-g">' + (d.paper_count || 0) + ' 篇论文</span>';
      if (d.description) h += ' <span style="color:var(--text-muted)">' + esc(d.description) + '</span>';
      h += ' <span style="color:var(--text-muted)">' + (d.updated_at || '') + '</span></div></div>';
      h += '<span style="font-size:14px;color:#FF6B81;cursor:pointer;opacity:.4;margin-right:10px" onclick="event.stopPropagation();deleteDomain(' + d.id + ',\'' + esc(d.name) + '\')" title="删除知识库"><i class="fa-solid fa-trash-can"></i></span>';
      h += '<span style="font-size:16px;color:var(--text-muted);opacity:.3"><i class="fa-solid fa-chevron-right"></i></span></div>';
    }
  }
  h += '</div>';
  return h;
}

/* ===== 视图二：知识库详情（Obsidian 风格） ===== */
var kbDomainPapers = [], kbDomainId = null;
var kbPaperFiles = {};
var kbCurFile = '', kbObsTab = 'edit';
var kbGraphInterval = null;

function openDomain(id) {
  kbMode = 'domain'; kbActiveDomain = id; kbDomainId = id;
  loadDomainView(id);
}

async function loadDomainView(id) {
  var domain = null;
  try { var dd = await api('GET', '/kb/domains'); domain = (dd.domains || []).find(function(x){return x.id === id;}); } catch(e) {}
  try { var pp = await api('GET', '/kb/domain/' + id + '/papers'); kbDomainPapers = pp.papers || []; } catch(e) {}

  // 构建文件映射
  kbPaperFiles = {};
  var hasMd = false;
  kbDomainPapers.forEach(function(p) {
    var name = p.original_name || 'paper_' + p.id;
    if (!name.endsWith('.md') && p.markdown_content) name += '.md';
    kbPaperFiles[name] = { paper: p, path: name };
    if (p.markdown_content) hasMd = true;
  });

  var names = Object.keys(kbPaperFiles);
  kbCurFile = names.length ? names[0] : '';

  var c = '#00E5A0';
  var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'kb\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回知识库列表</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(domain ? domain.name : '') + '</span>';
  h += '<span class="badge bdg-g">' + names.length + ' 篇</span></div>';

  // Obsidian 风格布局
  h += '<div class="flex-b" style="gap:16px;align-items:flex-start">';
  // 左侧：文件树 + 上传
  h += '<div class="card" style="width:220px;flex-shrink:0;padding:14px;display:flex;flex-direction:column;align-self:stretch">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
  h += '<div style="font-size:11px;font-weight:600;color:var(--text-muted)"><i class="fa-solid fa-folder-tree"></i> 文件</div>';
  h += '<div class="upload-z" style="padding:4px 8px;display:inline-flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;border:none" onclick="document.getElementById(\'kbf\').click()" id="dz' + id + '">';
  h += '<i class="fa-solid fa-cloud-arrow-up"></i> 上传</div>';
  h += '<input type="file" id="kbf" multiple accept=".pdf,.docx,.doc,.txt,.md,.zip" style="display:none" onchange="domainUpload(' + id + ', this.files)"></div>';
  h += '<div id="kbFileTree" style="flex:1;overflow-y:auto;font-size:11px;line-height:1.9;min-height:120px">';
  if (!names.length) {
    h += '<div style="color:var(--text-muted)">暂无论文</div>';
  } else {
    names.forEach(function(n) {
      var f = kbPaperFiles[n];
      var active = n === kbCurFile;
      var hasMd = f.paper.markdown_content ? 1 : 0;
      h += '<div style="cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;justify-content:space-between;' + (active ? 'background:rgba(0,229,160,.15);color:var(--text);font-weight:600' : 'color:var(--text)') + '" onclick="kbOpenFile(\'' + n + '\')"><span><i class="fa-regular ' + (hasMd ? 'fa-file-lines' : 'fa-file') + '" style="color:' + (hasMd ? '#00E5A0' : 'var(--text-muted)') + ';margin-right:6px;font-size:10px"></i> ' + n + '</span><span style="color:#FF6B81;font-size:10px;opacity:.3;flex-shrink:0;margin-left:6px" onclick="event.stopPropagation();deletePaper(' + f.paper.id + ',\'' + esc(n) + '\')" title="删除论文"><i class="fa-solid fa-xmark"></i></span></div>';
    });
  }
  h += '</div></div>';

  // 右侧：编辑/预览/图谱
  h += '<div class="card" style="flex:1;padding:0;overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:70vh">';
  h += '<div style="display:flex;border-bottom:1px solid var(--border);padding:6px 14px 0;gap:2px;align-items:center">';
  h += '<button class="btn" id="kbTabEdit" onclick="kbSwitchTab(\'edit\')" style="border-radius:6px 6px 0 0;border-bottom:none;background:var(--bg);margin-bottom:-1px;padding:5px 12px;font-size:11px"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>';
  h += '<button class="btn" id="kbTabPreview" onclick="kbSwitchTab(\'preview\')" style="border-radius:6px 6px 0 0;background:transparent;padding:5px 12px;font-size:11px"><i class="fa-solid fa-eye"></i> 预览</button>';
  h += '<button class="btn" id="kbTabGraph" onclick="kbSwitchTab(\'graph\')" style="border-radius:6px 6px 0 0;background:transparent;padding:5px 12px;font-size:11px"><i class="fa-solid fa-diagram-project"></i> 图谱</button>';
  h += '<div style="flex:1"></div>';
  h += '<button class="btn" onclick="kbSaveFile()" id="kbSaveBtn" style="padding:3px 10px;font-size:10px;margin-bottom:1px;color:#00E5A0"><i class="fa-solid fa-floppy-disk"></i> 保存</button>';
  h += '<button class="btn" onclick="kbReparse()" style="padding:3px 8px;font-size:9px;margin-bottom:1px"><i class="fa-solid fa-rotate"></i></button>';
  h += '<span id="kbFileName" style="font-size:10px;color:var(--text-muted);margin:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">' + (kbCurFile || '未选择') + '</span></div>';

  // 编辑面板（编辑+预览分割）
  h += '<div id="kbPanelEdit" style="flex:1;display:flex;overflow:hidden">';
  h += '<textarea id="kbEditor" class="inp" style="flex:1;resize:none;border:none;border-radius:0;font-family:Space Grotesk,monospace;font-size:12px;line-height:1.7;padding:14px;background:#1e293b;color:#e2e8f0" placeholder="选择文件开始编辑"></textarea>';
  h += '<div id="kbPreview" style="flex:1;overflow-y:auto;padding:14px 18px;font-size:14px;line-height:1.8;color:var(--text);display:none;border-left:1px solid var(--border);background:var(--card-bg)"></div></div>';

  // 图谱面板
  h += '<div id="kbPanelGraph" style="flex:1;overflow:hidden;display:none;background:rgba(0,0,0,.15);position:relative"><div id="kbGraphSvg" style="width:100%;height:100%"></div></div>';
  h += '</div></div>';

  // 上传进度
  h += '<div id="dubp' + id + '" class="pbar on" style="display:none;margin-top:12px"><div class="pb-t"><i class="fa-solid fa-gear fa-spin"></i>解析中...</div></div>';

  document.getElementById('ctnEl').innerHTML = h;
  if (kbCurFile) kbOpenFile(kbCurFile);
  setupDomainDragDrop(id);
}

function setupDomainDragDrop(id) {
  var z = document.getElementById('dz' + id);
  if (!z) return;
  z.addEventListener('dragover', function(e){e.preventDefault();z.classList.add('drag');});
  z.addEventListener('dragleave', function(){z.classList.remove('drag');});
  z.addEventListener('drop', function(e){e.preventDefault();z.classList.remove('drag');if(e.dataTransfer.files.length)domainUpload(id, e.dataTransfer.files);});
}

function kbOpenFile(name) {
  kbCurFile = name;
  var f = kbPaperFiles[name];
  if (!f) return;
  document.getElementById('kbFileName').textContent = name;
  document.getElementById('kbEditor').value = f.paper.markdown_content || '';
  // 刷新文件树高亮
  var tree = document.getElementById('kbFileTree');
  if (tree) {
    var items = tree.querySelectorAll('div[cursor]');
    tree.innerHTML = '';
    Object.keys(kbPaperFiles).forEach(function(n) {
      var active = n === name;
      var ff = kbPaperFiles[n];
      var hasMd = ff.paper.markdown_content ? 1 : 0;
      tree.innerHTML += '<div style="cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;justify-content:space-between;' + (active ? 'background:rgba(0,229,160,.15);color:var(--text);font-weight:600' : 'color:var(--text)') + '" onclick="kbOpenFile(\'' + n + '\')"><span><i class="fa-regular ' + (hasMd ? 'fa-file-lines' : 'fa-file') + '" style="color:' + (hasMd ? '#00E5A0' : 'var(--text-muted)') + ';margin-right:6px;font-size:10px"></i> ' + n + '</span><span style="color:#FF6B81;font-size:10px;opacity:.3;flex-shrink:0;margin-left:6px" onclick="event.stopPropagation();deletePaper(' + ff.paper.id + ',\'' + esc(n) + '\')" title="删除论文"><i class="fa-solid fa-xmark"></i></span></div>';
    });
  }
  if (kbObsTab === 'preview') kbRenderPreview();
}

function kbSwitchTab(tab) {
  kbObsTab = tab;
  var editP = document.getElementById('kbPanelEdit');
  var graphP = document.getElementById('kbPanelGraph');
  var btnE = document.getElementById('kbTabEdit');
  var btnP = document.getElementById('kbTabPreview');
  var btnG = document.getElementById('kbTabGraph');
  var prev = document.getElementById('kbPreview');
  if (editP) editP.style.display = tab === 'edit' || tab === 'preview' ? 'flex' : 'none';
  if (graphP) graphP.style.display = tab === 'graph' ? 'flex' : 'none';
  if (btnE) btnE.style.background = tab === 'edit' ? 'var(--bg)' : 'transparent';
  if (btnP) btnP.style.background = tab === 'preview' ? 'var(--bg)' : 'transparent';
  if (btnG) btnG.style.background = tab === 'graph' ? 'var(--bg)' : 'transparent';
  if (prev) prev.style.display = tab === 'preview' ? '' : 'none';
  if (tab === 'preview' && kbCurFile) kbRenderPreview();
  if (tab === 'graph') kbRenderGraph();
}

function kbRenderPreview() {
  var content = document.getElementById('kbEditor').value;
  var prev = document.getElementById('kbPreview');
  if (!prev) return;
  var html = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  html = html.replace(/\[\[([^\]]+)\]\]/g, '<span style="background:rgba(192,132,252,.15);color:#C084FC;padding:1px 6px;border-radius:4px;font-size:12px">$1</span>');
  if (typeof marked !== 'undefined') {
    html = marked.parse(html);
  } else {
    html = '<pre style="white-space:pre-wrap">' + html + '</pre>';
  }
  prev.innerHTML = html;
}

function kbSaveFile() {
  var f = kbPaperFiles[kbCurFile];
  if (!f) { toast('请先选择文件', 'fa-exclamation-circle', '#F5A623'); return; }
  var content = document.getElementById('kbEditor').value;
  var btn = document.getElementById('kbSaveBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  api('PUT', '/kb/paper/' + f.paper.id, {content: content}).then(function(r) {
    f.paper.markdown_content = content;
    toast('已保存 (' + r.md_length + ' 字符)', 'fa-check-circle', '#00E5A0');
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存';
  }).catch(function(e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 保存';
  });
}

function kbRenderGraph() {
  var el = document.getElementById('kbGraphSvg');
  if (!el) return;
  if (typeof d3 === 'undefined') {
    el.innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81">D3.js 未加载</div>'; return;
  }
  // 构建图谱数据
  var nodes = [], edges = [], nodeMap = {}, edgeSet = {};
  kbDomainPapers.forEach(function(p) {
    var name = p.original_name || 'paper_' + p.id;
    var id = name.replace(/\.[^.]+$/, '');
    if (!nodeMap[id]) {
      nodeMap[id] = true;
      nodes.push({ id: id, label: id, path: name, size: (p.markdown_content || '').length });
    }
  });
  // 解析 wiki 链接
  kbDomainPapers.forEach(function(p) {
    var name = p.original_name || 'paper_' + p.id;
    var src = name.replace(/\.[^.]+$/, '');
    var md = p.markdown_content || '';
    var re = /\[\[([^\]]+)\]\]/g;
    var m;
    while ((m = re.exec(md)) !== null) {
      var tgt = m[1];
      if (tgt !== src) {
        var key = src + '|' + tgt;
        if (!edgeSet[key]) { edgeSet[key] = true; edges.push({ from: src, to: tgt }); }
      }
    }
  });
  // 添加被引用但无文件的幽灵节点
  edges.forEach(function(e) {
    if (!nodeMap[e.from]) { nodeMap[e.from] = true; nodes.push({ id: e.from, label: e.from, path: null, size: 0 }); }
    if (!nodeMap[e.to]) { nodeMap[e.to] = true; nodes.push({ id: e.to, label: e.to, path: null, size: 0 }); }
  });

  if (!nodes.length) { el.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">图谱为空</div>'; return; }

  var W = el.clientWidth || 700, H = el.clientHeight || 400;
  if (W < 100) W = 700; if (H < 100) H = 400;
  var svg = d3.select(el); svg.selectAll('*').remove();
  svg = svg.append('svg').attr('width', W).attr('height', H);
  var g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.2,4]).on('zoom', function(e){g.attr('transform', e.transform)}));

  var links = edges.map(function(e){ return {source: e.from, target: e.to}; });
  var sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d){return d.id}).distance(100))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(W/2, H/2));

  // 读取主题 CSS 变量，适配亮色/暗色主题
  var rootStyle = getComputedStyle(document.documentElement);
  var edgeColor = rootStyle.getPropertyValue('--border').trim() || 'rgba(255,255,255,.06)';
  var textColor = rootStyle.getPropertyValue('--text-muted').trim() || '#7d849a';

  g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', edgeColor).attr('stroke-width', 1.2);
  var node = g.append('g').selectAll('circle').data(nodes).join('circle')
    .attr('r', function(d){return d.size === 0 ? 3 : Math.min(4 + d.size/2000, 10)})
    .attr('fill', function(d){return d.path ? '#00E5A0' : 'rgba(255,107,129,.4)'})
    .attr('cursor', function(d){return d.path ? 'pointer' : 'default'})
    .on('click', function(_, d){ if (d.path) kbOpenFile(d.path); });
  g.append('g').selectAll('text').data(nodes).join('text')
    .text(function(d){return d.label.slice(0, 12)})
    .attr('font-size', 9).attr('fill', textColor).attr('dx', 8).attr('dy', 3);

  sim.on('tick', function(){
    g.selectAll('line').attr('x1',function(d){return d.source.x}).attr('y1',function(d){return d.source.y})
      .attr('x2',function(d){return d.target.x}).attr('y2',function(d){return d.target.y});
    node.attr('cx',function(d){return d.x}).attr('cy',function(d){return d.y});
    g.selectAll('text').attr('x',function(d){return d.x}).attr('y',function(d){return d.y});
  });
}

function kbReparse() {
  var f = kbPaperFiles[kbCurFile];
  if (!f) return;
  toast('重新解析中...', 'fa-rotate', '#F5A623');
  api('POST', '/kb/paper/' + f.paper.id + '/reparse').then(function() {
    toast('解析完成', 'fa-check-circle', '#00E5A0');
    loadDomainView(kbDomainId);
  }).catch(function(e) { toast('解析失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81'); });
}

async function domainUpload(domainId, files) {
  if (!files || !files.length) return;
  var bar = document.getElementById('dubp' + domainId);
  if (bar) bar.style.display = '';
  toast('上传中...', 'fa-cloud-arrow-up', '#00E5A0');
  try {
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
    var resp = await fetch(API + '/kb/domain/' + domainId + '/upload', {method:'POST', body:fd});
    if (!resp.ok) throw new Error((await resp.json()).detail || '上传失败');
    var data = await resp.json();
    toast('上传完成 ' + data.uploaded.length + ' 篇', 'fa-check-circle', '#00E5A0');
  } catch(e) { toast('上传失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81'); }
  if (bar) bar.style.display = 'none';
  loadDomainView(domainId);
}

/* ===== 视图三：论文详情（备用，已整合到 Obsidian 视图） ===== */

/* ===== 交互函数 ===== */
function showNewDomainForm() { document.getElementById('newDomainForm').style.display = ''; }
function hideNewDomainForm() { document.getElementById('newDomainForm').style.display = 'none'; }

async function createDomain() {
  var name = document.getElementById('ndName').value.trim();
  if (!name) { toast('请输入知识库名称', 'fa-exclamation-circle', '#F5A623'); return; }
  var desc = document.getElementById('ndDesc').value.trim();
  try {
    await api('POST', '/kb/domain', {name: name, description: desc});
    toast('创建成功', 'fa-check-circle', '#00E5A0');
    go('kb');
  } catch(e) {
    toast('创建失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

function deleteDomain(id, name) {
  if (!confirm('确定要删除知识库「' + name + '」吗？\n该操作不可撤销，知识库下的论文不会被删除，但会移出该知识库。')) return;
  api('DELETE', '/kb/domain/' + id).then(function() {
    toast('已删除', 'fa-check-circle', '#00E5A0');
    go('kb');
  }).catch(function(e) {
    toast('删除失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  });
}

function deletePaper(id, name) {
  if (!confirm('确定要删除论文「' + name + '」吗？\n该操作不可撤销，论文文件及关联的知识条目都将被删除。')) return;
  api('DELETE', '/kb/paper/' + id).then(function() {
    toast('已删除', 'fa-check-circle', '#00E5A0');
    loadDomainView(kbDomainId);
  }).catch(function(e) {
    toast('删除失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  });
}

async function domainUpload(domainId, files) {
  if (!files || !files.length) return;
  var bar = document.getElementById('dubp' + domainId);
  var m = document.getElementById('dubp' + domainId);
  if (m) m.style.display = '';
  toast('上传中...', 'fa-cloud-arrow-up', '#00E5A0');
  try {
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
    var resp = await fetch(API + '/kb/domain/' + domainId + '/upload', {method:'POST', body:fd});
    if (!resp.ok) throw new Error((await resp.json()).detail || '上传失败');
    var data = await resp.json();
    toast('上传完成，共 ' + data.uploaded.length + ' 篇', 'fa-check-circle', '#00E5A0');
  } catch(e) {
    toast('上传失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
  if (m) m.style.display = 'none';
  loadDomainView(domainId);
}

async function reparsePaper(paperId) {
  toast('重新解析中...', 'fa-rotate', '#F5A623');
  try {
    await api('POST', '/kb/paper/' + paperId + '/reparse');
    toast('解析完成', 'fa-check-circle', '#00E5A0');
    loadPaperView(paperId);
  } catch(e) {
    toast('解析失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

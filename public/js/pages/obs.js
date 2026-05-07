/* ===== Obsidian Page ===== */
var obsCurPath = '', obsTab = 'edit', obsTreeCache = {};

pages.obs = async function(){
  var c='#C084FC';
  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'" id="obsNoteCount">-</div><div class="st-l">笔记数</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'" id="obsTagCount">-</div><div class="st-l">标签数</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#00E5A0" id="obsGraphNodes">-</div><div class="st-l">图谱节点</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#F5A623" id="obsGraphEdges">-</div><div class="st-l">链接数</div></div></div>';

  h+='<div class="flex-b" style="gap:16px;align-items:flex-start">';
  h+='<div class="card" style="width:220px;flex-shrink:0;padding:14px;overflow:hidden;display:flex;flex-direction:column;align-self:stretch">';
  h+='<div class="card-t mb12"><i class="fa-solid fa-folder-tree"></i>文件</div>';
  h+='<div style="margin-bottom:8px"><input class="inp" id="obsSearch" placeholder="搜索笔记..." onkeyup="if(event.key===\'Enter\')searchObs()" style="font-size:11px;padding:6px 10px"></div>';
  h+='<div id="obsTree" style="flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;font-size:11px;line-height:1.8;color:#7d849a"><div style="color:#464d65">正在加载...</div></div></div>';

  h+='<div class="card" style="flex:1;padding:0;overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:70vh">';
  h+='<div style="display:flex;border-bottom:1px solid rgba(255,255,255,.06);padding:8px 14px 0;gap:2px">';
  h+='<button class="btn" id="obsTabEdit" onclick="switchObsTab(\'edit\')" style="border-radius:8px 8px 0 0;border-bottom:none;background:rgba(255,255,255,.05);margin-bottom:-1px;padding:6px 14px;font-size:11px"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>';
  h+='<button class="btn" id="obsTabPreview" onclick="switchObsTab(\'preview\')" style="border-radius:8px 8px 0 0;background:transparent;padding:6px 14px;font-size:11px"><i class="fa-solid fa-eye"></i> 预览</button>';
  h+='<button class="btn" id="obsTabGraph" onclick="switchObsTab(\'graph\')" style="border-radius:8px 8px 0 0;background:transparent;padding:6px 14px;font-size:11px"><i class="fa-solid fa-diagram-project"></i> 图谱</button>';
  h+='<div style="flex:1"></div>';
  h+='<span id="obsFilePath" style="font-size:10px;color:#464d65;align-self:center;margin-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">未打开文件</span>';
  h+='<button class="btn" onclick="saveObsFile()" id="obsSaveBtn" style="padding:4px 10px;font-size:10px;margin-bottom:2px;display:none"><i class="fa-solid fa-floppy-disk"></i></button></div>';

  h+='<div id="obsPanelEdit" style="flex:1;display:flex;overflow:hidden">';
  h+='<textarea id="obsEditor" class="inp" style="flex:1;resize:none;border:none;border-radius:0;font-family:Space Grotesk,monospace;font-size:12px;line-height:1.7;padding:14px;background:rgba(0,0,0,.15)" placeholder="选择左侧文件开始编辑..."></textarea>';
  h+='<div id="obsPreview" style="flex:1;overflow-y:auto;padding:14px 18px;font-size:13px;line-height:1.8;color:#c0c5d4;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:none;border-left:1px solid rgba(255,255,255,.06)"></div></div>';

  h+='<div id="obsPanelGraph" style="flex:1;overflow:hidden;display:none;background:rgba(0,0,0,.15);position:relative"><div id="obsGraphSvg" style="width:100%;height:100%"></div></div>';
  h+='</div></div>';
  return h;
};

function switchObsTab(tab) {
  obsTab = tab;
  var editP = document.getElementById('obsPanelEdit'),
      graphP = document.getElementById('obsPanelGraph'),
      btnE = document.getElementById('obsTabEdit'),
      btnP = document.getElementById('obsTabPreview'),
      btnG = document.getElementById('obsTabGraph');
  editP.style.display = tab === 'graph' ? 'none' : 'flex';
  graphP.style.display = tab === 'graph' ? 'flex' : 'none';
  btnE.style.background = tab === 'edit' ? 'rgba(255,255,255,.05)' : 'transparent';
  btnP.style.background = tab === 'preview' ? 'rgba(255,255,255,.05)' : 'transparent';
  btnG.style.background = tab === 'graph' ? 'rgba(255,255,255,.05)' : 'transparent';
  var prev = document.getElementById('obsPreview');
  prev.style.display = tab === 'preview' ? '' : 'none';
  if (tab === 'preview' && obsCurPath) renderObsPreview();
  if (tab === 'graph') renderObsGraph();
}

async function loadObsTree(path) {
  path = path || '';
  try {
    var data = await api('GET', '/obsidian/tree?path=' + encodeURIComponent(path));
    var items = data.items || [], h = '';
    if (path) {
      var pp = path.split('/').slice(0, -1).join('/');
      h += '<div style="cursor:pointer;padding:1px 0;color:#464d65" onclick="loadObsTree(\'' + pp + '\')">\u2190 上级目录</div>';
    }
    items.forEach(function(item) {
      var icon = item.type === 'dir' ? '\u{1F4C1}' : (item.ext === '.md' ? '\u{1F4C4}' : '\u{1F4C3}');
      h += '<div style="cursor:pointer;padding:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+(item.ext==='.md'?'color:#c0c5d4;font-weight:500':'')+'" onclick="'+(item.type==='dir'?'loadObsTree(\''+item.path+'\')':'openObsFile(\''+item.path+'\')')+'">'+icon+' '+item.name+'</div>';
    });
    if (!items.length) h = '<div style="color:#464d65">(空目录)</div>';
    document.getElementById('obsTree').innerHTML = h;
  } catch(e) {
    document.getElementById('obsTree').innerHTML = '<div style="color:#FF6B81">加载失败</div>';
  }
}

async function openObsFile(path) {
  obsCurPath = path;
  document.getElementById('obsFilePath').textContent = path;
  document.getElementById('obsSaveBtn').style.display = '';
  try {
    var data = await api('GET', '/obsidian/file?path=' + encodeURIComponent(path));
    document.getElementById('obsEditor').value = data.content || '';
    if (obsTab === 'preview') renderObsPreview();
  } catch(e) {
    document.getElementById('obsEditor').value = '// 无法加载: ' + e.message;
  }
}

async function saveObsFile() {
  if (!obsCurPath) return;
  var content = document.getElementById('obsEditor').value;
  try {
    await api('POST', '/obsidian/file', {path: obsCurPath, content: content});
    toast('已保存', 'fa-check-circle', '#00E5A0');
    if (obsTab === 'preview') renderObsPreview();
  } catch(e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

function renderObsPreview() {
  var content = document.getElementById('obsEditor').value;
  var prev = document.getElementById('obsPreview');
  if (typeof marked !== 'undefined') {
    var html = content.replace(/\[\[([^\]]+)\]\]/g, '<span style="background:rgba(192,132,252,.15);color:#C084FC;padding:1px 6px;border-radius:4px;font-size:12px">$1</span>');
    html = marked.parse(html);
    prev.innerHTML = html;
  } else {
    prev.innerHTML = '<pre style="white-space:pre-wrap">' + esc(content) + '</pre>';
  }
}

async function renderObsGraph() {
  try {
    var data = await api('GET', '/obsidian/graph');
    var nodes = data.nodes || [], edges = data.edges || [];
    document.getElementById('obsGraphNodes').textContent = nodes.length;
    document.getElementById('obsGraphEdges').textContent = edges.length;
    if (!nodes.length) {
      document.getElementById('obsGraphSvg').innerHTML = '<div style="text-align:center;padding:60px;color:#464d65">图谱为空 — 笔记中缺少 [[wiki链接]]</div>';
      return;
    }
    if (typeof d3 === 'undefined') {
      document.getElementById('obsGraphSvg').innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81">D3.js 未加载，请检查网络</div>';
      return;
    }
    var panel = document.getElementById('obsPanelGraph');
    var W = panel.clientWidth || 800;
    var H = panel.clientHeight || 500;
    if (W < 100) W = 800;
    if (H < 100) H = 500;
    var svg = d3.select('#obsGraphSvg');
    svg.selectAll('*').remove();
    svg = svg.append('svg').attr('width', W).attr('height', H);
    var g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', function(e){g.attr('transform', e.transform)}));

    var links = edges.map(function(e) { return {source: e.from, target: e.to}; });

    var sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(function(d){return d.id}).distance(80))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(W/2, H/2));

    var link = g.append('g').selectAll('line').data(links).join('line')
      .attr('stroke', 'rgba(255,255,255,.06)').attr('stroke-width', 1);

    var node = g.append('g').selectAll('circle').data(nodes).join('circle')
      .attr('r', function(d){ return d.size === 0 ? 3 : (4 + Math.min(d.size/1000, 8)); })
      .attr('fill', function(d){ return d.size === 0 ? 'rgba(255,107,129,.4)' : d.size>5000?'#C084FC':d.size>2000?'#00D4FF':'#7d849a'; })
      .attr('stroke', function(d){ return d.size === 0 ? 'rgba(255,107,129,.2)' : 'none'; })
      .attr('stroke-width', 1)
      .attr('cursor', 'pointer')
      .attr('opacity', function(d){ return d.size === 0 ? 0.5 : 1; })
      .on('click', function(_, d){ if (d.size > 0) openObsFile(d.path); });
    node.append('title').text(function(d){return d.label});

    var label = g.append('g').selectAll('text').data(nodes).join('text')
      .text(function(d){return d.label.slice(0, 15)})
      .attr('font-size', 9).attr('fill', '#7d849a').attr('dx', 7).attr('dy', 3);

    sim.on('tick', function(){
      link.attr('x1',function(d){return d.source.x}).attr('y1',function(d){return d.source.y})
          .attr('x2',function(d){return d.target.x}).attr('y2',function(d){return d.target.y});
      node.attr('cx',function(d){return d.x}).attr('cy',function(d){return d.y});
      label.attr('x',function(d){return d.x}).attr('y',function(d){return d.y});
    });
  } catch(e) {
    document.getElementById('obsGraphSvg').innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81">图谱加载失败: ' + esc(String(e).slice(0,100)) + '</div>';
  }
}

async function searchObs() {
  var q = document.getElementById('obsSearch').value.trim();
  if (!q) return loadObsTree('');
  try {
    var data = await api('GET', '/obsidian/search?q=' + encodeURIComponent(q));
    var results = data.results || [], h = '<div style="color:#464d65;margin-bottom:4px">找到 ' + results.length + ' 条</div>';
    results.forEach(function(r) {
      h += '<div style="cursor:pointer;padding:2px 0;color:#c0c5d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px" onclick="openObsFile(\''+r.path+'\')">' + r.name.replace(/\//g,' > ') + '</div>';
    });
    document.getElementById('obsTree').innerHTML = h || '<div style="color:#464d65">无结果</div>';
  } catch(e) {
    document.getElementById('obsTree').innerHTML = '<div style="color:#FF6B81">搜索失败</div>';
  }
}

async function loadObsStats() {
  try {
    var vp = await api('GET', '/obsidian/vault-path');
    if (!vp.configured) { document.getElementById('obsTree').innerHTML = '<div style="color:#FF6B81">未配置 OBSIDIAN_VAULT_PATH</div>'; return; }
    try {
      var tg = await api('GET', '/obsidian/tags');
      document.getElementById('obsTagCount').textContent = tg.tags ? tg.tags.length : 0;
    } catch(e) {}
    try {
      var gr = await api('GET', '/obsidian/graph');
      document.getElementById('obsNoteCount').textContent = gr.nodes ? gr.nodes.length : 0;
    } catch(e) {}
  } catch(e) {}
}

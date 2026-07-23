/* ===== Wiki 知识库 —— agent 维护的结构化知识库（wiki/main） ===== */
var wikiData = null;
var wikiActiveKind = null;   // 当前展开的分组 kind
var wikiActiveName = null;   // 当前分组的 name（domain 类为 domain 名，其余为目录名）
var wikiActivePaper = null;  // 当前页 page_id
var wikiTab = 'preview';
var wikiPaperCache = {};  // { kind/name/pageId: { frontmatter, body, content } }
var wikiAllPapers = [];   // [{kind, name, id, title}] for graph

pages.wiki = async function() {
  wikiData = null;
  wikiActiveKind = null;
  wikiActiveName = null;
  wikiActivePaper = null;
  wikiTab = 'preview';
  wikiPaperCache = {};

  var h = '';
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">Wiki 知识库</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:13px;cursor:help" title="agent 维护的结构化知识库（wiki/main）"></i></div>';
  h += '<button class="btn" onclick="loadWiki()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-rotate"></i> 刷新</button>';
  h += '</div>';
  h += '<div id="wikiContent" style="min-height:60vh"><div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin" style="font-size:24px;display:block;margin-bottom:12px"></i>加载中...</div></div>';
  setTimeout(loadWiki, 100);
  return h;
};

async function loadWiki() {
  var el = document.getElementById('wikiContent');
  if (!el) return;
  try {
    var res = await api('GET', '/openclaw/wiki');
    wikiData = res;
    wikiAllPapers = [];
    (res.groups || []).forEach(function(g) {
      (g.pages || []).forEach(function(p) { wikiAllPapers.push({ kind: g.kind, name: g.name, id: p.id, title: p.title }); });
    });
    renderWikiList(res);
  } catch(e) {
    el.innerHTML = '<div style="text-align:center;padding:60px;color:#ef4444"><i class="fa-solid fa-triangle-exclamation" style="font-size:24px;display:block;margin-bottom:12px"></i><p>加载失败: ' + esc(e.message) + '</p></div>';
  }
}

var WIKI_KIND_LABEL = { concept: '概念', entity: '实体', source: '来源', synthesis: '综述', report: '报告', domain: '领域论文' };
var WIKI_KIND_ICON = { concept: 'fa-lightbulb', entity: 'fa-cube', source: 'fa-file-import', synthesis: 'fa-layer-group', report: 'fa-chart-line', domain: 'fa-folder-open' };
var WIKI_KIND_COLOR = { concept: '#f59e0b', entity: '#8b5cf6', source: '#06b6d4', synthesis: '#10b981', report: '#ef4444', domain: '#10b981' };

function renderWikiList(res) {
  var el = document.getElementById('wikiContent');
  if (!el) return;

  if (!res.groups || !res.groups.length) {
    el.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-book" style="font-size:40px;display:block;margin-bottom:12px;opacity:.15"></i><p style="font-weight:600;color:var(--text)">知识库为空</p><p style="font-size:11px;margin-top:4px">agent 尚未生成 Wiki 内容</p></div>';
    return;
  }

  var h = '';
  var totalPapers = 0;
  res.groups.forEach(function(g) { totalPapers += g.page_count || 0; });

  h += '<div style="display:flex;gap:16px;margin-bottom:16px">';
  h += '<div style="flex:1;text-align:center;padding:16px;border-radius:12px;background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1)"><div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:#10b981">' + res.groups.length + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">分类</div></div>';
  h += '<div style="flex:1;text-align:center;padding:16px;border-radius:12px;background:rgba(59,109,240,.04);border:1px solid rgba(59,109,240,.1)"><div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:#3b6df0">' + totalPapers + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">页面</div></div>';
  h += '</div>';

  h += '<div style="display:flex;gap:16px;min-height:55vh">';

  // ── Left sidebar（按 kind 分组） ──
  h += '<div style="width:220px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;max-height:60vh;overflow-y:auto;scrollbar-width:thin">';
  res.groups.forEach(function(g) {
    var isActive = wikiActiveKind === g.kind;
    var color = WIKI_KIND_COLOR[g.kind] || '#10b981';
    var icon = WIKI_KIND_ICON[g.kind] || 'fa-folder';
    var label = WIKI_KIND_LABEL[g.kind] || g.kind;
    h += '<div onclick="toggleWikiDomain(\'' + esc(g.kind) + '\')" style="cursor:pointer;padding:10px 12px;border-radius:8px;font-size:12px;background:' + (isActive ? 'var(--accent-light)' : 'var(--bg)') + ';border:1px solid ' + (isActive ? 'var(--accent)' : 'transparent') + '">';
    h += '<div style="display:flex;align-items:center;gap:6px"><i class="fa-solid ' + icon + '" style="color:' + color + ';font-size:11px"></i><span style="font-weight:600;color:var(--text);flex:1">' + esc(label) + '</span><span style="font-size:10px;color:var(--text-muted)">' + g.page_count + '</span></div>';
    if (isActive && g.pages) {
      g.pages.forEach(function(p) {
        var isP = wikiActivePaper === p.id;
        // domain 页 id 形如 "ml/slug"，取末段显示；其它直接显示 title/id
        var disp = p.title || p.id.split('/').pop();
        h += '<div onclick="event.stopPropagation();openWikiPaper(\'' + esc(g.kind) + '\',\'' + esc(g.name) + '\',\'' + esc(p.id) + '\')" style="cursor:pointer;padding:8px 10px 8px 24px;border-radius:6px;font-size:11px;margin-top:4px;background:' + (isP ? 'rgba(59,109,240,.12)' : 'transparent') + ';color:' + (isP ? 'var(--accent)' : 'var(--text)') + ';font-weight:' + (isP ? '600' : '400') + '">';
        h += '<i class="fa-solid fa-file-lines" style="margin-right:6px;color:' + (isP ? 'var(--accent)' : '#94a3b8') + '"></i>' + esc(disp);
        h += '</div>';
      });
    }
    h += '</div>';
  });
  h += '</div>';

  // ── Right panel ──
  h += '<div style="flex:1;min-width:0;display:flex;flex-direction:column">';
  if (wikiActivePaper && wikiActiveKind) {
    h += '<div id="wikiPaperPane" style="min-height:55vh"><div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> 加载页面...</div></div>';
  } else if (res.index) {
    h += '<div class="card" style="padding:20px;font-size:13px;line-height:1.8;overflow-y:auto;max-height:60vh"><div style="white-space:pre-wrap">' + esc(res.index) + '</div></div>';
  } else {
    h += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted)"><i class="fa-solid fa-arrow-left" style="font-size:24px;display:block;text-align:center;margin-bottom:12px"></i><p>选择一个页面查看</p></div>';
  }
  h += '</div></div>';

  el.innerHTML = h;
  if (wikiActivePaper && wikiActiveKind) loadWikiPaper(wikiActiveKind, wikiActiveName, wikiActivePaper);
}

function toggleWikiDomain(kind) {
  if (wikiActiveKind === kind) { wikiActiveKind = null; wikiActiveName = null; wikiActivePaper = null; }
  else { wikiActiveKind = kind; wikiActiveName = null; wikiActivePaper = null; }
  renderWikiList(wikiData);
}

// domain 页 id 形如 "ml/slug"：name=ml、page_id=slug；其它 kind：name 为目录名、page_id=id
function openWikiPaper(kind, groupName, pageId) {
  var name = groupName, pid = pageId;
  if (kind === 'domain') {
    var parts = pageId.split('/');
    name = parts[0];
    pid = parts.slice(1).join('/');
  }
  wikiActiveKind = kind;
  wikiActiveName = name;
  wikiActivePaper = pageId;
  wikiTab = 'preview';
  renderWikiList(wikiData);
  loadWikiPaper(kind, name, pageId);
}

function _wikiPageUrl(kind, name, pageId) {
  var pid = pageId;
  var n = name;
  if (kind === 'domain') {
    var parts = pageId.split('/');
    n = parts[0];
    pid = parts.slice(1).join('/');
  }
  return '/openclaw/wiki/' + encodeURIComponent(kind) + '/' + encodeURIComponent(n) + '/' + encodeURIComponent(pid);
}

async function loadWikiPaper(kind, name, pageId) {
  var key = kind + '/' + pageId;
  if (wikiPaperCache[key]) { renderWikiPaper(document.getElementById('wikiPaperPane'), wikiPaperCache[key]); return; }
  var el = document.getElementById('wikiPaperPane');
  if (!el) return;
  try {
    var res = await api('GET', _wikiPageUrl(kind, name, pageId));
    wikiPaperCache[key] = res;
    renderWikiPaper(el, res);
  } catch(e) {
    el.innerHTML = '<div style="padding:20px;color:#ef4444">加载失败: ' + esc(e.message) + '</div>';
  }
}

/* ── Tab system ── */
function wikiSwitchTab(tab) {
  wikiTab = tab;
  var el = document.getElementById('wikiPaperPane');
  if (el && wikiActivePaper) {
    var key = wikiActiveKind + '/' + wikiActivePaper;
    renderWikiPaper(el, wikiPaperCache[key]);
  }
}

function renderWikiPaper(el, res) {
  if (!res) return;
  var h = '<div class="card" style="padding:16px">';

  // ── Title bar ──
  var fm = res.frontmatter || {};
  h += '<div style="margin-bottom:12px">';
  h += '<h2 style="font-size:15px;font-weight:700;color:var(--text-bold);margin-bottom:6px">' + esc(fm['title'] || res.id) + '</h2>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">';
  if (fm['paper.title']) h += wikiTag(esc(fm['paper.title']), '#3b6df0');
  if (fm['paper.year']) h += wikiTag(fm['paper.year'], '#10b981');
  if (fm['evidence_level']) h += wikiTag('证据: ' + fm['evidence_level'], '#8b5cf6');
  if (fm['paper.venue']) h += wikiTag(esc(fm['paper.venue']), '#f59e0b');
  h += '</div>';
  var doi = fm['paper.doi']; var arxiv = fm['paper.arxiv'];
  if (doi) h += '<a href="' + esc('https://doi.org/' + doi) + '" target="_blank" style="font-size:11px;color:var(--accent);margin-right:12px"><i class="fa-solid fa-link"></i> DOI</a>';
  if (arxiv) h += '<a href="' + esc('https://arxiv.org/abs/' + arxiv) + '" target="_blank" style="font-size:11px;color:var(--accent)"><i class="fa-solid fa-file-zipper"></i> arXiv</a>';
  h += '</div>';

  // ── Tab bar ──
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
  h += '<div class="tab-bar" style="flex:1">';
  h += '<button class="tab-btn' + (wikiTab === 'source' ? ' on' : '') + '" onclick="wikiSwitchTab(\'source\')" style="font-size:11px;padding:5px 12px"><i class="fa-solid fa-pen"></i> 源码</button>';
  h += '<button class="tab-btn' + (wikiTab === 'preview' ? ' on' : '') + '" onclick="wikiSwitchTab(\'preview\')" style="font-size:11px;padding:5px 12px"><i class="fa-solid fa-eye"></i> 预览</button>';
  h += '<button class="tab-btn' + (wikiTab === 'graph' ? ' on' : '') + '" onclick="wikiSwitchTab(\'graph\')" style="font-size:11px;padding:5px 12px"><i class="fa-solid fa-project-diagram"></i> 图谱</button>';
  h += '</div>';
  h += '<button class="btn bp" onclick="wikiSavePaper()" style="font-size:11px;padding:5px 12px"><i class="fa-solid fa-floppy-disk"></i> 保存</button>';
  h += '<button class="btn" onclick="wikiDownload()" style="font-size:11px;padding:5px 12px"><i class="fa-solid fa-download"></i> 下载</button>';
  h += '</div>';

  // ── Source tab ──
  if (wikiTab === 'source') {
    h += '<textarea id="wikiEditor" style="width:100%;min-height:50vh;max-height:55vh;font-family:monospace;font-size:12px;line-height:1.6;padding:12px;background:#1e293b;color:#e2e8f0;border:1px solid var(--border);border-radius:8px;resize:vertical;scrollbar-width:thin">' + esc(res.content) + '</textarea>';
  }

  // ── Preview tab ──
  if (wikiTab === 'preview') {
    h += '<div id="wikiPreview" style="font-size:13px;line-height:1.8;overflow-y:auto;max-height:55vh;scrollbar-width:thin;color:var(--text);white-space:normal">';
    if (res.body) {
      if (typeof marked !== 'undefined') {
        h += marked.parse(res.body);
      } else {
        h += '<pre style="white-space:pre-wrap">' + esc(res.body) + '</pre>';
      }
    }
    h += '</div>';
  }

  // ── Graph tab ──
  if (wikiTab === 'graph') {
    h += '<div id="wikiGraph" style="width:100%;min-height:50vh;background:var(--bg);border-radius:8px;border:1px solid var(--border)">';
    if (typeof d3 === 'undefined') {
      h += '<div style="text-align:center;padding:60px;color:#FF6B81">D3.js 未加载</div>';
    } else {
      h += '<svg id="wikiGraphSvg" width="100%" height="500"></svg>';
    }
    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;

  // Render graph if needed
  if (wikiTab === 'graph' && typeof d3 !== 'undefined') {
    setTimeout(function() { wikiRenderGraph(res); }, 200);
  }
}

/* ── Graph ── */
function wikiRenderGraph(res) {
  var svgEl = document.getElementById('wikiGraphSvg');
  if (!svgEl) return;

  var width = svgEl.parentElement.clientWidth || 700;
  var height = 500;

  // Nodes: all papers + current paper
  var nodes = [];
  var edges = [];
  var nodeMap = {};

  // Add all papers as nodes
  wikiAllPapers.forEach(function(p) {
    var id = p.kind + '/' + p.id;
    if (!nodeMap[id]) {
      nodeMap[id] = true;
      nodes.push({ id: id, label: p.title || p.id.split('/').pop(), kind: p.kind, name: p.name, pageId: p.id, isActive: (id === wikiActiveKind + '/' + wikiActivePaper) });
    }
  });

  // Parse [[wikilinks]] from current paper body
  var linkRe = /\[\[([^\]]+)\]\]/g;
  var match;
  while ((match = linkRe.exec(res.body || '')) !== null) {
    var target = match[1].trim();
    var srcId = wikiActiveKind + '/' + wikiActivePaper;
    var found = false;
    for (var i = 0; i < wikiAllPapers.length; i++) {
      var p = wikiAllPapers[i];
      if (p.title === target || p.id === target) {
        var tgtId = p.kind + '/' + p.id;
        if (!nodeMap[tgtId]) { nodeMap[tgtId] = true; nodes.push({ id: tgtId, label: p.title || p.id.split('/').pop(), kind: p.kind, name: p.name, pageId: p.id }); }
        edges.push({ source: srcId, target: tgtId });
        found = true;
        break;
      }
    }
    if (!found) {
      if (!nodeMap[target]) { nodeMap[target] = true; nodes.push({ id: target, label: target, ghost: true }); }
      edges.push({ source: srcId, target: target });
    }
  }

  if (!nodes.length) {
    svgEl.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#64748b" font-size="13">无关联图谱</text>';
    return;
  }

  var svg = d3.select('#wikiGraphSvg');
  svg.selectAll('*').remove();
  svg.attr('viewBox', [0, 0, width, height]);

  var link = svg.append('g').selectAll('line').data(edges).enter().append('line')
    .attr('stroke', '#cbd5e1').attr('stroke-width', 1).attr('stroke-opacity', 0.6);

  var node = svg.append('g').selectAll('g').data(nodes).enter().append('g')
    .style('cursor', function(d) { return d.ghost ? 'default' : 'pointer'; });

  node.append('circle')
    .attr('r', function(d) { return d.isActive ? 10 : d.ghost ? 4 : 8; })
    .attr('fill', function(d) { return d.isActive ? '#3b6df0' : d.ghost ? 'rgba(255,107,129,.4)' : '#10b981'; })
    .attr('stroke', function(d) { return d.isActive ? '#2563eb' : 'none'; })
    .attr('stroke-width', 2);

  node.append('text')
    .text(function(d) { return d.label.length > 20 ? d.label.slice(0, 20) + '...' : d.label; })
    .attr('x', 12).attr('y', 4).attr('font-size', 10).attr('fill', function(d) { return d.ghost ? '#94a3b8' : '#334155'; });

  node.on('click', function(e, d) {
    if (d.ghost || d.isActive || !d.kind) return;
    openWikiPaper(d.kind, d.name, d.pageId);
  });

  var simulation = d3.forceSimulation(nodes).force('link', d3.forceLink(edges).distance(120))
    .force('charge', d3.forceManyBody().strength(-300)).force('center', d3.forceCenter(width / 2, height / 2));
  simulation.on('tick', function() {
    link.attr('x1', function(d) { return d.source.x; }).attr('y1', function(d) { return d.source.y; })
      .attr('x2', function(d) { return d.target.x; }).attr('y2', function(d) { return d.target.y; });
    node.attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; });
  });
}

/* ── Save ── */
async function wikiSavePaper() {
  var editor = document.getElementById('wikiEditor');
  if (!editor) return;
  var content = editor.value;
  try {
    await api('PUT', _wikiPageUrl(wikiActiveKind, wikiActiveName, wikiActivePaper), { content: content });
    var key = wikiActiveKind + '/' + wikiActivePaper;
    wikiPaperCache[key] = null; // invalidate cache so next load fetches fresh
    toast('已保存', 'fa-check-circle', '#10b981');
  } catch(e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

function wikiDownload() {
  var key = wikiActiveKind + '/' + wikiActivePaper;
  var res = wikiPaperCache[key];
  if (!res) return;
  var blob = new Blob([res.content], { type: 'text/markdown;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = wikiActivePaper.split('/').pop() + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function wikiTag(text, color) {
  return '<span style="display:inline-block;padding:2px 10px;border-radius:6px;background:' + color + '15;color:' + color + ';font-size:11px;font-weight:500">' + text + '</span>';
}

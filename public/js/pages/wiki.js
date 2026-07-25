/* ===== Wiki 知识库 —— agent 维护的结构化知识库（wiki/main） ===== */
var wikiData = null;
var wikiActiveKind = null;   // 当前展开的分组 kind
var wikiActiveName = null;   // 当前分组的 name（domain 类为 domain 名，其余为目录名）
var wikiActivePaper = null;  // 当前页 page_id
var wikiTab = 'preview';
var wikiPaperCache = {};  // { kind/name/pageId: { frontmatter, body, content } }
var wikiAllPapers = [];   // [{kind, name, id, title}] for graph

// ── 图谱状态 ──
var wikiGraphData = null;       // 后端 GET /wiki/graph 的 {nodes, edges} 全库预解析
var wikiGraphNetwork = null;    // vis.Network 实例
var wikiGraphMode = 'ego';      // 'ego'（当前页 1–2 跳）| 'global'（全库）
var wikiGraphEgoHops = 2;       // ego 图跳数
var WIKI_GRAPH_CLUSTER_THRESHOLD = 80;  // 节点超过此值时全局图按 kind 聚类

// 按 kind 着色（复用 WIKI_KIND_COLOR，dangling 灰）
function _wikiGraphColor(kind) {
  if (!kind) return '#94a3b8';
  return (WIKI_KIND_COLOR && WIKI_KIND_COLOR[kind]) || '#3b6df0';
}

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
function _wikiRerenderPaperPane() {
  var el = document.getElementById('wikiPaperPane');
  if (el && wikiActivePaper) {
    var key = wikiActiveKind + '/' + wikiActivePaper;
    renderWikiPaper(el, wikiPaperCache[key]);
  }
}

function wikiSwitchTab(tab) {
  wikiTab = tab;
  _wikiRerenderPaperPane();
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
    var activeId = wikiActiveKind && wikiActivePaper ? (wikiActiveKind + '/' + wikiActivePaper) : null;
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
    h += '<div class="tab-bar">';
    h += '<button class="tab-btn' + (wikiGraphMode === 'ego' ? ' on' : '') + '" onclick="wikiSetGraphMode(\'ego\')" style="font-size:11px;padding:4px 12px">局部</button>';
    h += '<button class="tab-btn' + (wikiGraphMode === 'global' ? ' on' : '') + '" onclick="wikiSetGraphMode(\'global\')" style="font-size:11px;padding:4px 12px">全局</button>';
    h += '</div>';
    if (wikiGraphMode === 'ego') {
      h += '<div class="tab-bar">';
      h += '<button class="tab-btn' + (wikiGraphEgoHops === 1 ? ' on' : '') + '" onclick="wikiSetEgoHops(1)" style="font-size:11px;padding:4px 10px">1 跳</button>';
      h += '<button class="tab-btn' + (wikiGraphEgoHops === 2 ? ' on' : '') + '" onclick="wikiSetEgoHops(2)" style="font-size:11px;padding:4px 10px">2 跳</button>';
      h += '</div>';
    }
    h += '<button class="btn" onclick="wikiRefreshGraph()" style="font-size:11px;padding:4px 12px;margin-left:auto"><i class="fa-solid fa-rotate"></i> 刷新</button>';
    h += '</div>';
    h += '<div id="wikiGraphNet" style="width:100%;height:55vh;background:var(--bg);border-radius:8px;border:1px solid var(--border)">';
    h += '<div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> 加载图谱...</div>';
    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;

  // Render graph if needed
  if (wikiTab === 'graph') {
    wikiRenderGraph(activeId);
  }
}

/* ── Graph ── */
// 加载 vis-network（lazy，CDN；issue #46 指定 vis-network 渲染图谱）
var _wikiVisLoading = null;
function wikiLoadVis() {
  if (typeof vis !== 'undefined' && vis.Network) return Promise.resolve();
  if (_wikiVisLoading) return _wikiVisLoading;
  _wikiVisLoading = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js';
    s.onload = function() { resolve(); };
    s.onerror = function() { reject(new Error('vis-network 加载失败')); };
    document.head.appendChild(s);
  });
  return _wikiVisLoading;
}

function wikiSetGraphMode(mode) { wikiGraphMode = mode; _wikiRerenderPaperPane(); }
function wikiSetEgoHops(n) { wikiGraphEgoHops = n; _wikiRerenderPaperPane(); }
function wikiRefreshGraph() { wikiGraphData = null; _wikiRerenderPaperPane(); }

// BFS：从 centerId 出发，沿无向边取 hops 跳内节点集合
function _wikiEgoNodes(centerId, hops, edges) {
  var adj = {};
  edges.forEach(function(e) {
    (adj[e.from] = adj[e.from] || []).push(e.to);
    (adj[e.to] = adj[e.to] || []).push(e.from);
  });
  var seen = {};
  seen[centerId] = 0;
  var queue = [centerId];
  while (queue.length) {
    var cur = queue.shift();
    var d = seen[cur];
    if (d >= hops) continue;
    (adj[cur] || []).forEach(function(nb) {
      if (!(nb in seen)) { seen[nb] = d + 1; queue.push(nb); }
    });
  }
  return seen;  // { nodeId: 距离 }
}

async function wikiRenderGraph(activeId) {
  if (!activeId && wikiActiveKind && wikiActivePaper) activeId = wikiActiveKind + '/' + wikiActivePaper;
  var container = document.getElementById('wikiGraphNet');
  if (!container) return;

  try {
    await wikiLoadVis();
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81">' + esc(e.message) + '</div>';
    return;
  }

  // 全库图谱数据（带缓存；wikiRefreshGraph / 保存后置 null 触发重取）
  if (!wikiGraphData) {
    try {
      wikiGraphData = await api('GET', '/openclaw/wiki/graph');
    } catch (e) {
      container.innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81">图谱加载失败: ' + esc(e.message) + '</div>';
      return;
    }
  }
  var data = wikiGraphData || { nodes: [], edges: [] };
  if (!data.nodes.length) {
    container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-circle-nodes" style="font-size:32px;display:block;margin-bottom:12px;opacity:.2"></i>暂无可视化的知识图谱</div>';
    return;
  }

  // 选子图：ego（当前页 hops 跳）或全局
  var nodeById = {};
  data.nodes.forEach(function(n) { nodeById[n.id] = n; });
  var subNodes, subEdges;
  if (wikiGraphMode === 'ego') {
    if (!activeId || !nodeById[activeId]) {
      container.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">先在左侧打开一个页面，再以它为中心看局部图谱</div>';
      return;
    }
    var dist = _wikiEgoNodes(activeId, wikiGraphEgoHops, data.edges);
    subNodes = data.nodes.filter(function(n) { return n.id in dist; });
    subEdges = data.edges.filter(function(e) { return (e.from in dist) && (e.to in dist); });
  } else {
    subNodes = data.nodes;
    subEdges = data.edges;
  }

  // 映射为 vis 节点/边
  var nodesArr = subNodes.map(function(n) {
    var isActive = n.id === activeId;
    var isDangling = !!n.dangling;
    var label = n.title || (n.pageId ? n.pageId.split('/').pop() : n.id);
    return {
      id: n.id,
      label: label.length > 24 ? label.slice(0, 24) + '…' : label,
      title: n.title || n.id,  // 悬停提示：vis-network 用 createTextNode 渲染，不解析 HTML，故不 esc（esc 会双重转义显示 &amp;）
      kind: n.kind, name: n.name, pageId: n.pageId, dangling: isDangling,
      color: {
        background: isActive ? '#3b6df0' : (isDangling ? 'rgba(148,163,184,.35)' : _wikiGraphColor(n.kind)),
        border: isActive ? '#2563eb' : (isDangling ? '#94a3b8' : _wikiGraphColor(n.kind)),
        highlight: { background: isActive ? '#3b6df0' : _wikiGraphColor(n.kind), border: '#2563eb' },
      },
      font: { color: isActive ? '#3b6df0' : (isDangling ? '#94a3b8' : '#334155'), size: isActive ? 13 : 11, bold: isActive },
      borderWidth: isActive ? 3 : 1,
      shape: isDangling ? 'ellipse' : 'dot',
      size: isActive ? 16 : 10,
      opacity: isDangling ? 0.6 : 1,
    };
  });
  var nodeIds = {};
  nodesArr.forEach(function(n) { nodeIds[n.id] = true; });
  var edgesArr = subEdges
    .filter(function(e) { return nodeIds[e.from] && nodeIds[e.to]; })
    .map(function(e, i) {
      // 边类型着色：wikilink 实线灰，related 蓝虚线，source_pages 绿虚线
      var style = { wikilink: { color: '#cbd5e1', dashes: false }, related: { color: '#3b6df0', dashes: true }, source_pages: { color: '#10b981', dashes: true } }[e.type] || { color: '#cbd5e1', dashes: false };
      return { id: 'e' + i, from: e.from, to: e.to, color: { color: style.color, opacity: 0.55 }, dashes: style.dashes, width: 1, smooth: { type: 'continuous' } };
    });

  // 物理布局：全局大库 Barnes-Hut + 拖拽隐边；ego 用较稳的 forceAtlas2 替代
  var isGlobalBig = wikiGraphMode === 'global' && nodesArr.length > WIKI_GRAPH_CLUSTER_THRESHOLD;
  var options = {
    nodes: { shape: 'dot', scaling: { min: 8, max: 20 } },
    edges: { smooth: { type: 'continuous' } },
    interaction: { hover: true, hideEdgesOnDrag: true, hideEdgesOnZoom: false, tooltipDelay: 120 },
    physics: {
      enabled: true,
      solver: 'barnesHut',
      barnesHut: { gravitationalConstant: wikiGraphMode === 'global' ? -8000 : -3000, springLength: wikiGraphMode === 'global' ? 150 : 110, damping: 0.4 },
      stabilization: { iterations: 150 },
    },
  };

  if (wikiGraphNetwork) { wikiGraphNetwork.destroy(); wikiGraphNetwork = null; }
  var network = new vis.Network(container, { nodes: new vis.DataSet(nodesArr), edges: new vis.DataSet(edgesArr) }, options);
  wikiGraphNetwork = network;

  // 大库全局图：稳定后按 kind 聚类降复杂度
  if (isGlobalBig) {
    network.once('stabilizationIterationsDone', function() {
      var byKind = {};
      nodesArr.forEach(function(n) { if (!n.dangling) (byKind[n.kind || 'other'] = byKind[n.kind || 'other'] || []).push(n.id); });
      Object.keys(byKind).forEach(function(kind) {
        if (byKind[kind].length < 2) return;
        network.cluster({
          joinCondition: function(opt) { return byKind[kind].indexOf(opt.id) >= 0; },
          clusterNodeProperties: {
            id: 'cluster:' + kind,
            label: (WIKI_KIND_LABEL && WIKI_KIND_LABEL[kind] || kind) + ' (' + byKind[kind].length + ')',
            color: { background: _wikiGraphColor(kind), border: _wikiGraphColor(kind) },
            shape: 'database',
            allowSingleNodeCluster: false,
          },
        });
      });
    });
    // 双击聚类展开
    network.on('doubleClick', function(params) {
      if (params.nodes.length === 1 && network.isCluster(params.nodes[0])) network.openCluster(params.nodes[0]);
    });
  }

  // 点节点直接打开对应文件进编辑器（dangling 与聚类节点除外）
  network.on('click', function(params) {
    if (!params.nodes.length) return;
    var nid = params.nodes[0];
    if (network.isCluster(nid)) { network.openCluster(nid); return; }
    var n = nodeById[nid];
    if (!n || n.dangling || !n.kind) return;
    if (nid === activeId) return;
    openWikiPaper(n.kind, n.name, n.pageId);
  });

  // 高亮当前节点：稳定后聚焦到 activeId
  if (activeId && nodeIds[activeId]) {
    network.once('stabilizationIterationsDone', function() {
      try { network.focus(activeId, { scale: wikiGraphMode === 'ego' ? 1.0 : 0.6, animation: true }); } catch (e) {}
    });
    network.selectNodes([activeId]);
  }
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
    // 图谱实时刷新（issue #46）：保存的 wikilink/frontmatter 可能改变图，重拉并（若在图谱 tab）重渲
    try {
      wikiGraphData = await api('GET', '/openclaw/wiki/graph');
      if (wikiTab === 'graph') wikiRenderGraph();
    } catch (e) { wikiGraphData = null; /* 拉取失败则下次进图重取 */ }
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

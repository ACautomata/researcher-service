/* ===== Wiki 知识库 —— Autoresearch 自动构建的论文知识库 ===== */
var wikiData = null;
var wikiActiveDomain = null;
var wikiActivePaper = null;

pages.wiki = async function() {
  wikiData = null;
  wikiActiveDomain = null;
  wikiActivePaper = null;
  var h = '';

  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">Wiki 知识库</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:13px;cursor:help" title="Autoresearch Agent 自动构建的结构化论文知识库"></i></div>';
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
    renderWikiList(res);
  } catch(e) {
    el.innerHTML = '<div style="text-align:center;padding:60px;color:#ef4444"><i class="fa-solid fa-triangle-exclamation" style="font-size:24px;display:block;margin-bottom:12px"></i><p>加载失败: ' + esc(e.message) + '</p></div>';
  }
}

function renderWikiList(res) {
  var el = document.getElementById('wikiContent');
  if (!el) return;

  if (!res.domains || !res.domains.length) {
    el.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-book" style="font-size:40px;display:block;margin-bottom:12px;opacity:.15"></i><p style="font-weight:600;color:var(--text)">知识库为空</p><p style="font-size:11px;margin-top:4px">Autoresearch 尚未生成 Wiki 内容</p></div>';
    return;
  }

  var h = '';

  // Stats
  var totalPapers = 0;
  res.domains.forEach(function(d) { totalPapers += d.paper_count || 0; });
  h += '<div style="display:flex;gap:16px;margin-bottom:16px">';
  h += '<div style="flex:1;text-align:center;padding:16px;border-radius:12px;background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1)"><div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:#10b981">' + res.domains.length + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">领域</div></div>';
  h += '<div style="flex:1;text-align:center;padding:16px;border-radius:12px;background:rgba(59,109,240,.04);border:1px solid rgba(59,109,240,.1)"><div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:#3b6df0">' + totalPapers + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px">论文</div></div>';
  h += '</div>';

  // Split view: tree + paper
  h += '<div style="display:flex;gap:16px;min-height:55vh">';

  // ── Left sidebar — domain tree ──
  h += '<div style="width:220px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;max-height:60vh;overflow-y:auto;scrollbar-width:thin">';
  res.domains.forEach(function(d) {
    var isActive = wikiActiveDomain === d.name;
    h += '<div onclick="toggleWikiDomain(\'' + esc(d.name) + '\')" style="cursor:pointer;padding:10px 12px;border-radius:8px;font-size:12px;background:' + (isActive ? 'var(--accent-light)' : 'var(--bg)') + ';border:1px solid ' + (isActive ? 'var(--accent)' : 'transparent') + '">';
    h += '<div style="display:flex;align-items:center;gap:6px"><i class="fa-solid fa-folder-open" style="color:#10b981;font-size:11px"></i><span style="font-weight:600;color:var(--text);flex:1">' + esc(d.name) + '</span><span style="font-size:10px;color:var(--text-muted)">' + d.paper_count + '</span></div>';
    if (isActive && d.papers) {
      d.papers.forEach(function(p) {
        var isP = wikiActivePaper === p.id;
        h += '<div onclick="event.stopPropagation();openWikiPaper(\'' + esc(d.name) + '\',\'' + esc(p.id) + '\')" style="cursor:pointer;padding:8px 10px 8px 24px;border-radius:6px;font-size:11px;margin-top:4px;background:' + (isP ? 'rgba(59,109,240,.12)' : 'transparent') + ';color:' + (isP ? 'var(--accent)' : 'var(--text)') + ';font-weight:' + (isP ? '600' : '400') + '">';
        h += '<i class="fa-solid fa-file-lines" style="margin-right:6px;color:' + (isP ? 'var(--accent)' : '#94a3b8') + '"></i>' + esc(p.title || p.id);
        h += '</div>';
      });
    }
    h += '</div>';
  });
  h += '</div>';

  // ── Right panel — paper view or index ──
  h += '<div style="flex:1;min-width:0">';
  if (wikiActivePaper && wikiActiveDomain) {
    h += '<div id="wikiPaperPane" style="min-height:55vh"><div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> 加载论文...</div></div>';
  } else if (res.index) {
    h += '<div class="card" style="padding:20px;font-size:13px;line-height:1.8;overflow-y:auto;max-height:60vh"><div style="white-space:pre-wrap">' + esc(res.index) + '</div></div>';
  } else {
    h += '<div style="text-align:center;padding:60px;color:var(--text-muted)"><i class="fa-solid fa-arrow-left" style="font-size:24px;display:block;margin-bottom:12px"></i><p>选择一个论文查看</p></div>';
  }
  h += '</div></div>';

  el.innerHTML = h;

  // Load paper if needed
  if (wikiActivePaper && wikiActiveDomain) {
    loadWikiPaper(wikiActiveDomain, wikiActivePaper);
  }
}

function toggleWikiDomain(domain) {
  if (wikiActiveDomain === domain) {
    wikiActiveDomain = null;
    wikiActivePaper = null;
  } else {
    wikiActiveDomain = domain;
    wikiActivePaper = null;
  }
  renderWikiList(wikiData);
}

function openWikiPaper(domain, paperId) {
  wikiActiveDomain = domain;
  wikiActivePaper = paperId;
  renderWikiList(wikiData);
  loadWikiPaper(domain, paperId);
}

async function loadWikiPaper(domain, paperId) {
  var el = document.getElementById('wikiPaperPane');
  if (!el) return;
  try {
    var res = await api('GET', '/openclaw/wiki/' + encodeURIComponent(domain) + '/' + encodeURIComponent(paperId));
    renderWikiPaper(el, res);
  } catch(e) {
    el.innerHTML = '<div style="padding:20px;color:#ef4444">加载失败: ' + esc(e.message) + '</div>';
  }
}

function renderWikiPaper(el, res) {
  var h = '<div class="card" style="padding:20px">';

  // ── YAML Frontmatter as metadata cards ──
  var fm = res.frontmatter || {};
  h += '<div style="margin-bottom:16px">';
  h += '<h2 style="font-size:16px;font-weight:700;color:var(--text-bold);margin-bottom:8px">' + esc(fm['title'] || res.id) + '</h2>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
  if (fm['paper.title']) h += wikiTag(esc(fm['paper.title']), '#3b6df0');
  if (fm['paper.year']) h += wikiTag(fm['paper.year'], '#10b981');
  if (fm['evidence_level']) h += wikiTag('证据: ' + fm['evidence_level'], '#8b5cf6');
  if (fm['paper.venue']) h += wikiTag(esc(fm['paper.venue']), '#f59e0b');
  h += '</div>';

  // Authors
  var authors = fm['authors'] || fm['paper.authors'];
  if (typeof authors === 'string') {
    h += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">作者: ' + esc(authors) + '</div>';
  }

  // DOI / arxiv links
  var doi = fm['paper.doi'];
  var arxiv = fm['paper.arxiv'];
  if (doi || arxiv) {
    h += '<div style="font-size:11px;margin-bottom:6px">';
    if (doi) h += '<a href="' + esc('https://doi.org/' + doi) + '" target="_blank" style="color:var(--accent);margin-right:12px"><i class="fa-solid fa-link"></i> DOI: ' + esc(doi) + '</a>';
    if (arxiv) h += '<a href="' + esc('https://arxiv.org/abs/' + arxiv) + '" target="_blank" style="color:var(--accent)"><i class="fa-solid fa-file-zipper"></i> arXiv: ' + esc(arxiv) + '</a>';
    h += '</div>';
  }

  // Tags
  var tags = fm['tags'] || fm['classification.label'];
  if (typeof tags === 'string') tags = tags.split(',').map(function(s) { return s.trim(); });
  if (tags && tags.length) {
    h += '<div style="margin-top:6px">';
    (Array.isArray(tags) ? tags : [tags]).forEach(function(t) {
      if (t) h += '<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:var(--accent-light);color:var(--accent);font-size:10px;margin-right:4px;margin-bottom:4px">' + esc(t.trim ? t.trim() : t) + '</span>';
    });
    h += '</div>';
  }
  h += '</div>';

  // ── Body ──
  if (res.body) {
    h += '<div style="height:1px;background:var(--border);margin:0 0 16px 0"></div>';
    h += '<div id="wikiBody" style="font-size:13px;line-height:1.8;overflow-y:auto;max-height:55vh;scrollbar-width:thin;color:var(--text)">';
    var bodyHtml = esc(res.body).replace(/\n/g, '<br>');
    // Simple markdown-like rendering for headings
    bodyHtml = bodyHtml.replace(/^### (.+)$/gm, '<h4 style="margin:12px 0 6px;font-size:13px;font-weight:600;color:var(--text-bold)">$1</h4>');
    bodyHtml = bodyHtml.replace(/^## (.+)$/gm, '<h3 style="margin:16px 0 8px;font-size:14px;font-weight:700;color:var(--text-bold)">$1</h3>');
    bodyHtml = bodyHtml.replace(/^# (.+)$/gm, '<h2 style="margin:20px 0 10px;font-size:16px;font-weight:700;color:var(--text-bold)">$1</h2>');
    bodyHtml = bodyHtml.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    bodyHtml = bodyHtml.replace(/\*(.+?)\*/g, '<em>$1</em>');
    bodyHtml = bodyHtml.replace(/`(.+?)`/g, '<code style="background:var(--border);padding:1px 4px;border-radius:3px;font-size:11px">$1</code>');
    bodyHtml = bodyHtml.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--accent)">$1</a>');
    bodyHtml = bodyHtml.replace(/- (.+)/g, '<li style="margin-left:16px;list-style:disc">$1</li>');
    bodyHtml = bodyHtml.replace(/<br><li/g, '<li');
    h += bodyHtml;
    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;

  // Try using marked.js if available for better rendering
  if (typeof marked !== 'undefined') {
    var bodyEl = document.getElementById('wikiBody');
    if (bodyEl && res.body) {
      bodyEl.innerHTML = marked.parse(res.body);
      bodyEl.style.whiteSpace = 'normal';
    }
  }
}

function wikiTag(text, color) {
  return '<span style="display:inline-block;padding:2px 10px;border-radius:6px;background:' + color + '15;color:' + color + ';font-size:11px;font-weight:500">' + text + '</span>';
}

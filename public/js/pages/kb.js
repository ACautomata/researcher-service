/* ===== KB Page: Domain-Based Knowledge Base ===== */
var kbMode = 'list'; // list | domain | paper
var kbActiveDomain = null;
var kbActivePaper = null;

pages.kb = async function() {
  kbMode = 'list'; kbActiveDomain = null; kbActivePaper = null;
  return renderDomainList();
};

/* ===== 视图一：领域列表 ===== */
async function renderDomainList() {
  var domains = [];
  try { var d = await api('GET', '/kb/domains'); domains = d.domains || []; } catch(e) {}
  var total = domains.length;
  var hasDocs = domains.filter(function(x){return x.paper_count > 0;}).length;

  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + total + '</div><div class="st-l">领域数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + hasDocs + '</div><div class="st-l">含文献</div></div>';
  h += '<div class="st-card" style="cursor:pointer" onclick="showNewDomainForm()"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-plus"></i></div><div class="st-l">新建领域</div></div>';
  h += '</div>';

  h += '<div id="newDomainForm" style="display:none" class="card mb24"><div class="card-t"><i class="fa-solid fa-layer-group"></i>新建领域</div>';
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">';
  h += '<div style="flex:1;min-width:200px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">领域名称</label><input class="inp" id="ndName" placeholder="如：自然语言处理" style="font-size:12px"></div>';
  h += '<div style="flex:2;min-width:200px"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">描述</label><input class="inp" id="ndDesc" placeholder="可选描述" style="font-size:12px"></div></div>';
  h += '<div style="display:flex;gap:8px"><button class="btn bp" onclick="createDomain()"><i class="fa-solid fa-check"></i> 创建</button><button class="btn" onclick="hideNewDomainForm()">取消</button></div></div>';

  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-layer-group"></i>所有领域</div>';
  if (!total) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-folder-open" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无领域，点击「新建领域」开始</p></div>';
  } else {
    for (var i = 0; i < domains.length; i++) {
      var d = domains[i];
      h += '<div class="li-item" style="cursor:pointer" onclick="openDomain(' + d.id + ')">';
      h += '<div class="li-ic" style="background:rgba(0,229,160,.12);color:#00E5A0"><i class="fa-solid fa-layer-group"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(d.name) + '</div>';
      h += '<div class="li-mt"><span class="badge bdg-g">' + (d.paper_count || 0) + ' 篇论文</span>';
      if (d.description) h += ' <span style="color:var(--text-muted)">' + esc(d.description) + '</span>';
      h += ' <span style="color:var(--text-muted)">' + (d.updated_at || '') + '</span></div></div>';
      h += '<span style="font-size:16px;color:var(--text-muted);opacity:.3"><i class="fa-solid fa-chevron-right"></i></span></div>';
    }
  }
  h += '</div>';
  return h;
}

/* ===== 视图二：领域详情 ===== */
function openDomain(id) {
  kbMode = 'domain'; kbActiveDomain = id;
  loadDomainView(id);
}

async function loadDomainView(id) {
  var domain = null;
  try { var dd = await api('GET', '/kb/domains'); domain = (dd.domains || []).find(function(x){return x.id === id;}); } catch(e) {}
  var papers = [];
  try { var pp = await api('GET', '/kb/domain/' + id + '/papers'); papers = pp.papers || []; } catch(e) {}

  var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'kb\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回领域列表</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(domain ? domain.name : '') + '</span>';
  h += '<span class="badge bdg-g">' + papers.length + ' 篇</span></div>';

  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-cloud-arrow-up"></i>上传文献 <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">PDF / DOCX / TXT / ZIP</span></div>';
  h += '<div class="upload-z" style="margin-bottom:12px" onclick="document.getElementById(\'df\').click()" id="dz' + id + '">';
  h += '<input type="file" id="df" multiple accept=".pdf,.docx,.doc,.txt,.md,.zip" style="display:none" onchange="domainUpload(' + id + ', this.files)">';
  h += '<i class="fa-solid fa-cloud-arrow-up u-ico"></i><div class="u-t">拖拽或点击上传论文</div><div class="u-s">上传后自动解析为 Markdown</div></div>';
  h += '<div id="dubp' + id + '" class="pbar on" style="display:none"><div class="pb-t"><i class="fa-solid fa-gear fa-spin"></i>解析中...</div></div></div>';

  if (papers.length) {
    h += '<div class="card"><div class="card-t"><i class="fa-solid fa-file-lines"></i>论文列表</div>';
    for (var i = 0; i < papers.length; i++) {
      var p = papers[i];
      var mdlen = p.markdown_content ? p.markdown_content.length : 0;
      h += '<div class="li-item" style="cursor:pointer" onclick="openPaper(' + id + ',' + p.id + ')">';
      h += '<div class="li-ic" style="background:rgba(0,212,255,.12);color:#00D4FF"><i class="fa-solid fa-file-pdf"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(p.original_name || p.filename) + '</div>';
      h += '<div class="li-mt"><span class="badge ' + (mdlen ? 'bdg-g' : 'bdg-m') + '">' + (mdlen ? '已解析 ' + mdlen + ' 字符' : '待解析') + '</span>';
      h += ' <span style="color:var(--text-muted)">' + (p.created_at || '') + '</span></div></div>';
      h += '<span style="font-size:16px;color:var(--text-muted);opacity:.3"><i class="fa-solid fa-chevron-right"></i></span></div>';
    }
    h += '</div>';
  } else {
    h += '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-inbox" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无论文，上传后自动解析为 Markdown</p></div>';
  }
  document.getElementById('ctnEl').innerHTML = h;
  // drag & drop
  setupDomainDrag(id);
}

function setupDomainDrag(id) {
  var z = document.getElementById('dz' + id);
  if (!z) return;
  z.addEventListener('dragover', function(e){e.preventDefault();z.classList.add('drag');});
  z.addEventListener('dragleave', function(){z.classList.remove('drag');});
  z.addEventListener('drop', function(e){e.preventDefault();z.classList.remove('drag');if(e.dataTransfer.files.length)domainUpload(id, e.dataTransfer.files);});
}

/* ===== 视图三：论文详情 ===== */
function openPaper(domainId, paperId) {
  kbMode = 'paper'; kbActiveDomain = domainId; kbActivePaper = paperId;
  loadPaperView(paperId);
}

async function loadPaperView(paperId) {
  var p = null;
  try { p = await api('GET', '/kb/paper/' + paperId); } catch(e) {}
  if (!p) { document.getElementById('ctnEl').innerHTML = '<div class="err-box">论文加载失败</div>'; return; }

  var h = '<div class="flex-b mb16"><button class="btn" onclick="openDomain(' + (kbActiveDomain || 0) + ')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回领域</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(p.original_name || p.filename) + '</span>';
  h += '<button class="btn" onclick="reparsePaper(' + paperId + ')" style="padding:4px 10px;font-size:10px"><i class="fa-solid fa-rotate"></i> 重新解析</button></div>';

  var md = p.markdown_content || '';
  if (md) {
    // Obsidian 风格：文件树（侧边） + Markdown 预览（主区）
    h += '<div style="display:flex;gap:16px;align-items:flex-start">';
    h += '<div class="card" style="width:200px;flex-shrink:0;padding:12px;font-size:11px;color:var(--text-muted)"><div class="card-t" style="margin-bottom:8px;font-size:12px"><i class="fa-solid fa-info-circle"></i> 文档信息</div>';
    h += '<div style="line-height:1.9">';
    if (p.size_bytes) h += '<div><span style="color:var(--text-muted)">大小</span><br><span style="color:var(--text);font-family:Space Grotesk">' + (p.size_bytes / 1024).toFixed(1) + ' KB</span></div>';
    h += '<div><span style="color:var(--text-muted)">类型</span><br><span style="color:var(--text)">' + (p.ext || '') + '</span></div>';
    h += '<div><span style="color:var(--text-muted)">解析长度</span><br><span style="color:var(--text);font-family:Space Grotesk">' + md.length + ' 字符</span></div>';
    if (p.status) h += '<div><span style="color:var(--text-muted)">状态</span><br><span class="badge bdg-g">' + p.status + '</span></div>';
    h += '</div></div>';
    h += '<div class="card" style="flex:1;padding:0;overflow:hidden"><div style="padding:12px 18px;border-bottom:1px solid var(--border);font-size:12px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:8px"><i class="fa-regular fa-file-lines"></i> Markdown 预览</div>';
    h += '<div id="paperMdView" style="padding:18px 22px;font-size:13px;line-height:1.8;color:#c0c5d4;max-height:60vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent"></div></div></div>';
  } else {
    h += '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-file-circle-question" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无 Markdown 内容，点击「重新解析」</p></div>';
  }
  document.getElementById('ctnEl').innerHTML = h;
  if (md) {
    // 渲染 Markdown：显示 [[wiki链接]] 为高亮标签
    var html = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    html = html.replace(/\[\[([^\]]+)\]\]/g, '<span style="background:rgba(192,132,252,.15);color:#C084FC;padding:1px 6px;border-radius:4px;font-size:12px;margin:0 2px">$1</span>');
    html = html.replace(/\n/g, '<br>');
    document.getElementById('paperMdView').innerHTML = html;
  }
}

/* ===== 交互函数 ===== */
function showNewDomainForm() { document.getElementById('newDomainForm').style.display = ''; }
function hideNewDomainForm() { document.getElementById('newDomainForm').style.display = 'none'; }

async function createDomain() {
  var name = document.getElementById('ndName').value.trim();
  if (!name) { toast('请输入领域名称', 'fa-exclamation-circle', '#F5A623'); return; }
  var desc = document.getElementById('ndDesc').value.trim();
  try {
    await api('POST', '/kb/domain', {name: name, description: desc});
    toast('创建成功', 'fa-check-circle', '#00E5A0');
    go('kb');
  } catch(e) {
    toast('创建失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
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

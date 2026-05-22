/* ===== Core: Globals, Auth, API, Nav, Routing ===== */
var API = '/api/v1';
var authToken = null;
var authUser = null;
var __AUTH_REQUIRED = false;
var __PIPELINE_REQUIRES_LOGIN = false;
var cur = 'home', pI = null;
var cache = { papers:[], entries:[], keywords:[], problems:[], ideas:[], algos:[] };
var P_GUEST = [
  { id: 'home', name: '首页', icon: 'fa-house', color: '#3b6df0', step: 0, desc: 'AI 驱动科研创新' },
  { id: 'doc', name: '需求与API文档', icon: 'fa-book', color: '#64748b', step: 0, desc: '规范与接口定义' }
];
var P_FULL = [
  { id: 'home', name: '首页', icon: 'fa-house', color: '#3b6df0', step: 0, desc: 'AI 驱动科研创新' },
  { id: 'kb', name: '文献知识库', icon: 'fa-book-open', color: '#3b6df0', step: 1, desc: '自动收集、管理与构建专属领域知识库' },
  { id: 'lit', name: '文献深度理解', icon: 'fa-magnifying-glass-chart', color: '#10b981', step: 2, desc: '深度解读文献内容，提炼关键信息与知识点' },
  { id: 'discover', name: '研究动机发现', icon: 'fa-lightbulb', color: '#f59e0b', step: 3, desc: '挖掘研究空白与趋势，发现有价值的研究方向' },
  { id: 'idea', name: '科学假说', icon: 'fa-flask', color: '#8b5cf6', step: 4, desc: '基于知识与数据，智能生成创新的科学假说' },
  { id: 'algo', name: '实验设计与执行', icon: 'fa-flask-vial', color: '#ef4444', step: 5, desc: '智能设计实验方案，辅助实验执行与记录' },
  { id: 'param', name: '结果分析与优化', icon: 'fa-chart-line', color: '#06b6d4', step: 6, desc: '分析实验结果，优化研究方法，提升科研效率' },
  { id: 'dashboard', name: '科技价值分析', icon: 'fa-chart-pie', color: '#f97316', step: 7, desc: '多维度评估科技价值，支撑决策与成果转化' },
  { id: 'chat', name: '论文辅助写作', icon: 'fa-file-pen', color: '#6366f1', step: 8, desc: '从内容构思到语言润色，全面辅助论文写作' },
  { id: 'obs', name: '科研绘图', icon: 'fa-chart-diagram', color: '#ec4899', step: 9, desc: '智能生成高质量科研图表，提升表达效果' },
  { id: 'profile', name: '个人配置', icon: 'fa-user-cog', color: '#64748b', step: 0, desc: 'API 密钥与偏好', navBreak: '账户' },
  { id: 'admin', name: '用户管理', icon: 'fa-user-gear', color: '#8b5cf6', step: 0, desc: '管理用户和权限', adminOnly: true },
  { id: 'doc', name: 'API 文档', icon: 'fa-book', color: '#64748b', step: 0, desc: '规范与接口定义' }
];

function loadToken() { authToken = localStorage.getItem('arp_token'); }
function saveToken(t) {
  authToken = t;
  if (t) localStorage.setItem('arp_token', t);
  else localStorage.removeItem('arp_token');
}

function navPages() {
  if (authUser) {
    var isAdmin = authUser.role === 'admin';
    return P_FULL.filter(function(p) { return !p.adminOnly || isAdmin; });
  }
  return P_GUEST;
}

/* ===== Utilities ===== */
function toast(m,i,c){i=i||'fa-check-circle';c=c||'';var t=document.createElement('div');t.className='tst';t.innerHTML='<i class="fa-solid '+i+'"'+(c?' style="color:'+c+'"':'')+'></i>'+m;document.getElementById('tbox').appendChild(t);setTimeout(function(){if(t.parentNode)t.remove()},3000)}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function cc(cat){return{'深度学习':'#00E5A0','表征学习':'#A78BFA','图学习':'#F5A623','生成模型':'#FF6B81','强化学习':'#00D4FF','多模态':'#34D399','NLP':'#F9A8D4'}[cat]||'#7d849a'}

/* ===== API ===== */
async function api(method, path, body) {
  var opts = { method: method, headers: {'Content-Type':'application/json'} };
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  if (body) opts.body = JSON.stringify(body);
  var resp = await fetch(API + path, opts);
  if (!resp.ok) {
    var err = await resp.json().catch(function(){ return {detail: resp.statusText}; });
    var det = err.detail;
    if (typeof det === 'object' && det !== null && det.length) det = det.map(function(d){ return d.msg || d; }).join('; ');
    throw new Error(det || '请求失败');
  }
  return resp.json();
}

async function apiUpload(files) {
  var fd = new FormData();
  for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
  var headers = {};
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  var resp = await fetch(API + '/kb/upload', { method:'POST', body: fd, headers: headers });
  if (!resp.ok) throw new Error('上传失败');
  return resp.json();
}

function pollTask(taskId, urlTpl, steps, barId, onDone) {
  var idx = 0;
  var iv = setInterval(async function() {
    try {
      var data = await api('GET', urlTpl.replace('{task_id}', taskId));
      var target = Math.min(Math.floor(data.progress / 25), steps.length - 1);
      while (idx <= target && idx < steps.length) {
        var el = document.getElementById(steps[idx]);
        if (el) {
          if (data.status === 'completed') el.className = 'p-step dn';
          else if (idx === target) {
            el.className = 'p-step rn';
            if (idx > 0) { var prev = document.getElementById(steps[idx-1]); if (prev) prev.className = 'p-step dn'; }
          }
        }
        idx++;
      }
      if (data.status === 'completed') {
        clearInterval(iv);
        for (var s = 0; s < steps.length; s++) { var el = document.getElementById(steps[s]); if (el) el.className = 'p-step dn'; }
        var bar = document.getElementById(barId); if (bar) bar.classList.remove('on');
        onDone(data.result);
      } else if (data.status === 'error') {
        clearInterval(iv);
        var bar = document.getElementById(barId); if (bar) bar.classList.remove('on');
        toast(data.error || '任务失败', 'fa-exclamation-circle', '#FF6B81');
      }
    } catch(e) { clearInterval(iv); toast('轮询异常: '+e.message, 'fa-exclamation-circle', '#FF6B81'); }
  }, 1200);
  return iv;
}

/* ===== Data Loading ===== */
async function loadPapers() {
  try {
    var data = await api('GET', '/kb/entries');
    cache.entries = data.entries || [];
    var srcMap = {};
    cache.entries.forEach(function(e){ if(e.source) srcMap[e.source]=true; });
    cache.papers = Object.keys(srcMap).map(function(s){ return {name:s, ok:true}; });
  } catch(e) { cache.entries=[]; cache.papers=[]; }
}

async function loadKeywords() {
  try {
    var data = await api('GET', '/kb/keywords?limit=200');
    cache.keywords = (data.keywords || []).map(function(k){ return {word:k.word, weight:k.weight, cat:k.category}; });
  } catch(e) { cache.keywords=[]; }
}

async function loadProblems(analysisId, domainId) {
  try {
    var url = '/lit/problems';
    var parts = [];
    if (analysisId) parts.push('analysis_id=' + encodeURIComponent(analysisId));
    if (domainId != null) parts.push('domain_id=' + domainId);
    if (parts.length) url += '?' + parts.join('&');
    var data = await api('GET', url);
    cache.problems = (data.problems || []).map(function(p){
      return { id:p.id, title:p.title, desc:p.description, src:p.source, srcType:p.source_type,
               cat:p.category, sv:p.severity, ok:!!p.validated, ing:!!p.validating, vs:p.validation_score, vm:p.validation_method };
    });
  } catch(e) { cache.problems=[]; }
}

async function loadIdeas() {
  try {
    var data = await api('GET', '/idea/list?min_score=0');
    cache.ideas = (data.ideas || []).map(function(i){
      return { id:i.id, title:i.title, desc:i.description, fp:i.from_problem, nv:i.novelty, fb:i.feasibility, im:i.impact, os:i.overall_score,
               domainId:i.domain_id, domainName:i.domain_name, problemIds:i.problem_ids };
    });
  } catch(e) { cache.ideas=[]; }
}

async function loadAlgos() {
  try {
    var data = await api('GET', '/algo/list');
    cache.algos = (data.algorithms || []).map(function(a){
      return { id:a.id, name:a.name, code:a.code, lang:a.language, fi:a.from_idea,
               ok:!!a.tested, ing:!!a.testing, tp:a.test_passed, tt:a.test_total, pb:a.perf_before_ms, pa:a.perf_after_ms };
    });
  } catch(e) { /* keep existing */ }
}

/* ===== Navigation ===== */
function buildNav(){
  var sideEl = document.getElementById('sideEl');
  if (!sideEl) return;
  if (!authUser) {
    sideEl.style.display = 'none';
    return;
  }
  sideEl.style.display = '';
  var items = navPages();
  var h='<div class="sb-head"><div class="sb-logo"><i class="fa-solid fa-hexagon-nodes"></i></div><div><div class="sb-name">天研</div><div class="sb-sub">AI for Science</div></div></div><div class="sb-nav">';
  for(var i=0;i<items.length;i++){
    var p=items[i], act=cur===p.id;
    if (p.navBreak) h+='<div class="sb-div"></div><div class="sb-sec">'+p.navBreak+'</div>';
    h+='<button class="sb-btn'+(act?' on':'')+'" onclick="go(\''+p.id+'\')">';
    h+='<span class="sb-ico"><i class="fa-solid '+p.icon+'"></i></span>';
    h+='<span class="sb-lb">'+p.name+'<small>'+p.desc+'</small></span>';
    if(p.step) h+='<span class="sb-sn" style="'+(act?'background:var(--accent);color:#fff':'')+'">'+p.step+'</span>';
    h+='</button>';
  }
  h+='</div><div class="sb-ft">';
  h+='<span class="sb-dot"></span>';
  if (authUser && authUser.username) {
    h+='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(authUser.username)+'">'+esc(authUser.username)+'</span>';
    h+='<button type="button" class="btn bp" style="padding:4px 10px;font-size:11px;flex-shrink:0" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i></button>';
  } else {
    h+='<span style="flex:1">天津大学</span>';
    h+='<button type="button" class="btn bp" style="padding:4px 10px;font-size:11px;flex-shrink:0" onclick="openAccountPanel()"><i class="fa-solid fa-user"></i></button>';
  }
  h+='</div>';
  document.getElementById('sideEl').innerHTML=h;
}

function navFindItem(items, id) {
  for (var j = 0; j < items.length; j++) if (items[j].id === id) return items[j];
  return null;
}

function buildTop(){
  var topEl = document.getElementById('topEl');
  if (!topEl) return;
  if (!authUser) {
    topEl.style.display = 'none';
    return;
  }
  topEl.style.display = '';
  var items = navPages();
  var p = navFindItem(items, cur) || items[0];
  var h='<div class="top-l"><span class="top-ico" style="background:'+p.color+'12;color:'+p.color+'"><i class="fa-solid '+p.icon+'"></i></span><span class="top-ti">'+p.name+'</span></div>';
  h+='<div class="top-r">';
  h+='<button type="button" class="notif-btn" title="消息通知"><i class="fa-regular fa-bell"></i></button>';
  h+='<span style="font-size:12px;color:var(--text-muted);font-weight:500;display:flex;align-items:center;gap:6px"><i class="fa-solid fa-building-columns" style="color:var(--text-light)"></i> 天津大学</span>';
  h+='</div>';
  document.getElementById('topEl').innerHTML=h;
}

async function go(id){
  if(pI){clearInterval(pI);pI=null}
  if(typeof heroTimer !== 'undefined'){clearInterval(heroTimer);heroTimer=undefined}
  // 清理离开页面的轮询 interval
  if(cur === 'lit' && typeof litRunningTaskIds !== 'undefined') {
    for (var k in litRunningTaskIds) {
      if (litRunningTaskIds[k] && litRunningTaskIds[k].intervalId) clearInterval(litRunningTaskIds[k].intervalId);
    }
    litRunningTaskIds = {};
  }
  if(cur === 'algo' && typeof algoRunningTaskIds !== 'undefined') {
    for (var k in algoRunningTaskIds) {
      if (algoRunningTaskIds[k] && algoRunningTaskIds[k].intervalId) clearInterval(algoRunningTaskIds[k].intervalId);
    }
    algoRunningTaskIds = {};
  }
  if(cur === 'dashboard' && typeof stopDashboardPoll === 'function') {
    stopDashboardPoll();
  }
  var np = navPages();
  if (!np.some(function(x){ return x.id === id; })) id = np[0].id;
  cur = id;
  buildNav(); buildTop();
  await buildContent();
}

var pages = {};

async function buildContent(){
  var fn = pages[cur];
  if(fn){
    try {
      document.getElementById('ctnEl').innerHTML = await fn();
    } catch(e) {
      document.getElementById('ctnEl').innerHTML = '<div style="text-align:center;padding:60px;color:#FF6B81"><i class="fa-solid fa-plug-circle-xmark" style="font-size:40px;display:block;margin-bottom:12px"></i><p>无法连接后端服务</p><p style="font-size:11px;color:#464d65;margin-top:4px">请确保 Python 后端已启动: python main.py</p></div>';
    }
  }
  if(cur==='kb') setTimeout(setupDrag, 60);
  if(cur==='obs') setTimeout(function(){ loadObsTree(''); loadObsStats(); }, 100);
  if(cur==='profile') setTimeout(function(){ loadProfilePage(); }, 50);
  if(cur==='admin') setTimeout(function(){ loadAdminPage(); }, 50);
  if(cur==='dashboard') { isFirstLoad = true; setTimeout(function(){ loadDashboard(); startDashboardPoll(); }, 50); }
  if(cur==='home' && !authUser) { heroTimer = setInterval(function() { if(typeof heroJumpTo === 'function') heroJumpTo((heroIdx + 1) % heroImgs.length); }, 4000); }
}

/* ===== Auth ===== */
function showAuthErr(msg) {
  var el = document.getElementById('authErr');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.innerHTML = msg ? '<i class="fa-solid fa-circle-exclamation"></i> ' + esc(msg) : '';
}

function showAuthTab(which) {
  showAuthErr('');
  var L = document.getElementById('tabLogin'), R = document.getElementById('tabReg');
  var fL = document.getElementById('formLogin'), fR = document.getElementById('formReg');
  if (!L || !R || !fL || !fR) return;
  if (which === 'login') {
    L.className = 'auth-tab on'; R.className = 'auth-tab';
    fL.className = 'auth-form on'; fR.className = 'auth-form';
  } else {
    R.className = 'auth-tab on'; L.className = 'auth-tab';
    fR.className = 'auth-form on'; fL.className = 'auth-form';
  }
}

function onAuthBgClick(ev) {
  var shell = document.getElementById('authShell');
  if (shell && shell.classList.contains('optional') && ev.target && ev.target.id === 'authBg') closeOptionalAuth();
}

function openAccountPanel() {
  var shell = document.getElementById('authShell');
  if (!shell) return;
  shell.classList.add('on', 'optional');
  shell.style.pointerEvents = 'auto';
  showAuthTab('login');
}

function closeOptionalAuth() {
  var shell = document.getElementById('authShell');
  if (!shell || !shell.classList.contains('optional')) return;
  shell.classList.remove('on', 'optional');
  shell.style.pointerEvents = 'none';
  showAuthErr('');
}

function enterApp() {
  var shell = document.getElementById('authShell');
  if (shell) {
    shell.classList.remove('on', 'optional');
    shell.style.pointerEvents = 'none';
  }
  var app = document.getElementById('appMain');
  if (app) app.style.display = 'flex';
  if (authUser) {
    if (!navPages().some(function(x) { return x.id === cur; })) cur = 'dashboard';
  } else {
    if (!navPages().some(function(x) { return x.id === cur; })) cur = 'home';
  }
  buildNav();
  buildTop();
  go(cur || (authUser ? 'kb' : 'home'));
}

async function submitLogin() {
  var u = document.getElementById('loginUser').value.trim();
  var p = document.getElementById('loginPass').value;
  if (!u || !p) { showAuthErr('请填写用户名和密码'); return; }
  showAuthErr('');
  try {
    var data = await api('POST', '/auth/login', { username: u, password: p });
    saveToken(data.access_token);
    authUser = data.user || null;
    document.getElementById('loginPass').value = '';
    if (authUser) {
      try { var s = await api('GET', '/user/settings'); applyTheme(s.theme_color); } catch(e) {}
    }
    if (__AUTH_REQUIRED) enterApp();
    else {
      closeOptionalAuth();
      cur = 'dashboard';
      enterApp();
      toast('登录成功', 'fa-check-circle', '#00E5A0');
    }
  } catch (e) {
    showAuthErr(e.message || '登录失败');
  }
}

async function submitRegister() {
  var u = document.getElementById('regUser').value.trim();
  var p = document.getElementById('regPass').value;
  var p2 = document.getElementById('regPass2').value;
  var ic = document.getElementById('regInviteCode').value.trim();
  if (!u || !p) { showAuthErr('请填写用户名和密码'); return; }
  if (!ic) { showAuthErr('请输入邀请码'); return; }
  if (p !== p2) { showAuthErr('两次输入的密码不一致'); return; }
  if (p.length < 8) { showAuthErr('密码至少 8 位'); return; }
  showAuthErr('');
  try {
    var data = await api('POST', '/auth/register', { username: u, password: p, invite_code: ic });
    saveToken(data.access_token);
    authUser = data.user || null;
    document.getElementById('regPass').value = '';
    document.getElementById('regPass2').value = '';
    document.getElementById('regInviteCode').value = '';
    if (authUser) {
      try { var s = await api('GET', '/user/settings'); applyTheme(s.theme_color); } catch(e) {}
    }
    if (__AUTH_REQUIRED) enterApp();
    else {
      closeOptionalAuth();
      cur = 'dashboard';
      enterApp();
      toast('注册并登录成功', 'fa-check-circle', '#00E5A0');
    }
  } catch (e) {
    showAuthErr(e.message || '注册失败');
  }
}

async function doLogout() {
  try { await api('POST', '/auth/logout', {}); } catch (e) {}
  saveToken(null);
  authUser = null;
  if (__AUTH_REQUIRED) {
    var shell = document.getElementById('authShell');
    if (shell) {
      shell.classList.add('on');
      shell.style.pointerEvents = 'auto';
    }
    var app = document.getElementById('appMain');
    if (app) app.style.display = 'none';
    showAuthTab('login');
  } else {
    cur = 'home';
    buildNav();
    buildTop();
    await go('home');
  }
  toast('已退出登录', 'fa-right-from-bracket', '#7d849a');
}

async function fetchWithTimeout(url, opts, ms) {
  ms = ms || 12000;
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var id = setTimeout(function() {
    if (ctrl) try { ctrl.abort(); } catch (e) {}
  }, ms);
  try {
    var opt = ctrl ? Object.assign({}, opts || {}, { signal: ctrl.signal }) : (opts || {});
    return await fetch(url, opt);
  } finally {
    clearTimeout(id);
  }
}

async function bootstrap() {
  loadToken();
  var cfg = { auth_required: false, pipeline_requires_login: false };
  try {
    var rc = await fetchWithTimeout(API + '/auth/config', {}, 12000);
    if (rc.ok) cfg = await rc.json();
  } catch (e) {}
  __AUTH_REQUIRED = !!cfg.auth_required;
  __PIPELINE_REQUIRES_LOGIN = !!cfg.pipeline_requires_login;

  if (__AUTH_REQUIRED) {
    var shell = document.getElementById('authShell');
    var app = document.getElementById('appMain');
    if (app) app.style.display = 'none';
    if (shell) {
      shell.classList.add('on');
      shell.classList.remove('optional');
      shell.style.pointerEvents = 'auto';
    }
    if (authToken) {
      try {
        var me = await api('GET', '/auth/me');
        authUser = me.user || null;
        if (authUser) {
          try {
            var s = await api('GET', '/user/settings');
            applyTheme(s.theme_color);
          } catch(e) {}
        }
        enterApp();
        return;
      } catch (e) {
        saveToken(null);
        authUser = null;
      }
    }
    showAuthTab('login');
    return;
  }

  if (authToken) {
    try {
      var me2 = await api('GET', '/auth/me');
      authUser = me2.user || null;
      if (authUser) {
        try {
          var settings = await api('GET', '/user/settings');
          applyTheme(settings.theme_color);
        } catch(e) { /* ignore */ }
      }
    } catch (e) {
      saveToken(null);
      authUser = null;
    }
  }
  enterApp();
}

/* ===== Theme System ===== */
// Two themes: light (亮色) and dark (暗色)
var THEMES = {
  light: { name:'亮色', accent:'#3b6df0', rgb:'59,109,240' },
  dark:  { name:'暗色', accent:'#4b7df0', rgb:'75,125,240' }
};

function applyTheme(name) {
  var theme = THEMES[name];
  if (!theme) { name = 'light'; theme = THEMES.light; }
  var style = document.getElementById('theme-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'theme-style';
    document.head.appendChild(style);
  }
  // Inject accent overrides
  style.textContent = ':root{'
    + '--accent:' + theme.accent + ';'
    + '--accent-rgb:' + theme.rgb + ';'
    + '--accent-gradient:linear-gradient(135deg,' + theme.accent + ',' + theme.accent + ');'
    + '--accent-light:' + 'rgba(' + theme.rgb + ',.1);'
    + '--accent-glow:rgba(' + theme.rgb + ',.12);'
    + '--accent-glow-hover:rgba(' + theme.rgb + ',.22);'
    + '--accent-subtle:rgba(' + theme.rgb + ',.06);'
    + '}';
  // Toggle dark theme CSS class
  var root = document.documentElement;
  if (name === 'dark') {
    root.classList.add('dark-theme');
  } else {
    root.classList.remove('dark-theme');
  }
}

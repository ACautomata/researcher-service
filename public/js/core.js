/* ===== Core: Globals, Auth, API, Nav, Routing ===== */
var API = '/api/v1';
var authToken = null;
var authUser = null;
var __AUTH_REQUIRED = false;
var __PIPELINE_REQUIRES_LOGIN = false;
var cur = 'home', pI = null;
var cache = { papers:[], entries:[], keywords:[], problems:[], ideas:[], algos:[] };
var P_GUEST = [
  { id: 'home', name: '欢迎', icon: 'fa-house', color: '#00E5A0', step: 0, desc: '登录后解锁完整流水线' },
  { id: 'doc', name: '需求与API文档', icon: 'fa-book', color: '#7d849a', step: 0, desc: '规范与接口定义' }
];
var P_FULL = [
  { id: 'dashboard', name: '任务状态', icon: 'fa-chart-line', color: '#00E5A0', step: 0, desc: '任务状态与资源监控', navBreak: '步骤' },
  { id: 'kb', name: '知识库构建与更新', icon: 'fa-database', color: '#00E5A0', step: 0, desc: '上传文献，解析关键字' },
  { id: 'lit', name: '文献问题发现与验证', icon: 'fa-magnifying-glass-chart', color: '#F5A623', step: 0, desc: '分析验证文献问题' },
  { id: 'idea', name: 'Idea生成与验证分析', icon: 'fa-lightbulb', color: '#A78BFA', step: 0, desc: '生成评价研究创意' },
  { id: 'algo', name: '算法自动实现', icon: 'fa-code', color: '#FF6B81', step: 0, desc: '代码浏览与编辑' },
  { id: 'param', name: '参数优化', icon: 'fa-sliders', color: '#F5A623', step: 0, desc: '参数组对比与曲线' },
  { id: 'agent', name: 'Agent 终端控制台', icon: 'fa-terminal', color: '#00D4FF', step: 0, desc: 'Claude Agent 交互', navBreak: '工具与扩展' },
  { id: 'obs', name: 'Obsidian Vault', icon: 'fa-note-sticky', color: '#C084FC', step: 0, desc: '笔记浏览·编辑·图谱' },
  { id: 'profile', name: '个人配置', icon: 'fa-sliders', color: '#34D399', step: 0, desc: 'API 密钥与模型', navBreak: '账户' },
  { id: 'doc', name: '需求与API文档', icon: 'fa-book', color: '#7d849a', step: 0, desc: '规范与接口定义' }
];

function loadToken() { authToken = localStorage.getItem('arp_token'); }
function saveToken(t) {
  authToken = t;
  if (t) localStorage.setItem('arp_token', t);
  else localStorage.removeItem('arp_token');
}

function navPages() {
  if (authUser) return P_FULL;
  return P_GUEST;
}

/* ===== Utilities ===== */
function toast(m,i,c){i=i||'fa-check-circle';c=c||'#00E5A0';var t=document.createElement('div');t.className='tst';t.innerHTML='<i class="fa-solid '+i+'" style="color:'+c+'"></i>'+m;document.getElementById('tbox').appendChild(t);setTimeout(function(){if(t.parentNode)t.remove()},3000)}
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

async function loadProblems() {
  try {
    var data = await api('GET', '/lit/problems');
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
      return { id:i.id, title:i.title, desc:i.description, fp:i.from_problem, nv:i.novelty, fb:i.feasibility, im:i.impact, os:i.overall_score };
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
  var items = navPages();
  var secTitle = authUser ? '步骤' : '入门';
  var h='<div class="sb-head"><div class="sb-logo"><i class="fa-solid fa-brain"></i></div><div><div class="sb-name">AI Pipeline</div><div class="sb-sub">Research Automation</div></div></div><div class="sb-nav"><div class="sb-sec">'+secTitle+'</div>';
  for(var i=0;i<items.length;i++){
    var p=items[i], act=cur===p.id;
    if (p.navBreak) h+='<div class="sb-div"></div><div class="sb-sec">'+p.navBreak+'</div>';
    h+='<button class="sb-btn'+(act?' on':'')+'" onclick="go(\''+p.id+'\')">';
    h+='<span class="sb-ico" style="background:'+(act?p.color+'20':'rgba(255,255,255,.03)')+';color:'+(act?'var(--text-inverse)':p.color)+'"><i class="fa-solid '+p.icon+'"></i></span>';
    h+='<span class="sb-lb">'+p.name+'<small>'+p.desc+'</small></span>';
    if(p.step) h+='<span class="sb-sn" style="'+(act?'background:'+p.color+';color:var(--text-inverse)':'')+'">'+p.step+'</span>';
    h+='</button>';
  }
  h+='</div><div class="sb-ft" style="gap:8px">';
  h+='<span class="sb-dot"></span>';
  if (authUser && authUser.username) {
    h+='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px" title="'+esc(authUser.username)+'">'+esc(authUser.username)+'</span>';
    h+='<button type="button" class="btn" style="padding:4px 10px;font-size:10px;flex-shrink:0" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i></button>';
  } else if (!__AUTH_REQUIRED) {
    h+='<span style="flex:1;font-size:10px">v1.0</span>';
    h+='<button type="button" class="btn bp" style="padding:4px 10px;font-size:10px;flex-shrink:0" onclick="openAccountPanel()"><i class="fa-solid fa-user"></i> 账户</button>';
  } else {
    h+='<span style="font-size:10px">v1.0 · API 已连接</span>';
  }
  h+='</div>';
  document.getElementById('sideEl').innerHTML=h;
}

function navFindItem(items, id) {
  for (var j = 0; j < items.length; j++) if (items[j].id === id) return items[j];
  return null;
}

function buildTop(){
  var items = navPages();
  var p = navFindItem(items, cur) || items[0];
  var h='<div class="top-l"><span class="top-ico" style="background:'+p.color+'18;color:'+p.color+'"><i class="fa-solid '+p.icon+'"></i></span><span class="top-ti">'+p.name+'</span></div><div class="top-fl">';
  var sp = (authUser ? P_FULL : []).filter(function(x){ return x.step > 0; });
  for(var i=0;i<sp.length;i++){h+='<span class="fd'+(cur===sp[i].id?' on':'')+'" style="background:'+sp[i].color+';color:'+sp[i].color+'"></span>';if(i<sp.length-1)h+='<span class="fl"></span>';}
  h+='</div>';
  document.getElementById('topEl').innerHTML=h;
}

async function go(id){
  if(pI){clearInterval(pI);pI=null}
  if(typeof stopDashboardPoll === 'function') stopDashboardPoll();
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
  if(cur==='dashboard') setTimeout(function(){ loadDashboard(); startDashboardPoll(); }, 50);
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
    if (!navPages().some(function(x) { return x.id === cur; })) cur = 'kb';
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
      cur = 'kb';
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
  if (!u || !p) { showAuthErr('请填写用户名和密码'); return; }
  if (p !== p2) { showAuthErr('两次输入的密码不一致'); return; }
  if (p.length < 8) { showAuthErr('密码至少 8 位'); return; }
  showAuthErr('');
  try {
    var data = await api('POST', '/auth/register', { username: u, password: p });
    saveToken(data.access_token);
    authUser = data.user || null;
    document.getElementById('regPass').value = '';
    document.getElementById('regPass2').value = '';
    if (authUser) {
      try { var s = await api('GET', '/user/settings'); applyTheme(s.theme_color); } catch(e) {}
    }
    if (__AUTH_REQUIRED) enterApp();
    else {
      closeOptionalAuth();
      cur = 'kb';
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

/* ===== Theme ===== */
/* ===== Theme System ===== */
// 8 套预设主题：每套定义 accent（强调色）、rgb（RGB 逗号值）、
// mode（dark/light）、bg/bgRgb/bgAlt（背景色）、glow1/glow2（环境光晕）
var THEMES = {
  aurora:  { name:'极光蓝', mode:'light', accent:'#3B82F6', rgb:'59,130,246', bg:'#f0f4ff', bgRgb:'240,244,255', bgAlt:'#e4ebfa', glow1:'#3B82F6', glow2:'#60A5FA' },
  emerald: { name:'翡翠绿', mode:'dark', accent:'#00E5A0', rgb:'0,229,160', bg:'#05070d', bgRgb:'5,7,13', bgAlt:'#0a0e17', glow1:'#00E5A0', glow2:'#A78BFA' },
  flame:   { name:'烈焰橙', mode:'dark', accent:'#F97316', rgb:'249,115,22', bg:'#0d0805', bgRgb:'13,8,5', bgAlt:'#140c07', glow1:'#F97316', glow2:'#DC2626' },
  nebula:  { name:'星云紫', mode:'dark', accent:'#A78BFA', rgb:'167,139,250', bg:'#0a0510', bgRgb:'10,5,16', bgAlt:'#10081a', glow1:'#A78BFA', glow2:'#EC4899' },
  ocean:   { name:'海洋青', mode:'light', accent:'#0891B2', rgb:'8,145,178', bg:'#eef9ff', bgRgb:'238,249,255', bgAlt:'#e0f2fe', glow1:'#0891B2', glow2:'#06B6D4' },
  mint:    { name:'薄荷绿', mode:'light', accent:'#059669', rgb:'5,150,105', bg:'#ecfdf5', bgRgb:'236,253,245', bgAlt:'#d1fae5', glow1:'#059669', glow2:'#34D399' },
  sunset:  { name:'落日金', mode:'dark', accent:'#F59E0B', rgb:'245,158,11', bg:'#0f0a04', bgRgb:'15,10,4', bgAlt:'#170e06', glow1:'#F59E0B', glow2:'#F97316' },
  sakura:  { name:'樱花粉', mode:'light', accent:'#DB2777', rgb:'219,39,119', bg:'#fef2f4', bgRgb:'254,242,244', bgAlt:'#fce7ed', glow1:'#DB2777', glow2:'#F472B6' }
};

/* 注入 :root CSS 变量覆盖默认主题 */
function applyTheme(name) {
  var theme = THEMES[name];
  if (!theme) { name = 'aurora'; theme = THEMES.aurora; }
  var dark = theme.mode !== 'light';
  var text = dark ? '#c9d1d9' : '#1f2937';
  var textMuted = dark ? '#484f6e' : '#6b7280';
  var textBold = dark ? '#e6edf3' : '#111827';
  var border = dark ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.08)';
  var borderLight = dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.04)';
  var borderHover = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.12)';
  var style = document.getElementById('theme-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'theme-style';
    document.head.appendChild(style);
  }
  style.textContent = ':root{--bg:' + theme.bg
    + ';--bg-rgb:' + theme.bgRgb
    + ';--bg-alt:' + theme.bgAlt
    + ';--bg-card:linear-gradient(180deg,rgba(' + theme.bgRgb + ',.95),rgba(' + theme.bgRgb + ',.9))'
    + ';--bg-surface:rgba(' + theme.bgRgb + ',.5)'
    + ';--text:' + text
    + ';--text-bold:' + textBold
    + ';--text-muted:' + textMuted
    + ';--text-inverse:' + (dark ? '#f0f4ff' : '#05070d')
    + ';--border:' + border
    + ';--border-light:' + borderLight
    + ';--border-hover:' + borderHover
    + ';--accent:' + theme.accent
    + ';--accent-rgb:' + theme.rgb
    + ';--accent2:' + theme.accent
    + ';--accent-glow:rgba(' + theme.rgb + ',.12)'
    + ';--accent-glow-hover:rgba(' + theme.rgb + ',.22)'
    + ';--accent-subtle:rgba(' + theme.rgb + ',.06)'
    + ';--accent-gradient:linear-gradient(135deg,' + theme.accent + ',' + theme.accent + ')'
    + ';--glow-1:' + theme.glow1
    + ';--glow-2:' + theme.glow2 + '}';
}

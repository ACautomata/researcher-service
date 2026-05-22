/* ===== API Documentation Page ===== */
var API_SECTIONS = [
  {
    label: '知识库', icon: 'fa-book-open', color: '#00E5A0', apis: [
      { m: 'POST', p: '/api/v1/kb/upload', d: '上传文献（多文件）' },
      { m: 'POST', p: '/api/v1/kb/parse', d: '触发 AI 解析' },
      { m: 'GET',  p: '/api/v1/kb/parse/{task_id}/progress', d: '解析任务进度' },
      { m: 'GET',  p: '/api/v1/kb/entries', d: '知识条目列表（分页/过滤）' },
      { m: 'DELETE', p: '/api/v1/kb/entries', d: '删除指定条目' },
      { m: 'GET',  p: '/api/v1/kb/keywords', d: '关键词池（带权重）' },
      { m: 'POST', p: '/api/v1/kb/clear-all', d: '清空全部数据' },
      { m: 'POST', p: '/api/v1/kb/domain', d: '创建研究领域' },
      { m: 'GET',  p: '/api/v1/kb/domains', d: '领域列表（含论文数）' },
      { m: 'DELETE', p: '/api/v1/kb/domain/{domain_id}', d: '删除领域' },
      { m: 'PUT',  p: '/api/v1/kb/domain/{domain_id}', d: '更新领域名称/描述' },
      { m: 'POST', p: '/api/v1/kb/domain/{domain_id}/upload', d: '上传到指定领域' },
      { m: 'GET',  p: '/api/v1/kb/domain/{domain_id}/papers', d: '领域内论文列表' },
      { m: 'GET',  p: '/api/v1/kb/paper/{paper_id}', d: '论文详情' },
      { m: 'PUT',  p: '/api/v1/kb/paper/{paper_id}', d: '保存论文编辑（Markdown）' },
      { m: 'POST', p: '/api/v1/kb/paper/{paper_id}/reparse', d: '重新解析论文' },
      { m: 'DELETE', p: '/api/v1/kb/paper/{paper_id}', d: '删除论文及关联数据' },
    ]
  },
  {
    label: '文献分析', icon: 'fa-magnifying-glass-chart', color: '#F5A623', apis: [
      { m: 'POST', p: '/api/v1/lit/auto-discover', d: 'AI 启动问题发现' },
      { m: 'GET',  p: '/api/v1/lit/auto-discover/{task_id}/progress', d: '发现任务进度' },
      { m: 'POST', p: '/api/v1/lit/validate', d: 'AI 启动问题验证' },
      { m: 'GET',  p: '/api/v1/lit/validate/{task_id}/progress', d: '验证任务进度' },
      { m: 'GET',  p: '/api/v1/lit/problems', d: '已发现问题列表（过滤）' },
      { m: 'GET',  p: '/api/v1/lit/search-external', d: '外部检索 arXiv / Semantic Scholar' },
      { m: 'GET',  p: '/api/v1/lit/history', d: '分析历史列表' },
      { m: 'POST', p: '/api/v1/lit/history', d: '创建分析记录' },
      { m: 'PUT',  p: '/api/v1/lit/history/{aid}', d: '更新分析记录' },
      { m: 'DELETE', p: '/api/v1/lit/history/{aid}', d: '删除分析记录' },
    ]
  },
  {
    label: '科学假说', icon: 'fa-flask', color: '#A78BFA', apis: [
      { m: 'POST', p: '/api/v1/idea/generate', d: 'AI 生成研究假说（基于问题）' },
      { m: 'GET',  p: '/api/v1/idea/generate/{task_id}/progress', d: '生成任务进度' },
      { m: 'GET',  p: '/api/v1/idea/list', d: '假说列表（评分/过滤）' },
      { m: 'DELETE', p: '/api/v1/idea/{iid}', d: '删除指定假说' },
    ]
  },
  {
    label: '算法工程', icon: 'fa-flask-vial', color: '#FF6B81', apis: [
      { m: 'POST', p: '/api/v1/algo/generate', d: 'AI 生成算法（基于假说）' },
      { m: 'GET',  p: '/api/v1/algo/generate/{task_id}/progress', d: '生成任务进度' },
      { m: 'POST', p: '/api/v1/algo/generate-from-desc', d: '描述直转代码' },
      { m: 'POST', p: '/api/v1/algo/suggest-params', d: '超参数优化建议' },
      { m: 'GET',  p: '/api/v1/algo/list', d: '算法列表' },
      { m: 'GET',  p: '/api/v1/algo/history', d: '算法分析历史' },
      { m: 'POST', p: '/api/v1/algo/history', d: '创建算法分析记录' },
      { m: 'PUT',  p: '/api/v1/algo/history/{aid}', d: '更新算法分析记录' },
      { m: 'DELETE', p: '/api/v1/algo/history/{aid}', d: '删除算法分析记录' },
      { m: 'POST', p: '/api/v1/algo/test/{algo_id}', d: '运行算法测试' },
      { m: 'GET',  p: '/api/v1/algo/test/{task_id}/progress', d: '测试任务进度' },
      { m: 'POST', p: '/api/v1/algo/optimize/{algo_id}', d: '算法性能优化' },
    ]
  },
  {
    label: '参数优化', icon: 'fa-chart-line', color: '#06B6D4', apis: [
      { m: 'GET',  p: '/api/v1/param/list', d: '参数优化任务列表' },
      { m: 'POST', p: '/api/v1/param/save', d: '保存/更新参数任务' },
      { m: 'DELETE', p: '/api/v1/param/{pid}', d: '删除参数任务' },
    ]
  },
  {
    label: 'Agent', icon: 'fa-robot', color: '#3B82F6', apis: [
      { m: 'POST', p: '/api/v1/agent/chat', d: '启动 Agent 会话（SSE）' },
      { m: 'GET',  p: '/api/v1/agent/chat/{task_id}/stream', d: 'SSE 流式输出' },
      { m: 'GET',  p: '/api/v1/agent/sessions', d: '活跃会话列表' },
    ]
  },
  {
    label: 'AI 对话', icon: 'fa-comment-dots', color: '#F97316', apis: [
      { m: 'POST', p: '/api/v1/chat/send', d: '非流式对话' },
      { m: 'POST', p: '/api/v1/chat/stream', d: 'SSE 流式对话' },
    ]
  },
  {
    label: 'Obsidian', icon: 'fa-diagram-project', color: '#EC4899', apis: [
      { m: 'GET',  p: '/api/v1/obsidian/vault-path', d: '获取 Vault 路径' },
      { m: 'GET',  p: '/api/v1/obsidian/tree', d: 'Vault 目录树' },
      { m: 'GET',  p: '/api/v1/obsidian/file', d: '读取文件内容' },
      { m: 'POST', p: '/api/v1/obsidian/file', d: '写入/保存文件' },
      { m: 'GET',  p: '/api/v1/obsidian/graph', d: '知识图谱扫描' },
      { m: 'GET',  p: '/api/v1/obsidian/search', d: '全文搜索笔记' },
      { m: 'GET',  p: '/api/v1/obsidian/tags', d: '标签列表' },
    ]
  },
  {
    label: '认证 & 用户', icon: 'fa-lock', color: '#10B981', apis: [
      { m: 'GET',  p: '/api/v1/auth/config', d: '认证配置开关' },
      { m: 'POST', p: '/api/v1/auth/register', d: '用户注册（邀请码）' },
      { m: 'POST', p: '/api/v1/auth/login', d: '用户登录' },
      { m: 'GET',  p: '/api/v1/auth/me', d: '当前用户信息' },
      { m: 'POST', p: '/api/v1/auth/logout', d: '用户登出' },
      { m: 'GET',  p: '/api/v1/auth/settings', d: '获取个人 API 配置' },
      { m: 'PUT',  p: '/api/v1/auth/settings', d: '更新个人 API 配置' },
      { m: 'PUT',  p: '/api/v1/auth/password', d: '修改密码' },
      { m: 'GET',  p: '/api/v1/user/settings', d: '获取用户设置' },
      { m: 'PUT',  p: '/api/v1/user/settings', d: '更新用户设置' },
    ]
  },
  {
    label: '管理后台', icon: 'fa-user-gear', color: '#8B5CF6', admin: true, apis: [
      { m: 'GET',    p: '/api/v1/auth/admin/users', d: '用户列表' },
      { m: 'PUT',    p: '/api/v1/auth/admin/users/{uid}/password', d: '重置用户密码' },
      { m: 'PUT',    p: '/api/v1/auth/admin/users/{uid}/role', d: '修改用户角色' },
      { m: 'DELETE', p: '/api/v1/auth/admin/users/{uid}', d: '删除用户' },
      { m: 'GET',    p: '/api/v1/auth/admin/invite-codes', d: '邀请码列表' },
      { m: 'POST',   p: '/api/v1/auth/admin/invite-codes', d: '生成邀请码' },
      { m: 'PUT',    p: '/api/v1/auth/admin/invite-codes/{cid}/toggle', d: '启用/禁用邀请码' },
      { m: 'DELETE', p: '/api/v1/auth/admin/invite-codes/{cid}', d: '删除邀请码' },
    ]
  },
  {
    label: 'Dashboard', icon: 'fa-chart-pie', color: '#34D399', apis: [
      { m: 'GET', p: '/api/v1/dashboard/tasks', d: '任务列表' },
      { m: 'GET', p: '/api/v1/dashboard/stats', d: '系统状态（CPU/内存/磁盘/GPU）' },
      { m: 'GET', p: '/api/v1/dashboard/usage', d: '用量统计' },
    ]
  }
];

var METHOD_COLORS = {
  GET:    '#10b981',
  POST:   '#3b6df0',
  PUT:    '#f59e0b',
  DELETE: '#ef4444'
};

pages.doc = function(){
  var h = '';

  // ── Header ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">API 参考</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="完整的后端 API 接口文档，共 ' + countAll() + ' 个端点"></i></div>';
  h += '<span style="font-size:11px;color:var(--text-muted)"><i class="fa-regular fa-file-lines"></i> ' + countAll() + ' 个端点 · ' + API_SECTIONS.length + ' 个模块</span>';
  h += '</div>';

  // ── API 说明 ──
  h += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;font-size:11px;color:var(--text-muted)">';
  h += '<span><span class="api-t" style="background:#10b98118;color:#10b981">GET</span> 查询</span>';
  h += '<span><span class="api-t" style="background:#3b6df018;color:#3b6df0">POST</span> 创建/触发</span>';
  h += '<span><span class="api-t" style="background:#f59e0b18;color:#f59e0b">PUT</span> 更新</span>';
  h += '<span><span class="api-t" style="background:#ef444418;color:#ef4444">DELETE</span> 删除</span>';
  h += '<span style="color:var(--text-light)">|</span>';
  h += '<span><i class="fa-regular fa-clock"></i> 异步任务路径含 <code>{task_id}</code>，轮询 <code>progress</code> 端点</span>';
  h += '<span><i class="fa-solid fa-bolt"></i> SSE 流式端点 <code>stream</code></span>';
  h += '</div>';

  // ── Module Sections ──
  for (var s = 0; s < API_SECTIONS.length; s++) {
    var sec = API_SECTIONS[s];
    h += '<div class="card mb12">';
    // Header
    h += '<div class="card-t" style="border-bottom:none;padding-bottom:0;margin-bottom:6px">';
    h += '<i class="fa-solid ' + sec.icon + '" style="color:' + sec.color + '"></i>' + sec.label;
    h += '<span class="api-t api-g" style="margin-left:auto;font-size:10px">' + sec.apis.length + ' 个端点</span>';
    if (sec.admin) {
      h += '<span class="api-t" style="background:#8b5cf618;color:#8b5cf6;margin-left:4px;font-size:10px">管理员</span>';
    }
    h += '</div>';
    // API list
    h += '<div style="font-size:12px">';
    for (var a = 0; a < sec.apis.length; a++) {
      var api = sec.apis[a];
      var mc = METHOD_COLORS[api.m] || '#64748b';
      h += '<div class="api-row">';
      h += '<span class="api-t" style="background:' + mc + '18;color:' + mc + ';font-weight:700;min-width:52px;text-align:center">' + api.m + '</span>';
      h += '<code style="flex:1;color:var(--text);font-size:11px">' + api.p + '</code>';
      h += '<span style="color:var(--text-muted);font-size:11px;white-space:nowrap">' + api.d + '</span>';
      h += '</div>';
    }
    h += '</div></div>';
  }

  // ── Database Schema ──
  h += '<div class="card mt16"><div class="card-t"><i class="fa-solid fa-database"></i>数据库结构 <span style="font-size:9px;color:#464d65;font-weight:400;margin-left:4px">· SQLite (aiosqlite)</span></div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:10px">';

  var tables = [
    { g:'核心流水线', t:['papers','keywords','entries','problems','ideas','algorithms','tasks','domains','lit_analyses'], c:'#00E5A0' },
    { g:'认证（可选）', t:['users','sessions','user_settings'], c:'#F5A623' },
    { g:'工具集成', t:['uploads/ 目录','vault/ (Obsidian)','pipeline.db'], c:'#A78BFA' },
  ];
  for (var i = 0; i < tables.length; i++) {
    h += '<div style="padding:8px;border-radius:8px;border:1px solid ' + tables[i].c + '20;background:' + tables[i].c + '08">';
    h += '<div style="font-weight:600;font-size:10px;color:' + tables[i].c + ';margin-bottom:4px">' + tables[i].g + '</div>';
    for (var j = 0; j < tables[i].t.length; j++) {
      h += '<div style="color:#7d849a;padding:1px 0"><i class="fa-regular fa-circle" style="font-size:5px;color:' + tables[i].c + ';margin-right:4px;vertical-align:middle"></i>' + tables[i].t[j] + '</div>';
    }
    h += '</div>';
  }
  h += '</div></div>';

  return h;
};

function countAll() {
  var n = 0;
  for (var i = 0; i < API_SECTIONS.length; i++) n += API_SECTIONS[i].apis.length;
  return n;
}

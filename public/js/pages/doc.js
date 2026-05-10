/* ===== API Documentation Page ===== */
pages.doc = function(){
  var h='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-diagram-project"></i>系统数据流</div>';
  h+='<div style="display:flex;align-items:center;justify-content:center;gap:0;padding:20px 0;flex-wrap:wrap">';
  var ns=[{n:'知识库',s:'上传·解析·领域',c:'#00E5A0'},{n:'问题发现',s:'AI发现·验证·搜索',c:'#F5A623'},{n:'Idea生成',s:'AI创意·评分排序',c:'#A78BFA'},{n:'算法实现',s:'代码·测试·优化',c:'#FF6B81'},{n:'参数优化',s:'超参建议',c:'#F97316'}];
  for(var i=0;i<ns.length;i++){
    h+='<div style="text-align:center;padding:16px 22px;border-radius:12px;border:2px solid '+ns[i].c+'30;background:'+ns[i].c+'0a;min-width:90px"><div style="font-size:11px;font-weight:700;color:'+ns[i].c+'">'+ns[i].n+'</div><div style="font-size:10px;color:#464d65;margin-top:2px">'+ns[i].s+'</div></div>';
    if(i<ns.length-1) h+='<div style="display:flex;flex-direction:column;align-items:center;width:48px;padding:0 4px"><div style="font-size:9px;color:#464d65;margin-bottom:2px">产出</div><i class="fa-solid fa-arrow-right" style="font-size:12px;color:#464d65"></i></div>';
  }
  h+='</div></div>';

  // 需求文档 + API 文档
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">';

  // ===== 左侧：需求文档 =====
  h+='<div class="card"><div class="card-t"><i class="fa-solid fa-clipboard-list"></i>功能全景</div>';
  var reqs=[
    {t:'知识库 (KB)', items:['多格式上传：PDF/DOCX/TXT/MD/TeX','AI 自动解析提取关键字与条目','领域（Domain）分组管理','Obsidian 风格论文浏览/编辑/图谱','Markdown 导出与保存','重新解析与全文检索']},
    {t:'文献分析 (Lit)', items:['AI 自动发现问题（3种深度）','交叉分析：双知识库对比','问题验证与评分（AI）','外部文献搜索：arXiv/Semantic Scholar','分析历史持久化存储','批量验证']},
    {t:'Idea 生成', items:['AI 生成研究思路（基于问题）','三维评分：新颖性/可行性/影响力','关键词过滤与方向引导','排序与筛选']},
    {t:'算法工程 (Algo)', items:['AI 生成代码（从 Idea 或描述）','参数优化建议','语法检查（AST）','Mock 测试与性能对比']},
    {t:'对话交互 & 其他', items:['AI 直接对话（流式/非流式）','Obsidian Vault 集成','Dashboard 系统监控','用户认证（可选启用）']}
  ];
  for(var r=0;r<reqs.length;r++){
    h+='<div style="margin-bottom:16px"><div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#c0c5d4">'+reqs[r].t+'</div><ul style="padding-left:16px;font-size:11px;color:#7d849a;line-height:1.7">';
    for(var j=0;j<reqs[r].items.length;j++) h+='<li>'+reqs[r].items[j]+'</li>';
    h+='</ul></div>';
  }
  h+='</div>';

  // ===== 右侧：API 文档 =====
  h+='<div class="card"><div class="card-t"><i class="fa-solid fa-book"></i>API 文档 <span style="font-size:9px;color:#464d65;font-weight:400;margin-left:4px">· /docs</span></div>';
  h+='<div style="max-height:520px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent">';

  // 按模块分组的 API 列表
  var sections = [
    {label:'知识库', color:'#00E5A0', apis:[
      {m:'POST', p:'/api/v1/kb/upload', d:'上传文献'},
      {m:'POST', p:'/api/v1/kb/parse', d:'触发AI解析'},
      {m:'GET',  p:'/api/v1/kb/parse/{tid}/progress', d:'解析进度'},
      {m:'POST', p:'/api/v1/kb/clear-all', d:'清空全部数据'},
      {m:'GET',  p:'/api/v1/kb/entries', d:'条目列表'},
      {m:'DELETE',p:'/api/v1/kb/entries', d:'删除条目'},
      {m:'GET',  p:'/api/v1/kb/keywords', d:'关键字池'},
      {m:'POST', p:'/api/v1/kb/domain', d:'创建知识库'},
      {m:'GET',  p:'/api/v1/kb/domains', d:'知识库列表'},
      {m:'DELETE',p:'/api/v1/kb/domain/{id}', d:'删除知识库'},
      {m:'PUT',  p:'/api/v1/kb/domain/{id}', d:'更新知识库'},
      {m:'POST', p:'/api/v1/kb/domain/{id}/upload', d:'上传到知识库'},
      {m:'GET',  p:'/api/v1/kb/domain/{id}/papers', d:'知识库论文列表'},
      {m:'GET',  p:'/api/v1/kb/paper/{id}', d:'论文详情'},
      {m:'PUT',  p:'/api/v1/kb/paper/{id}', d:'保存论文编辑'},
      {m:'POST', p:'/api/v1/kb/paper/{id}/reparse', d:'重新解析'},
    ]},
    {label:'文献分析', color:'#F5A623', apis:[
      {m:'POST', p:'/api/v1/lit/auto-discover', d:'AI发现问题'},
      {m:'GET',  p:'/api/v1/lit/auto-discover/{tid}/progress', d:'发现进度'},
      {m:'POST', p:'/api/v1/lit/validate', d:'AI验证问题'},
      {m:'GET',  p:'/api/v1/lit/validate/{tid}/progress', d:'验证进度'},
      {m:'GET',  p:'/api/v1/lit/problems', d:'问题列表'},
      {m:'GET',  p:'/api/v1/lit/search-external', d:'外部文献搜索'},
      {m:'GET',  p:'/api/v1/lit/history', d:'分析历史'},
      {m:'POST', p:'/api/v1/lit/history', d:'创建分析记录'},
      {m:'PUT',  p:'/api/v1/lit/history/{id}', d:'更新分析记录'},
    ]},
    {label:'Idea', color:'#A78BFA', apis:[
      {m:'POST', p:'/api/v1/idea/generate', d:'AI生成Idea'},
      {m:'GET',  p:'/api/v1/idea/generate/{tid}/progress', d:'生成进度'},
      {m:'GET',  p:'/api/v1/idea/list', d:'Idea列表'},
    ]},
    {label:'算法', color:'#FF6B81', apis:[
      {m:'POST', p:'/api/v1/algo/generate', d:'AI生成算法'},
      {m:'GET',  p:'/api/v1/algo/generate/{tid}/progress', d:'生成进度'},
      {m:'POST', p:'/api/v1/algo/generate-from-desc', d:'描述转代码'},
      {m:'POST', p:'/api/v1/algo/suggest-params', d:'超参建议'},
      {m:'GET',  p:'/api/v1/algo/list', d:'算法列表'},
      {m:'POST', p:'/api/v1/algo/test/{id}', d:'运行测试'},
      {m:'GET',  p:'/api/v1/algo/test/{tid}/progress', d:'测试进度'},
      {m:'POST', p:'/api/v1/algo/optimize/{id}', d:'优化性能'},
    ]},
    {label:'Agent', color:'#3B82F6', apis:[
      {m:'POST', p:'/api/v1/agent/chat', d:'启动Agent会话'},
      {m:'GET',  p:'/api/v1/agent/chat/{tid}/stream', d:'SSE流式输出'},
      {m:'GET',  p:'/api/v1/agent/sessions', d:'活跃会话列表'},
    ]},
    {label:'对话 & 认证', color:'#F97316', apis:[
      {m:'POST', p:'/api/v1/chat/send', d:'AI对话（非流式）'},
      {m:'POST', p:'/api/v1/chat/stream', d:'AI对话（SSE流式）'},
      {m:'POST', p:'/api/v1/auth/register', d:'注册'},
      {m:'POST', p:'/api/v1/auth/login', d:'登录'},
      {m:'GET',  p:'/api/v1/auth/config', d:'认证配置'},
      {m:'GET',  p:'/api/v1/auth/me', d:'当前用户'},
      {m:'POST', p:'/api/v1/auth/logout', d:'登出'},
      {m:'GET',  p:'/api/v1/auth/settings', d:'个人API配置'},
      {m:'PUT',  p:'/api/v1/auth/settings', d:'更新API配置'},
      {m:'GET',  p:'/api/v1/user/settings', d:'用户设置'},
      {m:'PUT',  p:'/api/v1/user/settings', d:'更新用户设置'},
    ]},
    {label:'Obsidian', color:'#06B6D4', apis:[
      {m:'GET',  p:'/api/v1/obsidian/vault-path', d:'Vault路径'},
      {m:'GET',  p:'/api/v1/obsidian/tree', d:'目录树'},
      {m:'GET',  p:'/api/v1/obsidian/file', d:'读取文件'},
      {m:'POST', p:'/api/v1/obsidian/file', d:'写入文件'},
      {m:'GET',  p:'/api/v1/obsidian/graph', d:'知识图谱'},
      {m:'GET',  p:'/api/v1/obsidian/search', d:'搜索笔记'},
      {m:'GET',  p:'/api/v1/obsidian/tags', d:'标签列表'},
    ]},
    {label:'Dashboard', color:'#34D399', apis:[
      {m:'GET',  p:'/api/v1/dashboard/tasks', d:'任务列表'},
      {m:'GET',  p:'/api/v1/dashboard/stats', d:'系统监控'},
      {m:'GET',  p:'/api/v1/dashboard/usage', d:'用量统计'},
    ]},
  ];

  for(var s=0;s<sections.length;s++){
    var sec=sections[s];
    h+='<div style="margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,.04);padding-bottom:8px">';
    // 标记颜色箭头
    h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">';
    h+='<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+sec.color+'"></span>';
    h+='<span style="font-size:10px;font-weight:600;color:'+sec.color+'">'+sec.label+'</span>';
    h+='<span style="font-size:8px;color:#464d65">('+sec.apis.length+' 个端点)</span></div>';
    for(var a=0;a<sec.apis.length;a++){
      var api=sec.apis[a];
      h+='<div class="api-ep"><div class="api-path"><span class="api-t" style="background:'+sec.color+'18;color:'+sec.color+'">'+api.m+'</span>'+api.p+'</div><div class="api-desc">'+api.d+'</div></div>';
    }
    h+='</div>';
  }

  h+='</div></div></div>';

  // 底部数据库说明
  h+='<div class="card mt24"><div class="card-t"><i class="fa-solid fa-database"></i>数据库结构 <span style="font-size:9px;color:#464d65;font-weight:400;margin-left:4px">· SQLite (aiosqlite)</span></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:10px">';

  var tables=[
    {g:'核心流水线', t:['papers','keywords','entries','problems','ideas','algorithms','tasks','domains','lit_analyses'], c:'#00E5A0'},
    {g:'认证 (可选)', t:['users','sessions','user_settings'], c:'#F5A623'},
    {g:'工具集成', t:['uploads/ 目录','vault/ (Obsidian)','pipeline.db'], c:'#A78BFA'},
  ];
  for(var i=0;i<tables.length;i++){
    h+='<div style="padding:8px;border-radius:8px;border:1px solid '+tables[i].c+'20;background:'+tables[i].c+'08">';
    h+='<div style="font-weight:600;font-size:10px;color:'+tables[i].c+';margin-bottom:4px">'+tables[i].g+'</div>';
    for(var j=0;j<tables[i].t.length;j++) h+='<div style="color:#7d849a;padding:1px 0"><i class="fa-regular fa-circle" style="font-size:5px;color:'+tables[i].c+';margin-right:4px;vertical-align:middle"></i>'+tables[i].t[j]+'</div>';
    h+='</div>';
  }
  h+='</div></div>';

  return h;
};

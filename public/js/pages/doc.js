/* ===== API Documentation Page ===== */
pages.doc = function(){
  var h='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-diagram-project"></i>系统数据流</div>';
  h+='<div style="display:flex;align-items:center;justify-content:center;gap:0;padding:20px 0;flex-wrap:wrap">';
  var ns=[{n:'页面1',s:'知识库',c:'#00E5A0'},{n:'页面2',s:'问题发现',c:'#F5A623'},{n:'页面3',s:'Idea生成',c:'#A78BFA'},{n:'页面4',s:'算法实现',c:'#FF6B81'}];
  for(var i=0;i<ns.length;i++){
    h+='<div style="text-align:center;padding:16px 22px;border-radius:12px;border:2px solid '+ns[i].c+'30;background:'+ns[i].c+'0a;min-width:90px"><div style="font-size:11px;font-weight:700;color:'+ns[i].c+'">'+ns[i].n+'</div><div style="font-size:10px;color:#464d65;margin-top:2px">'+ns[i].s+'</div></div>';
    if(i<ns.length-1) h+='<div style="display:flex;flex-direction:column;align-items:center;width:48px;padding:0 4px"><div style="font-size:9px;color:#464d65;margin-bottom:2px">产出</div><i class="fa-solid fa-arrow-right" style="font-size:12px;color:#464d65"></i></div>';
  }
  h+='</div></div>';
  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">';
  h+='<div class="card"><div class="card-t"><i class="fa-solid fa-clipboard-list"></i>需求文档</div>';
  var reqs=[{t:'页面1：知识库构建',items:['上传文献','AI 自动解析提取关键字','生成结构化条目']},{t:'页面2：问题发现',items:['AI 自动发现问题','搜索 arXiv / S2','AI 验证问题']},{t:'页面3：Idea 生成',items:['AI 生成研究思路','多维度评分排序']},{t:'页面4：算法实现',items:['AI 生成代码','语法检查与测试','性能对比']}];
  for(var r=0;r<reqs.length;r++){h+='<div style="margin-bottom:16px"><div style="font-weight:600;font-size:12px;margin-bottom:6px;color:#c0c5d4">'+reqs[r].t+'</div><ul style="padding-left:16px;font-size:11px;color:#7d849a;line-height:1.7">';for(var j=0;j<reqs[r].items.length;j++)h+='<li>'+reqs[r].items[j]+'</li>';h+='</ul></div>';}
  h+='</div>';
  h+='<div class="card"><div class="card-t"><i class="fa-solid fa-book"></i>API 文档 <span style="font-size:9px;color:#464d65;font-weight:400;margin-left:4px">· /docs</span></div><div style="max-height:520px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent">';
  var apis=[{m:'POST',p:'/api/v1/kb/upload',d:'上传文献',c:'#F5A623'},{m:'POST',p:'/api/v1/kb/parse',d:'触发AI解析',c:'#F5A623'},{m:'GET',p:'/api/v1/kb/parse/:id/progress',d:'解析进度',c:'#00E5A0'},{m:'GET',p:'/api/v1/kb/entries',d:'知识条目',c:'#00E5A0'},{m:'GET',p:'/api/v1/kb/keywords',d:'关键字池',c:'#00E5A0'},{m:'POST',p:'/api/v1/lit/auto-discover',d:'AI发现问题',c:'#F5A623'},{m:'GET',p:'/api/v1/lit/search-external',d:'外部搜索',c:'#00E5A0'},{m:'POST',p:'/api/v1/lit/validate',d:'AI验证问题',c:'#F5A623'},{m:'GET',p:'/api/v1/lit/problems',d:'问题列表',c:'#00E5A0'},{m:'POST',p:'/api/v1/idea/generate',d:'AI生成Idea',c:'#F5A623'},{m:'GET',p:'/api/v1/idea/list',d:'Idea列表',c:'#00E5A0'},{m:'POST',p:'/api/v1/algo/generate',d:'AI生成算法',c:'#F5A623'},{m:'GET',p:'/api/v1/algo/list',d:'算法列表',c:'#00E5A0'},{m:'POST',p:'/api/v1/algo/test/:id',d:'运行测试',c:'#F5A623'},{m:'POST',p:'/api/v1/algo/optimize/:id',d:'优化性能',c:'#F5A623'}];
  for(var a=0;a<apis.length;a++){h+='<div class="api-ep"><div class="api-path"><span class="api-t" style="background:'+apis[a].c+'18;color:'+apis[a].c+'">'+apis[a].m+'</span>'+apis[a].p+'</div><div class="api-desc">'+apis[a].d+'</div></div>';}
  h+='</div></div></div>';
  return h;
};

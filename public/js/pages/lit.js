/* ===== Literature Page ===== */
pages.lit = async function(){
  await Promise.all([loadPapers(), loadKeywords(), loadProblems()]);
  var c='#F5A623';
  var hiP=cache.problems.filter(function(p){return p.sv==='high'}).length;
  var okP=cache.problems.filter(function(p){return p.ok}).length;
  var cs={};cache.entries.forEach(function(e){if(e.category)cs[e.category]=1});
  var cKeys=Object.keys(cs);

  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.entries.length+'</div><div class="st-l">可分析文档</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.problems.length+'</div><div class="st-l">已发现问题</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#FF6B81">'+hiP+'</div><div class="st-l">高优先级</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#00E5A0">'+okP+'</div><div class="st-l">已验证</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-database"></i>AI 自动发现问题 <span class="src-t src-k" style="margin-left:6px"><i class="fa-solid fa-arrow-left" style="font-size:7px"></i>来自页面1</span><span class="api-t api-p" style="margin-left:auto">POST /lit/auto-discover</span></div>';
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
  h+='<div style="flex:1;min-width:170px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">分析范围</label><select class="inp" id="dsc"><option value="all">全部 ('+cache.entries.length+')</option>';
  cKeys.forEach(function(k){h+='<option value="'+k+'">'+k+'</option>';});
  h+='</select></div>';
  h+='<div style="flex:1;min-width:170px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">分析深度</label><select class="inp" id="dsd"><option value="quick">快速扫描</option><option value="deep" selected>深度分析</option><option value="cross">交叉引用</option></select></div>';
  h+='<div style="align-self:flex-end"><button class="btn bp" onclick="autoDisc()"'+(cache.entries.length>0?'':' disabled')+'><i class="fa-solid fa-magnifying-glass-chart"></i>AI 发现</button></div></div>';
  if(cache.entries.length===0) h+='<div class="err-box"><i class="fa-solid fa-triangle-exclamation"></i>知识库为空，请先在页面1上传文献</div>';
  h+='<div class="pbar" id="dpb"><div class="pb-t" style="color:#F5A623"><i class="fa-solid fa-gear fa-spin"></i>AI 分析中…</div>';
  h+='<div class="p-step wt" id="ds1"><span class="pc"></span>扫描关键字与条目结构</div>';
  h+='<div class="p-step wt" id="ds2"><span class="pc"></span>提取方法论述与结论断言</div>';
  h+='<div class="p-step wt" id="ds3"><span class="pc"></span>识别局限性、矛盾与空白</div>';
  h+='<div class="p-step wt" id="ds4"><span class="pc"></span>问题定级与分类</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-globe"></i>外部文献搜集 <span class="api-t api-g" style="margin-left:auto">GET /lit/search-external</span></div>';
  var dk='';cache.keywords.slice(0,3).forEach(function(k,i){dk+=(i?' ':'')+k.word;});
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
  h+='<div style="flex:1;min-width:200px"><input class="inp" id="extk" placeholder="输入关键词搜索外部文献…" value="'+dk+'"></div>';
  h+='<select class="inp" style="width:auto;min-width:130px" id="exts"><option value="arxiv">arXiv</option><option value="semantic_scholar">Semantic Scholar</option></select>';
  h+='<button class="btn bw" onclick="searchExt()"><i class="fa-solid fa-search"></i>搜索</button></div>';
  h+='<div id="extr"></div></div>';

  var pendCnt=cache.problems.filter(function(p){return !p.ok&&!p.ing}).length;
  h+='<div class="flex-b mb12"><span style="font-size:13px;font-weight:700">已发现问题</span>';
  h+='<button class="btn bp" style="padding:5px 12px;font-size:10px" onclick="batchV()"'+(pendCnt>0?'':' disabled')+'><i class="fa-solid fa-check-double"></i>批量 AI 验证</button></div>';

  if(cache.problems.length>0){
    cache.problems.forEach(function(p){
      var svb=p.sv==='high'?'bdg-r':'bdg-y', svl=p.sv==='high'?'高':'中';
      var stb=p.ok?'bdg-g':p.ing?'bdg-y':'bdg-m', stl=p.ok?'已验证':p.ing?'验证中':'待验证';
      h+='<div class="prob-card"><div class="flex-b mb8"><span style="font-weight:600;font-size:13px">'+p.title+'</span><div style="display:flex;gap:4px"><span class="badge '+svb+'">'+svl+'</span><span class="badge '+stb+'">'+stl+'</span></div></div>';
      h+='<div style="font-size:12px;color:#7d849a;margin-bottom:6px">'+esc(p.desc)+'</div>';
      h+='<div style="display:flex;gap:8px;font-size:10px;color:#464d65;align-items:center;flex-wrap:wrap">';
      var srcCls=p.srcType==='kb'?'src-k':'src-e', srcLb=p.srcType==='kb'?'知识库':'外部';
      h+='<span class="src-t '+srcCls+'">'+srcLb+'</span><span>分类：'+p.cat+'</span>';
      if(p.vs!=null&&p.vs!==undefined) h+='<span style="color:#00E5A0;font-weight:600;font-family:Space Grotesk,sans-serif">'+p.vs+'/10</span>';
      h+='</div>';
      if(!p.ok&&!p.ing) h+='<button class="btn" style="padding:3px 10px;font-size:10px;margin-top:8px" onclick="val1(\''+p.id+'\')"><i class="fa-solid fa-flask"></i>AI 验证</button>';
      h+='</div>';
    });
  } else {
    h+='<div class="card" style="text-align:center;padding:40px;color:#464d65"><i class="fa-solid fa-magnifying-glass" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂未发现问题</p></div>';
  }
  return h;
};

async function autoDisc(){
  toast('AI 分析中…','fa-magnifying-glass-chart','#F5A623');
  try{
    var res=await api('POST','/lit/auto-discover',{deep_analysis:document.getElementById('dsd').value});
    var pb=document.getElementById('dpb');if(pb)pb.classList.add('on');
    pollTask(res.task_id,'/lit/auto-discover/{task_id}/progress',['ds1','ds2','ds3','ds4'],'dpb',function(result){
      if(result) toast('发现 '+result.problems_count+' 个问题','fa-check-circle','#F5A623');
      go('lit');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

async function searchExt(){
  var kw=document.getElementById('extk');if(!kw||!kw.value)return;
  var el=document.getElementById('extr');
  el.innerHTML='<div style="text-align:center;padding:16px;color:#464d65"><i class="fa-solid fa-spinner fa-spin"></i></div>';
  try{
    var data=await api('GET','/lit/search-external?keyword='+encodeURIComponent(kw.value)+'&source='+document.getElementById('exts').value);
    var r=data.results||[], h='<div style="font-size:10px;color:#464d65;margin-bottom:8px">找到 '+r.length+' 篇</div>';
    r.forEach(function(item){h+='<div class="li-item"><div class="li-ic" style="background:rgba(0,212,255,.12);color:#00D4FF"><i class="fa-solid fa-globe"></i></div><div style="flex:1;min-width:0"><div class="li-nm">'+item.title+'</div><div class="li-mt"><span>'+(item.authors||[]).slice(0,3).join(', ')+' · '+(item.year||'')+'</span></div></div></div>';});
    if(!r.length) h+='<div style="text-align:center;padding:16px;color:#464d65">未找到结果</div>';
    el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="err-box"><i class="fa-solid fa-triangle-exclamation"></i>'+e.message+'</div>'}
}

async function val1(id){
  toast('AI 验证中…','fa-flask','#F5A623');
  try{
    var res=await api('POST','/lit/validate',{problem_ids:[id],method:'cross_reference'});
    pollTask(res.task_id,'/lit/validate/{task_id}/progress',[],'none',function(result){
      go('lit');toast('验证完成','fa-check-circle','#00E5A0');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

async function batchV(){
  var pending=cache.problems.filter(function(p){return !p.ok&&!p.ing});
  if(!pending.length)return;
  toast('批量验证中 ('+pending.length+')…','fa-check-double','#F5A623');
  try{
    var ids=pending.map(function(p){return p.id});
    var res=await api('POST','/lit/validate',{problem_ids:ids,method:'cross_reference'});
    pollTask(res.task_id,'/lit/validate/{task_id}/progress',[],'none',function(result){
      go('lit');toast('批量验证完成','fa-check-circle','#00E5A0');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

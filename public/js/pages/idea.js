/* ===== Idea Page ===== */
var ideaDomains = [];
pages.idea = async function(){
  await loadIdeas();

  // 加载知识库列表
  ideaDomains = [];
  try { var d = await api('GET', '/kb/domains'); ideaDomains = d.domains || []; } catch(e) {}

  var c='#A78BFA';
  var hiI=cache.ideas.filter(function(ii){return ii.os>=7}).length;

  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'" id="ideaOkCount">--</div><div class="st-l">可分析问题</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.ideas.length+'</div><div class="st-l">已生成Idea</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#00E5A0">'+hiI+'</div><div class="st-l">高分Idea</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-lightbulb"></i>AI 生成研究 Idea <span class="api-t api-p" style="margin-left:auto">POST /idea/generate</span></div>';
  if(ideaDomains.length===0){
    h+='<div class="err-box"><i class="fa-solid fa-triangle-exclamation"></i>暂无知识库，请先在知识库页面创建知识库并完成问题发现与验证</div>';
  } else {
    h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">知识库</label><select class="inp" id="ideaDomain" onchange="onIdeaDomainChange()" style="font-size:12px"><option value="">-- 选择知识库 --</option>';
    ideaDomains.forEach(function(d){ h+='<option value="'+d.id+'">'+esc(d.name)+' ('+(d.paper_count||0)+' 篇)</option>'; });
    h+='</select></div>';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">基于问题</label><select class="inp" id="idp" style="font-size:12px"><option value="">请先选择知识库</option></select></div>';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">创新方向</label><input class="inp" id="idd" placeholder="如：探索高效的序列建模方法"></div>';
    h+='<div style="align-self:flex-end"><button class="btn bp" onclick="genIdeas()"><i class="fa-solid fa-wand-magic-sparkles"></i>AI 生成</button></div></div>';
  }
  h+='</div>';

  if(cache.ideas.length>0){
    var sorted=cache.ideas.slice().sort(function(a,b){return b.os-a.os});
    h+='<div class="flex-b mb12"><span style="font-size:13px;font-weight:700">Idea 评价与排序</span><span class="api-t api-g">GET /idea/list</span></div>';
    sorted.forEach(function(idea, idx){
      var sc=idea.os>=7?'#00E5A0':idea.os>=5?'#F5A623':'#FF6B81';
      h+='<div class="idea-card"><div class="flex-b mb8"><div style="display:flex;align-items:center;gap:8px">';
      h+='<span style="width:26px;height:26px;border-radius:7px;background:'+(idx===0?'#A78BFA':'rgba(255,255,255,.05)')+';display:grid;place-items:center;font-family:Space Grotesk,sans-serif;font-weight:700;font-size:12px;color:'+(idx===0?'#fff':'#464d65')+'">'+(idx+1)+'</span>';
      h+='<span style="font-weight:600;font-size:13px">'+idea.title+'</span></div>';
      h+='<span style="font-family:Space Grotesk,sans-serif;font-weight:700;font-size:18px;color:'+sc+'">'+idea.os.toFixed(1)+'</span></div>';
      h+='<div style="font-size:12px;color:#7d849a;margin-bottom:8px">'+esc(idea.desc)+'</div>';
      h+='<div style="font-size:10px;color:#464d65;margin-bottom:10px">来源问题：'+esc(idea.fp)+'</div>';
      var dims=[['创新性',idea.nv,'#A78BFA'],['可行性',idea.fb,'#F5A623'],['影响力',idea.im,'#00E5A0'],['综合',idea.os,sc]];
      h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px">';
      dims.forEach(function(d){h+='<div class="score-row"><span class="sl">'+d[0]+'</span><div class="sbar"><div class="sf" style="width:'+d[1]*10+'%;background:'+d[2]+'"></div></div><span class="sn" style="color:'+d[2]+'">'+d[1].toFixed(1)+'</span></div>';});
      h+='</div></div>';
    });
  } else {
    h+='<div class="card" style="text-align:center;padding:40px;color:#464d65"><i class="fa-solid fa-lightbulb" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i></div>';
  }
  return h;
};

async function onIdeaDomainChange(){
  var sel = document.getElementById('ideaDomain');
  var probSel = document.getElementById('idp');
  var okCount = document.getElementById('ideaOkCount');
  if(!sel || !probSel) return;
  var domainId = sel.value;
  if(!domainId) {
    probSel.innerHTML = '<option value="">请先选择知识库</option>';
    if(okCount) okCount.textContent = '--';
    return;
  }
  probSel.innerHTML = '<option value="">加载中...</option>';
  probSel.disabled = true;
  try {
    await loadProblems(null, parseInt(domainId));
    var okP = cache.problems.filter(function(p){return p.ok});
    if(okCount) okCount.textContent = okP.length;
    probSel.innerHTML = '';
    if(okP.length===0){
      probSel.innerHTML = '<option value="">该知识库暂无可分析问题，请先完成问题发现与验证</option>';
    } else {
      probSel.innerHTML = '<option value="all">全部已验证 ('+okP.length+')</option>';
      okP.forEach(function(p){
        probSel.innerHTML += '<option value="'+p.id+'">'+esc(p.title.slice(0,30))+'</option>';
      });
    }
  } catch(e){
    probSel.innerHTML = '<option value="">加载失败: '+esc(e.message)+'</option>';
  }
  probSel.disabled = false;
}

async function genIdeas(){
  var sel = document.getElementById('idp');
  if(!sel || !sel.value || sel.value==='' || sel.disabled){ toast('请先选择知识库和问题','fa-exclamation-circle','#F5A623'); return; }
  toast('AI 生成中…','fa-wand-magic-sparkles','#A78BFA');
  try{
    var body={direction:document.getElementById('idd')?document.getElementById('idd').value:null};
    if(sel.value!=='all') body.problem_ids=[sel.value];
    var res=await api('POST','/idea/generate',body);
    pollTask(res.task_id,'/idea/generate/{task_id}/progress',[],'none',function(result){
      if(result) toast('生成了 '+result.ideas_count+' 个 Idea','fa-check-circle','#A78BFA');
      go('idea');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

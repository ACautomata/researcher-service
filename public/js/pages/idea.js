/* ===== Idea Page ===== */
var ideaDomains = [];
var ideaEvalFilter = 0; // domain filter, 0=all
var ideaEvalProbFilter = 0; // problem filter, 0=all

pages.idea = async function(){
  await loadIdeas();

  // 加载知识库列表
  ideaDomains = [];
  try { var d = await api('GET', '/kb/domains'); ideaDomains = d.domains || []; } catch(e) {}

  var c='#A78BFA';
  var hiI=cache.ideas.filter(function(ii){return ii.os>=7}).length;

  // ── 统计卡片 ──
  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'" id="ideaOkCount">--</div><div class="st-l">可分析问题</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.ideas.length+'</div><div class="st-l">已生成Idea</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#00E5A0">'+hiI+'</div><div class="st-l">高分Idea</div></div></div>';

  // ══════════════════════════════════════
  // Part 1: 生成新的 Idea（置顶）
  // ══════════════════════════════════════
  h+='<div class="card mb24" id="ideaGenSection"><div class="card-t"><i class="fa-solid fa-lightbulb"></i>生成新的 Idea <span class="api-t api-p" style="margin-left:auto">POST /idea/generate</span></div>';
  if(ideaDomains.length===0){
    h+='<div class="err-box"><i class="fa-solid fa-triangle-exclamation"></i>暂无知识库，请先在知识库页面创建知识库并完成问题发现与验证</div>';
  } else {
    h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">知识库</label><select class="inp" id="ideaDomain" onchange="onIdeaDomainChange()" style="font-size:12px"><option value="">-- 选择知识库 --</option>';
    ideaDomains.forEach(function(d){ h+='<option value="'+d.id+'">'+esc(d.name)+' ('+(d.paper_count||0)+' 篇)</option>'; });
    h+='</select></div>';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">基于问题</label><select class="inp" id="idp" style="font-size:12px"><option value="">请先选择知识库</option></select></div>';
    h+='<div style="flex:1;min-width:180px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">创新方向</label><input class="inp" id="idd" placeholder="如：探索高效的序列建模方法"></div>';
    h+='<div style="align-self:flex-end"><button class="btn bp" id="ideaGenBtn" onclick="genIdeas()"><i class="fa-solid fa-wand-magic-sparkles"></i>AI 生成</button></div></div>';
    // 生成进度条
    h+='<div id="ideaBar" class="pbar" style="margin-top:12px"><div class="pb-t"><i class="fa-solid fa-gear fa-spin"></i>AI 生成中…</div>';
    h+='<div id="ideaStep1" class="p-step wt"><div class="pc"></div><span>分析问题特征</span></div>';
    h+='<div id="ideaStep2" class="p-step wt"><div class="pc"></div><span>AI 生成候选 Idea</span></div>';
    h+='<div id="ideaStep3" class="p-step wt"><div class="pc"></div><span>四维度评分排序</span></div>';
    h+='<div id="ideaStep4" class="p-step wt"><div class="pc"></div><span>保存到数据库</span></div></div>';
  }
  h+='</div>';

  // ══════════════════════════════════════
  // Part 2: 已完成的 Idea 评价展示
  // ══════════════════════════════════════
  if(cache.ideas.length>0){
    // 构建映射
    var domainMap = {};
    ideaDomains.forEach(function(d){ domainMap[d.id] = d.name; });
    var usedDomains = {}, usedProblems = {};
    cache.ideas.forEach(function(i){
      if(i.domainId && domainMap[i.domainId]) usedDomains[i.domainId] = domainMap[i.domainId];
      try {
        var pids = typeof i.problemIds === 'string' ? JSON.parse(i.problemIds) : (i.problemIds || []);
        pids.forEach(function(pid){ usedProblems[pid] = true; });
      } catch(e){}
    });

    // 问题标题映射
    var problemTitleMap = {};
    cache.problems.forEach(function(p){ problemTitleMap[p.id] = p.title || ('问题 #'+p.id); });

    var domainOpts = '<option value="0">全部知识库</option>';
    Object.keys(usedDomains).forEach(function(did){
      var sel = ideaEvalFilter == did ? ' selected' : '';
      domainOpts += '<option value="'+did+'"'+sel+'>'+esc(usedDomains[did])+'</option>';
    });

    h+='<div class="card mb24" id="ideaEvalSection"><div class="card-t"><i class="fa-solid fa-star"></i>已完成的 Idea 评价 <span class="api-t api-g" style="margin-left:auto">GET /idea/list</span></div>';

    // 筛选栏：知识库 + 问题（始终展示）
    var showDomainFilter = ideaDomains.length >= 1;
    var showProblemFilter = Object.keys(usedProblems).length >= 1;
    if(showDomainFilter || showProblemFilter){
      h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">';
      if(showDomainFilter){
        h+='<span style="font-size:10px;color:var(--text-muted);flex-shrink:0">知识库</span>';
        h+='<select class="inp" id="ideaEvalDomain" onchange="onIdeaEvalFilter()" style="font-size:12px;max-width:200px">'+domainOpts+'</select>';
      }
      if(showProblemFilter){
        // 当前 domain 下的可用问题
        var filteredForProblems = cache.ideas;
        if(ideaEvalFilter > 0){
          filteredForProblems = cache.ideas.filter(function(i){return i.domainId == ideaEvalFilter;});
        }
        var curUsedProblems = {};
        filteredForProblems.forEach(function(i){
          try {
            var pids = typeof i.problemIds === 'string' ? JSON.parse(i.problemIds) : (i.problemIds || []);
            pids.forEach(function(pid){ curUsedProblems[pid] = true; });
          } catch(e){}
        });
        var probOpts = '<option value="0">全部问题</option>';
        Object.keys(curUsedProblems).forEach(function(pid){
          var sel = ideaEvalProbFilter == pid ? ' selected' : '';
          var ptitle = problemTitleMap[pid] || ('问题 #'+pid);
          probOpts += '<option value="'+pid+'"'+sel+'>'+esc(ptitle.slice(0,30))+'</option>';
        });
        h+='<span style="font-size:10px;color:var(--text-muted);flex-shrink:0;margin-left:4px">问题</span>';
        h+='<select class="inp" id="ideaEvalProblem" onchange="onIdeaEvalProbFilter()" style="font-size:12px;max-width:240px">'+probOpts+'</select>';
      }
      h+='</div>';
    }

    // 排序 + 过滤
    var sorted = cache.ideas.slice().sort(function(a,b){return b.os-a.os});
    if(ideaEvalFilter>0){
      sorted = sorted.filter(function(i){return i.domainId == ideaEvalFilter;});
    }
    if(ideaEvalProbFilter !== 0 && ideaEvalProbFilter !== '0'){
      sorted = sorted.filter(function(i){
        try {
          var pids = typeof i.problemIds === 'string' ? JSON.parse(i.problemIds) : (i.problemIds || []);
          return pids.indexOf(ideaEvalProbFilter) !== -1 || pids.indexOf(parseInt(ideaEvalProbFilter)) !== -1;
        } catch(e){ return false; }
      });
    }

    sorted.forEach(function(idea, idx){
      var sc=idea.os>=7?'#00E5A0':idea.os>=5?'#F5A623':'#FF6B81';
      var dName = (idea.domainId && domainMap[idea.domainId]) ? domainMap[idea.domainId] : '';
      var fromProbTitle = idea.fp || '';
      try {
        var ipids = typeof idea.problemIds === 'string' ? JSON.parse(idea.problemIds) : (idea.problemIds || []);
        if(ipids.length > 0 && problemTitleMap[ipids[0]]){
          fromProbTitle = problemTitleMap[ipids[0]];
        }
      } catch(e){}

      h+='<div class="idea-card">';
      h+='<div class="flex-b mb8"><div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">';
      h+='<span style="width:26px;height:26px;border-radius:7px;background:'+(idx===0?'#A78BFA':'rgba(255,255,255,.05)')+';display:grid;place-items:center;font-family:Space Grotesk,sans-serif;font-weight:700;font-size:12px;color:'+(idx===0?'#fff':'var(--text-muted)')+';flex-shrink:0">'+(idx+1)+'</span>';
      h+='<span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(idea.title)+'</span></div>';
      h+='<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">';
      h+='<span style="font-family:Space Grotesk,sans-serif;font-weight:700;font-size:18px;color:'+sc+'">'+idea.os.toFixed(1)+'</span>';
      h+='<button class="btn" style="padding:4px 8px;font-size:10px;opacity:.3;border-color:rgba(255,107,129,.15);color:#FF6B81" onclick="event.stopPropagation();deleteIdea(\''+esc(idea.id)+'\',\''+esc(idea.title.replace(/'/g,"\\'"))+'\')" title="删除此 Idea"><i class="fa-solid fa-trash"></i></button>';
      h+='</div></div>';

      h+='<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">';
      if(dName){
        h+='<span style="display:inline-block;padding:2px 10px;border-radius:6px;font-size:10px;font-weight:600;background:rgba(167,139,250,.12);color:#A78BFA">'+esc(dName)+'</span>';
      }
      h+='<span style="font-size:11px;color:var(--text-muted)">来源：'+esc(fromProbTitle)+'</span></div>';

      h+='<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">'+esc(idea.desc)+'</div>';

      var dims=[['创新性',idea.nv,'#A78BFA'],['可行性',idea.fb,'#F5A623'],['影响力',idea.im,'#00E5A0'],['综合',idea.os,sc]];
      h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px">';
      dims.forEach(function(d){h+='<div class="score-row"><span class="sl">'+d[0]+'</span><div class="sbar"><div class="sf" style="width:'+d[1]*10+'%;background:'+d[2]+'"></div></div><span class="sn" style="color:'+d[2]+'">'+d[1].toFixed(1)+'</span></div>';});
      h+='</div></div>';
    });

    if(sorted.length===0){
      h+='<div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px">当前筛选条件下暂无 Idea 记录</div>';
    }
    h+='</div>';
  } else if(ideaDomains.length>0){
    h+='<div class="card" style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-lightbulb" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:12px">暂无已生成的 Idea，请在上方选择知识库和问题后开始生成</p></div>';
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
  if(!sel || !sel.value || sel.value=='' || sel.disabled){ toast('请先选择知识库和问题','fa-exclamation-circle','#F5A623'); return; }

  // 显示进度条，禁用按钮
  var bar = document.getElementById('ideaBar');
  var btn = document.getElementById('ideaGenBtn');
  if(bar) bar.classList.add('on');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-gear fa-spin"></i> 生成中…'; }

  // 重置步骤状态
  ['ideaStep1','ideaStep2','ideaStep3','ideaStep4'].forEach(function(id, i){
    var el = document.getElementById(id);
    if(el) el.className = i===0 ? 'p-step rn' : 'p-step wt';
  });

  try{
    var body={direction:document.getElementById('idd')?document.getElementById('idd').value:null};
    if(sel.value!=='all') body.problem_ids=[sel.value];
    var res=await api('POST','/idea/generate',body);
    var steps = ['ideaStep1','ideaStep2','ideaStep3','ideaStep4'];
    pollTask(res.task_id,'/idea/generate/{task_id}/progress',steps,'ideaBar',function(result){
      if(result) toast('生成了 '+result.ideas_count+' 个 Idea','fa-check-circle','#A78BFA');
      ideaEvalFilter = 0;
      ideaEvalProbFilter = 0;
      if(bar) bar.classList.remove('on');
      go('idea');
    });
  }catch(e){
    if(bar) bar.classList.remove('on');
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成'; }
    toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81');
  }
}

function onIdeaEvalFilter(){
  var sel = document.getElementById('ideaEvalDomain');
  if(!sel) return;
  ideaEvalFilter = parseInt(sel.value) || 0;
  ideaEvalProbFilter = 0; // 切换知识库时重置问题筛选
  go('idea');
}

function onIdeaEvalProbFilter(){
  var sel = document.getElementById('ideaEvalProblem');
  if(!sel) return;
  ideaEvalProbFilter = sel.value === '0' ? 0 : sel.value;
  go('idea');
}

async function deleteIdea(iid, title){
  if(!confirm('确定要删除此 Idea？\n\n'+title)) return;
  try {
    await api('DELETE', '/idea/'+encodeURIComponent(iid));
    toast('Idea 已删除', 'fa-check-circle', '#00E5A0');
    go('idea');
  } catch(e) {
    toast('删除失败: '+e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

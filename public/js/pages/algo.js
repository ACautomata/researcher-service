/* ===== Algorithm Page ===== */
pages.algo = async function(){
  await Promise.all([loadIdeas(), loadAlgos()]);
  var okI=cache.ideas.filter(function(ii){return ii.os>=5});
  var c='#FF6B81';

  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+okI.length+'</div><div class="st-l">可实现Idea</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.algos.length+'</div><div class="st-l">已生成算法</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:#00E5A0">'+cache.algos.filter(function(a){return a.ok}).length+'</div><div class="st-l">测试通过</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-code"></i>AI 生成算法 <span class="api-t api-p" style="margin-left:auto">POST /algo/generate</span></div>';
  if(okI.length===0){
    h+='<div class="err-box"><i class="fa-solid fa-triangle-exclamation"></i>暂无可用 Idea</div>';
  } else {
    h+='<div style="display:flex;gap:10px;flex-wrap:wrap">';
    h+='<div style="flex:1;min-width:220px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">选择 Idea</label><select class="inp" id="aid">';
    okI.forEach(function(ii){h+='<option value="'+ii.id+'">'+ii.title.slice(0,30)+' ('+ii.os.toFixed(1)+')</option>';});
    h+='</select></div>';
    h+='<select class="inp" style="width:auto;min-width:100px" id="alg"><option>Python</option><option>C++</option></select>';
    h+='<div style="align-self:flex-end"><button class="btn bp" onclick="genAlgo()"><i class="fa-solid fa-code"></i>AI 生成</button></div></div>';
  }
  h+='</div>';

  cache.algos.forEach(function(a){
    var stb=a.ok?'bdg-g':a.ing?'bdg-y':'bdg-m', stl=a.ok?'已通过':a.ing?'测试中':'待测试';
    h+='<div class="card mb24"><div class="flex-b mb12"><div style="display:flex;align-items:center;gap:8px">';
    h+='<span style="font-weight:700;font-size:14px;font-family:Space Grotesk,sans-serif">'+a.name+'</span><span class="badge bdg-m">'+(a.lang||'Python')+'</span></div>';
    h+='<div style="display:flex;gap:4px;align-items:center"><span class="badge '+stb+'">'+stl+'</span>';
    if(!a.ok&&!a.ing) h+='<button class="btn" style="padding:4px 10px;font-size:10px" onclick="testAlgo(\''+a.id+'\')"><i class="fa-solid fa-play"></i>测试</button>';
    h+='</div></div>';
    h+='<div style="font-size:10px;color:#464d65;margin-bottom:10px">来源 Idea：'+esc(a.fi)+'</div>';
    h+='<div class="code-blk"><span class="ccp" onclick="navigator.clipboard.writeText(this.parentNode.innerText.replace(\'复制\',\'\').trim());toast(\'已复制\',\'fa-copy\',\'#FF6B81\')">复制</span>'+esc(a.code)+'</div>';
    if(a.tt>0){
      h+='<div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:12px">';
      h+='<div style="padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.01)"><div style="font-size:10px;color:#464d65;margin-bottom:4px">测试用例</div><div style="font-family:Space Grotesk,sans-serif;font-size:14px"><span style="color:#00E5A0;font-weight:700">'+a.tp+'</span><span style="color:#464d65"> / '+a.tt+'</span></div></div>';
      if(a.pa>0){
        var pct=Math.round((1-a.pa/a.pb)*100);
        h+='<div style="padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.01)"><div style="font-size:10px;color:#464d65;margin-bottom:4px">推理耗时</div><div style="font-family:Space Grotesk,sans-serif"><span style="color:#FF6B81;text-decoration:line-through;font-size:12px">'+a.pb+'ms</span> <span style="color:#00E5A0;font-weight:700;font-size:14px">'+a.pa+'ms</span> <span style="font-size:10px;color:#00E5A0">&darr;'+pct+'%</span></div></div>';
      }
      h+='</div>';
    }
    h+='</div>';
  });

  if(cache.algos.length===0){
    h+='<div class="card" style="text-align:center;padding:40px;color:#464d65"><i class="fa-solid fa-code" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">选择高分 Idea 后可生成算法代码</p></div>';
  }
  return h;
};

async function genAlgo(){
  var sel=document.getElementById('aid'), langSel=document.getElementById('alg');
  if(!sel||!sel.value)return;
  toast('AI 生成算法中，请稍候…','fa-code','#FF6B81');
  try{
    var res=await api('POST','/algo/generate',{idea_id:sel.value,language:langSel?langSel.value:'Python'});
    pollTask(res.task_id,'/algo/generate/{task_id}/progress',[],'none',function(result){
      if(result) toast('算法已生成：'+result.name,'fa-check-circle','#00E5A0');
      go('algo');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

async function testAlgo(id){
  toast('运行测试中…','fa-play','#F5A623');
  try{
    var res=await api('POST','/algo/test/'+id,{});
    pollTask(res.task_id,'/algo/test/{task_id}/progress',[],'none',function(result){
      if(result) toast('测试完成：'+result.passed+'/'+result.total+' 通过','fa-check-circle','#00E5A0');
      go('algo');
    });
  }catch(e){toast('失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

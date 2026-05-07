/* ===== KB Page ===== */
pages.kb = async function(){
  await Promise.all([loadPapers(), loadKeywords()]);
  var c='#00E5A0', cats={};
  cache.keywords.forEach(function(k){cats[k.cat]=1});
  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.papers.length+'</div><div class="st-l">已上传文献</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.entries.length+'</div><div class="st-l">知识条目</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+cache.keywords.length+'</div><div class="st-l">解析关键字</div></div>';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">'+Object.keys(cats).length+'</div><div class="st-l">覆盖分类</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-cloud-arrow-up"></i>上传文献 <span class="api-t api-p" style="margin-left:auto">POST /kb/upload</span></div>';
  h+='<div class="upload-z" id="upz" onclick="document.getElementById(\'fii\').click()">';
  h+='<input type="file" id="fii" multiple accept=".pdf,.txt,.md,.docx,.tex" onchange="doUpload(this.files)" style="display:none">';
  h+='<i class="fa-solid fa-cloud-arrow-up u-ico"></i><div class="u-t">拖拽文献到此处，或点击选择文件</div><div class="u-s">支持 PDF / TXT / Markdown / DOCX / LaTeX</div></div>';
  h+='<div class="pbar" id="pbar"><div class="pb-t"><i class="fa-solid fa-gear fa-spin"></i>正在解析…</div>';
  h+='<div class="p-step wt" id="ps1"><span class="pc"></span>文件接收与格式校验</div>';
  h+='<div class="p-step wt" id="ps2"><span class="pc"></span>文本提取与结构化</div>';
  h+='<div class="p-step wt" id="ps3"><span class="pc"></span>AI 关键字识别与权重计算</div>';
  h+='<div class="p-step wt" id="ps4"><span class="pc"></span>AI 知识条目生成与分类</div></div></div>';

  if(cache.papers.length>0){
    h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-file-lines"></i>已上传文献</div>';
    cache.papers.forEach(function(p){h+='<div class="li-item"><div class="li-ic" style="background:rgba(0,229,160,.12);color:#00E5A0"><i class="fa-solid fa-file-pdf"></i></div><div style="flex:1"><div class="li-nm">'+p.name+'</div><div class="li-mt"><span class="badge bdg-g">已解析</span></div></div></div>';});
    h+='</div>';
  }
  if(cache.keywords.length>0){
    h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-key"></i>AI 解析关键字池 <span class="api-t api-g" style="margin-left:auto">GET /kb/keywords</span></div><div style="display:flex;flex-wrap:wrap;gap:6px">';
    cache.keywords.forEach(function(k){h+='<span class="kw-tag" style="color:'+cc(k.cat)+'"><i class="fa-solid fa-key" style="font-size:8px;opacity:.4"></i>'+k.word+'<span class="kw-w">'+k.weight.toFixed(1)+'</span></span>';});
    h+='</div></div>';
  }
  h+='<div class="flex-b mb12"><span style="font-size:13px;font-weight:700">知识条目</span><div style="display:flex;gap:6px;align-items:center"><span class="api-t api-g">GET /kb/entries</span><button class="btn bdr" style="padding:4px 10px;font-size:10px" onclick="clearAll()"><i class="fa-solid fa-trash-can"></i> 清空全部数据</button></div></div>';
  if(cache.entries.length>0){
    h+='<div class="tbl-w"><table><thead><tr><th>标题</th><th>来源</th><th>分类</th><th>关键字</th><th>状态</th></tr></thead><tbody>';
    cache.entries.forEach(function(e){
      var kws=e.keywords||[];
      h+='<tr><td style="font-weight:600">'+e.title+'</td><td style="font-size:11px;color:#464d65">'+(e.source||'-')+'</td><td><span class="badge bdg-m">'+(e.category||'-')+'</span></td><td>';
      kws.slice(0,3).forEach(function(k){h+='<span class="badge bdg-g" style="margin:1px;font-size:9px">'+k+'</span>';});
      if(kws.length>3) h+='<span style="font-size:9px;color:#464d65">+'+(kws.length-3)+'</span>';
      h+='</td><td><span class="badge bdg-g">'+(e.status||'draft')+'</span></td></tr>';
    });
    h+='</tbody></table></div>';
  } else {
    h+='<div class="card" style="text-align:center;padding:40px;color:#464d65"><i class="fa-solid fa-inbox" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">上传文献后将自动调用 AI 解析关键字并生成条目</p></div>';
  }
  return h;
};

async function clearAll(){
  if(!confirm('确定要清空全部数据吗？包括所有文献、条目、问题、Idea、算法。此操作不可撤销。')) return;
  try{
    await api('POST','/kb/clear-all');
    toast('已清空全部数据','fa-trash-can','#FF6B81');
    cache={papers:[],entries:[],keywords:[],problems:[],ideas:[],algos:[]};
    go('kb');
  }catch(e){
    toast('清空失败: '+e.message,'fa-exclamation-circle','#FF6B81');
  }
}

function setupDrag(){
  var z=document.getElementById('upz');if(!z)return;
  z.addEventListener('dragover',function(e){e.preventDefault();z.classList.add('drag')});
  z.addEventListener('dragleave',function(){z.classList.remove('drag')});
  z.addEventListener('drop',function(e){e.preventDefault();z.classList.remove('drag');if(e.dataTransfer.files.length)doUpload(e.dataTransfer.files)});
}

async function doUpload(files){
  if(!files||!files.length)return;
  try{
    toast('正在上传…','fa-cloud-arrow-up','#00E5A0');
    var data=await apiUpload(files);
    for(var i=0;i<data.uploaded.length;i++){
      var uid=data.uploaded[i].upload_id;
      try{
        var pr=await api('POST','/kb/parse',{upload_id:uid});
        var pb=document.getElementById('pbar');if(pb)pb.classList.add('on');
        pollTask(pr.task_id,'/kb/parse/{task_id}/progress',['ps1','ps2','ps3','ps4'],'pbar',function(result){
          if(result) toast('解析完成：'+result.entries_count+' 条目，'+result.keywords_count+' 关键字','fa-check-circle','#00E5A0');
          go('kb');
        });
      }catch(e){toast('解析失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
    }
  }catch(e){toast('上传失败: '+e.message,'fa-exclamation-circle','#FF6B81')}
}

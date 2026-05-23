/* ===== OpenClaw Agent 平台 —— 多 Agent 协作科研 ===== */
var ocHistory = [];
var ocAgentId = 'main';
var ocSessionKey = 'oc_' + Math.random().toString(36).slice(2, 10);
var ocStreaming = false;
var ocEvtSource = null;
var ocReviewTaskId = null;
var ocReviewPollIv = null;

var OC_AGENTS = [
  { id: 'main', name: '颖姗', icon: 'fa-brain', color: '#3b6df0',
    desc: '主科研助手 —— 负责对话交互、委派子Agent、论文RSS推送' },
  { id: 'autoresearch', name: 'Autoresearch', icon: 'fa-database', color: '#10b981',
    desc: 'AutoResearch —— 论文知识库维护、文献 Wiki 构建、跨论文对比' },
  { id: 'paper-review', name: 'Paper Review', icon: 'fa-file-magnifying-glass', color: '#8b5cf6',
    desc: '论文评审 —— 5阶段分析：Wiki整理→实验提取→问题分析→验证设计→Codex提示' }
];

pages.openclaw = async function() {
  var h = '';

  // ── Header ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">OpenClaw Agent 平台</span>';
  h += '<span id="ocStatus" style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text-muted)">检测中...</span>';
  h += '</div>';
  h += '<div style="display:flex;gap:8px">';
  h += '<button class="btn" onclick="clearOcChat()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-eraser"></i> 清空</button>';
  h += '<button class="btn" onclick="ocRefresh()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-rotate"></i> 刷新</button>';
  h += '</div></div>';

  // ── Agent Selector ──
  h += '<div class="card mb16" style="padding:12px 16px">';
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap">';
  for (var i = 0; i < OC_AGENTS.length; i++) {
    var a = OC_AGENTS[i];
    var sel = ocAgentId === a.id;
    h += '<button class="oc-agent-btn' + (sel ? ' on' : '') + '" onclick="selectOcAgent(\'' + a.id + '\')" style="flex:1;min-width:180px;text-align:left;padding:12px;border:2px solid ' + (sel ? a.color : 'var(--border)') + ';border-radius:var(--radius);background:' + (sel ? a.color + '10' : 'var(--bg)') + ';cursor:pointer;transition:all .2s">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><i class="fa-solid ' + a.icon + '" style="color:' + a.color + ';font-size:16px"></i><span style="font-weight:700;color:var(--text-bold);font-size:13px">' + a.name + '</span></div>';
    h += '<div style="font-size:11px;color:var(--text-muted);line-height:1.5">' + a.desc + '</div>';
    h += '</button>';
  }
  h += '</div></div>';

  // ── Paper Review Mode (only for paper-review agent) ──
  if (ocAgentId === 'paper-review') {
    h += '<div class="card mb16" style="padding:16px;background:linear-gradient(135deg,rgba(139,92,246,.03),rgba(139,92,246,.06))">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><i class="fa-solid fa-microscope" style="color:#8b5cf6;font-size:16px"></i><span style="font-weight:700;color:var(--text-bold);font-size:13px">论文评审 —— 5阶段深度分析</span></div>';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">提交论文内容后，Agent 将依次执行：Wiki条目整理 → 实验深度提取 → 评审式问题分析 → 验证实验设计 → Codex任务提示生成</div>';
    h += '<div style="display:flex;gap:8px;align-items:flex-end">';
    h += '<textarea id="ocReviewInput" class="inp" rows="4" placeholder="在此粘贴论文标题、摘要、正文（或从文献知识库复制）..." style="flex:1;font-size:13px;line-height:1.6;resize:vertical"></textarea>';
    h += '<button class="btn bp" id="ocReviewBtn" onclick="startOcReview()" style="padding:10px 16px;font-size:13px;flex-shrink:0;height:fit-content;white-space:nowrap"><i class="fa-solid fa-play"></i> 开始评审</button>';
    h += '</div>';
    h += '<div id="ocReviewProgress" style="margin-top:10px;display:none">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><i class="fa-solid fa-spinner fa-spin" style="color:#8b5cf6"></i><span id="ocReviewStep" style="font-size:12px;color:var(--text-muted)">准备中...</span></div>';
    h += '<div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div id="ocReviewBar" style="height:100%;background:#8b5cf6;width:0%;border-radius:2px;transition:width .5s"></div></div>';
    h += '</div>';
    h += '<div id="ocReviewResult" style="margin-top:12px;display:none;max-height:60vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent"></div>';
    h += '</div>';
  }

  // ── Chat Area ──
  h += '<div class="card" style="padding:16px">';
  h += '<div id="ocChatMessages" style="min-height:35vh;max-height:45vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:flex;flex-direction:column;gap:12px;padding:4px 0">';
  if (!ocHistory.length) {
    h += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:180px"><div style="text-align:center;max-width:400px">';
    h += '<i class="fa-solid fa-robot" style="font-size:40px;display:block;margin-bottom:14px;opacity:.12"></i>';
    h += '<p style="font-weight:600;margin-bottom:6px">OpenClaw 多 Agent 协作平台</p>';
    h += '<p style="font-size:11px;line-height:1.6">选择上方 Agent 开始对话。<br>颖姗：通用科研助手 | Autoresearch：文献Wiki管理 | Paper Review：深度论文评审</p>';
    h += '</div></div>';
  } else {
    ocHistory.forEach(function(msg) { h += renderOcMsg(msg); });
  }
  h += '</div>';

  // ── Input ──
  h += '<div style="display:flex;gap:10px;margin-top:14px;align-items:flex-end">';
  h += '<div style="flex:1"><textarea class="inp" id="ocChatInput" rows="2" placeholder="向 ' + (OC_AGENTS.find(function(a){return a.id===ocAgentId})||{name:'Agent'}).name + ' 发送消息...（Enter 发送，Shift+Enter 换行）" style="resize:vertical;min-height:44px;font-size:13px;line-height:1.6" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();sendOcChat()}"></textarea></div>';
  h += '<button class="btn bp" id="ocSendBtn" onclick="sendOcChat()" style="padding:10px 20px;font-size:13px;flex-shrink:0;height:fit-content"><i class="fa-solid fa-paper-plane"></i> 发送</button>';
  h += '</div></div>';

  // Check health on load
  setTimeout(checkOcHealth, 100);
  return h;
};

/* ── Health Check ── */
async function checkOcHealth() {
  var st = document.getElementById('ocStatus');
  if (!st) return;
  st.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 检测中...';
  st.style.background = 'var(--border)'; st.style.color = 'var(--text-muted)';
  try {
    var res = await api('GET', '/openclaw/health');
    if (res.enabled && res.reachable) {
      st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;margin-right:4px;color:#10b981"></i>已连接';
      st.style.background = '#10b98120'; st.style.color = '#10b981';
    } else if (res.enabled) {
      st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;margin-right:4px;color:#f59e0b"></i>网关离线';
      st.style.background = '#f59e0b20'; st.style.color = '#f59e0b';
    } else {
      st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;margin-right:4px;color:#64748b"></i>未启用';
      st.style.background = 'var(--border)'; st.style.color = 'var(--text-muted)';
    }
  } catch(e) {
    st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:7px;margin-right:4px;color:#ef4444"></i>连接失败';
    st.style.background = '#ef444420'; st.style.color = '#ef4444';
  }
}

/* ── Agent Selection ── */
function selectOcAgent(id) {
  ocAgentId = id;
  ocHistory = [];
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.openclaw) {
    pages.openclaw().then(function(html) { ctn.innerHTML = html; });
  }
}

/* ── Message Rendering ── */
function renderOcMsg(msg) {
  var isUser = msg.role === 'user';
  var align = isUser ? 'flex-end' : 'flex-start';
  var bg = isUser ? 'var(--accent-light)' : 'var(--bg)';
  var border = isUser ? 'var(--accent)' : 'var(--border)';
  var name = isUser ? authUser ? authUser.username : '你' : OC_AGENTS.find(function(a){return a.id===ocAgentId}) ? OC_AGENTS.find(function(a){return a.id===ocAgentId}).name : 'Agent';
  var ic = isUser ? 'fa-user' : 'fa-robot';
  var thinkingHtml = msg.thinking ? '<div style="font-size:11px;margin-bottom:8px;padding:6px 10px;background:rgba(139,92,246,.08);border-left:3px solid #8b5cf6;border-radius:4px;color:var(--text-muted);line-height:1.5"><i class="fa-solid fa-brain" style="margin-right:4px;color:#8b5cf6"></i>' + esc(msg.thinking) + '</div>' : '';

  var h = '<div style="display:flex;flex-direction:column;align-items:' + align + ';max-width:85%">';
  h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid ' + ic + '"></i> ' + name + '</div>';
  h += '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--text);word-break:break-word;white-space:pre-wrap">' + thinkingHtml + esc(msg.content) + '</div>';
  h += '</div>';
  return h;
}

/* ── Send (SSE Streaming) ── */
async function sendOcChat() {
  var input = document.getElementById('ocChatInput');
  if (!input || !input.value.trim() || ocStreaming) return;
  var text = input.value.trim();
  input.value = '';
  ocStreaming = true;
  var btn = document.getElementById('ocSendBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  // Add user message
  ocHistory.push({role: 'user', content: text});
  var msgArea = document.getElementById('ocChatMessages');
  msgArea.innerHTML += renderOcMsg({role: 'user', content: text});
  var loadingId = 'ocLoading_' + Date.now();
  msgArea.innerHTML += '<div id="' + loadingId + '" style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-robot"></i> Agent</div><div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-muted);font-size:13px"><span id="' + loadingId + '_text"><i class="fa-solid fa-spinner fa-spin"></i> 思考中...</span></div></div>';
  msgArea.scrollTop = msgArea.scrollHeight;

  var fullResponse = '';
  var thinkingText = '';

  try {
    // Step 1: Start streaming session
    var startRes = await api('POST', '/openclaw/chat/stream', {
      agent_id: ocAgentId,
      message: text,
      history: ocHistory.slice(0, -1),
      temperature: 0.5
    });
    var taskId = startRes.task_id;

    // Step 2: Connect to SSE
    var streamUrl = API + '/openclaw/chat/' + taskId + '/stream';
    if (authToken) streamUrl += '?access_token=' + encodeURIComponent(authToken);
    ocEvtSource = new EventSource(streamUrl);

    ocEvtSource.onmessage = function(event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'text') {
          fullResponse += data.text;
          var loadText = document.getElementById(loadingId + '_text');
          if (loadText) loadText.textContent = fullResponse || '...';
        } else if (data.type === 'thinking' || data.type === 'assistant') {
          var blocks = data.blocks || [];
          blocks.forEach(function(b) {
            if (b.type === 'text') { fullResponse += b.text; }
            if (b.type === 'thinking') { thinkingText += b.text || ''; }
          });
          var loadText = document.getElementById(loadingId + '_text');
          if (loadText) loadText.textContent = fullResponse || (thinkingText ? '思考: ' + thinkingText.slice(-100) : '...');
        } else if (data.type === 'done') {
          ocEvtSource.close();
          ocEvtSource = null;
          var loading = document.getElementById(loadingId);
          if (loading) loading.remove();
          ocHistory.push({role: 'assistant', content: fullResponse, thinking: thinkingText});
          msgArea.innerHTML += renderOcMsg({role: 'assistant', content: fullResponse, thinking: thinkingText});
          msgArea.scrollTop = msgArea.scrollHeight;
          ocStreaming = false;
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送';
        } else if (data.type === 'error') {
          throw new Error(data.text || '未知错误');
        } else if (data.type === 'raw') {
          fullResponse += data.text || '';
        }
      } catch(e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    };

    ocEvtSource.onerror = function() {
      if (ocEvtSource) ocEvtSource.close();
      ocEvtSource = null;
      finishOcChat(loadingId, fullResponse, thinkingText, msgArea, btn);
    };

  } catch(e) {
    finishOcChat(loadingId, fullResponse || e.message, thinkingText, msgArea, btn);
  }
}

function finishOcChat(loadingId, fullResponse, thinkingText, msgArea, btn) {
  var loading = document.getElementById(loadingId);
  if (loading) loading.remove();
  if (fullResponse) {
    ocHistory.push({role: 'assistant', content: fullResponse, thinking: thinkingText});
    msgArea.innerHTML += renderOcMsg({role: 'assistant', content: fullResponse, thinking: thinkingText});
  }
  msgArea.scrollTop = msgArea.scrollHeight;
  ocStreaming = false;
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送'; }
}

/* ── Clear ── */
function clearOcChat() {
  if (ocEvtSource) { ocEvtSource.close(); ocEvtSource = null; }
  ocHistory = [];
  ocStreaming = false;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.openclaw) {
    pages.openclaw().then(function(html) { ctn.innerHTML = html; });
  }
}

/* ── Refresh ── */
function ocRefresh() {
  checkOcHealth();
}

/* ── Paper Review (Async Task Pattern) ── */
async function startOcReview() {
  var input = document.getElementById('ocReviewInput');
  var btn = document.getElementById('ocReviewBtn');
  if (!input || !input.value.trim()) { toast('请先输入论文内容', 'fa-exclamation-circle', '#f59e0b'); return; }
  var text = input.value.trim();
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 提交中...';

  try {
    var res = await api('POST', '/openclaw/paper-review', { message: text });
    ocReviewTaskId = res.task_id;

    // Show progress
    var prog = document.getElementById('ocReviewProgress');
    if (prog) prog.style.display = 'block';
    var bar = document.getElementById('ocReviewBar');
    if (bar) bar.style.width = '0%';
    var step = document.getElementById('ocReviewStep');
    if (step) step.textContent = '已提交，等待 Agent 分析...';

    // Poll progress
    var resultText = '';
    ocReviewPollIv = setInterval(async function() {
      try {
        var p = await api('GET', '/openclaw/paper-review/' + ocReviewTaskId + '/progress');
        var b = document.getElementById('ocReviewBar');
        if (b) b.style.width = p.progress + '%';
        var s = document.getElementById('ocReviewStep');
        if (s) s.textContent = p.step || '分析中...';
        if (p.status === 'completed') {
          clearInterval(ocReviewPollIv);
          ocReviewPollIv = null;
          var r = document.getElementById('ocReviewResult');
          if (r && p.result && p.result.response) {
            r.innerHTML = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;font-size:13px;line-height:1.8;white-space:pre-wrap">' + esc(p.result.response) + '</div>';
            r.style.display = 'block';
          }
          if (b) b.style.background = '#10b981';
          if (s) s.textContent = '评审完成';
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始评审';
          toast('论文评审完成', 'fa-check-circle', '#10b981');
        } else if (p.status === 'error') {
          clearInterval(ocReviewPollIv);
          ocReviewPollIv = null;
          toast(p.error || '评审失败', 'fa-exclamation-circle', '#ef4444');
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始评审';
        }
      } catch(e) {
        clearInterval(ocReviewPollIv);
        ocReviewPollIv = null;
        toast('轮询异常: ' + e.message, 'fa-exclamation-circle', '#ef4444');
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始评审';
      }
    }, 2000);
  } catch(e) {
    toast('提交失败: ' + e.message, 'fa-exclamation-circle', '#ef4444');
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始评审';
  }
}

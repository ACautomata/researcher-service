/* ===== OpenClaw Shared — 多 Session 管理、SSE 流式对话、Agent 页面共享模块 ===== */

var OC_AGENTS = {
  'main': {
    id: 'main', name: '颖姗', icon: 'fa-brain', color: '#3b6df0',
    desc: '主科研助手 —— 负责交互、委派子Agent、论文RSS推送'
  },
  'autoresearch': {
    id: 'autoresearch', name: 'Autoresearch', icon: 'fa-database', color: '#10b981',
    desc: '论文知识库维护、文献 Wiki 构建、跨论文对比'
  },
  'paper-review': {
    id: 'paper-review', name: 'Paper Review', icon: 'fa-microscope', color: '#8b5cf6',
    desc: '论文深度评审 —— 5阶段分析：Wiki整理→实验提取→问题分析→验证设计→Codex提示'
  },
  'idea-generate': {
    id: 'idea-generate', name: 'Idea Generate', icon: 'fa-lightbulb', color: '#f59e0b',
    desc: '研究想法生成 —— 7种策略驱动的创新思路产出'
  }
};

/* ── Session Storage (localStorage) ── */
function ocStorageKey(agentId) { return 'oc_sessions_' + agentId; }
function ocActiveKey(agentId) { return 'oc_active_' + agentId; }
function ocCounterKey(agentId) { return 'oc_counter_' + agentId; }

function ocLoadSessions(agentId) {
  try {
    return JSON.parse(localStorage.getItem(ocStorageKey(agentId)) || '{}');
  } catch(e) { return {}; }
}

function ocSaveSessions(agentId, sessions) {
  try {
    localStorage.setItem(ocStorageKey(agentId), JSON.stringify(sessions));
  } catch(e) {
    toast('存储空间不足，请清理旧会话', 'fa-exclamation-circle', '#FF6B81');
  }
}

function ocGetActive(agentId) {
  return localStorage.getItem(ocActiveKey(agentId)) || '';
}

function ocSetActive(agentId, sessionId) {
  localStorage.setItem(ocActiveKey(agentId), sessionId);
}

function ocNextName(agentId) {
  var c = parseInt(localStorage.getItem(ocCounterKey(agentId)) || '0') + 1;
  localStorage.setItem(ocCounterKey(agentId), String(c));
  return 'Session ' + c;
}

function ocCreateSession(agentId) {
  var sessions = ocLoadSessions(agentId);
  var sid = 'oc_' + Date.now().toString(36);
  var name = ocNextName(agentId);
  sessions[sid] = { id: sid, name: name, history: [], createdAt: new Date().toISOString() };
  ocSaveSessions(agentId, sessions);
  ocSetActive(agentId, sid);
  return sid;
}

function ocDeleteSession(agentId, sessionId) {
  var sessions = ocLoadSessions(agentId);
  delete sessions[sessionId];
  ocSaveSessions(agentId, sessions);
  // Also clean up active SSE source if any
  if (ocEvtSources[sessionId]) {
    ocEvtSources[sessionId].close();
    delete ocEvtSources[sessionId];
  }
  if (ocGetActive(agentId) === sessionId) {
    var keys = Object.keys(sessions);
    ocSetActive(agentId, keys.length ? keys[0] : '');
  }
}

function ocClearAll(agentId) {
  Object.keys(ocEvtSources).forEach(function(k) {
    if (ocEvtSources[k]) ocEvtSources[k].close();
  });
  ocEvtSources = {};
  localStorage.removeItem(ocStorageKey(agentId));
  localStorage.removeItem(ocActiveKey(agentId));
  localStorage.removeItem(ocCounterKey(agentId));
}

/* ── Active SSE sources (in-memory, not persisted) ── */
var ocEvtSources = {};

/* ── Page Builder ── */
function buildOcAgentPage(agentId) {
  var agent = OC_AGENTS[agentId] || OC_AGENTS['main'];
  var sessions = ocLoadSessions(agentId);
  var activeId = ocGetActive(agentId);

  // Auto-create first session if none
  if (!Object.keys(sessions).length) {
    activeId = ocCreateSession(agentId);
    sessions = ocLoadSessions(agentId);
  }
  if (!sessions[activeId]) {
    activeId = Object.keys(sessions)[0];
    ocSetActive(agentId, activeId);
  }

  var sessionKeys = Object.keys(sessions);
  var activeSession = sessions[activeId] || { history: [] };

  var h = '';

  // ── Top bar ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px">';
  h += '<i class="fa-solid ' + agent.icon + '" style="color:' + agent.color + ';font-size:18px"></i>';
  h += '<span style="font-size:16px;font-weight:700;color:var(--text-bold)">' + agent.name + '</span>';
  h += '<span style="font-size:10px;color:var(--text-muted)">' + agent.desc + '</span>';
  h += '<span id="ocStatus_' + agentId + '" style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text-muted)">检测中...</span>';
  h += '</div>';
  h += '<div style="display:flex;gap:6px">';
  h += '<button class="btn" onclick="ocCreateAndSwitch(\'' + agentId + '\')" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-plus"></i> 新会话</button>';
  h += '<button class="btn" onclick="ocClearAllAndRefresh(\'' + agentId + '\')" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-trash"></i> 清空全部</button>';
  h += '</div></div>';

  h += '<div style="display:flex;gap:16px;min-height:60vh">';

  // ── Session sidebar ──
  h += '<div style="width:180px;flex-shrink:0;display:flex;flex-direction:column;gap:4px;max-height:65vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;padding-right:4px">';
  for (var i = 0; i < sessionKeys.length; i++) {
    var sid = sessionKeys[i];
    var s = sessions[sid];
    var isActive = sid === activeId;
    h += '<div onclick="ocSwitchSession(\'' + agentId + '\',\'' + sid + '\')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;font-size:12px;' + (isActive ? 'background:var(--accent-light);color:var(--accent);font-weight:600;border:1px solid var(--accent)' : 'background:var(--bg);color:var(--text);border:1px solid var(--border-light)') + ';transition:all .15s">';
    h += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + esc(s.name) + '</span>';
    h += '<span onclick="event.stopPropagation();ocDeleteAndRefresh(\'' + agentId + '\',\'' + sid + '\')" style="margin-left:8px;color:var(--text-muted);cursor:pointer;font-size:14px;flex-shrink:0" title="删除会话">&times;</span>';
    h += '</div>';
  }
  h += '<div onclick="ocCreateAndSwitch(\'' + agentId + '\')" style="cursor:pointer;padding:10px 12px;border-radius:8px;font-size:12px;color:var(--text-muted);border:1px dashed var(--border);text-align:center;transition:all .15s">+ 新会话</div>';
  h += '</div>';

  // ── Chat area ──
  h += '<div style="flex:1;display:flex;flex-direction:column;min-width:0">';
  h += '<div class="card" style="padding:16px;flex:1;display:flex;flex-direction:column">';
  h += '<div id="ocMessages_' + agentId + '" style="flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:flex;flex-direction:column;gap:12px;padding:4px 0;min-height:35vh;max-height:55vh">';

  var hist = activeSession.history || [];
  if (!hist.length) {
    h += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px"><div style="text-align:center"><i class="fa-solid ' + agent.icon + '" style="font-size:36px;display:block;margin-bottom:12px;opacity:.12"></i><p style="font-weight:600">' + agent.name + '</p><p style="font-size:11px">' + agent.desc + '</p></div></div>';
  } else {
    hist.forEach(function(msg) { h += renderOcMsg(msg, agent); });
  }
  h += '</div>';

  // ── Input ──
  h += '<div style="display:flex;gap:10px;margin-top:14px;align-items:flex-end">';
  h += '<div style="flex:1">';
  h += '<div id="ocFiles_' + agentId + '" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px"></div>';
  h += '<textarea class="inp" id="ocInput_' + agentId + '" rows="2" placeholder="向 ' + agent.name + ' 发送消息...（Enter 发送，Shift+Enter 换行）" style="resize:vertical;min-height:44px;font-size:13px;line-height:1.6;width:100%" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();ocSend(\'' + agentId + '\')}"></textarea></div>';
  h += '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">';
  h += '<button class="btn" onclick="ocPickFile(\'' + agentId + '\')" style="padding:10px 12px;font-size:13px;height:fit-content" title="上传文件"><i class="fa-solid fa-paperclip"></i></button>';
  h += '<button class="btn bp" id="ocSend_' + agentId + '" onclick="ocSend(\'' + agentId + '\')" style="padding:10px 12px;font-size:13px;flex-shrink:0;height:fit-content"><i class="fa-solid fa-paper-plane"></i></button>';
  h += '</div>';
  h += '<input type="file" id="ocFileInput_' + agentId + '" onchange="ocFileSelected(\'' + agentId + '\')" style="display:none" multiple>';
  h += '</div></div></div></div>';

  setTimeout(function() { ocCheckHealth(agentId); }, 100);
  return h;
}

/* ── Health Check ── */
async function ocCheckHealth(agentId) {
  var st = document.getElementById('ocStatus_' + agentId);
  if (!st) return;
  try {
    var res = await api('GET', '/openclaw/health');
    if (res.enabled && res.reachable) {
      st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px;color:#10b981"></i>已连接';
      st.style.background = '#10b98120'; st.style.color = '#10b981';
    } else {
      st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px;color:#f59e0b"></i>离线';
      st.style.background = '#f59e0b20'; st.style.color = '#f59e0b';
    }
  } catch(e) {
    st.innerHTML = '<i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px;color:#ef4444"></i>连接失败';
    st.style.background = '#ef444420'; st.style.color = '#ef4444';
  }
}

/* ── Session Actions ── */
function ocCreateAndSwitch(agentId) {
  var sid = ocCreateSession(agentId);
  ocRefreshPage(agentId);
}

function ocSwitchSession(agentId, sessionId) {
  ocSetActive(agentId, sessionId);
  ocRefreshPage(agentId);
}

function ocDeleteAndRefresh(agentId, sessionId) {
  if (!confirm('删除会话「' + (ocLoadSessions(agentId)[sessionId] || {}).name + '」？')) return;
  ocDeleteSession(agentId, sessionId);
  ocRefreshPage(agentId);
}

function ocClearAllAndRefresh(agentId) {
  if (!confirm('确定清空 ' + OC_AGENTS[agentId].name + ' 的所有会话？')) return;
  ocClearAll(agentId);
  ocRefreshPage(agentId);
}

function ocRefreshPage(agentId) {
  var ctn = document.getElementById('ctnEl');
  if (!ctn) return;
  ctn.innerHTML = buildOcAgentPage(agentId);
}

/* ── Message Rendering ── */
function renderOcMsg(msg, agent) {
  var isUser = msg.role === 'user';
  var align = isUser ? 'flex-end' : 'flex-start';
  var bg = isUser ? 'var(--accent-light)' : 'var(--bg)';
  var border = isUser ? 'var(--accent)' : 'var(--border)';
  var name = isUser ? (authUser ? authUser.username : '你') : (agent ? agent.name : 'Agent');
  var ic = isUser ? 'fa-user' : 'fa-robot';
  var thinkingHtml = msg.thinking ? '<div style="font-size:11px;margin-bottom:8px;padding:6px 10px;background:rgba(139,92,246,.08);border-left:3px solid #8b5cf6;border-radius:4px;color:var(--text-muted);line-height:1.5"><i class="fa-solid fa-brain" style="margin-right:4px;color:#8b5cf6"></i>' + esc(msg.thinking) + '</div>' : '';

  return '<div style="display:flex;flex-direction:column;align-items:' + align + ';max-width:85%">'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid ' + ic + '"></i> ' + name + '</div>'
    + (msg.files && msg.files.length ? '<div style="margin-bottom:6px">' + msg.files.map(function(fn) { return '<span style="display:inline-block;padding:2px 8px;background:var(--accent);color:#fff;border-radius:4px;font-size:10px;margin-right:4px"><i class="fa-solid fa-paperclip" style="margin-right:3px"></i>' + esc(fn) + '</span>'; }).join('') + '</div>' : '')
    + '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--text);word-break:break-word;white-space:pre-wrap">' + thinkingHtml + esc(msg.content) + '</div>'
    + '</div>';
}

/* ── File Upload ── */
var ocPendingFiles = {};  // { agentId: [{name, data, type}] }

function ocPickFile(agentId) {
  var input = document.getElementById('ocFileInput_' + agentId);
  if (input) input.click();
}

function ocFileSelected(agentId) {
  var input = document.getElementById('ocFileInput_' + agentId);
  if (!input || !input.files.length) return;
  if (!ocPendingFiles[agentId]) ocPendingFiles[agentId] = [];
  var MAX_SIZE = 20 * 1024 * 1024; // 20MB
  var filesToRead = input.files.length;
  var readCount = 0;
  for (var i = 0; i < input.files.length; i++) {
    (function(file) {
      if (file.size > MAX_SIZE) { toast(file.name + ' 超过 20MB 限制', 'fa-exclamation-circle', '#FF6B81'); readCount++; return; }
      var reader = new FileReader();
      reader.onload = function() {
        ocPendingFiles[agentId].push({ name: file.name, data: reader.result, type: file.type });
        readCount++;
        if (readCount >= filesToRead) ocRenderFiles(agentId);
      };
      reader.readAsDataURL(file);
    })(input.files[i]);
  }
  input.value = '';
}

function ocRemoveFile(agentId, index) {
  ocPendingFiles[agentId].splice(index, 1);
  if (!ocPendingFiles[agentId].length) delete ocPendingFiles[agentId];
  ocRenderFiles(agentId);
}

function ocRenderFiles(agentId) {
  var el = document.getElementById('ocFiles_' + agentId);
  if (!el) return;
  var files = ocPendingFiles[agentId] || [];
  var h = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var isImg = f.type && f.type.startsWith('image/');
    h += '<div style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;background:var(--accent-light);border-radius:6px;font-size:11px;color:var(--accent);max-width:200px">';
    h += '<i class="fa-solid ' + (isImg ? 'fa-image' : 'fa-file-lines') + '"></i>';
    h += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.name) + '</span>';
    h += '<span onclick="ocRemoveFile(\'' + agentId + '\',' + i + ')" style="cursor:pointer;margin-left:2px">&times;</span>';
    h += '</div>';
  }
  el.innerHTML = h;
}

/* ── Send (SSE Streaming) ── */
async function ocSend(agentId) {
  var input = document.getElementById('ocInput_' + agentId);
  var btn = document.getElementById('ocSend_' + agentId);
  var text = (input ? input.value.trim() : '');
  var files = ocPendingFiles[agentId] || [];
  if (!text && !files.length) return;
  if (input) input.value = '';

  var activeId = ocGetActive(agentId);
  if (!activeId) return;
  var sessions = ocLoadSessions(agentId);
  var session = sessions[activeId];
  if (!session) return;

  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  // Add user message (include file info)
  var userMsg = { role: 'user', content: text };
  if (files.length) userMsg.files = files.map(function(f) { return f.name; });
  session.history.push(userMsg);
  var msgArea = document.getElementById('ocMessages_' + agentId);
  var agent = OC_AGENTS[agentId];
  msgArea.innerHTML += renderOcMsg(userMsg, agent);
  // Clear pending files
  delete ocPendingFiles[agentId];

  var loadingId = 'ocLoad_' + Date.now();
  msgArea.innerHTML += '<div id="' + loadingId + '" style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-robot"></i> ' + agent.name + '</div><div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-muted);font-size:13px"><span id="' + loadingId + '_t"><i class="fa-solid fa-spinner fa-spin"></i> 思考中...</span></div></div>';
  msgArea.scrollTop = msgArea.scrollHeight;
  ocSaveSessions(agentId, sessions);

  var fullResponse = '';
  var thinkingText = '';

  try {
    var startRes = await api('POST', '/openclaw/chat/stream', {
      agent_id: agentId,
      message: text,
      history: session.history.slice(0, -1),
      temperature: 0.5,
      files: files.length ? files.map(function(f) { return {name: f.name, data: f.data, type: f.type}; }) : null
    });
    var taskId = startRes.task_id;

    var streamUrl = API + '/openclaw/chat/' + taskId + '/stream';
    if (authToken) streamUrl += '?access_token=' + encodeURIComponent(authToken);
    var es = new EventSource(streamUrl);
    ocEvtSources[activeId] = es;

    es.onmessage = function(event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'text') {
          fullResponse += data.text;
          var t = document.getElementById(loadingId + '_t');
          if (t) t.textContent = fullResponse || '...';
        } else if (data.type === 'done') {
          es.close();
          delete ocEvtSources[activeId];
          var l = document.getElementById(loadingId);
          if (l) l.remove();
          session.history.push({ role: 'assistant', content: fullResponse, thinking: thinkingText });
          ocSaveSessions(agentId, sessions);
          msgArea.innerHTML += renderOcMsg({ role: 'assistant', content: fullResponse, thinking: thinkingText }, agent);
          msgArea.scrollTop = msgArea.scrollHeight;
          btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送';
        } else if (data.type === 'error') {
          es.close();
          delete ocEvtSources[activeId];
          var l = document.getElementById(loadingId);
          if (l) l.remove();
          var errMsg = data.text || '请求失败（请检查 API Key 是否正确）';
          session.history.push({ role: 'assistant', content: '【错误】' + errMsg, thinking: thinkingText });
          ocSaveSessions(agentId, sessions);
          msgArea.innerHTML += renderOcMsg({ role: 'assistant', content: '【错误】' + errMsg }, agent);
        } else if (data.type === 'raw') {
          fullResponse += data.text || '';
        }
        // 更新 loading 文本
        var t = document.getElementById(loadingId + '_t');
        if (t && fullResponse) t.textContent = fullResponse;
      } catch(e) {
        if (e.message && e.message.indexOf('JSON') === -1) throw e;
      }
    };

    es.onerror = function() {
      if (es) es.close();
      delete ocEvtSources[activeId];
      ocFinishSend(loadingId, fullResponse, thinkingText, agentId, activeId, msgArea, btn, agent);
    };

  } catch(e) {
    ocFinishSend(loadingId, fullResponse || e.message, thinkingText, agentId, activeId, msgArea, btn, agent);
  }
}

function ocFinishSend(loadingId, fullResponse, thinkingText, agentId, activeId, msgArea, btn, agent) {
  var l = document.getElementById(loadingId);
  if (l) l.remove();
  if (fullResponse) {
    var sessions = ocLoadSessions(agentId);
    var session = sessions[activeId];
    if (session) {
      session.history.push({ role: 'assistant', content: fullResponse, thinking: thinkingText });
      ocSaveSessions(agentId, sessions);
    }
    msgArea.innerHTML += renderOcMsg({ role: 'assistant', content: fullResponse, thinking: thinkingText }, agent);
  }
  msgArea.scrollTop = msgArea.scrollHeight;
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送'; }
}

/* ===== 论文辅助写作 — 从内容构思到语言润色，全面辅助论文写作 ===== */
var chatHistory = [];
var chatStreaming = false;
var chatEvtSource = null;

pages.chat = async function() {
  var h = '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-comment-dots"></i> AI 对话</div>';
  h += '<div id="chatMessages" style="min-height:50vh;max-height:60vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;display:flex;flex-direction:column;gap:12px;padding:4px 0">';
  if (!chatHistory.length) {
    h += '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px"><div style="text-align:center"><i class="fa-solid fa-comment-dots" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p>发送一条消息开始对话</p></div></div>';
  } else {
    chatHistory.forEach(function(msg) {
      h += renderChatMsg(msg.role, msg.content);
    });
  }
  h += '</div>';
  h += '<div style="display:flex;gap:10px;margin-top:14px;align-items:flex-end">';
  h += '<div style="flex:1"><textarea class="inp" id="chatInput" rows="2" placeholder="输入你的问题..." style="resize:vertical;min-height:40px;font-size:13px;line-height:1.6" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();sendChat()}"></textarea></div>';
  h += '<button class="btn bp" onclick="sendChat()" id="chatSendBtn" style="padding:10px 20px;font-size:13px;flex-shrink:0;height:fit-content"><i class="fa-solid fa-paper-plane"></i> 发送</button>';
  h += '<button class="btn bdr" onclick="clearChat()" style="padding:10px 14px;font-size:13px;flex-shrink:0;height:fit-content" title="清空对话"><i class="fa-solid fa-eraser"></i></button>';
  h += '</div></div>';
  return h;
};

function renderChatMsg(role, content) {
  var isUser = role === 'user';
  var align = isUser ? 'flex-end' : 'flex-start';
  var bg = isUser ? 'rgba(59,109,240,.08)' : 'var(--bg)';
  var color = isUser ? 'var(--accent)' : 'var(--text)';
  var labelColor = isUser ? 'var(--accent)' : 'var(--text-muted)';
  var border = isUser ? 'rgba(59,109,240,.15)' : 'var(--border)';
  var name = isUser ? '你' : 'AI';
  var ic = isUser ? 'fa-user' : 'fa-robot';
  var h = '<div style="display:flex;flex-direction:column;align-items:' + align + ';max-width:85%">';
  h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:' + labelColor + ';font-weight:600"><i class="fa-solid ' + ic + '"></i> ' + name + '</div>';
  h += '<div style="background:' + bg + ';border:1px solid ' + border + ';border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.7;color:' + color + ';word-break:break-word">' + esc(content).replace(/\n/g,'<br>') + '</div>';
  h += '</div>';
  return h;
}

async function sendChat() {
  var input = document.getElementById('chatInput');
  if (!input || !input.value.trim() || chatStreaming) return;
  var text = input.value.trim();
  input.value = '';
  chatStreaming = true;
  var btn = document.getElementById('chatSendBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  // 添加用户消息到界面
  chatHistory.push({role: 'user', content: text});
  var msgArea = document.getElementById('chatMessages');
  msgArea.innerHTML += renderChatMsg('user', text);
  msgArea.innerHTML += '<div id="chatLoading" style="display:flex;flex-direction:column;align-items:flex-start;max-width:85%"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-robot"></i> AI</div><div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:12px 16px;color:var(--text-muted);font-size:13px"><i class="fa-solid fa-spinner fa-spin"></i> 思考中...</div></div>';
  msgArea.scrollTop = msgArea.scrollHeight;

  try {
    var res = await api('POST', '/chat/send', {message: text, history: chatHistory.slice(0, -1)});
    // 移除加载状态
    var loading = document.getElementById('chatLoading');
    if (loading) loading.remove();
    var reply = res.response || '(无回复)';
    chatHistory.push({role: 'assistant', content: reply});
    msgArea.innerHTML += renderChatMsg('assistant', reply);
    msgArea.scrollTop = msgArea.scrollHeight;
  } catch(e) {
    var loading = document.getElementById('chatLoading');
    if (loading) loading.remove();
    msgArea.innerHTML += renderChatMsg('assistant', '错误: ' + e.message);
  }
  chatStreaming = false;
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 发送';
}

function clearChat() {
  chatHistory = [];
  var msgArea = document.getElementById('chatMessages');
  if (msgArea) {
    msgArea.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;min-height:200px"><div style="text-align:center"><i class="fa-solid fa-comment-dots" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p>发送一条消息开始对话</p></div></div>';
  }
}

/* ===== Agent Page ===== */
var agEvt = null, agLogLines = 0, agResultText = '', agToolsUsed = [];

pages.agent = async function(){
  var c='#00D4FF';
  var h='<div class="stats">';
  h+='<div class="st-card"><div class="st-v" style="color:'+c+'">Claude</div><div class="st-l">Agent SDK</div></div>';
  h+='<div class="st-card"><div class="st-v" id="agStat" style="color:#7d849a">就绪</div><div class="st-l">会话状态</div></div>';
  h+='<div class="st-card"><div class="st-v" id="agTurnsStat" style="color:#7d849a">-</div><div class="st-l">已用轮次</div></div>';
  h+='<div class="st-card"><div class="st-v" id="agCostStat" style="color:#7d849a">-</div><div class="st-l">费用 (USD)</div></div></div>';

  h+='<div class="card mb24"><div class="card-t"><i class="fa-solid fa-terminal"></i>发送指令 <span class="api-t api-p" style="margin-left:auto">POST /agent/chat</span></div>';
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">';
  h+='<div style="flex:1;min-width:300px"><textarea class="inp" id="agPrompt" rows="3" placeholder="输入你的指令，Agent 将自动执行（可读写文件、运行代码、搜索等）" style="resize:vertical;min-height:56px;font-family:Space Grotesk,monospace"></textarea></div></div>';
  h+='<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-end">';
  h+='<div style="flex:0 0 auto;min-width:200px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">工作目录</label><input class="inp" id="agCwd" value="." placeholder="./"></div>';
  h+='<div style="flex:0 0 auto;min-width:120px"><label style="font-size:10px;color:#464d65;display:block;margin-bottom:3px">最大轮次</label><select class="inp" id="agTurns"><option>5</option><option selected>10</option><option>15</option><option>25</option></select></div>';
  h+='<button class="btn bp" onclick="startAgent()" id="agBtn"><i class="fa-solid fa-play"></i> 启动 Agent</button>';
  h+='<button class="btn bdr" onclick="stopAgent()" id="agStopBtn" style="display:none"><i class="fa-solid fa-stop"></i> 停止</button></div></div>';

  h+='<div id="agResultCard" class="card mb24" style="display:none"><div class="card-t"><i class="fa-solid fa-message"></i>Agent 回答 <span id="agResultMeta" style="font-size:10px;color:#464d65;font-weight:400;margin-left:6px"></span><button class="btn" onclick="copyResult()" style="margin-left:auto;padding:3px 10px;font-size:10px"><i class="fa-solid fa-copy"></i></button></div>';
  h+='<div id="agResult" style="font-size:13px;line-height:1.8;color:#c0c5d4"></div></div>';

  h+='<details class="card" style="margin-bottom:0"><summary style="cursor:pointer;padding:8px 0;font-size:12px;color:#7d849a;font-weight:600;outline:none"><i class="fa-solid fa-align-left" style="margin-right:6px"></i>执行日志（点击展开）<button class="btn" onclick="event.stopPropagation();clearAgentLog()" style="padding:2px 8px;font-size:10px;margin-left:12px"><i class="fa-solid fa-eraser"></i></button></summary>';
  h+='<div id="agLog" style="max-height:400px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid rgba(255,255,255,.06);padding:10px 14px;font-family:Space Grotesk,monospace;font-size:11px;line-height:1.6;min-height:80px;margin-top:10px">';
  h+='<div style="color:#464d65">等待输入指令...</div></div></details>';
  return h;
};

function clearAgentLog() {
  var el = document.getElementById('agLog');
  if (el) el.innerHTML = '<div style="color:#464d65">日志已清空</div>';
  agLogLines = 0;
  agResultText = '';
  agToolsUsed = [];
  var rc = document.getElementById('agResultCard');
  if (rc) rc.style.display = 'none';
  var rr = document.getElementById('agResult');
  if (rr) rr.innerHTML = '';
}

function appendLog(type, content, extra) {
  var el = document.getElementById('agLog');
  if (!el) return;
  if (agLogLines === 0) el.innerHTML = '';
  agLogLines++;
  var colors = {
    system: '#464d65', text: '#e8ebf2', thinking: '#7d849a',
    tool_use: '#F5A623', tool_result: '#464d65', tool_error: '#FF6B81',
    result: '#00E5A0', error: '#FF6B81', stderr: '#464d65'
  };
  var c = colors[type] || '#7d849a';
  var icon = '';
  if (type === 'tool_use') icon = '<i class="fa-solid fa-wrench" style="font-size:10px;margin-right:4px;color:#F5A623"></i>';
  else if (type === 'thinking') icon = '<i class="fa-solid fa-brain" style="font-size:10px;margin-right:4px;color:#7d849a"></i>';
  else if (type === 'error') icon = '<i class="fa-solid fa-circle-exclamation" style="font-size:10px;margin-right:4px;color:#FF6B81"></i>';
  else if (type === 'result') icon = '<i class="fa-solid fa-circle-check" style="font-size:10px;margin-right:4px;color:#00E5A0"></i>';
  else if (type === 'tool_result') icon = '<i class="fa-solid fa-arrow-turn-down" style="font-size:9px;margin-right:4px;color:#464d65"></i>';
  var line = '<div style="color:' + c + ';padding:2px 0;' + (type === 'thinking' ? 'font-style:italic;' : '') + '">';
  line += icon + esc(content);
  if (extra) line += ' <span style="color:#464d65;font-size:9px">' + extra + '</span>';
  line += '</div>';
  el.innerHTML += line;
  el.scrollTop = el.scrollHeight;
}

function updateResult() {
  var rc = document.getElementById('agResultCard');
  var rr = document.getElementById('agResult');
  var rm = document.getElementById('agResultMeta');
  if (!rc || !rr) return;
  if (agResultText.trim()) {
    rc.style.display = '';
    var html = agResultText
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
        return '<pre style="background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:12px;overflow-x:auto;margin:8px 0;font-family:Space Grotesk,monospace;font-size:12px;line-height:1.6;color:#7d849a;white-space:pre-wrap">' + code.trim() + '</pre>';
      })
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e8ebf2">$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(0,229,160,.12);color:#00E5A0;padding:1px 6px;border-radius:4px;font-family:Space Grotesk,monospace;font-size:11px">$1</code>')
      .replace(/\n/g, '<br>');
    rr.innerHTML = html;
    if (rm && agToolsUsed.length) rm.textContent = '· 工具调用: ' + agToolsUsed.join(', ');
  }
}

function copyResult() {
  navigator.clipboard.writeText(agResultText);
  toast('已复制', 'fa-copy', '#00D4FF');
}

function renderAgentEvent(d) {
  if (!d || d.type === 'heartbeat') return;
  if (d.type === 'done') {
    appendLog('system', '会话结束');
    return;
  }
  if (d.type === 'error') {
    appendLog('error', d.text || '未知错误');
    return;
  }
  if (d.type === 'assistant') {
    var blocks = d.blocks || [];
    blocks.forEach(function(b) {
      if (b.type === 'text') {
        appendLog('text', b.text);
        agResultText += b.text + '\n';
        updateResult();
      }
      else if (b.type === 'thinking') appendLog('thinking', b.text);
      else if (b.type === 'tool_use') {
        appendLog('tool_use', b.name, 'id: ' + b.id.slice(0, 12));
        if (agToolsUsed.indexOf(b.name) === -1) agToolsUsed.push(b.name);
      }
      else if (b.type === 'tool_result') appendLog(b.is_error ? 'tool_error' : 'tool_result', (b.content || '').slice(0, 300), b.is_error ? '错误' : '');
    });
    return;
  }
  if (d.type === 'result') {
    document.getElementById('agTurnsStat').textContent = d.num_turns || '-';
    document.getElementById('agTurnsStat').style.color = '#F5A623';
    if (d.total_cost_usd != null) {
      document.getElementById('agCostStat').textContent = '$' + d.total_cost_usd.toFixed(4);
      document.getElementById('agCostStat').style.color = '#00D4FF';
    }
    appendLog('result', '完成 · ' + (d.num_turns || '?') + ' 轮 · $' + ((d.total_cost_usd || 0).toFixed(4)) + ' · ' + (d.duration_ms ? (d.duration_ms/1000).toFixed(1)+'s' : ''));
    if (d.errors && d.errors.length) d.errors.forEach(function(e) { appendLog('error', e); });
    if (d.is_error) appendLog('error', 'Agent 执行异常');
    updateResult();
    return;
  }
  if (d.type === 'user') {
    var blks = d.blocks || [];
    blks.forEach(function(b) { if (b.type === 'text') appendLog('system', '[用户] ' + b.text); });
    return;
  }
  if (d.type === 'stderr') {
    appendLog('stderr', d.text);
    return;
  }
  if (d.type === 'system') {
    appendLog('system', '[系统] ' + (d.subtype || '') + ' · cwd: ' + (d.data || ''));
    return;
  }
  appendLog('system', JSON.stringify(d).slice(0, 200));
}

async function startAgent() {
  var prompt = document.getElementById('agPrompt');
  if (!prompt || !prompt.value.trim()) return;
  stopAgent();
  clearAgentLog();
  appendLog('system', '正在启动 Agent...');
  document.getElementById('agBtn').style.display = 'none';
  document.getElementById('agStopBtn').style.display = '';
  document.getElementById('agStat').textContent = '运行中';
  document.getElementById('agStat').style.color = '#F5A623';
  document.getElementById('agTurnsStat').textContent = '-';
  document.getElementById('agCostStat').textContent = '-';
  try {
    var cwd = document.getElementById('agCwd');
    var turns = document.getElementById('agTurns');
    var data = await api('POST', '/agent/chat', {
      prompt: prompt.value,
      cwd: cwd ? cwd.value : '.',
      max_turns: turns ? parseInt(turns.value) : 10
    });
    var streamUrl = API + '/agent/chat/' + data.task_id + '/stream';
    if (authToken) streamUrl += '?access_token=' + encodeURIComponent(authToken);
    agEvt = new EventSource(streamUrl);
    agEvt.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        renderAgentEvent(d);
        if (d.type === 'done') finishAgent(d.type === 'error' ? '错误' : '完成', d.type === 'error' ? '#FF6B81' : '#00E5A0');
      } catch(ex) {}
    };
    agEvt.onerror = function() {
      finishAgent('连接断开', '#FF6B81');
    };
  } catch(e) {
    appendLog('error', '启动失败: ' + e.message);
    finishAgent('失败', '#FF6B81');
  }
}

function finishAgent(status, color) {
  if (agEvt) { agEvt.close(); agEvt = null; }
  document.getElementById('agBtn').style.display = '';
  document.getElementById('agStopBtn').style.display = 'none';
  document.getElementById('agStat').textContent = status;
  document.getElementById('agStat').style.color = color;
}

function stopAgent() {
  if (agEvt) { agEvt.close(); agEvt = null; }
  document.getElementById('agBtn').style.display = '';
  document.getElementById('agStopBtn').style.display = 'none';
  document.getElementById('agStat').textContent = '已停止';
  document.getElementById('agStat').style.color = '#FF6B81';
  appendLog('system', '已手动停止');
}

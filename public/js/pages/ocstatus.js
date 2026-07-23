/* ===== OpenClaw 状态面板 ===== */
pages.ocstatus = async function() {
  var h = '';

  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">OpenClaw 状态</span>';
  h += '<span id="ocStatBadge" style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--border);color:var(--text-muted)">加载中...</span>';
  h += '</div>';
  h += '<button class="btn" onclick="refreshOcStatus()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-rotate"></i> 刷新</button>';
  h += '</div>';

  h += '<div id="ocStatusContent" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">';
  h += '<div class="card" style="padding:16px;text-align:center;color:var(--text-muted)"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';
  h += '</div>';

  setTimeout(refreshOcStatus, 100);
  return h;
};

async function refreshOcStatus() {
  var el = document.getElementById('ocStatusContent');
  var badge = document.getElementById('ocStatBadge');
  if (!el) return;

  try {
    var s = await api('GET', '/openclaw/status');

    // Badge
    if (!s.enabled) {
      badge.innerHTML = '未启用';
      badge.style.background = 'var(--border)'; badge.style.color = 'var(--text-muted)';
    } else if (!s.gateway.reachable) {
      badge.innerHTML = '<i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px;color:#ef4444"></i>离线';
      badge.style.background = '#ef444420'; badge.style.color = '#ef4444';
    } else {
      badge.innerHTML = '<i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px;color:#10b981"></i>运行中';
      badge.style.background = '#10b98120'; badge.style.color = '#10b981';
    }

    if (!s.enabled) {
      el.innerHTML = '<div class="card" style="padding:24px;text-align:center;grid-column:1/-1"><i class="fa-solid fa-circle-info" style="font-size:32px;display:block;margin-bottom:12px;opacity:.15"></i><p style="font-weight:600;color:var(--text)">OpenClaw 未启用</p><p style="font-size:11px;color:var(--text-muted);margin-top:4px">请在 .env 中设置 OPENCLAW_ENABLED=true</p></div>';
      return;
    }

    var h = '';

    // ── 网关状态 ──
    h += '<div class="card" style="padding:16px">';
    h += '<div class="card-t" style="margin-bottom:12px"><i class="fa-solid fa-server"></i> 网关</div>';
    h += statusRow('状态', s.gateway.reachable
      ? '<span style="color:#10b981"><i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px"></i>在线</span>'
      : '<span style="color:#ef4444"><i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px"></i>离线</span>');
    if (s.gateway.status) h += statusRow('详情', s.gateway.status);
    h += '</div>';

    // ── 容器状态 ──
    h += '<div class="card" style="padding:16px">';
    h += '<div class="card-t" style="margin-bottom:12px"><i class="fa-brands fa-docker"></i> Docker 容器</div>';
    h += statusRow('运行', s.container.running
      ? '<span style="color:#10b981"><i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px"></i>是</span>'
      : '<span style="color:#ef4444"><i class="fa-solid fa-circle" style="font-size:6px;margin-right:4px"></i>否</span>');
    if (s.container.status) h += statusRow('状态', s.container.status);
    if (s.container.image) h += statusRow('镜像', s.container.image.split(':').pop());
    if (s.container.started_at) h += statusRow('启动时间', s.container.started_at.slice(0, 19).replace('T', ' '));
    h += '</div>';

    // ── Agent（单 main） ──
    h += '<div class="card" style="padding:16px">';
    h += '<div class="card-t" style="margin-bottom:12px"><i class="fa-solid fa-robot"></i> 主 Agent</div>';
    h += '<div style="display:flex;gap:12px;margin-bottom:12px">';
    h += statBox((s.agents && s.agents.length) || 0, 'Agent', '#3b6df0');
    h += statBox(s.active_sessions || 0, '活跃会话', '#10b981');
    h += '</div>';
    if (s.agents && s.agents.length) {
      h += '<div style="max-height:200px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#464d65 transparent">';
      s.agents.forEach(function(a) {
        h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-light);font-size:12px">';
        h += '<span style="flex:1;color:var(--text);font-weight:500">' + esc(a.name) + '</span>';
        if (a.is_default) h += '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(59,109,240,.1);color:#3b6df0">主</span>';
        h += '<span style="font-size:10px;color:var(--text-muted)">' + esc(a.id) + '</span>';
        h += '</div>';
      });
      h += '</div>';
    }
    h += '</div>';

    // ── 模型 ──
    h += '<div class="card" style="padding:16px">';
    h += '<div class="card-t" style="margin-bottom:12px"><i class="fa-solid fa-microchip"></i> 模型提供商</div>';
    if (s.model_provider) {
      h += statusRow('名称', s.model_provider.name || '-');
      h += statusRow('协议', s.model_provider.api || '-');
      h += statusRow('端点', '<span style="font-size:11px;word-break:break-all">' + esc(s.model_provider.base_url || '-') + '</span>');
      if (s.model_provider.models && s.model_provider.models.length) {
        h += '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">模型：' + s.model_provider.models.join(', ') + '</div>';
      }
    } else {
      h += '<div style="color:var(--text-muted);font-size:12px">未配置</div>';
    }
    h += '</div>';

    el.className = '';
    el.style.display = 'grid';
    el.style.gridTemplateColumns = '1fr 1fr';
    el.style.gap = '16px';
    el.innerHTML = h;

  } catch(e) {
    badge.innerHTML = '错误';
    badge.style.background = '#ef444420'; badge.style.color = '#ef4444';
    el.className = '';
    el.style.display = 'grid';
    el.style.gridTemplateColumns = '1fr 1fr';
    el.style.gap = '16px';
    el.innerHTML = '<div class="card" style="padding:16px;text-align:center;grid-column:1/-1;color:#ef4444"><i class="fa-solid fa-triangle-exclamation"></i> ' + esc(e.message) + '</div>';
  }
}

function statusRow(label, value) {
  return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-light);font-size:12px"><span style="color:var(--text-muted)">' + label + '</span><span style="color:var(--text);font-weight:500">' + value + '</span></div>';
}

function statBox(num, label, color) {
  return '<div style="flex:1;text-align:center;padding:12px 8px;border-radius:10px;background:' + color + '10;border:1px solid ' + color + '20">'
    + '<div style="font-family:\'Space Grotesk\';font-size:24px;font-weight:700;color:' + color + '">' + num + '</div>'
    + '<div style="font-size:10px;color:var(--text-muted);margin-top:4px">' + label + '</div></div>';
}

/* ===== Profile Page ===== */
var AI_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek（Anthropic协议）',
    base_url: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash']
  },
  {
    id: 'anthropic',
    name: 'Anthropic（Claude）',
    base_url: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-5']
  },
  {
    id: 'custom',
    name: '自定义（Anthropic协议）',
    base_url: '',
    models: []
  }
];

function findProviderByUrl(url) {
  if (!url) return null;
  var clean = url.replace(/\/+$/, '').toLowerCase();
  for (var i = 0; i < AI_PROVIDERS.length; i++) {
    var p = AI_PROVIDERS[i];
    if (p.base_url && p.base_url.replace(/\/+$/, '').toLowerCase() === clean) return p;
  }
  if (clean.indexOf('deepseek') >= 0) return AI_PROVIDERS[0];
  if (clean.indexOf('anthropic') >= 0) return AI_PROVIDERS[1];
  return null;
}
pages.profile = async function() {
  var h = '<div class="card mb24" id="profCard"><div class="card-t"><i class="fa-solid fa-sliders"></i>个人配置 <span class="api-t api-g" style="margin-left:auto">GET/PUT /user/settings</span></div><div id="profInner" style="color:#7d849a;font-size:13px">加载中…</div></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-lock"></i>修改密码 <span class="api-t api-g" style="margin-left:auto">PUT /auth/password</span></div>';
  h += '<div class="auth-field mb12"><label class="auth-lbl">当前密码</label><input class="inp" type="password" id="pf_cur_pwd" placeholder="输入当前密码"></div>';
  h += '<div class="auth-field mb12"><label class="auth-lbl">新密码（至少 8 位）</label><input class="inp" type="password" id="pf_new_pwd" placeholder="输入新密码"></div>';
  h += '<div class="auth-field mb12"><label class="auth-lbl">确认新密码</label><input class="inp" type="password" id="pf_new_pwd2" placeholder="再次输入新密码"></div>';
  h += '<button type="button" class="btn bp" onclick="changePassword()"><i class="fa-solid fa-key"></i> 修改密码</button></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-coins"></i>Token 使用情况 <span class="api-t api-g" style="margin-left:auto">GET /dashboard/usage</span></div><div id="profTokenStats" style="color:#7d849a;font-size:13px">加载中…</div></div>';
  return h;
};

async function fetchUserSettings() {
  try {
    return await api('GET', '/user/settings');
  } catch (e1) {
    if (e1.message === 'Not Found' || (e1.message && e1.message.indexOf('Not Found') >= 0)) {
      return await api('GET', '/auth/settings');
    }
    throw e1;
  }
}

async function putUserSettings(body) {
  try {
    return await api('PUT', '/user/settings', body);
  } catch (e1) {
    if (e1.message === 'Not Found' || (e1.message && e1.message.indexOf('Not Found') >= 0)) {
      return await api('PUT', '/auth/settings', body);
    }
    throw e1;
  }
}

async function loadProfilePage() {
  var inner = document.getElementById('profInner');
  if (!inner) return;
  try {
    var s = await fetchUserSettings();
    applyTheme(s.theme_color || 'aurora');
    var h = '<p class="mb16" style="font-size:12px;color:#464d65">以下配置仅对当前登录用户生效。密钥类字段留空表示不修改；在输入框中清空后点「清除主模型 Key」等按钮可删除已保存的值并回退到服务器环境变量。</p>';

    // 检测当前保存的 URL 是否匹配某个预设厂商
    var currentProvider = findProviderByUrl(s.ai_api_base || '');
    var providerId = currentProvider ? currentProvider.id : 'custom';
    var isCustom = providerId === 'custom';

    // 厂商选择器
    h += '<div class="auth-field mb12"><label class="auth-lbl">API 厂商</label>';
    h += '<select class="inp" id="pf_provider" onchange="onProviderChange()" style="font-size:12px">';
    for (var pi = 0; pi < AI_PROVIDERS.length; pi++) {
      var pv = AI_PROVIDERS[pi];
      h += '<option value="' + pv.id + '"' + (pv.id === providerId ? ' selected' : '') + '>' + pv.name + (pv.id !== 'custom' ? '  (' + pv.base_url + ')' : '') + '</option>';
    }
    h += '</select></div>';

    // Base URL（预设时隐藏，自定义时显示）
    h += '<div class="auth-field mb12" id="pf_base_url_group" style="display:' + (isCustom ? 'block' : 'none') + '">';
    h += '<label class="auth-lbl">自定义 API Base URL</label>';
    h += '<input class="inp" id="pf_ai_base" placeholder="https://api.example.com/v1" value="' + esc(s.ai_api_base || '') + '"></div>';
    h += '<input type="hidden" id="pf_ai_base_preset" value="' + (currentProvider ? esc(currentProvider.base_url) : '') + '">';

    // 模型名称
    h += '<div class="auth-field mb12"><label class="auth-lbl">主模型名称 (Model)</label>';
    var models = (currentProvider && !isCustom) ? currentProvider.models : [];
    var currentModel = s.ai_model || '';
    var modelInList = models.indexOf(currentModel) >= 0;
    if (models.length) {
      h += '<select class="inp" id="pf_ai_model_sel" onchange="onModelSelectChange()" style="font-size:12px">';
      for (var mi = 0; mi < models.length; mi++) {
        h += '<option value="' + models[mi] + '"' + (models[mi] === currentModel ? ' selected' : '') + '>' + models[mi] + '</option>';
      }
      if (!modelInList && currentModel) {
        h += '<option value="' + esc(currentModel) + '" selected>' + esc(currentModel) + ' (已保存)</option>';
      }
      h += '</select>';
      h += '<input type="hidden" id="pf_ai_model" value="' + esc(currentModel || (models.length ? models[0] : '')) + '">';
    } else {
      h += '<input class="inp" id="pf_ai_model" placeholder="如 glm-4 / deepseek-chat" value="' + esc(currentModel) + '">';
    }
    h += '</div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">主模型 API Key（SK）</label>';
    h += '<input class="inp" type="password" id="pf_ai_key" placeholder="'+(s.ai_api_key_set ? '已保存 · 留空不修改 · 当前：'+esc(s.ai_api_key_masked||'***') : '未设置，填写后保存')+'"></div>';
    h += '<div style="margin-bottom:20px"><button type="button" class="btn bdr" style="font-size:11px" onclick="document.getElementById(\'pf_ai_key\').value=\'\';saveProfileField(\'ai_api_key\',\'\')">清除主模型 Key</button></div>';
    // Agent 配置暂时注释（2025-05）
    // h += '<div style="height:1px;background:var(--border);margin:18px 0"></div>';
    // h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · Anthropic Base URL（可选）</label><input class="inp" id="pf_ant_base" placeholder="留空使用 .env" value="'+esc(s.anthropic_base_url||'')+'"></div>';
    // h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · 模型 ID</label><input class="inp" id="pf_ant_model" placeholder="claude-sonnet-4-20250514" value="'+esc(s.anthropic_model||'')+'"></div>';
    // h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · Anthropic API Key（SK）</label>';
    // h += '<input class="inp" type="password" id="pf_ant_key" placeholder="'+(s.anthropic_api_key_set ? '已保存 · 留空不修改 · '+esc(s.anthropic_api_key_masked||'***') : '未设置，可与主模型 Key 不同')+'"></div>';
    // h += '<div class="mb16"><button type="button" class="btn bdr" style="font-size:11px" onclick="document.getElementById(\'pf_ant_key\').value=\'\';saveProfileField(\'anthropic_api_key\',\'\')">清除 Agent Key</button></div>';
    h += '<div style="height:1px;background:var(--border);margin:20px 0"></div>';
    h += '<label class="auth-lbl" style="margin-bottom:8px"><i class="fa-solid fa-robot"></i> OpenClaw Agent</label>';
    h += '<p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">将上方 API 厂商和模型同步到 OpenClaw 网关（researcher openclaw.json，单 main agent），无需重复填写。</p>';
    h += '<button type="button" class="btn bp" style="font-size:12px;padding:8px 16px" onclick="applyOpenClawFromMain()"><i class="fa-solid fa-rocket"></i> 应用当前配置到 OpenClaw</button>';
    h += '<span style="font-size:10px;color:var(--text-muted);margin-left:8px">写入 researcher openclaw.json 并重启网关生效</span>';
    h += '<div style="margin-top:20px"><button type="button" class="btn bp" onclick="saveProfileForm()"><i class="fa-solid fa-floppy-disk"></i> 保存配置</button></div>';

    // 主题配色选择器
    h += '<div style="height:1px;background:var(--border);margin:20px 0"></div>';
    h += '<label class="auth-lbl" style="margin-bottom:12px"><i class="fa-solid fa-palette"></i> 主题配色</label>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="themePicker">';
    for (var key in THEMES) {
      var t = THEMES[key];
      var active = s.theme_color === key;
      var isDark = key === 'dark';
      var previewBg = isDark ? '#1a1f2e' : '#ffffff';
      h += '<div class="theme-opt" data-theme="'+key+'" onclick="setTheme(\''+key+'\')" style="cursor:pointer;border-radius:10px;padding:14px 10px;text-align:center;border:2px solid '+(active ? t.accent : 'var(--border)')+';background:'+(active ? 'rgba(var(--accent-rgb),.08)' : 'var(--bg)')+';transition:all .2s ease">';
      h += '<div style="width:40px;height:28px;border-radius:6px;margin:0 auto 8px;background:'+previewBg+';border:1px solid '+(isDark ? '#2a3040' : '#e2e8f0')+';display:flex;align-items:center;justify-content:center;gap:3px;padding:4px">';
      h += '<div style="width:6px;height:6px;border-radius:50%;background:'+t.accent+'"></div>';
      h += '<div style="width:16px;height:2px;border-radius:1px;background:'+(isDark ? '#3a4050' : '#cbd5e1')+'"></div>';
      h += '</div>';
      h += '<div style="font-size:11px;font-weight:600;color:var(--text)">'+t.name+'</div>';
      h += '<div style="font-size:9px;color:var(--text-muted);margin-top:2px">'+(isDark ? '深色护眼' : '清新明亮')+'</div>';
      h += '</div>';
    }
    h += '</div>';

    inner.innerHTML = h;
  } catch (e) {
    inner.innerHTML = '<div class="err-box">无法加载：'+esc(e.message)+'</div>';
  }

  await loadProfileStats();
}

/* ===== 厂商选择切换逻辑 ===== */
function onProviderChange() {
  var sel = document.getElementById('pf_provider');
  if (!sel) return;
  var pid = sel.value;
  var provider = null;
  for (var i = 0; i < AI_PROVIDERS.length; i++) {
    if (AI_PROVIDERS[i].id === pid) { provider = AI_PROVIDERS[i]; break; }
  }
  if (!provider) return;

  var isCustom = provider.id === 'custom';
  var baseGroup = document.getElementById('pf_base_url_group');
  var basePreset = document.getElementById('pf_ai_base_preset');

  // 切换 Base URL 显示
  if (isCustom) {
    if (baseGroup) baseGroup.style.display = 'block';
    if (basePreset) basePreset.value = '';
  } else {
    if (baseGroup) baseGroup.style.display = 'none';
    if (basePreset) basePreset.value = provider.base_url;
  }

  // 重建模型选择器
  var modelField = document.getElementById('pf_ai_model');
  var modelSel = document.getElementById('pf_ai_model_sel');
  var parent = (modelSel || modelField).parentNode;

  if (!isCustom && provider.models.length) {
    // 用 select 替换
    var h = '<label class="auth-lbl">主模型名称 (Model)</label>';
    h += '<select class="inp" id="pf_ai_model_sel" onchange="onModelSelectChange()" style="font-size:12px">';
    for (var mi = 0; mi < provider.models.length; mi++) {
      h += '<option value="' + provider.models[mi] + '">' + provider.models[mi] + '</option>';
    }
    h += '</select>';
    h += '<input type="hidden" id="pf_ai_model" value="' + provider.models[0] + '">';
    parent.innerHTML = h;
  } else {
    // 用 input 替换
    var curVal = modelField ? modelField.value : '';
    parent.innerHTML = '<label class="auth-lbl">主模型名称 (Model)</label><input class="inp" id="pf_ai_model" placeholder="如 glm-4 / deepseek-chat" value="' + esc(curVal) + '">';
  }
}

function onModelSelectChange() {
  var sel = document.getElementById('pf_ai_model_sel');
  var hid = document.getElementById('pf_ai_model');
  if (sel && hid) {
    hid.value = sel.value;
  }
}

/* 切换主题：实时预览 → 保存到后端 → 更新选择器 UI */
async function setTheme(name) {
  applyTheme(name);
  try {
    await putUserSettings({ theme_color: name });
    var opts = document.querySelectorAll('#themePicker .theme-opt');
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var isActive = o.getAttribute('data-theme') === name;
      o.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
      o.style.background = isActive ? 'rgba(var(--accent-rgb),.08)' : 'transparent';
    }
    toast('主题已切换为 ' + (THEMES[name] ? THEMES[name].name : name), 'fa-check', 'var(--accent)');
  } catch (e) {
    toast('保存主题失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function loadProfileStats() {
  try {
    await loadProfileTokenStats();
  } catch (e) {
    toast('加载统计信息失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function loadProfileTokenStats() {
  var el = document.getElementById('profTokenStats');
  if (!el) return;
  try {
    var usage = await api('GET', '/dashboard/usage');
    var h = '<div style="padding:16px;border-radius:12px;background:rgba(59,109,240,.05);border:1px solid rgba(59,109,240,.1);margin-bottom:16px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    h += '<div><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Token 使用</div>';
    h += '<div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:var(--accent)">'+usage.tokens.estimated_used.toLocaleString()+' <span style="font-size:14px;color:var(--text-muted)">/ '+usage.tokens.limit.toLocaleString()+'</span></div></div>';
    h += '<div style="text-align:right"><div style="font-size:32px;font-weight:700;color:var(--accent)">'+usage.tokens.usage_percent+'%</div></div></div>';
    h += '<div style="height:8px;background:var(--border-light);border-radius:4px;overflow:hidden">';
    h += '<div style="width:'+Math.min(usage.tokens.usage_percent,100)+'%;height:100%;background:linear-gradient(90deg,var(--accent),#818cf8);transition:width .5s ease"></div></div>';
    h += '<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--text-muted)">';
    h += '<span>剩余: <strong style="color:var(--accent)">'+usage.tokens.remaining.toLocaleString()+'</strong> tokens</span>';
    h += '<span class="badge '+(usage.tokens.usage_percent > 80 ? 'bdg-r' : (usage.tokens.usage_percent > 50 ? 'bdg-y' : 'bdg-g'))+'">'+(usage.tokens.usage_percent > 80 ? '即将耗尽' : '正常使用')+'</span></div></div>';

    h += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">';
    h += '<div style="padding:12px;border-radius:10px;background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1)">';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">任务统计</div>';
    h += '<div style="font-size:13px;color:var(--text)">完成: <strong style="color:#10b981">'+usage.tasks.completed+'</strong> | 运行: <strong style="color:#f59e0b">'+usage.tasks.running+'</strong></div></div>';

    h += '<div style="padding:12px;border-radius:10px;background:rgba(139,92,246,.04);border:1px solid rgba(139,92,246,.1)">';
    h += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">数据统计</div>';
    h += '<div style="font-size:13px;color:var(--text)">Idea: <strong>'+usage.data.ideas+'</strong> | 算法: <strong>'+usage.data.algorithms+'</strong></div></div></div>';

    el.innerHTML = h;
  } catch (e) {
    el.innerHTML = '<div class="err-box">加载失败: '+esc(e.message)+'</div>';
  }
}

async function saveProfileField(field, val) {
  try {
    var body = {};
    body[field] = val;
    await putUserSettings(body);
    toast('已更新', 'fa-check', '#00E5A0');
    await loadProfilePage();
  } catch (e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function changePassword() {
  var cur = document.getElementById('pf_cur_pwd');
  var nu = document.getElementById('pf_new_pwd');
  var nu2 = document.getElementById('pf_new_pwd2');
  if (!cur || !nu || !nu2) return;
  var cv = cur.value, nv = nu.value, nv2 = nu2.value;
  if (!cv) { toast('请输入当前密码', 'fa-exclamation-circle', '#F5A623'); return; }
  if (!nv || nv.length < 8) { toast('新密码至少 8 位', 'fa-exclamation-circle', '#F5A623'); return; }
  if (nv !== nv2) { toast('两次输入的新密码不一致', 'fa-exclamation-circle', '#F5A623'); return; }
  if (cv === nv) { toast('新密码不能与当前密码相同', 'fa-exclamation-circle', '#F5A623'); return; }
  try {
    var data = await api('PUT', '/auth/password', { current_password: cv, new_password: nv });
    cur.value = ''; nu.value = ''; nu2.value = '';
    toast(data.message || '密码已修改', 'fa-check-circle', '#00E5A0');
    setTimeout(function() { doLogout(); }, 1200);
  } catch (e) {
    toast('修改失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function applyOpenClawFromMain() {
  // 从上方主模型配置读取当前值
  var presetBase = document.getElementById('pf_ai_base_preset');
  var manualBase = document.getElementById('pf_ai_base');
  var apiBase = (presetBase && presetBase.value) ? presetBase.value : ((manualBase && manualBase.value.trim()) || '');
  var apiKey = document.getElementById('pf_ai_key');
  var keyVal = apiKey ? apiKey.value : '';
  var modelEl = document.getElementById('pf_ai_model');
  var modelVal = modelEl ? modelEl.value.trim() : '';

  if (!apiBase && !keyVal) {
    toast('请先填写上方的 API Base URL 或 API Key', 'fa-exclamation-circle', '#F5A623');
    return;
  }
  try {
    toast('正在应用到 OpenClaw...', 'fa-spinner fa-spin', 'var(--accent)');
    var res = await api('POST', '/openclaw/apply-config', {
      api_key: keyVal || null,
      api_base: apiBase || null,
      api_model: modelVal || null
    });
    toast(res.message || '已应用', 'fa-check-circle', '#10b981');
  } catch (e) {
    toast('应用失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

async function saveProfileForm() {
  try {
    // Base URL: 预设厂商优先，其次手动输入（自定义模式）
    var presetBase = document.getElementById('pf_ai_base_preset');
    var manualBase = document.getElementById('pf_ai_base');
    var apiBase = (presetBase && presetBase.value) ? presetBase.value : ((manualBase && manualBase.value.trim()) || '');
    var apiModel = (document.getElementById('pf_ai_model') && document.getElementById('pf_ai_model').value.trim()) || '';
    var body = {
      ai_api_base: apiBase,
      ai_model: apiModel
    };
    // Agent 配置暂时注释（2025-05）
    // var ab = document.getElementById('pf_ant_base');
    // var am = document.getElementById('pf_ant_model');
    // if (ab) body.anthropic_base_url = ab.value.trim();
    // if (am) body.anthropic_model = am.value.trim();
    var k = document.getElementById('pf_ai_key');
    if (k && k.value) body.ai_api_key = k.value;
    await putUserSettings(body);
    toast('配置已保存', 'fa-check-circle', '#00E5A0');
    await loadProfilePage();
  } catch (e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

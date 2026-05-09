/* ===== Profile Page ===== */
pages.profile = async function() {
  var h = '<div class="card mb24" id="profCard"><div class="card-t"><i class="fa-solid fa-sliders"></i>个人配置 <span class="api-t api-g" style="margin-left:auto">GET/PUT /user/settings</span></div><div id="profInner" style="color:#7d849a;font-size:13px">加载中…</div></div>';
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
    h += '<div class="auth-field mb12"><label class="auth-lbl">主模型 API Base URL</label><input class="inp" id="pf_ai_base" placeholder="https://open.bigmodel.cn/api/paas/v4" value="'+esc(s.ai_api_base||'')+'"></div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">主模型名称 (Model)</label><input class="inp" id="pf_ai_model" placeholder="glm-4" value="'+esc(s.ai_model||'')+'"></div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">主模型 API Key（SK）</label>';
    h += '<input class="inp" type="password" id="pf_ai_key" placeholder="'+(s.ai_api_key_set ? '已保存 · 留空不修改 · 当前：'+esc(s.ai_api_key_masked||'***') : '未设置，填写后保存')+'"></div>';
    h += '<div style="margin-bottom:20px"><button type="button" class="btn bdr" style="font-size:11px" onclick="document.getElementById(\'pf_ai_key\').value=\'\';saveProfileField(\'ai_api_key\',\'\')">清除主模型 Key</button></div>';
    h += '<div style="height:1px;background:rgba(255,255,255,.06);margin:18px 0"></div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · Anthropic Base URL（可选）</label><input class="inp" id="pf_ant_base" placeholder="留空使用 .env" value="'+esc(s.anthropic_base_url||'')+'"></div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · 模型 ID</label><input class="inp" id="pf_ant_model" placeholder="claude-sonnet-4-20250514" value="'+esc(s.anthropic_model||'')+'"></div>';
    h += '<div class="auth-field mb12"><label class="auth-lbl">Agent · Anthropic API Key（SK）</label>';
    h += '<input class="inp" type="password" id="pf_ant_key" placeholder="'+(s.anthropic_api_key_set ? '已保存 · 留空不修改 · '+esc(s.anthropic_api_key_masked||'***') : '未设置，可与主模型 Key 不同')+'"></div>';
    h += '<div class="mb16"><button type="button" class="btn bdr" style="font-size:11px" onclick="document.getElementById(\'pf_ant_key\').value=\'\';saveProfileField(\'anthropic_api_key\',\'\')">清除 Agent Key</button></div>';
    h += '<button type="button" class="btn bp" onclick="saveProfileForm()"><i class="fa-solid fa-floppy-disk"></i> 保存配置</button>';

    // 主题配色选择器
    h += '<div style="height:1px;background:rgba(255,255,255,.06);margin:20px 0"></div>';
    h += '<label class="auth-lbl" style="margin-bottom:12px"><i class="fa-solid fa-palette"></i> 主题配色</label>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px" id="themePicker">';
    for (var key in THEMES) {
      var t = THEMES[key];
      var active = s.theme_color === key;
      h += '<div class="theme-opt" data-theme="'+key+'" onclick="setTheme(\''+key+'\')" style="cursor:pointer;border-radius:10px;padding:10px 8px;text-align:center;border:2px solid '+(active ? t.accent : 'rgba(255,255,255,.05)')+';background:'+(active ? 'rgba(var(--accent-rgb),.08)' : 'transparent')+';transition:all .2s ease">';
      h += '<div style="width:24px;height:24px;border-radius:50%;margin:0 auto 6px;background:'+t.accent+';box-shadow:0 2px 8px rgba('+t.rgb+',.3)"></div>';
      h += '<div style="font-size:10px;color:#b0b8c8">'+t.name+'</div></div>';
    }
    h += '</div>';

    inner.innerHTML = h;
  } catch (e) {
    inner.innerHTML = '<div class="err-box">无法加载：'+esc(e.message)+'</div>';
  }

  await loadProfileStats();
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
      o.style.borderColor = isActive ? 'var(--accent)' : 'rgba(255,255,255,.05)';
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
    var h = '<div style="padding:16px;border-radius:12px;background:rgba(0,212,255,.05);border:1px solid rgba(0,212,255,.1);margin-bottom:16px">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    h += '<div><div style="font-size:11px;color:#484f6e;margin-bottom:4px">Token 使用</div>';
    h += '<div style="font-family:\'Space Grotesk\';font-size:28px;font-weight:700;color:#00D4FF">'+usage.tokens.estimated_used.toLocaleString()+' <span style="font-size:14px;color:#6e768a">/ '+usage.tokens.limit.toLocaleString()+'</span></div></div>';
    h += '<div style="text-align:right"><div style="font-size:32px;font-weight:700;color:#00D4FF">'+usage.tokens.usage_percent+'%</div></div></div>';
    h += '<div style="height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden">';
    h += '<div style="width:'+Math.min(usage.tokens.usage_percent,100)+'%;height:100%;background:linear-gradient(90deg,#00D4FF,#00E5A0);transition:width .5s ease"></div></div>';
    h += '<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:#6e768a">';
    h += '<span>剩余: <strong style="color:#00D4FF">'+usage.tokens.remaining.toLocaleString()+'</strong> tokens</span>';
    h += '<span class="badge '+(usage.tokens.usage_percent > 80 ? 'bdg-r' : (usage.tokens.usage_percent > 50 ? 'bdg-y' : 'bdg-g'))+'">'+(usage.tokens.usage_percent > 80 ? '即将耗尽' : '正常使用')+'</span></div></div>';

    h += '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">';
    h += '<div style="padding:12px;border-radius:10px;background:rgba(0,229,160,.03);border:1px solid rgba(0,229,160,.08)">';
    h += '<div style="font-size:10px;color:#484f6e;margin-bottom:4px">任务统计</div>';
    h += '<div style="font-size:13px;color:#b0b8c8">完成: <strong style="color:#00E5A0">'+usage.tasks.completed+'</strong> | 运行: <strong style="color:#F5A623">'+usage.tasks.running+'</strong></div></div>';

    h += '<div style="padding:12px;border-radius:10px;background:rgba(167,139,250,.03);border:1px solid rgba(167,139,250,.08)">';
    h += '<div style="font-size:10px;color:#484f6e;margin-bottom:4px">数据统计</div>';
    h += '<div style="font-size:13px;color:#b0b8c8">Idea: <strong>'+usage.data.ideas+'</strong> | 算法: <strong>'+usage.data.algorithms+'</strong></div></div></div>';

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

async function saveProfileForm() {
  try {
    var body = {
      ai_api_base: (document.getElementById('pf_ai_base') && document.getElementById('pf_ai_base').value.trim()) || '',
      ai_model: (document.getElementById('pf_ai_model') && document.getElementById('pf_ai_model').value.trim()) || ''
    };
    var ab = document.getElementById('pf_ant_base');
    var am = document.getElementById('pf_ant_model');
    if (ab) body.anthropic_base_url = ab.value.trim();
    if (am) body.anthropic_model = am.value.trim();
    var k = document.getElementById('pf_ai_key');
    if (k && k.value) body.ai_api_key = k.value;
    var ak = document.getElementById('pf_ant_key');
    if (ak && ak.value) body.anthropic_api_key = ak.value;
    await putUserSettings(body);
    toast('配置已保存', 'fa-check-circle', '#00E5A0');
    await loadProfilePage();
  } catch (e) {
    toast('保存失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
}

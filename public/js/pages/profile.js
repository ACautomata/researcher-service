/* ===== Profile Page ===== */
pages.profile = async function() {
  return '<div class="card mb24" id="profCard"><div class="card-t"><i class="fa-solid fa-sliders"></i>个人配置 <span class="api-t api-g" style="margin-left:auto">GET/PUT /user/settings</span></div><div id="profInner" style="color:#7d849a;font-size:13px">加载中…</div></div>';
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
    inner.innerHTML = h;
  } catch (e) {
    inner.innerHTML = '<div class="err-box">无法加载：'+esc(e.message)+'</div>';
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

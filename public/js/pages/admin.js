/* ===== Admin 用户管理页面 ===== */
pages.admin = async function() {
  var h = '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-user-gear"></i> 用户管理 <span class="api-t api-g" style="margin-left:auto">GET/PUT/DELETE /auth/admin/users</span></div>';
  h += '<div id="adminInner" style="font-size:13px">加载中…</div></div>';
  return h;
};

async function loadAdminPage() {
  var inner = document.getElementById('adminInner');
  if (!inner) return;
  try {
    var data = await api('GET', '/auth/admin/users');
    var users = data.users || [];
    var h = '';
    // summary bar
    var adminCount = users.filter(function(u) { return u.role === 'admin'; }).length;
    h += '<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">';
    h += '<div class="stat-chip"><span class="stat-num">' + users.length + '</span> 总用户</div>';
    h += '<div class="stat-chip" style="border-color:rgba(167,139,250,.3)"><span class="stat-num" style="color:#A78BFA">' + adminCount + '</span> 管理员</div>';
    h += '<div class="stat-chip" style="border-color:rgba(0,229,160,.3)"><span class="stat-num" style="color:#00E5A0">' + (users.length - adminCount) + '</span> 普通用户</div>';
    h += '</div>';

    // table
    h += '<div style="overflow-x:auto">';
    h += '<table class="admin-tbl" style="width:100%;border-collapse:collapse;font-size:12px">';
    h += '<thead><tr style="background:rgba(255,255,255,.03);text-align:left">';
    h += '<th style="padding:10px 12px;border-bottom:1px solid var(--border);color:#6e768a;font-weight:500">ID</th>';
    h += '<th style="padding:10px 12px;border-bottom:1px solid var(--border);color:#6e768a;font-weight:500">用户名</th>';
    h += '<th style="padding:10px 12px;border-bottom:1px solid var(--border);color:#6e768a;font-weight:500">角色</th>';
    h += '<th style="padding:10px 12px;border-bottom:1px solid var(--border);color:#6e768a;font-weight:500">创建时间</th>';
    h += '<th style="padding:10px 12px;border-bottom:1px solid var(--border);color:#6e768a;font-weight:500">操作</th>';
    h += '</tr></thead><tbody>';

    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var isSelf = authUser && authUser.id === u.id;
      var isAdmin = u.role === 'admin';
      var rowBg = isSelf ? 'rgba(0,229,160,.04)' : (i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,.015)');
      h += '<tr style="background:' + rowBg + '">';
      h += '<td style="padding:10px 12px;border-bottom:1px solid var(--border-light);color:#6e768a">' + u.id + '</td>';
      h += '<td style="padding:10px 12px;border-bottom:1px solid var(--border-light)">' + esc(u.username) + (isSelf ? ' <span style="font-size:9px;color:#00E5A0;background:rgba(0,229,160,.12);padding:1px 6px;border-radius:4px">当前</span>' : '') + '</td>';
      h += '<td style="padding:10px 12px;border-bottom:1px solid var(--border-light)"><span class="badge ' + (isAdmin ? 'bdg-p' : 'bdg-g') + '">' + (isAdmin ? 'admin' : 'user') + '</span></td>';
      h += '<td style="padding:10px 12px;border-bottom:1px solid var(--border-light);color:#6e768a">' + (u.created_at || '-') + '</td>';
      h += '<td style="padding:10px 12px;border-bottom:1px solid var(--border-light)">';
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
      // 修改密码
      h += '<button type="button" class="btn bdr" style="font-size:10px;padding:3px 10px" onclick="adminOpenPwdModal(' + u.id + ',\'' + esc(u.username) + '\')"><i class="fa-solid fa-key"></i> 密码</button>';
      // 修改角色
      if (!isSelf) {
        h += '<button type="button" class="btn bdr" style="font-size:10px;padding:3px 10px" onclick="adminOpenRoleModal(' + u.id + ',\'' + esc(u.username) + '\',\'' + u.role + '\')"><i class="fa-solid fa-shield"></i> 角色</button>';
      }
      // 删除
      if (!isSelf) {
        h += '<button type="button" class="btn bdr" style="font-size:10px;padding:3px 10px;color:#FF6B81;border-color:rgba(255,107,129,.2)" onclick="adminOpenDelModal(' + u.id + ',\'' + esc(u.username) + '\')"><i class="fa-solid fa-trash-can"></i> 删除</button>';
      }
      h += '</div></td>';
      h += '</tr>';
    }
    h += '</tbody></table></div>';

    inner.innerHTML = h;
  } catch (e) {
    inner.innerHTML = '<div class="err-box">加载失败：' + esc(e.message) + '</div>';
  }
}

/* ===== Modal: 修改密码 ===== */
function adminOpenPwdModal(uid, uname) {
  var overlay = document.getElementById('adminModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'adminModalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease';
    overlay.onclick = function(e) { if (e.target === overlay) adminCloseModal(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<div class="card" style="width:400px;max-width:90vw;animation:fadeIn .25s ease" onclick="event.stopPropagation()">' +
    '<div class="card-t" style="border:none;padding-bottom:6px"><i class="fa-solid fa-key"></i> 重置密码 – ' + esc(uname) + '</div>' +
    '<div style="padding:4px 0 16px">' +
    '<div class="auth-field mb12"><label class="auth-lbl">新密码（至少 8 位）</label><input class="inp" type="password" id="adminPwdInput" placeholder="输入新密码"></div>' +
    '<div class="auth-field mb12"><label class="auth-lbl">确认密码</label><input class="inp" type="password" id="adminPwdConfirm" placeholder="再次输入新密码"></div>' +
    '<div id="adminPwdErr" style="color:#FF6B81;font-size:11px;margin-bottom:10px;display:none"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button type="button" class="btn" onclick="adminCloseModal()">取消</button>' +
    '<button type="button" class="btn bp" onclick="adminDoResetPwd(' + uid + ')"><i class="fa-solid fa-check"></i> 确认重置</button>' +
    '</div></div></div>';
  overlay.style.opacity = '1';
  overlay.style.pointerEvents = 'auto';
}

async function adminDoResetPwd(uid) {
  var pwd = document.getElementById('adminPwdInput').value;
  var pwd2 = document.getElementById('adminPwdConfirm').value;
  var errEl = document.getElementById('adminPwdErr');
  if (!pwd || pwd.length < 8) { errEl.textContent = '密码至少 8 位'; errEl.style.display = ''; return; }
  if (pwd !== pwd2) { errEl.textContent = '两次密码不一致'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';
  try {
    await api('PUT', '/auth/admin/users/' + uid + '/password', { password: pwd });
    toast('密码已重置', 'fa-check-circle', '#00E5A0');
    adminCloseModal();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
}

/* ===== Modal: 修改角色 ===== */
function adminOpenRoleModal(uid, uname, curRole) {
  var overlay = document.getElementById('adminModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'adminModalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease';
    overlay.onclick = function(e) { if (e.target === overlay) adminCloseModal(); };
    document.body.appendChild(overlay);
  }
  var isAdmin = curRole === 'admin';
  overlay.innerHTML = '<div class="card" style="width:380px;max-width:90vw;animation:fadeIn .25s ease" onclick="event.stopPropagation()">' +
    '<div class="card-t" style="border:none;padding-bottom:6px"><i class="fa-solid fa-shield"></i> 修改角色 – ' + esc(uname) + '</div>' +
    '<div style="padding:4px 0 16px">' +
    '<p style="font-size:12px;color:#6e768a;margin-bottom:14px">当前角色：<span class="badge ' + (isAdmin ? 'bdg-p' : 'bdg-g') + '">' + curRole + '</span></p>' +
    '<div style="display:flex;gap:12px;margin-bottom:16px">' +
    '<label style="flex:1;padding:12px;border-radius:10px;border:2px solid ' + (isAdmin ? 'var(--border)' : 'var(--accent)') + ';text-align:center;cursor:pointer;background:' + (isAdmin ? 'transparent' : 'rgba(var(--accent-rgb),.06)') + '" onclick="document.getElementById(\'adminRoleUser\').checked=true">' +
    '<input type="radio" name="adminRole" id="adminRoleUser" value="user"' + (!isAdmin ? ' checked' : '') + ' style="display:none">' +
    '<div style="font-size:22px;margin-bottom:4px">👤</div><div style="font-size:12px">user</div><div style="font-size:10px;color:#6e768a;margin-top:2px">普通用户</div></label>' +
    '<label style="flex:1;padding:12px;border-radius:10px;border:2px solid ' + (isAdmin ? 'var(--accent)' : 'var(--border)') + ';text-align:center;cursor:pointer;background:' + (isAdmin ? 'rgba(var(--accent-rgb),.06)' : 'transparent') + '" onclick="document.getElementById(\'adminRoleAdmin\').checked=true">' +
    '<input type="radio" name="adminRole" id="adminRoleAdmin" value="admin"' + (isAdmin ? ' checked' : '') + ' style="display:none">' +
    '<div style="font-size:22px;margin-bottom:4px">🛡️</div><div style="font-size:12px">admin</div><div style="font-size:10px;color:#6e768a;margin-top:2px">管理员</div></label>' +
    '</div>' +
    '<div id="adminRoleErr" style="color:#FF6B81;font-size:11px;margin-bottom:10px;display:none"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button type="button" class="btn" onclick="adminCloseModal()">取消</button>' +
    '<button type="button" class="btn bp" onclick="adminDoChangeRole(' + uid + ')"><i class="fa-solid fa-check"></i> 确认</button>' +
    '</div></div></div>';
  overlay.style.opacity = '1';
  overlay.style.pointerEvents = 'auto';
}

async function adminDoChangeRole(uid) {
  var selected = document.querySelector('input[name="adminRole"]:checked');
  var errEl = document.getElementById('adminRoleErr');
  if (!selected) { errEl.textContent = '请选择角色'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';
  try {
    var res = await api('PUT', '/auth/admin/users/' + uid + '/role', { role: selected.value });
    toast('角色已变更：' + res.previous_role + ' → ' + res.new_role, 'fa-check-circle', '#A78BFA');
    adminCloseModal();
    await loadAdminPage();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
}

/* ===== Modal: 删除用户 ===== */
function adminOpenDelModal(uid, uname) {
  var overlay = document.getElementById('adminModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'adminModalOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease';
    overlay.onclick = function(e) { if (e.target === overlay) adminCloseModal(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<div class="card" style="width:380px;max-width:90vw;animation:fadeIn .25s ease" onclick="event.stopPropagation()">' +
    '<div class="card-t" style="border:none;padding-bottom:6px;color:#FF6B81"><i class="fa-solid fa-exclamation-triangle"></i> 删除用户</div>' +
    '<div style="padding:4px 0 16px">' +
    '<p style="font-size:13px;margin-bottom:6px">确定要删除用户 <strong>' + esc(uname) + '</strong> 吗？</p>' +
    '<p style="font-size:11px;color:#6e768a;margin-bottom:16px">该用户的所有 pipeline 数据（文献、条目、问题、想法、算法等）将保留但解除关联（user_id 置为 NULL）。此操作不可撤销。</p>' +
    '<div id="adminDelErr" style="color:#FF6B81;font-size:11px;margin-bottom:10px;display:none"></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button type="button" class="btn" onclick="adminCloseModal()">取消</button>' +
    '<button type="button" class="btn" style="background:#FF6B81;color:#fff;border:none" onclick="adminDoDelete(' + uid + ',\'' + esc(uname) + '\')"><i class="fa-solid fa-trash-can"></i> 确认删除</button>' +
    '</div></div></div>';
  overlay.style.opacity = '1';
  overlay.style.pointerEvents = 'auto';
}

async function adminDoDelete(uid, uname) {
  var errEl = document.getElementById('adminDelErr');
  try {
    await api('DELETE', '/auth/admin/users/' + uid);
    toast('用户 ' + uname + ' 已删除', 'fa-check-circle', '#00E5A0');
    adminCloseModal();
    await loadAdminPage();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = '';
  }
}

function adminCloseModal() {
  var overlay = document.getElementById('adminModalOverlay');
  if (overlay) {
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    setTimeout(function() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 300);
  }
}

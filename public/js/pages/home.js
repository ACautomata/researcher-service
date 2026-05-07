/* ===== Home Page ===== */
pages.home = function() {
  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0"><i class="fa-solid fa-lock-open" style="font-size:22px"></i></div><div class="st-l">访客视图</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA">7+</div><div class="st-l">登录后可用页面</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00D4FF">1</div><div class="st-l">个人配置页</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#7d849a"><i class="fa-solid fa-book"></i></div><div class="st-l">文档始终可阅</div></div></div>';
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-circle-info"></i>开始使用</div>';
  h += '<p style="font-size:13px;color:#c0c5d4;line-height:1.75;margin-bottom:14px">当前为<strong style="color:#e8ebf2">访客</strong>：侧栏仅显示「欢迎」与「需求与API文档」。登录后可使用知识库、文献分析、Idea、算法、Agent、Obsidian，并在<strong style="color:#34D399">个人配置</strong>中填写自己的 API Key（SK）、接口地址与模型名（将覆盖仅对您账号生效；未填写时仍使用服务器 <code style="font-size:11px;background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px">.env</code> 默认值）。</p>';
  if (__PIPELINE_REQUIRES_LOGIN) {
    h += '<div class="err-box mb12" style="border-color:rgba(245,166,35,.25);color:#F5A623;background:rgba(245,166,35,.08)"><i class="fa-solid fa-shield-halved"></i> 服务器已开启 <strong>PIPELINE_REQUIRES_LOGIN</strong>：未登录时无法调用流水线相关接口，请先点击侧栏底部「账户」注册或登录。</div>';
  } else {
    h += '<div style="font-size:12px;color:#464d65;margin-bottom:14px">未登录也可浏览文档；若未开启强制登录，部分接口仍可能匿名可用（由服务器配置决定）。</div>';
  }
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap">';
  h += '<button type="button" class="btn bp" onclick="openAccountPanel()"><i class="fa-solid fa-right-to-bracket"></i> 登录 / 注册</button>';
  h += '<button type="button" class="btn" onclick="go(\'doc\')"><i class="fa-solid fa-book"></i> 查看 API 文档</button></div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-route"></i>登录后解锁</div>';
  h += '<ul style="font-size:12px;color:#7d849a;line-height:2;padding-left:18px">';
  h += '<li>知识库上传与 AI 解析</li><li>文献问题发现与外部检索</li><li>Idea 生成与评分</li><li>算法代码生成与测试</li><li>Claude Agent 控制台</li><li>Obsidian Vault 集成</li></ul></div>';
  return h;
};

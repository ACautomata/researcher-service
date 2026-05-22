/* ===== 科技价值分析 — 多维度评估科技价值，支撑决策与成果转化 ===== */

pages.dashboard = function() {
  var h = '';

  h += '<div class="flex-b mb24">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">科技价值分析</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="多维度评估科技价值，支撑决策与成果转化"></i></div>';
  h += '</div>';

  h += '<div class="card mb24" style="text-align:center;padding:32px 24px">';
  h += '<i class="fa-solid fa-arrow-right-arrow-left" style="font-size:40px;color:var(--accent);display:block;margin-bottom:16px;opacity:0.7"></i>';
  h += '<p style="font-size:14px;color:var(--text);font-weight:600;margin-bottom:8px">任务管理与系统监控已整合至「任务管理」页面</p>';
  h += '<p style="font-size:12px;color:var(--text-muted);margin-bottom:20px">研究流程可视化、异步任务跟踪、系统资源监控等功能已统一迁移。</p>';
  h += '<button class="btn bp" style="font-size:13px;padding:10px 24px" onclick="go(\'tasks\')"><i class="fa-solid fa-list-check"></i> 前往任务管理</button>';
  h += '</div>';

  // ── Quick Key Data ──
  h += '<div class="card mb24">';
  h += '<div class="card-t"><i class="fa-solid fa-database"></i>关键数据概览</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px" id="dashQuickData">';
  var kd = [
    {key:'papers', label:'文献数量', color:'#3b6df0'},
    {key:'entries', label:'知识条目', color:'#10b981'},
    {key:'problems', label:'发现问题', color:'#f59e0b'},
    {key:'ideas', label:'研究创意', color:'#8b5cf6'}
  ];
  for (var j = 0; j < kd.length; j++) {
    var d = kd[j];
    h += '<div style="padding:12px 16px;border-radius:8px;background:var(--bg);text-align:center">';
    h += '<div style="font-family:\'Space Grotesk\',sans-serif;font-size:24px;font-weight:700;color:'+d.color+'" id="dashQk_'+d.key+'">--</div>';
    h += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">'+d.label+'</div>';
    h += '</div>';
  }
  h += '</div></div>';

  return h;
};

async function loadDashboardQuick() {
  try {
    var usage = await api('GET', '/dashboard/usage');
    var data = usage.data || {};
    var keys = ['papers','entries','problems','ideas'];
    keys.forEach(function(k){
      var el = document.getElementById('dashQk_' + k);
      if (el) {
        var val = data[k] != null ? data[k] : 0;
        el.textContent = val;
      }
    });
  } catch(e) { /* ignore */ }
}

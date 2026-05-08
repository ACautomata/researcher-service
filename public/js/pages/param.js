/* ===== Param Optimization Page ===== */
// 模拟参数组数据
var DEMO_PARAM_GROUPS = [
  {
    name: 'd256_n4_l3_dp0.1_lr3e4_bs64',
    params: { d_model: 256, nhead: 4, num_layers: 3, dropout: 0.1, lr: 3e-4, batch_size: 64 },
    results: { accuracy: 82.3, val_loss: [2.3,1.8,1.4,1.1,0.92,0.78,0.68,0.61,0.56,0.52], val_accuracy: [55.1,62.3,68.5,72.8,76.2,78.9,80.5,81.7,82.1,82.3] }
  },
  {
    name: 'd512_n8_l6_dp0.1_lr3e4_bs64',
    params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: 3e-4, batch_size: 64 },
    results: { accuracy: 88.7, val_loss: [2.1,1.5,1.1,0.85,0.68,0.56,0.48,0.42,0.38,0.35], val_accuracy: [58.2,66.8,73.5,78.9,82.4,85.1,86.9,87.8,88.3,88.7] }
  },
  {
    name: 'd512_n8_l6_dp0.1_lr1e3_bs64',
    params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: 1e-3, batch_size: 64 },
    results: { accuracy: 85.1, val_loss: [2.5,2.1,1.7,1.5,1.3,1.2,1.1,1.05,1.0,0.97], val_accuracy: [52.1,58.5,63.8,68.2,72.5,76.1,79.8,82.4,84.1,85.1] }
  },
  {
    name: 'd512_n8_l6_dp0.3_lr3e4_bs64',
    params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.3, lr: 3e-4, batch_size: 64 },
    results: { accuracy: 86.2, val_loss: [2.4,1.9,1.5,1.2,1.0,0.88,0.78,0.71,0.65,0.61], val_accuracy: [53.5,60.1,66.2,71.5,75.8,79.2,82.1,84.0,85.3,86.2] }
  },
  {
    name: 'd512_n8_l6_dp0.1_lr3e4_bs32',
    params: { d_model: 512, nhead: 8, num_layers: 6, dropout: 0.1, lr: 3e-4, batch_size: 32 },
    results: { accuracy: 89.5, val_loss: [2.0,1.4,1.0,0.78,0.62,0.51,0.43,0.38,0.34,0.31], val_accuracy: [60.5,69.2,76.1,81.0,84.5,86.8,88.2,89.0,89.3,89.5] }
  },
];

var paramChartIdx = 0;

pages.param = async function() {
  var maxAcc = Math.max.apply(null, DEMO_PARAM_GROUPS.map(function(g){return g.results.accuracy;}));
  var h = '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">';
  h += '<div class="st-card" style="--accent:#F5A623"><div class="st-v" style="color:#F5A623">'+DEMO_PARAM_GROUPS.length+'</div><div class="st-l">参数组数</div></div>';
  h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-v" style="color:#00E5A0">'+maxAcc+'%</div><div class="st-l">最高准确率</div></div>';
  h += '<div class="st-card" style="--accent:#A78BFA"><div class="st-v" style="color:#A78BFA">'+DEMO_PARAM_GROUPS[0].params.d_model+'~'+DEMO_PARAM_GROUPS[1].params.d_model+'</div><div class="st-l">d_model 范围</div></div>';
  h += '</div>';

  // 参数组卡片
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-table-cells"></i>参数组对比 <span class="api-t api-g" style="margin-left:auto">演示数据</span></div>';
  var maxAcc = Math.max.apply(null, DEMO_PARAM_GROUPS.map(function(g){return g.results.accuracy;}));
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px" id="paramGroups">';
  for (var i = 0; i < DEMO_PARAM_GROUPS.length; i++) {
    var g = DEMO_PARAM_GROUPS[i];
    var best = g.results.accuracy >= maxAcc;
    h += '<div class="param-card" style="padding:16px;border-radius:14px;border:1px solid ' + (best ? 'rgba(var(--accent-rgb),.25)' : 'var(--border)') + ';background:' + (best ? 'rgba(var(--accent-rgb),.04)' : 'var(--bg-card)') + '">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">';
    h += '<span style="font-weight:700;font-size:13px;color:var(--text)">' + g.name + '</span>';
    if (best) h += '<span class="badge bdg-g">推荐</span>';
    h += '</div>';
    // 参数列表
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">';
    for (var key in g.params) {
      h += '<div style="font-size:11px;display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--border-light)">';
      h += '<span style="color:var(--text-muted)">' + key + '</span>';
      h += '<span style="color:var(--text);font-weight:600;font-family:\'Space Grotesk\'">' + g.params[key] + '</span>';
      h += '</div>';
    }
    h += '</div>';
    // 准确率
    h += '<div style="margin-top:10px;display:flex;align-items:center;gap:8px">';
    var ac = g.results.accuracy >= maxAcc ? '#00E5A0' : (g.results.accuracy >= maxAcc - 3 ? '#F5A623' : '#FF6B81');
    h += '<div style="font-size:11px;color:var(--text-muted)">准确率</div>';
    h += '<div style="flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.05);overflow:hidden">';
    h += '<div style="width:' + g.results.accuracy + '%;height:100%;background:' + ac + ';border-radius:3px;transition:width .5s"></div></div>';
    h += '<span style="font-size:12px;font-weight:700;color:' + ac + ';font-family:\'Space Grotesk\'">' + g.results.accuracy + '%</span>';
    h += '</div></div>';
  }
  h += '</div></div>';

  // 对比图表
  h += '<div class="card mb24"><div class="card-t"><i class="fa-solid fa-chart-bar"></i>准确率对比 <span class="api-t api-g" style="margin-left:auto">Bar</span></div>';
  h += '<div id="paramAccChart" style="height:260px"></div></div>';

  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-line"></i>验证准确率曲线 <span class="api-t api-y" style="margin-left:auto">Val Accuracy</span></div><div id="paramValAccChart" style="height:260px"></div></div>';
  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-chart-line"></i>验证损失曲线 <span class="api-t api-y" style="margin-left:auto">Val Loss</span></div><div id="paramValChart" style="height:260px"></div></div>';
  h += '</div>';

  // 图表渲染
  setTimeout(function() {
    renderAccChart();
    renderAccCurveChart();
    renderLossChart();
  }, 50);

  return h;
};

function renderAccChart() {
  var el = document.getElementById('paramAccChart');
  if (!el) return;
  var data = DEMO_PARAM_GROUPS;
  var maxVal = Math.max.apply(null, data.map(function(g){return g.results.accuracy;}));
  var w = 700, h = 220, barW = 70, gap = 40, startX = 60;
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  // Y axis
  svg += '<line x1="50" y1="10" x2="50" y2="200" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 0; p <= 100; p += 20) {
    var y = 200 - p/100 * 180;
    svg += '<text x="45" y="'+(y+4)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p+'%</text>';
    svg += '<line x1="50" y1="'+y+'" x2="'+(w-20)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var i = 0; i < data.length; i++) {
    var x = startX + i * (barW + gap);
    var bh = (data[i].results.accuracy / 100) * 180;
    var ac = data[i].results.accuracy >= maxVal ? '#00E5A0' : (data[i].results.accuracy >= maxVal - 3 ? '#F5A623' : '#FF6B81');
    svg += '<rect x="'+x+'" y="'+(200-bh)+'" width="'+barW+'" height="'+bh+'" fill="'+ac+'" rx="4" opacity="0.85"/>';
    svg += '<text x="'+(x+barW/2)+'" y="195" text-anchor="middle" fill="var(--text-muted)" font-size="9" transform="rotate(-30,'+(x+barW/2)+',195)">'+data[i].name.slice(0,4)+'</text>';
    svg += '<text x="'+(x+barW/2)+'" y="'+(195-bh-6)+'" text-anchor="middle" fill="'+ac+'" font-size="10" font-weight="700" font-family="\'Space Grotesk\'">'+data[i].results.accuracy+'%</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderAccCurveChart() {
  var el = document.getElementById('paramValAccChart');
  if (!el) return;
  var data = DEMO_PARAM_GROUPS;
  var w = 500, h = 220, padL = 45, padR = 20, padT = 10, padB = 30;
  var plotW = w - padL - padR, plotH = h - padT - padB;
  var colors = ['#3B82F6','#00E5A0','#F5A623','#A78BFA','#FF6B81'];
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  svg += '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 50; p <= 100; p += 10) {
    var y = (h - padB) - ((p-50) / 50) * plotH;
    svg += '<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p+'%</text>';
    svg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var e = 0; e < 10; e++) {
    var x = padL + (e / 9) * plotW;
    svg += '<text x="'+x+'" y="'+(h-padB+16)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">'+(e*5)+'</text>';
  }
  svg += '<text x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">Epoch</text>';
  for (var i = 0; i < data.length; i++) {
    var vals = data[i].results.val_accuracy;
    if (!vals) continue;
    var color = colors[i % colors.length];
    svg += '<polyline points="';
    for (var e = 0; e < vals.length; e++) {
      var x = padL + (e / (vals.length-1)) * plotW;
      var y = (h - padB) - ((vals[e] - 50) / 50) * plotH;
      svg += (e > 0 ? ' ' : '') + x + ',' + y;
    }
    svg += '" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
    var lx = padL + 10;
    var ly = padT + 14 + i * 18;
    svg += '<rect x="'+lx+'" y="'+(ly-6)+'" width="12" height="3" fill="'+color+'" rx="1"/>';
    svg += '<text x="'+(lx+18)+'" y="'+(ly+1)+'" fill="var(--text-muted)" font-size="9">'+data[i].name+'</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

function renderLossChart() {
  var el = document.getElementById('paramValChart');
  if (!el) return;
  var data = DEMO_PARAM_GROUPS;
  var maxLoss = 3.0;
  var w = 500, h = 220, padL = 45, padR = 20, padT = 10, padB = 30;
  var plotW = w - padL - padR, plotH = h - padT - padB;
  var colors = ['#3B82F6','#00E5A0','#F5A623','#A78BFA','#FF6B81'];
  var svg = '<svg width="100%" height="100%" viewBox="0 0 '+w+' '+h+'" style="background:transparent">';
  svg += '<line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(h-padB)+'" stroke="var(--border)" stroke-width="1"/>';
  for (var p = 0; p <= 3; p++) {
    var y = (h - padB) - (p / maxLoss) * plotH;
    svg += '<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+p.toFixed(1)+'</text>';
    svg += '<line x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'" stroke="var(--border-light)" stroke-width="1"/>';
  }
  for (var e = 0; e < 10; e++) {
    var x = padL + (e / 9) * plotW;
    svg += '<text x="'+x+'" y="'+(h-padB+16)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">'+(e*5)+'</text>';
  }
  svg += '<text x="'+(w/2)+'" y="'+(h-2)+'" text-anchor="middle" fill="var(--text-muted)" font-size="9">Epoch</text>';
  for (var i = 0; i < data.length; i++) {
    var vals = data[i].results.val_loss;
    if (!vals) continue;
    var color = colors[i % colors.length];
    svg += '<polyline points="';
    for (var e = 0; e < vals.length; e++) {
      var x = padL + (e / (vals.length-1)) * plotW;
      var y = (h - padB) - (vals[e] / maxLoss) * plotH;
      svg += (e > 0 ? ' ' : '') + x + ',' + y;
    }
    svg += '" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>';
    var lx = padL + 10;
    var ly = padT + 14 + i * 18;
    svg += '<rect x="'+lx+'" y="'+(ly-6)+'" width="12" height="3" fill="'+color+'" rx="1"/>';
    svg += '<text x="'+(lx+18)+'" y="'+(ly+1)+'" fill="var(--text-muted)" font-size="9">'+data[i].name+'</text>';
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

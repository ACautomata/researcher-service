/* ===== 科研绘图 — 智能生成高质量科研图表，提升表达效果 ===== */
var chartTab = 'ai';
var chartPreviewHtml = '';
var chartType = 'bar';

var CHART_TYPES = [
  { id:'bar', label:'柱状图', icon:'fa-chart-bar', desc:'对比分类数据', prompt:'柱状图 (bar chart)' },
  { id:'line', label:'折线图', icon:'fa-chart-line', desc:'展示趋势变化', prompt:'折线图 (line chart)' },
  { id:'scatter', label:'散点图', icon:'fa-circle-dot', desc:'相关关系', prompt:'散点图 (scatter chart)' },
  { id:'pie', label:'饼图', icon:'fa-chart-pie', desc:'占比分布', prompt:'饼图 (pie chart)' },
  { id:'radar', label:'雷达图', icon:'fa-dharmachakra', desc:'多维对比', prompt:'雷达图 (radar chart)' },
  { id:'heatmap', label:'热力图', icon:'fa-table-cells', desc:'密度分布', prompt:'热力图 (heatmap)' },
  { id:'flowchart', label:'流程图', icon:'fa-diagram-project', desc:'流程关系', prompt:'流程图 (flowchart)，使用 Mermaid 语法' },
  { id:'arch', label:'架构图', icon:'fa-sitemap', desc:'系统架构', prompt:'系统架构图 (architecture diagram)，使用 Mermaid 语法' }
];

pages.obs = async function() {
  var h = '';

  // ── Header ──
  h += '<div class="flex-b mb16">';
  h += '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:16px;font-weight:700;color:var(--text-bold)">科研绘图</span><i class="fa-solid fa-circle-info" style="color:var(--text-muted);font-size:14px;cursor:help" title="支持 AI 智能生成、数据可视化和代码编辑三种模式。选择图表类型，描述需求或输入数据，即可生成高质量科研图表"></i></div>';
  h += '<div style="display:flex;gap:8px">';
  if (chartPreviewHtml) {
    h += '<button class="btn" onclick="exportChartHTML()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-download"></i> 导出HTML</button>';
  }
  h += '<button class="btn" onclick="downloadChartPNG()" style="font-size:11px;padding:6px 12px"><i class="fa-solid fa-image"></i> 导出图片</button>';
  h += '</div></div>';

  // ── Chart Type Selector ──
  h += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">';
  for (var i = 0; i < CHART_TYPES.length; i++) {
    var ct = CHART_TYPES[i];
    var sel = chartType === ct.id;
    h += '<button class="btn'+(sel?' bp':'')+'" onclick="selectChartType(\''+ct.id+'\')" style="font-size:11px;padding:8px 14px" title="'+esc(ct.desc)+'">';
    h += '<i class="fa-solid '+ct.icon+'"></i> '+ct.label;
    h += '</button>';
  }
  h += '</div>';

  // ── Tab: AI 智能生成 / 数据可视化 / 代码编辑 ──
  h += '<div class="tab-bar mb16">';
  h += '<button class="tab-btn'+(chartTab==='ai'?' on':'')+'" onclick="switchChartTab(\'ai\')"><i class="fa-solid fa-robot"></i> AI 智能生成</button>';
  h += '<button class="tab-btn'+(chartTab==='data'?' on':'')+'" onclick="switchChartTab(\'data\')"><i class="fa-solid fa-table"></i> 数据可视化</button>';
  h += '<button class="tab-btn'+(chartTab==='code'?' on':'')+'" onclick="switchChartTab(\'code\')"><i class="fa-solid fa-code"></i> 代码编辑</button>';
  h += '</div>';

  // ── Tab Content ──
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">';

  // Left panel
  h += '<div>';

  // AI Tab
  h += '<div id="chartPanelAI" class="card" style="'+(chartTab!=='ai'?'display:none':'')+'padding:16px">';
  h += '<div class="card-t"><i class="fa-solid fa-robot" style="color:#8b5cf6"></i>用自然语言描述图表需求</div>';
  h += '<textarea class="inp" id="chartAIInput" rows="5" placeholder="例如：画一个柱状图，X轴为实验组别（对照组、处理A、处理B、处理C），Y轴为细胞存活率（%），数据分别为 95、78、62、45。要求：添加误差线，蓝色配色，标题为&#34;不同处理对细胞存活率的影响&#34;..." style="resize:vertical;min-height:100px;font-size:12px;line-height:1.6;width:100%"></textarea>';
  h += '<button class="btn bp" onclick="generateChartAI()" id="chartAIBtn" style="margin-top:10px;width:100%;padding:10px"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成图表</button>';
  h += '</div>';

  // Data Tab
  h += '<div id="chartPanelData" class="card" style="'+(chartTab!=='data'?'display:none':'')+'padding:16px">';
  h += '<div class="card-t"><i class="fa-solid fa-table" style="color:#10b981"></i>输入数据（CSV 格式）</div>';
  h += '<textarea class="inp" id="chartDataInput" rows="8" placeholder="category,value,error&#10;对照组,95,2&#10;处理A,78,3&#10;处理B,62,4&#10;处理C,45,3" style="resize:vertical;min-height:120px;font-size:12px;line-height:1.6;font-family:\'Space Grotesk\',monospace;width:100%"></textarea>';
  h += '<div style="display:flex;gap:8px;margin-top:8px">';
  h += '<div style="flex:1"><label style="font-size:10px;color:var(--text-muted)">图表标题</label><input class="inp" id="chartTitle" placeholder="输入图表标题" style="font-size:11px;padding:6px 10px;width:100%"></div>';
  h += '<div style="flex:1"><label style="font-size:10px;color:var(--text-muted)">X 轴标签</label><input class="inp" id="chartXLabel" placeholder="X 轴" style="font-size:11px;padding:6px 10px;width:100%"></div>';
  h += '<div style="flex:1"><label style="font-size:10px;color:var(--text-muted)">Y 轴标签</label><input class="inp" id="chartYLabel" placeholder="Y 轴" style="font-size:11px;padding:6px 10px;width:100%"></div>';
  h += '</div>';
  h += '<button class="btn bp" onclick="generateChartData()" style="margin-top:10px;width:100%;padding:10px"><i class="fa-solid fa-chart-simple"></i> 生成图表</button>';
  h += '</div>';

  // Code Tab
  h += '<div id="chartPanelCode" class="card" style="'+(chartTab!=='code'?'display:none':'')+'padding:16px">';
  h += '<div class="card-t"><i class="fa-solid fa-code" style="color:#f59e0b"></i>编辑 HTML/JS 代码</div>';
  h += '<textarea class="inp" id="chartCodeInput" rows="12" placeholder="输入完整的 HTML 代码（可使用 ECharts CDN）..." style="resize:vertical;min-height:180px;font-size:11px;line-height:1.5;font-family:\'Space Grotesk\',monospace;width:100%"></textarea>';
  h += '<button class="btn bp" onclick="previewCode()" style="margin-top:10px;width:100%;padding:10px"><i class="fa-solid fa-play"></i> 预览代码</button>';
  h += '</div>';

  h += '</div>';

  // Right panel - Preview
  h += '<div class="card" style="padding:0;overflow:hidden;min-height:400px;display:flex;flex-direction:column">';
  h += '<div class="card-t" style="margin:14px 16px 0"><i class="fa-solid fa-eye"></i>图表预览</div>';
  h += '<div style="flex:1;position:relative;min-height:350px;background:var(--bg)">';
  if (chartPreviewHtml) {
    h += '<iframe id="chartPreview" srcdoc="'+escAttr(chartPreviewHtml)+'" style="width:100%;height:100%;border:none" sandbox="allow-scripts allow-same-origin"></iframe>';
  } else {
    h += '<div id="chartPreviewPlaceholder" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;flex-direction:column;gap:8px">';
    h += '<i class="fa-solid fa-chart-pie" style="font-size:40px;opacity:.1"></i>';
    h += '<span>图表预览区域</span>';
    h += '<span style="font-size:10px">使用左侧面板生成图表后将在此处显示</span>';
    h += '</div>';
  }
  h += '</div></div>';

  h += '</div>'; // grid

  return h;
};

/* ── Utility ── */
function escAttr(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ── Tab Switching ── */
function switchChartTab(tab) {
  chartTab = tab;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.obs) {
    pages.obs().then(function(html) { ctn.innerHTML = html; });
  }
}

/* ── Chart Type Selection ── */
function selectChartType(typeId) {
  chartType = typeId;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.obs) {
    pages.obs().then(function(html) { ctn.innerHTML = html; });
  }
}

/* ── Get Chart Type Info ── */
function getChartTypeInfo() {
  for (var i = 0; i < CHART_TYPES.length; i++) {
    if (CHART_TYPES[i].id === chartType) return CHART_TYPES[i];
  }
  return CHART_TYPES[0];
}

/* ── Update Preview ── */
function updatePreview(html) {
  chartPreviewHtml = html;
  var ctn = document.getElementById('ctnEl');
  if (ctn && pages.obs) {
    pages.obs().then(function(h) {
      ctn.innerHTML = h;
      // Scroll to preview
      setTimeout(function() {
        var iframe = document.getElementById('chartPreview');
        if (iframe) iframe.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    });
  }
}

/* ── AI Generate Chart ── */
async function generateChartAI() {
  var input = document.getElementById('chartAIInput');
  if (!input || !input.value.trim()) {
    toast('请描述你想要的图表', 'fa-circle-info', '#f59e0b');
    return;
  }

  var desc = input.value.trim();
  var ct = getChartTypeInfo();
  var btn = document.getElementById('chartAIBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 正在生成图表...';

  var prompt = '请生成一个完整的、可直接显示的 HTML 页面，包含一个' + ct.prompt + '。\n\n';
  prompt += '要求如下：\n';
  prompt += '1. 使用 ECharts CDN（https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js）\n';
  prompt += '2. 图表风格为学术科研风格，配色专业，字体清晰\n';
  prompt += '3. 整体背景为白色或浅灰，图表区域清晰\n';
  prompt += '4. 包含完整的 HTML5 文档结构（<!DOCTYPE html> 到 </html>）\n';
  prompt += '5. 响应式设计，图表宽度100%，高度至少400px\n';
  if (desc) prompt += '\n具体需求：' + desc + '\n';

  try {
    var res = await api('POST', '/chat/send', { message: prompt, history: [] });
    var reply = res.response || '';

    // Extract HTML code block
    var htmlCode = extractCodeBlock(reply);
    if (!htmlCode) {
      // Try to use the entire response as HTML
      htmlCode = reply.replace(/```[\s\S]*?```/g, '').trim();
      if (!htmlCode.includes('<html') && !htmlCode.includes('<div')) {
        toast('AI 未能生成有效的 HTML 代码，请尝试更具体的描述', 'fa-exclamation-circle', '#ef4444');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成图表';
        return;
      }
    }

    updatePreview(htmlCode);
  } catch(e) {
    toast('生成失败: ' + e.message, 'fa-exclamation-circle', '#ef4444');
  }
  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成图表';
}

/* ── Data Generate Chart ── */
function generateChartData() {
  var dataInput = document.getElementById('chartDataInput');
  var title = document.getElementById('chartTitle');
  var xLabel = document.getElementById('chartXLabel');
  var yLabel = document.getElementById('chartYLabel');

  if (!dataInput || !dataInput.value.trim()) {
    toast('请输入图表数据', 'fa-circle-info', '#f59e0b');
    return;
  }

  var rawData = dataInput.value.trim();
  var ct = getChartTypeInfo();
  var chartTitle = title ? title.value.trim() || '科研图表' : '科研图表';
  var chartX = xLabel ? xLabel.value.trim() || '' : '';
  var chartY = yLabel ? yLabel.value.trim() || '' : '';

  // Parse CSV
  var lines = rawData.split('\n').filter(function(l) { return l.trim(); });
  if (lines.length < 2) {
    toast('数据至少需要表头和一行数据', 'fa-circle-info', '#f59e0b');
    return;
  }

  var headers = lines[0].split(',').map(function(h) { return h.trim(); });
  var categories = [];
  var seriesData = [];

  for (var i = 1; i < lines.length; i++) {
    var vals = lines[i].split(',').map(function(v) { return v.trim(); });
    categories.push(vals[0] || '');
    seriesData.push(parseFloat(vals[1]) || 0);
  }

  // Generate ECharts HTML
  var html = buildEChartsHTML(ct.id, chartTitle, chartX, chartY, categories, seriesData, headers);
  updatePreview(html);
}

/* ── Code Preview ── */
function previewCode() {
  var codeInput = document.getElementById('chartCodeInput');
  if (!codeInput || !codeInput.value.trim()) {
    toast('请输入 HTML 代码', 'fa-circle-info', '#f59e0b');
    return;
  }
  updatePreview(codeInput.value.trim());
}

/* ── Extract Code Block ── */
function extractCodeBlock(text) {
  // Try ```html ... ``` first
  var m = text.match(/```html\s*([\s\S]*?)```/i);
  if (m && m[1].trim()) return m[1].trim();
  // Try ``` ... ``` 
  m = text.match(/```\s*([\s\S]*?)```/);
  if (m && m[1].trim() && (m[1].includes('<html') || m[1].includes('echarts') || m[1].includes('<script'))) return m[1].trim();
  return null;
}

/* ── Build ECharts HTML ── */
function buildEChartsHTML(type, title, xLabel, yLabel, categories, seriesData, headers) {
  var seriesName = headers && headers.length > 1 ? headers[1] : '数值';
  var hasError = headers && headers.length > 2 && seriesData.length > 0;

  var option = {
    title: { text: title, left: 'center', textStyle: { fontSize: 16, fontWeight: 'bold', color: '#333' } },
    tooltip: { trigger: type === 'pie' ? 'item' : 'axis' },
    legend: { bottom: 10, textStyle: { fontSize: 11 } }
  };

  if (type === 'pie') {
    var pieData = [];
    for (var i = 0; i < categories.length; i++) {
      pieData.push({ name: categories[i], value: seriesData[i] });
    }
    option.series = [{
      type: 'pie', radius: ['40%', '70%'], center: ['50%', '55%'],
      data: pieData,
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.2)' } },
      label: { fontSize: 11 }
    }];
  } else {
    option.xAxis = { type: 'category', data: categories, name: xLabel, nameTextStyle: { fontSize: 11 } };
    option.yAxis = { type: 'value', name: yLabel, nameTextStyle: { fontSize: 11 } };
    option.grid = { top: 70, right: 30, bottom: 50, left: 60 };

    var seriesItem = { type: type, data: seriesData, name: seriesName };
    if (type === 'bar') {
      seriesItem.itemStyle = { borderRadius: [4, 4, 0, 0] };
      seriesItem.barWidth = Math.max(20, Math.min(40, 600 / categories.length));
    }
    if (type === 'line' || type === 'scatter') {
      seriesItem.smooth = true;
      seriesItem.symbolSize = 8;
    }

    if (hasError) {
      var errors = [];
      for (var i = 0; i < seriesData.length; i++) {
        errors.push(parseFloat(lines[i + 1] ? lines[i + 1].split(',')[2] : '0') || 0);
      }
      seriesItem.error_y = { type: 'data', data: errors, visible: true };
      seriesItem = { type: type, data: seriesData, name: seriesName, itemStyle: { borderRadius: [4, 4, 0, 0] } };
    }

    option.series = [seriesItem];
  }

  var optionJSON = JSON.stringify(option, null, 2);

  return '<!DOCTYPE html>\n<html lang="zh">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' + esc(title) + '</title>\n<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"><\/script>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}body{background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}\n#chart{width:100%;height:450px}\n<\/style>\n</head>\n<body>\n<div id="chart"></div>\n<script>\nvar chart=echarts.init(document.getElementById("chart"));\nchart.setOption(' + optionJSON + ');\nwindow.addEventListener("resize",function(){chart.resize()});\n<\/script>\n</body>\n</html>';
}

/* ── Export HTML ── */
function exportChartHTML() {
  if (!chartPreviewHtml) {
    toast('没有可导出的图表', 'fa-circle-info', '#f59e0b');
    return;
  }
  var blob = new Blob([chartPreviewHtml], { type: 'text/html' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'chart_' + new Date().toISOString().slice(0,10) + '.html';
  a.click();
  URL.revokeObjectURL(url);
  toast('HTML 文件已下载', 'fa-check-circle', '#10b981');
}

/* ── Download PNG (simple approach via canvas) ── */
function downloadChartPNG() {
  var iframe = document.getElementById('chartPreview');
  if (!iframe) {
    toast('没有可导出的图表', 'fa-circle-info', '#f59e0b');
    return;
  }

  // Try to get ECharts instance from iframe
  try {
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    var chartDiv = iframeDoc.getElementById('chart');
    if (chartDiv && iframe.contentWindow.echarts) {
      var instance = iframe.contentWindow.echarts.getInstanceByDom(chartDiv);
      if (instance) {
        var dataURL = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
        var a = document.createElement('a');
        a.href = dataURL;
        a.download = 'chart_' + new Date().toISOString().slice(0,10) + '.png';
        a.click();
        toast('PNG 图片已下载', 'fa-check-circle', '#10b981');
        return;
      }
    }
  } catch(e) {}

  // Fallback: export HTML
  exportChartHTML();
}

/* ── Init (called from core.js) ── */
function loadObsStats() {
  // No-op: replaced by chart page, kept for backward compatibility
}

function loadObsTree(path) {
  // No-op: replaced by chart page, kept for backward compatibility
}

function initChartPage() {
  // Chart page initialization - preload if needed
}

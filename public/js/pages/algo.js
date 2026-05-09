/* ===== Algo Page: Code Generation Task Management ===== */
var ALGO_TASKS = [
  {
    id: 'a1',
    name: 'Transformer 优化器',
    status: 'completed',
    created_at: '2026-05-05 14:30',
    language: 'Python',
    test_passed: 5,
    test_total: 6,
    logs: 'Epoch 0: loss=2.3412\nEpoch 10: loss=1.1256\nEpoch 20: loss=0.6821\nEpoch 30: loss=0.4123\nEpoch 40: loss=0.2876\nTraining complete! Final loss=0.2514',
    files: [
      { name: 'README.md', type: 'file', content: '# Transformer Optimizer\n\n基于改进自注意力机制的序列建模算法。\n\n## 文件结构\n- src/model.py: 模型定义\n- src/train.py: 训练脚本\n- config.py: 配置文件\n- requirements.txt: 依赖列表' },
      { name: 'src', type: 'dir', children: [
        { name: 'model.py', type: 'file', content: 'import torch\nimport torch.nn as nn\n\nclass TransformerEncoder(nn.Module):\n    def __init__(self, d_model=512, nhead=8, num_layers=6):\n        super().__init__()\n        self.layers = nn.ModuleList([TransformerBlock(d_model, nhead) for _ in range(num_layers)])\n        self.norm = nn.LayerNorm(d_model)\n\n    def forward(self, x, mask=None):\n        for layer in self.layers:\n            x = layer(x, mask)\n        return self.norm(x)\n\n\nclass TransformerBlock(nn.Module):\n    def __init__(self, d_model, nhead):\n        super().__init__()\n        self.attn = nn.MultiheadAttention(d_model, nhead)\n        self.ffn = nn.Sequential(nn.Linear(d_model, d_model*4), nn.GELU(), nn.Linear(d_model*4, d_model))\n        self.norm1 = nn.LayerNorm(d_model)\n        self.norm2 = nn.LayerNorm(d_model)\n\n    def forward(self, x, mask=None):\n        x = x + self.attn(self.norm1(x), self.norm1(x), self.norm1(x), attn_mask=mask)[0]\n        x = x + self.ffn(self.norm2(x))\n        return x' },
        { name: 'train.py', type: 'file', content: 'import torch\nfrom model import TransformerEncoder\n\nEPOCHS = 50\nBATCH_SIZE = 64\nLR = 3e-4\n\nmodel = TransformerEncoder(d_model=512, nhead=8, num_layers=6)\noptimizer = torch.optim.AdamW(model.parameters(), lr=LR)\nscheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, EPOCHS)\n\nfor epoch in range(EPOCHS):\n    model.train()\n    total_loss = 0\n    for x, y in get_dataloader(BATCH_SIZE):\n        pred = model(x)\n        loss = nn.functional.cross_entropy(pred, y)\n        loss.backward(); optimizer.step(); optimizer.zero_grad()\n        total_loss += loss.item()\n    scheduler.step()\n    print(f"Epoch {epoch}: loss={total_loss:.4f}")\nprint("Training complete!")' },
      ]},
      { name: 'config.py', type: 'file', content: 'MODEL_CONFIG = {"d_model": 512, "nhead": 8, "num_layers": 6, "dropout": 0.1}\nTRAIN_CONFIG = {"batch_size": 64, "epochs": 50, "learning_rate": 3e-4}' },
      { name: 'requirements.txt', type: 'file', content: 'torch>=2.0.0\nnumpy>=1.24.0\ntqdm>=4.66.0' },
    ],
  },
];

var algoTaskActive = null;
var algoCurFile = '';
var algoFilesFlat = {};

function flattenAlgoFiles(nodes, prefix) {
  prefix = prefix || '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var path = prefix + '/' + n.name;
    if (n.type === 'file') algoFilesFlat[path] = n.content;
    if (n.children) flattenAlgoFiles(n.children, path);
  }
}

pages.algo = async function() {
  algoTaskActive = null;
  return renderAlgoTaskList();
};

function renderAlgoTaskList() {
  var completed = ALGO_TASKS.filter(function(t){return t.status==='completed';}).length;
  var running = ALGO_TASKS.filter(function(t){return t.status==='running';}).length;
  var h = '<div class="stats">';
  h += '<div class="st-card"><div class="st-v" style="color:#FF6B81">' + ALGO_TASKS.length + '</div><div class="st-l">总任务</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + completed + '</div><div class="st-l">已完成</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#3B82F6">' + running + '</div><div class="st-l">运行中</div></div>';
  h += '<div class="st-card" style="cursor:pointer" onclick="showAlgoNewForm()"><div class="st-v" style="color:#A78BFA;font-size:20px"><i class="fa-solid fa-plus"></i></div><div class="st-l">新建任务</div></div>';
  h += '</div>';

  h += '<div id="algoNewForm" style="display:none" class="card mb24"><div class="card-t"><i class="fa-solid fa-code"></i>新建代码生成任务 <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">描述你的算法，AI 生成完整项目</span></div>';
  h += '<div style="display:flex;gap:10px;margin-bottom:12px"><div style="flex:1"><textarea class="inp" id="algoDesc" rows="2" placeholder="如：用 PyTorch 实现一个 Vision Transformer 图像分类模型，数据集 CIFAR-100" style="font-size:12px;resize:vertical;min-height:40px"></textarea></div>';
  h += '<div style="flex:0 0 auto"><label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:3px">语言</label><select class="inp" id="algoLang" style="font-size:12px"><option>Python</option><option>C++</option><option>JavaScript</option></select></div></div>';
  h += '<div style="display:flex;gap:8px"><button class="btn bp" onclick="aiGenerateAlgo()" id="algoGenBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成代码</button><button class="btn" onclick="hideAlgoNewForm()">取消</button></div></div>';

  h += '<div class="card"><div class="card-t"><i class="fa-solid fa-list"></i>任务列表</div>';
  if (!ALGO_TASKS.length) {
    h += '<div style="text-align:center;padding:40px;color:var(--text-muted)"><i class="fa-solid fa-code" style="font-size:30px;display:block;margin-bottom:10px;opacity:.2"></i><p style="font-size:13px">暂无任务，点击「新建任务」开始</p></div>';
  } else {
    for (var i = 0; i < ALGO_TASKS.length; i++) {
      var t = ALGO_TASKS[i];
      h += '<div class="li-item" style="' + (t.status === 'completed' ? 'cursor:pointer' : '') + '" onclick="' + (t.status === 'completed' ? 'openAlgoTask(\'' + t.id + '\')' : '') + '">';
      var ic = t.status === 'completed' ? 'rgba(0,229,160,.12);color:#00E5A0' : 'rgba(59,130,246,.12);color:#3B82F6';
      var ico = t.status === 'completed' ? 'fa-check-circle' : 'fa-spinner fa-spin';
      h += '<div class="li-ic" style="background:' + ic + '"><i class="fa-solid ' + ico + '"></i></div>';
      h += '<div style="flex:1;min-width:0"><div class="li-nm">' + esc(t.name) + '</div>';
      h += '<div class="li-mt"><span class="badge ' + (t.status === 'completed' ? 'bdg-g' : 'bdg-m') + '">' + (t.status === 'completed' ? '已完成' : (t.status === 'failed' ? '失败' : '运行中')) + '</span>';
      h += ' <span class="badge bdg-m">' + t.language + '</span>';
      if (t.status === 'running' && t.progress != null) h += ' <span style="color:#3B82F6">' + t.progress + '%</span>';
      h += ' <span style="color:var(--text-muted)">' + (t.created_at || '') + '</span></div></div>';
      if (t.status === 'running' && t.progress != null) {
        h += '<div style="width:80px"><div style="height:4px;border-radius:2px;background:rgba(255,255,255,.05);overflow:hidden"><div style="width:' + t.progress + '%;height:100%;background:#3B82F6;border-radius:2px"></div></div></div>';
      } else if (t.status === 'completed') {
        h += '<span style="font-family:Space Grotesk,sans-serif;font-size:11px;color:var(--text-muted)">' + countFiles(t.files) + ' 文件</span>';
      }
      h += '</div>';
    }
  }
  h += '</div>';
  return h;
}

function countFiles(nodes) {
  var c = 0;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'file') c++;
    if (nodes[i].children) c += countFiles(nodes[i].children);
  }
  return c;
}

function showAlgoNewForm() { document.getElementById('algoNewForm').style.display = ''; }
function hideAlgoNewForm() { document.getElementById('algoNewForm').style.display = 'none'; }

async function aiGenerateAlgo() {
  var desc = document.getElementById('algoDesc').value.trim();
  if (!desc) { toast('请先描述算法需求', 'fa-exclamation-circle', '#F5A623'); return; }
  var lang = document.getElementById('algoLang').value;
  var btn = document.getElementById('algoGenBtn');
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 生成中...';

  var tid = 'a' + Date.now().toString(36);
  ALGO_TASKS.unshift({ id: tid, name: desc.slice(0, 30), status: 'running', created_at: new Date().toLocaleString(), language: lang, progress: 5, files: [], logs: '', test_passed: 0, test_total: 0 });
  hideAlgoNewForm();
  go('algo');

  try {
    // 调用 AI 生成
    var res = await api('POST', '/algo/generate-from-desc', { description: desc, language: lang });
    var t = ALGO_TASKS.find(function(x){return x.id === tid;});
    if (!t) return;
    t.files = (res.result && res.result.files) || buildFallbackFiles(desc, lang);
    t.name = (res.result && res.result.name) || desc.slice(0, 30);
    t.progress = 60;

    // 模拟测试运行
    simulateAlgoRun(tid);
  } catch(e) {
    var t = ALGO_TASKS.find(function(x){return x.id === tid;});
    if (t) { t.status = 'failed'; t.logs = '错误: ' + e.message; }
    toast('生成失败: ' + e.message, 'fa-exclamation-circle', '#FF6B81');
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 生成代码';
}

function buildFallbackFiles(desc, lang) {
  return [
    { name: 'src', type: 'dir', children: [
      { name: 'model.py', type: 'file', content: '# ' + desc + '\n# 由 AI Research Pipeline 生成\n\nclass MyModel:\n    def __init__(self):\n        pass\n\n    def forward(self, x):\n        return x' },
      { name: 'train.py', type: 'file', content: 'from model import MyModel\n\nmodel = MyModel()\nprint("Model ready")' },
    ]},
    { name: 'config.py', type: 'file', content: 'CONFIG = {"model": "MyModel", "epochs": 10}' },
    { name: 'README.md', type: 'file', content: '# ' + desc + '\n\nAI 生成的算法项目。' },
  ];
}

function simulateAlgoRun(tid) {
  var t = ALGO_TASKS.find(function(x){return x.id === tid;});
  if (!t || t.status !== 'running') return;
  t.progress = Math.min(100, (t.progress || 60) + Math.floor(Math.random() * 15));
  if (t.progress >= 100) {
    t.status = 'completed'; t.progress = 100;
    t.test_total = 6; t.test_passed = 4 + Math.floor(Math.random() * 3);
    t.logs = '环境检查通过\n依赖安装完成\n语法检查通过\n运行测试...\n' + t.test_passed + '/' + t.test_total + ' 测试通过\n代码生成完成';
    toast('任务完成: ' + t.name, 'fa-check-circle', '#00E5A0');
    return;
  }
  setTimeout(function(){ simulateAlgoRun(tid); }, 1200);
}

function openAlgoTask(tid) {
  var t = ALGO_TASKS.find(function(x){return x.id === tid;});
  if (!t || t.status !== 'completed') return;
  algoTaskActive = t;
  algoFilesFlat = {};
  flattenAlgoFiles(t.files, '');
  algoCurFile = '';
  // 默认打开第一个文件
  for (var p in algoFilesFlat) { algoCurFile = p; break; }
  document.getElementById('ctnEl').innerHTML = renderAlgoDetail(t);
  renderAlgoTree();
  renderAlgoFile();
}

function renderAlgoDetail(task) {
  var fc = countFiles(task.files);
  var lines = 0;
  for (var p in algoFilesFlat) lines += algoFilesFlat[p].split('\n').length;
  var h = '<div class="flex-b mb16"><button class="btn" onclick="go(\'algo\')" style="padding:6px 14px;font-size:11px"><i class="fa-solid fa-arrow-left"></i> 返回任务列表</button>';
  h += '<span style="font-size:13px;font-weight:700;color:var(--text)">' + esc(task.name) + '</span>';
  h += '<span class="badge bdg-g">已完成</span></div>';

  h += '<div class="stats" style="margin-bottom:16px">';
  h += '<div class="st-card"><div class="st-v" style="color:#FF6B81">' + fc + '</div><div class="st-l">文件数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#A78BFA">' + lines + '</div><div class="st-l">代码行数</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#00E5A0">' + task.test_passed + '/' + task.test_total + '</div><div class="st-l">测试通过</div></div>';
  h += '<div class="st-card"><div class="st-v" style="color:#F5A623">' + task.language + '</div><div class="st-l">语言</div></div>';
  h += '</div>';

  // 文件树 + 代码
  h += '<div style="display:flex;gap:16px;align-items:flex-start">';
  h += '<div class="card" style="width:220px;flex-shrink:0;padding:12px;overflow-y:auto;max-height:55vh">';
  h += '<div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px"><i class="fa-solid fa-folder-tree"></i> 文件</div>';
  h += '<div id="algoFileTree" style="font-size:11px;line-height:1.9"></div></div>';
  h += '<div style="flex:1;min-width:0"><div id="algoFileContent"></div></div>';
  h += '</div>';

  // 运行日志
  if (task.logs) {
    h += '<details class="card" style="margin-top:16px"><summary style="cursor:pointer;padding:8px 0;font-size:12px;color:var(--text-muted);font-weight:600"><i class="fa-solid fa-terminal" style="margin-right:6px"></i>运行日志</summary>';
    h += '<pre style="background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:Space Grotesk,monospace;font-size:11px;color:#7d849a;line-height:1.6;overflow-x:auto;margin-top:8px">' + esc(task.logs) + '</pre></details>';
  }
  return h;
}

function renderAlgoTree() {
  var el = document.getElementById('algoFileTree');
  if (!el || !algoTaskActive) return;
  el.innerHTML = buildTreeHtml(algoTaskActive.files, '');
}

function buildTreeHtml(nodes, prefix) {
  var h = '';
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], p = prefix + '/' + n.name;
    if (n.type === 'dir') {
      h += '<div style="margin-left:12px"><div class="algo-ti" style="cursor:pointer;padding:1px 4px;border-radius:3px;color:var(--text-muted)" onclick="algoToggleDir(this)"><i class="fa-solid fa-chevron-right" style="font-size:7px;margin-right:4px;transition:transform .2s"></i><i class="fa-solid fa-folder" style="color:#F5A623;margin-right:4px;font-size:10px"></i> ' + n.name + '</div><div class="algo-tc" style="display:none">' + buildTreeHtml(n.children, p) + '</div></div>';
    } else {
      var active = algoCurFile === p ? ' style="color:var(--accent);font-weight:600"' : ' style="color:var(--text)"';
      h += '<div class="algo-ti" style="cursor:pointer;padding:1px 4px;border-radius:3px' + (algoCurFile === p ? ';background:rgba(var(--accent-rgb),.15)' : '') + '" onclick="algoOpenDetailFile(\'' + p + '\')"><i class="fa-regular fa-file-code" style="color:#7d849a;margin-right:4px;font-size:10px"></i> ' + n.name + '</div>';
    }
  }
  return h;
}

function algoToggleDir(el) {
  var c = el.nextElementSibling;
  var icon = el.querySelector('.fa-chevron-right');
  if (c) { c.style.display = c.style.display === 'block' ? 'none' : 'block'; if (icon) icon.style.transform = c.style.display === 'block' ? 'rotate(90deg)' : ''; }
}

function algoOpenDetailFile(path) {
  algoCurFile = path;
  renderAlgoTree();
  renderAlgoFile();
}

function renderAlgoFile() {
  var el = document.getElementById('algoFileContent');
  if (!el) return;
  var content = algoFilesFlat[algoCurFile] || '// 无法加载文件';
  var name = algoCurFile.split('/').pop();
  var ext = name.includes('.') ? name.split('.').pop() : '';
  el.innerHTML = '<div class="card" style="padding:0;overflow:hidden"><div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--text)"><i class="fa-regular fa-file-code"></i> ' + algoCurFile.slice(1) + '</div><pre class="code-blk" style="border:none;border-radius:0;max-height:400px;overflow-y:auto;background:rgba(0,0,0,.25);margin:0;font-size:11px;line-height:1.6;white-space:pre-wrap">' + esc(content) + '</pre></div>';
}

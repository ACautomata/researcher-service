/* ===== Algo Page: Code Viewer ===== */
// 模拟项目文件树
var DEMO_PROJECT = {
  name: 'transformer-optimizer',
  type: 'dir',
  children: [
    { name: 'README.md', type: 'file', content: '# Transformer Optimizer\n\n基于改进的自注意力机制的序列建模算法。\n\n## 文件结构\n- model.py: 模型定义\n- train.py: 训练脚本\n- config.py: 配置文件\n- utils.py: 工具函数\n- requirements.txt: 依赖列表' },
    { name: 'src', type: 'dir', children: [
      { name: 'model.py', type: 'file', content: 'import torch\nimport torch.nn as nn\n\nclass TransformerEncoder(nn.Module):\n    def __init__(self, d_model=512, nhead=8, num_layers=6):\n        super().__init__()\n        self.layers = nn.ModuleList([\n            TransformerBlock(d_model, nhead)\n            for _ in range(num_layers)\n        ])\n        self.norm = nn.LayerNorm(d_model)\n\n    def forward(self, x, mask=None):\n        for layer in self.layers:\n            x = layer(x, mask)\n        return self.norm(x)\n\n\nclass TransformerBlock(nn.Module):\n    def __init__(self, d_model, nhead):\n        super().__init__()\n        self.attn = nn.MultiheadAttention(d_model, nhead)\n        self.ffn = nn.Sequential(\n            nn.Linear(d_model, d_model * 4),\n            nn.GELU(),\n            nn.Linear(d_model * 4, d_model),\n        )\n        self.norm1 = nn.LayerNorm(d_model)\n        self.norm2 = nn.LayerNorm(d_model)\n\n    def forward(self, x, mask=None):\n        x = x + self.attn(self.norm1(x), self.norm1(x), self.norm1(x), attn_mask=mask)[0]\n        x = x + self.ffn(self.norm2(x))\n        return x' },
      { name: 'train.py', type: 'file', content: 'import torch\nfrom model import TransformerEncoder\nfrom data import get_dataloader\n\nEPOCHS = 50\nBATCH_SIZE = 64\nLR = 3e-4\n\nmodel = TransformerEncoder(d_model=512, nhead=8, num_layers=6)\noptimizer = torch.optim.AdamW(model.parameters(), lr=LR)\nscheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, EPOCHS)\n\nfor epoch in range(EPOCHS):\n    model.train()\n    total_loss = 0\n    for batch in get_dataloader(BATCH_SIZE):\n        x, y = batch\n        pred = model(x)\n        loss = nn.functional.cross_entropy(pred, y)\n        loss.backward()\n        optimizer.step()\n        optimizer.zero_grad()\n        total_loss += loss.item()\n    scheduler.step()\n    print(f"Epoch {epoch}: loss={total_loss:.4f}")\n\nprint("Training complete!")' },
      { name: 'config.py', type: 'file', content: '# 模型配置\nMODEL_CONFIG = {\n    "d_model": 512,\n    "nhead": 8,\n    "num_layers": 6,\n    "dropout": 0.1,\n    "activation": "gelu",\n}\n\n# 训练配置\nTRAIN_CONFIG = {\n    "batch_size": 64,\n    "epochs": 50,\n    "learning_rate": 3e-4,\n    "weight_decay": 0.01,\n    "warmup_steps": 1000,\n}\n\n# 数据配置\nDATA_CONFIG = {\n    "vocab_size": 30000,\n    "max_seq_len": 512,\n    "train_path": "./data/train.txt",\n    "valid_path": "./data/valid.txt",\n}' },
      { name: 'utils.py', type: 'file', content: 'import torch\nimport numpy as np\n\n\ndef compute_accuracy(pred, target):\n    return (pred.argmax(-1) == target).float().mean().item()\n\n\ndef compute_loss(pred, target, criterion):\n    return criterion(pred, target).item()\n\n\ndef save_checkpoint(model, optimizer, epoch, path):\n    torch.save({\n        "epoch": epoch,\n        "model": model.state_dict(),\n        "optimizer": optimizer.state_dict(),\n    }, path)\n\n\ndef load_checkpoint(path, model, optimizer):\n    ckpt = torch.load(path)\n    model.load_state_dict(ckpt["model"])\n    optimizer.load_state_dict(ckpt["optimizer"])\n    return ckpt["epoch"]' },
    ]},
    { name: 'requirements.txt', type: 'file', content: 'torch>=2.0.0\nnumpy>=1.24.0\ntqdm>=4.66.0\ntensorboard>=2.14.0\nwandb>=0.16.0' },
    { name: 'data', type: 'dir', children: [
      { name: 'train.txt', type: 'file', content: 'SENT_0001: The quick brown fox jumps over the lazy dog.\nSENT_0002: Attention mechanisms have revolutionized NLP.\nSENT_0003: Transformer architectures scale with data and compute.\nSENT_0004: Self-supervised learning unlocks vast unlabeled data.\nSENT_0005: Neural network depth improves representation quality.' },
      { name: 'valid.txt', type: 'file', content: 'SENT_0001: Test validation sentence one.\nSENT_0002: Validation measures generalization ability.\nSENT_0003: Overfitting occurs when model memorizes noise.' },
    ]},
  ]
};

var DEMO_FILES = {}; // flat lookup
(function flatten(node, path) {
  if (node.type === 'file') {
    DEMO_FILES[path + '/' + node.name] = node.content;
  } else if (node.type === 'dir') {
    var dirPath = path + '/' + node.name;
    if (node.children) node.children.forEach(function(c) { flatten(c, dirPath); });
  }
})(DEMO_PROJECT, '');

var algoCurFile = '/README.md';

function renderFileTree(node, path) {
  var p = path + '/' + node.name;
  if (node.type === 'dir') {
    var h = '<div style="margin-left:12px">';
    h += '<div class="algo-tree-item algo-folder" onclick="algoToggleDir(this)"><i class="fa-solid fa-chevron-right" style="font-size:8px;margin-right:6px;transition:transform .2s"></i><i class="fa-solid fa-folder" style="color:#F5A623;margin-right:6px"></i> ' + node.name + '</div>';
    h += '<div class="algo-children">';
    if (node.children) node.children.forEach(function(c) { h += renderFileTree(c, p); });
    h += '</div></div>';
    return h;
  } else {
    var active = algoCurFile === p ? ' algo-active' : '';
    return '<div class="algo-tree-item algo-file' + active + '" onclick="algoOpenFile(\'' + p + '\')"><i class="fa-solid fa-file-lines" style="color:#7d849a;margin-right:6px"></i> ' + node.name + '</div>';
  }
}

function algoToggleDir(el) {
  var children = el.nextElementSibling;
  var icon = el.querySelector('.fa-chevron-right');
  if (children) {
    children.style.display = children.style.display === 'none' ? '' : 'none';
    if (icon) icon.style.transform = children.style.display === 'none' ? '' : 'rotate(90deg)';
  }
}

function algoOpenFile(path) {
  algoCurFile = path;
  // Re-render tree and content
  var treeEl = document.getElementById('algoTree');
  if (treeEl) {
    var root = DEMO_PROJECT;
    treeEl.innerHTML = '<div class="algo-tree-root">' + root.children.map(function(c) { return renderFileTree(c, ''); }).join('') + '</div>';
  }
  renderAlgoContent();
}

function renderAlgoContent() {
  var el = document.getElementById('algoContent');
  if (!el) return;
  var content = DEMO_FILES[algoCurFile] || '// 文件内容加载失败';
  var fileName = algoCurFile.split('/').pop();
  var ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  el.innerHTML = '<div class="card" style="padding:0;overflow:hidden">'
    + '<div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--text)"><i class="fa-regular fa-file-code"></i> ' + algoCurFile.slice(1)
    + '<span style="margin-left:auto;font-size:10px;color:var(--text-muted);font-weight:400">展示模式 · 只读</span></div>'
    + '<div class="code-blk" style="border:none;border-radius:0;max-height:500px;overflow-y:auto;background:rgba(0,0,0,.25)">' + esc(content) + '</div>'
    + '</div>';
}

pages.algo = async function() {
  var h = '<div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">';
  h += '<div class="st-card" style="--accent:#FF6B81"><div class="st-v" style="color:#FF6B81">transformer-optimizer</div><div class="st-l">项目名称</div></div>';
  h += '<div class="st-card" style="--accent:#A78BFA"><div class="st-v" style="color:#A78BFA">6</div><div class="st-l">文件数</div></div>';
  h += '<div class="st-card" style="--accent:#00E5A0"><div class="st-v" style="color:#00E5A0">Python</div><div class="st-l">主要语言</div></div>';
  h += '</div>';

  h += '<div style="display:flex;gap:16px;align-items:flex-start">';
  // 左侧：文件树
  h += '<div class="card" style="width:240px;flex-shrink:0;padding:14px;overflow-y:auto;max-height:600px">';
  h += '<div class="card-t mb12"><i class="fa-solid fa-folder-tree"></i> 文件</div>';
  var root = DEMO_PROJECT;
  h += '<div id="algoTree" style="font-size:12px;line-height:1.9">';
  h += '<div class="algo-tree-root">' + root.children.map(function(c) { return renderFileTree(c, ''); }).join('') + '</div>';
  h += '</div></div>';

  // 右侧：代码预览
  h += '<div style="flex:1;min-width:0" id="algoContent"></div>';
  h += '</div>';

  h += '<style>.algo-tree-item{cursor:pointer;padding:2px 4px;border-radius:4px;transition:all .15s;color:var(--text)}';
  h += '.algo-tree-item:hover{background:rgba(var(--accent-rgb),.08)}';
  h += '.algo-file.algo-active{background:rgba(var(--accent-rgb),.15);color:var(--accent)}';
  h += '.algo-tree-root>.algo-folder,.algo-tree-root>.algo-file{margin-left:0}';
  h += '.algo-children{display:none}';
  h += '.algo-folder+.algo-children{display:block}</style>';

  return h;
};

/* ===== Welcome Page (Guest) ===== */
var heroImgs = ['1.png','2.png','3.png','4.png','5.png','6.png'];
var heroLabels = ['知识库构建','文献问题发现','Idea 生成','算法实现','Agent 终端','参数优化'];
var heroIdx = 0;

pages.home = function() {
  var h = '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;position:relative;overflow:hidden">';
  h += '<div style="position:absolute;inset:0;background:radial-gradient(ellipse 70% 55% at 50% 45%,rgba(59,130,246,.07),transparent 65%),radial-gradient(ellipse 50% 40% at 30% 65%,rgba(0,229,160,.04),transparent 65%),radial-gradient(ellipse 50% 40% at 70% 65%,rgba(167,139,250,.05),transparent 65%);pointer-events:none"></div>';
  h += '<div style="position:relative;z-index:2;font-size:clamp(30px,4.5vw,50px);font-weight:800;line-height:1.12;background:linear-gradient(135deg,#e6edf3 0%,#60A5FA 45%,#A78BFA 75%,#e6edf3 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;max-width:700px;margin-bottom:10px">AI 学术研究<br>自动化流水线</div>';
  h += '<div style="position:relative;z-index:2;font-size:15px;color:var(--text-muted);max-width:420px;line-height:1.6;margin-bottom:28px">上传论文、发现问题、生成 Idea、输出算法代码，全流程 AI 驱动</div>';
  h += '<button type="button" onclick="openAccountPanel()" style="position:relative;z-index:2;padding:14px 40px;border-radius:14px;border:none;background:linear-gradient(135deg,#3B82F6,#8B5CF6);color:#fff;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 8px 32px rgba(59,130,246,.2);margin-bottom:24px;display:inline-flex;align-items:center;gap:8px;transition:transform .3s,box-shadow .3s" onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 12px 40px rgba(59,130,246,.3)\'" onmouseout="this.style.transform=\'\';this.style.boxShadow=\'0 8px 32px rgba(59,130,246,.2)\'"><i class="fa-solid fa-right-to-bracket"></i> 开始使用</button>';

  // Coverflow deck — images resized to 1280x620
  h += '<div style="position:relative;z-index:1;width:100%;max-width:760px;aspect-ratio:64/31;perspective:1100px" id="heroDeck">';
  for (var i = 0; i < heroImgs.length; i++) {
    var s = getCardStyles(i, heroIdx);
    h += '<div onclick="heroJumpTo('+i+')" id="deckCard'+i+'" style="position:absolute;left:50%;top:50%;width:88%;aspect-ratio:64/31;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.06);cursor:pointer;box-shadow:0 8px 40px rgba(0,0,0,.25);transition:all .6s cubic-bezier(.22,1,.36,1);'+s+'"><img src="/images/'+heroImgs[i]+'" style="width:100%;height:100%;object-fit:cover;display:block"></div>';
  }
  h += '</div>';

  h += '<div style="display:flex;gap:12px;margin-top:18px;position:relative;z-index:2">';
  for (var i = 0; i < heroImgs.length; i++) {
    h += '<div onclick="heroJumpTo('+i+')" id="deckDot'+i+'" style="width:12px;height:12px;border-radius:50%;border:2px solid '+(i===heroIdx?'var(--accent,#60A5FA)':'rgba(107,114,128,.35)')+';background:'+(i===heroIdx?'var(--accent,#60A5FA)':'rgba(107,114,128,.15)')+';cursor:pointer;transition:all .3s;box-shadow:'+(i===heroIdx?'0 0 16px rgba(96,165,250,.4)':'none')+'"></div>';
  }
  h += '</div></div>';
  return h;
};

function getCardStyles(i, idx) {
  var offset = i - idx;
  var absOff = Math.abs(offset);
  if (offset === 0) return 'transform:translate(-50%,-50%) scale(1) translateZ(0);opacity:1;z-index:10';
  var dir = offset < 0 ? -1 : 1;
  var scale = Math.max(0.5, 1 - absOff * 0.14);
  var translateX = dir * (75 + absOff * 35);
  var translateZ = -absOff * 90;
  var rotateY = dir * (4 + absOff * 2);
  var opacity = Math.max(0.25, 1 - absOff * 0.16);
  var z = 10 - absOff;
  return 'transform:translate(-50%,-50%) translateX('+translateX+'px) translateZ('+translateZ+'px) scale('+scale+') rotateY('+rotateY+'deg);opacity:'+opacity+';z-index:'+z;
}

function heroJumpTo(idx) {
  heroIdx = idx;
  var deck = document.getElementById('heroDeck');
  if (!deck) return;
  for (var i = 0; i < heroImgs.length; i++) {
    var card = document.getElementById('deckCard'+i);
    var dot = document.getElementById('deckDot'+i);
    if (card) card.setAttribute('style', 'position:absolute;left:50%;top:50%;width:88%;aspect-ratio:64/31;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.06);cursor:pointer;box-shadow:0 8px 40px rgba(0,0,0,.25);transition:all .6s cubic-bezier(.22,1,.36,1);' + getCardStyles(i, idx));
    if (dot) {
      dot.style.background = i === idx ? 'var(--accent,#60A5FA)' : 'rgba(107,114,128,.15)';
      dot.style.borderColor = i === idx ? 'var(--accent,#60A5FA)' : 'rgba(107,114,128,.35)';
      dot.style.boxShadow = i === idx ? '0 0 16px rgba(96,165,250,.4)' : 'none';
    }
  }
}

var heroTimer = undefined;

/* UI 组件层：负责把 store 状态渲染到 DOM */
window.SR = window.SR || {};

SR.ui = (function () {
  var el = {};
  var layers = { a: null, b: null, front: 'a' }; // 双层立绘交叉淡入
  var typeTimer = null;

  function cache() {
    el.app = document.getElementById('app');
    el.stage = document.getElementById('stage');
    el.charWrap = el.stage.querySelector('.char-wrap');
    el.layerA = document.getElementById('char-layer-a');
    el.layerB = document.getElementById('char-layer-b');
    el.emotionBadge = document.getElementById('emotion-badge');
    el.thinking = document.getElementById('thinking');
    el.subtitleName = document.getElementById('subtitle-name');
    el.subtitleZh = document.getElementById('subtitle-zh');
    el.subtitleJa = document.getElementById('subtitle-ja');
    el.switcher = document.getElementById('personality-switcher');
    el.form = document.getElementById('worry-form');
    el.input = document.getElementById('worry-input');
    el.sendBtn = document.getElementById('btn-send');
    el.historyPanel = document.getElementById('history-panel');
    el.historyList = document.getElementById('history-list');
    el.settingsOverlay = document.getElementById('settings-overlay');
    el.setAdapter = document.getElementById('set-adapter');
    el.setApiKey = document.getElementById('set-apikey');
    el.setTtsEngine = document.getElementById('set-tts-engine');
    el.setRate = document.getElementById('set-rate');
    el.setPitch = document.getElementById('set-pitch');
    el.setVoice = document.getElementById('set-voice');
    el.setAutoSpeak = document.getElementById('set-autospeak');
    el.outRate = document.getElementById('out-rate');
    el.outPitch = document.getElementById('out-pitch');
    layers.a = el.layerA; layers.b = el.layerB;
  }

  /* ---- 立绘切换（预加载 + 交叉淡入 + 情绪 pop） ---- */
  var imgSeq = 0; // 切换序号：快速来回切换时丢弃过期的加载回调，避免层状态错乱
  function setImage(personalityId, emotion) {
    var src = SR.CONFIG.imageFor(personalityId, emotion);
    var seq = ++imgSeq;
    // 先用独立 Image 预加载；成功后再放到背面层并切换可见，杜绝“直接改可见层 src”导致的闪烁/停留在上一张
    var pre = new Image();
    pre.onload = function () {
      if (seq !== imgSeq) return; // 已有更新的切换请求，本次作废
      var front = layers[layers.front];
      var back = layers[layers.front === 'a' ? 'b' : 'a'];
      back.src = src; // 已预加载，命中缓存即时渲染
      front.classList.remove('active');
      back.classList.add('active');
      layers.front = (layers.front === 'a' ? 'b' : 'a');
      // 情绪冲击动画
      el.charWrap.classList.remove('emote-pop');
      void el.charWrap.offsetWidth; // 强制 reflow 重启动画
      el.charWrap.classList.add('emote-pop');
    };
    pre.onerror = function () { /* 缺图时保持当前层 */ };
    pre.src = src;
  }

  /* ---- 预加载立绘：先三张 normal（切换性格即时），其余情绪图延后加载 ---- */
  function preloadImages() {
    if (!SR.PERSONALITIES || !SR.CONFIG) return;
    var normals = [], rest = [];
    SR.PERSONALITIES.forEach(function (p) {
      SR.CONFIG.EMOTIONS.forEach(function (e) {
        var s = SR.CONFIG.imageFor(p.id, e);
        if (e === 'normal') normals.push(s); else rest.push(s);
      });
    });
    normals.forEach(function (s) { var im = new Image(); im.src = s; });
    setTimeout(function () {
      rest.forEach(function (s) { var im = new Image(); im.src = s; });
    }, 1500);
  }

  /* ---- 打字机字幕 ---- */
  function typeSubtitle(text) {
    if (typeTimer) clearInterval(typeTimer);
    el.subtitleZh.textContent = '';
    var i = 0;
    typeTimer = setInterval(function () {
      el.subtitleZh.textContent = text.slice(0, ++i);
      if (i >= text.length) clearInterval(typeTimer);
    }, 28);
  }

  /* ---- 性格切换按钮 ---- */
  function renderSwitcher(state) {
    el.switcher.innerHTML = '';
    SR.PERSONALITIES.forEach(function (p) {
      var btn = document.createElement('button');
      btn.className = 'pswitch-btn' + (p.id === state.personalityId ? ' active' : '');
      btn.type = 'button';
      btn.innerHTML = '<span class="dot" style="background:' + p.dotColor + '"></span>' + p.nameZh;
      btn.onclick = function () { SR.main.switchPersonality(p.id); };
      el.switcher.appendChild(btn);
    });
  }

  /* ---- 历史列表 ---- */
  function renderHistory(state) {
    el.historyList.innerHTML = '';
    var items = state.history.slice().reverse();
    if (!items.length) {
      el.historyList.innerHTML = '<li style="color:var(--text-dim)">暂无对话</li>';
      return;
    }
    items.forEach(function (h) {
      var li = document.createElement('li');
      var p = SR.getPersonality(h.personalityId);
      li.innerHTML =
        '<div class="h-worry">我：' + escapeHtml(h.worry) + '</div>' +
        '<div class="h-reply">' + p.nameZh + '：' + escapeHtml(h.zh) + '</div>' +
        '<div class="h-meta">' + (SR.CONFIG.EMOTION_LABELS[h.emotion] || h.emotion) + '</div>';
      el.historyList.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- 设置面板音色填充 ---- */
  function populateVoices() {
    if (!el.setVoice) return;
    var list = SR.speech.jaVoices();
    var cur = SR.store.get().settings.voiceURI;
    el.setVoice.innerHTML = '<option value="">自动（默认 ja-JP）</option>';
    list.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = v.name + ' (' + v.lang + ')';
      if (v.voiceURI === cur) opt.selected = true;
      el.setVoice.appendChild(opt);
    });
  }

  /* ---- 主渲染（订阅 store） ---- */
  function render(state) {
    el.app.dataset.personality = state.personalityId;
    var p = SR.getPersonality(state.personalityId);
    el.emotionBadge.textContent = (SR.CONFIG.EMOTION_LABELS[state.emotion] || state.emotion) + ' · ' + state.emotion;
    el.subtitleName.textContent = p.nameZh + ' / ' + p.nameJa;
    el.thinking.classList.toggle('hidden', !state.isThinking);
    el.charWrap.classList.toggle('speaking', state.isSpeaking);
    el.sendBtn.disabled = state.isThinking;
    renderSwitcher(state);
  }

  return {
    cache: cache,
    el: function () { return el; },
    setImage: setImage,
    preloadImages: preloadImages,
    typeSubtitle: typeSubtitle,
    renderHistory: renderHistory,
    populateVoices: populateVoices,
    render: render,
    setSubtitleJa: function (t) { el.subtitleJa.textContent = t || ''; }
  };
})();

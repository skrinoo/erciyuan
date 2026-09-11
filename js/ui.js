/* UI 组件层：负责把 store 状态渲染到 DOM */
window.SR = window.SR || {};

SR.ui = (function () {
  var el = {};
  var layers = { a: null, b: null, front: 'a' }; // 双层立绘交叉淡入
  var typeTimer = null;
  var historyFilter = 'all';   // 历史面板的角色筛选：'all' 或 personalityId

  function cache() {
    el.app = document.getElementById('app');
    el.stage = document.getElementById('stage');
    el.charWrap = el.stage.querySelector('.char-wrap');
    el.layerA = document.getElementById('char-layer-a');
    el.layerB = document.getElementById('char-layer-b');
    el.emotionBadge = document.getElementById('emotion-badge');
    el.modeBadge = document.getElementById('mode-badge');
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
    el.setChatModel = document.getElementById('set-chat-model');
    el.setTtsEngine = document.getElementById('set-tts-engine');
    el.setRate = document.getElementById('set-rate');
    el.setPitch = document.getElementById('set-pitch');
    el.setVoice = document.getElementById('set-voice');
    el.setAutoSpeak = document.getElementById('set-autospeak');
    el.outRate = document.getElementById('out-rate');
    el.outPitch = document.getElementById('out-pitch');
    el.connStatus = document.getElementById('conn-status');
    el.setSessionOnly = document.getElementById('set-session-only');
    el.diagBox = document.getElementById('diag-box');
    el.historyFilter = document.getElementById('history-filter');
    el.btnExport = document.getElementById('btn-export-history');
    el.unmute = document.getElementById('btn-unmute');
    el.btnResetStats = document.getElementById('btn-reset-stats');
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

  /* ---- 打字机字幕（离线/问候用；自适应速度，总时长封顶，避免“回复已到还在慢慢打字”） ---- */
  function typeSubtitle(text) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    text = stripCues(text);
    el.subtitleZh.textContent = '';
    var n = text.length;
    if (!n) return;
    var per = n > 28 ? 2 : 1;                                   // 长句每次多打几个字
    var steps = Math.ceil(n / per);
    var ms = Math.max(12, Math.min(26, Math.round(640 / steps))); // 总时长≈640ms 封顶
    var i = 0;
    typeTimer = setInterval(function () {
      i = Math.min(n, i + per);
      el.subtitleZh.textContent = text.slice(0, i);
      if (i >= n) { clearInterval(typeTimer); typeTimer = null; }
    }, ms);
  }

  /* 立即设置中文字幕（真模型流式渐进显示 / 定稿用），并打断进行中的打字动画 */
  function setSubtitleZh(t) {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    el.subtitleZh.textContent = stripCues(t);
  }

  /* 字幕只显示台词：剔除（）内的声の演技指示（那是给 TTS 看的，模型有时会把它也译进中文） */
  function stripCues(t) {
    return SR._stripCues ? SR._stripCues(t) : String(t == null ? '' : t);
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

  /* ---- 历史列表（时间戳 / 角色筛选 / 点条目重播语音） ---- */
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  function renderHistory(state) {
    el.historyList.innerHTML = '';
    var all = state.history || [];
    var items = all.slice().reverse();
    if (historyFilter !== 'all') {
      items = items.filter(function (h) { return h.personalityId === historyFilter; });
    }
    if (!items.length) {
      el.historyList.innerHTML = '<li style="color:var(--text-dim)">' + (all.length ? '这个角色还没有对话' : '暂无对话') + '</li>';
      return;
    }
    items.forEach(function (h) {
      var li = document.createElement('li');
      var p = SR.getPersonality(h.personalityId);
      var idx = all.indexOf(h);   // 原数组下标，重播时取同一条的 ja/zh
      li.innerHTML =
        '<div class="h-worry">我：' + escapeHtml(h.worry) + '</div>' +
        '<div class="h-reply">' + escapeHtml(p.nameZh) + '：' + escapeHtml(stripCues(h.zh)) + '</div>' +
        '<div class="h-meta">' +
          '<span class="h-emo">' + escapeHtml(SR.CONFIG.EMOTION_LABELS[h.emotion] || h.emotion || '') + '</span>' +
          '<span class="h-time">' + fmtTime(h.ts) + '</span>' +
          '<button type="button" class="h-replay" title="重播这条的语音">🔊</button>' +
        '</div>';
      var btn = li.querySelector('.h-replay');
      if (btn) btn.onclick = function () { if (SR.main && SR.main.replayLine) SR.main.replayLine(idx); };
      el.historyList.appendChild(li);
    });
  }

  function setHistoryFilter(id) {
    historyFilter = id || 'all';
    renderHistory(SR.store.get());
  }

  /* 导出全部对话为 JSON（纯本地生成 + 下载，不经过任何服务器） */
  function exportHistory() {
    var h = SR.store.get().history || [];
    if (!h.length) { toast('还没有对话可导出', 'info'); return; }
    var data = h.map(function (x) {
      var p = SR.getPersonality(x.personalityId);
      return {
        time: new Date(x.ts || 0).toLocaleString(),
        character: p.nameZh,
        worry: x.worry,
        ja: stripCues(x.ja),
        zh: stripCues(x.zh),
        emotion: x.emotion
      };
    });
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'kokoro-history-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 500);
      toast('已导出 ' + data.length + ' 条对话', 'ok');
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e), 'error');
    }
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

  /* ---- 连接状态提示（离线 Mock / 真模型已启用） ---- */
  function renderStatus() {
    if (!el.connStatus) return;
    var s = SR.store.get().settings;
    var hasKey = !!(s.apiKey && String(s.apiKey).trim());
    var real = (s.adapter === 'stepfun' || s.adapter === 'aiping');
    var backend = s.adapter === 'aiping' ? 'aiping.cn' : (s.adapter === 'stepfun' ? 'StepFun' : 'Mock');
    var level, text;
    if (real && hasKey) { level = 'ok'; text = '真模型已启用 · ' + backend + '（对话）'; }
    else if (real && !hasKey) { level = 'error'; text = '已选 ' + backend + ' 但缺 Key → 会回退 Mock'; }
    else if (!real && hasKey) { level = 'warn'; text = '已填 Key，但后端仍是 Mock（未生效）'; }
    else { level = 'idle'; text = '离线 Mock · 未启用真模型'; }
    var voice = (s.ttsEngine === 'remote')
      ? (hasKey ? '语音：远端 TTS（StepFun）' : '语音：远端 TTS 缺 Key → 回退')
      : '语音：Web Speech / 预生成';
    el.connStatus.className = 'conn-status conn-' + level;
    el.connStatus.innerHTML = '<span class="conn-dot"></span><span class="conn-text">' +
      escapeHtml(text) + '　·　' + escapeHtml(voice) + '</span>';
  }

  /* ---- 轻量 Toast 通知 ---- */
  function toast(msg, type) {
    var host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      document.body.appendChild(host);
    }
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = msg;
    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 3400);
  }

  /* ---- 诊断区（生产可观测）：SR.stats 的计数实时显示在设置面板底部。
     以前“到底回退了多少次、首响多久”只能靠猜，现在用户与开发者都能直接看到 ---- */
  function renderDiag(s) {
    if (!el.diagBox || !s) return;
    var cell = function (label, v) {
      return '<span class="diag-item"><b>' + escapeHtml(String(v)) + '</b>' + label + '</span>';
    };
    el.diagBox.innerHTML =
      '<div class="diag-grid">' +
        cell('真模型成功', s.realOk || 0) + cell('回退 Mock', s.fallback || 0) +
        cell('空响应', s.emptyResp || 0) + cell('审核 451', s.err451 || 0) +
        cell('TTS 失败', s.ttsFail || 0) + cell('JA 行违约', s.jaViolation || 0) +
        cell('重写救回', s.jaRewrite || 0) + cell('翻译补齐', s.translateFix || 0) +
        cell('剥离越界 cue', s.cueStripped || 0) + cell('播放被拦', s.autoplayBlocked || 0) +
        cell('首响均值', (s.ttftMs || 0) + 'ms') + cell('首响最近', (s.ttftLast || 0) + 'ms') +
      '</div>' +
      (s.lastErr ? '<div class="diag-err">最近错误：' + escapeHtml(s.lastErr) + '</div>' : '');
  }

  /* ---- 声音首触引导：浏览器自动播放策略拦下音频时，给一个明确的开关而不是静默失败 ---- */
  function showUnmute() { if (el.unmute) el.unmute.classList.remove('hidden'); }
  function hideUnmute() { if (el.unmute) el.unmute.classList.add('hidden'); }

  /* ---- 主渲染（订阅 store） ---- */
  function render(state) {
    el.app.dataset.personality = state.personalityId;
    var p = SR.getPersonality(state.personalityId);
    el.emotionBadge.textContent = SR.CONFIG.EMOTION_LABELS[state.emotion] || state.emotion;   // 不再把内部枚举泄漏给用户
    if (el.modeBadge) {
      if (state.replySource === 'real') {
        var bn = state.settings.adapter === 'aiping' ? 'aiping' : 'StepFun';
        el.modeBadge.textContent = '🟢 真模型 · ' + bn;
        el.modeBadge.classList.remove('hidden');
      } else {
        el.modeBadge.classList.add('hidden');
      }
    }
    el.subtitleName.textContent = p.nameZh + ' / ' + p.nameJa;
    el.thinking.classList.toggle('hidden', !state.isThinking);
    el.charWrap.classList.toggle('speaking', state.isSpeaking);
    el.sendBtn.disabled = state.isThinking;
    renderSwitcher(state);
    renderStatus();
  }

  return {
    cache: cache,
    el: function () { return el; },
    setImage: setImage,
    preloadImages: preloadImages,
    typeSubtitle: typeSubtitle,
    setSubtitleZh: setSubtitleZh,
    renderHistory: renderHistory,
    setHistoryFilter: setHistoryFilter,
    exportHistory: exportHistory,
    renderDiag: renderDiag,
    showUnmute: showUnmute,
    hideUnmute: hideUnmute,
    populateVoices: populateVoices,
    renderStatus: renderStatus,
    toast: toast,
    render: render,
    setSubtitleJa: function (t) { el.subtitleJa.textContent = stripCues(t); }
  };
})();

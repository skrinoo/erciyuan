/* 服务层：本地存储、情绪路由、Web Speech 日语合成、音频播放 */
window.SR = window.SR || {};

/* ---------- 本地存储 ---------- */
SR.storage = {
  load: function () {
    try {
      var raw = localStorage.getItem(SR.CONFIG.STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  save: function (obj) {
    try { localStorage.setItem(SR.CONFIG.STORAGE_KEY, JSON.stringify(obj)); } catch (e) {}
  }
};

/* ---------- 生产可观测（纯本地，不联网上报） ----------
   目的：回答“线上到底回退了多少次、首响多久、哪个环节在静默失败”。
   没有这层数据，每次 bug 只能靠猜（历史教训：“双中文”复发时无法判断频率）。
   设置面板底部的诊断区实时显示；控制台可调 SR.stats.dump() 导出。 */
SR.stats = (function () {
  var KEY = 'sr-stats-v1';
  var s = {
    realOk: 0, fallback: 0, emptyResp: 0, err451: 0, ttsFail: 0,
    translateFix: 0, jaViolation: 0, jaRewrite: 0, cueStripped: 0,
    autoplayBlocked: 0, ttftMs: 0, ttftLast: 0, ttftN: 0, lastErr: '', lastErrAt: 0
  };
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) Object.assign(s, saved);
  } catch (e) {}

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  function draw() { if (SR.ui && SR.ui.renderDiag) SR.ui.renderDiag(s); }

  return {
    get: function () { return s; },
    /* 计数 +1（或 +n） */
    hit: function (k, n) { s[k] = (s[k] || 0) + (n == null ? 1 : n); persist(); draw(); },
    /* 首响耗时（滑动均值 + 最近一次） */
    time: function (ms) {
      ms = Math.max(0, Math.round(ms));
      var n = (s.ttftN || 0) + 1;
      s.ttftMs = Math.round(((s.ttftMs || 0) * (n - 1) + ms) / n);
      s.ttftLast = ms; s.ttftN = n;
      persist(); draw();
    },
    noteErr: function (msg) { s.lastErr = String(msg || '').slice(0, 140); s.lastErrAt = Date.now(); persist(); draw(); },
    reset: function () {
      Object.keys(s).forEach(function (k) { s[k] = (typeof s[k] === 'number') ? 0 : ''; });
      persist(); draw();
    },
    dump: function () { if (console.table) console.table(s); return s; }
  };
})();

/* ---------- 情绪路由 ---------- */
SR.emotionRouter = {
  // 校验/归一化情绪值，非法则回退
  normalize: function (emo) {
    return SR.CONFIG.EMOTIONS.indexOf(emo) >= 0 ? emo : 'normal';
  },
  // 从真模型回复文本里解析 [emotion:xxx] 标签
  parseTag: function (text) {
    var m = /\[emotion:\s*([a-z]+)\s*\]/i.exec(text || '');
    if (m) return { emotion: SR.emotionRouter.normalize(m[1].toLowerCase()), clean: text.replace(m[0], '').trim() };
    return { emotion: null, clean: text };
  },
  // 按性格的 emotionBias 加权随机一个情绪
  weighted: function (personality) {
    var bias = personality.emotionBias || {};
    var keys = Object.keys(bias);
    var total = 0, i;
    for (i = 0; i < keys.length; i++) total += bias[keys[i]];
    var r = Math.random() * total;
    for (i = 0; i < keys.length; i++) {
      r -= bias[keys[i]];
      if (r <= 0) return SR.emotionRouter.normalize(keys[i]);
    }
    return 'normal';
  }
};

/* ---------- Web Speech 日语合成 ---------- */
SR.speech = {
  _voices: [],
  _ready: false,
  init: function () {
    var synth = window.speechSynthesis;
    if (!synth) return;
    var load = function () {
      SR.speech._voices = synth.getVoices() || [];
      SR.speech._ready = true;
      if (SR.ui && SR.ui.populateVoices) SR.ui.populateVoices();
    };
    load();
    synth.onvoiceschanged = load;
  },
  // 返回 ja-JP 音色列表（供设置面板填充）
  jaVoices: function () {
    return (SR.speech._voices || []).filter(function (v) {
      return /^ja/i.test(v.lang);
    });
  },
  supported: function () { return !!window.speechSynthesis; },
  hasJaVoice: function () { return SR.speech.jaVoices().length > 0; },
  cancel: function () { if (window.speechSynthesis) window.speechSynthesis.cancel(); },
  // 播放文本，返回 Promise；onstart/onend 回调用于驱动立绘说话动画。
  // 主文本为空、或系统无 ja 音色且提供了 opts.fallbackText 时，改用 fallbackLang（默认 zh-CN）朗读字幕，保证始终有声。
  speak: function (text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var synth = window.speechSynthesis;
      if (!synth) { resolve(false); return; }
      var useText = text, useLang = 'ja-JP';
      // 主文本为空（模型把 JA 行写成中文且重写/翻译均失败）时也要回退，
      // 否则在装了日语音色的机器上会“有中文字幕但完全无声”
      if ((!useText || !SR.speech.hasJaVoice()) && opts.fallbackText) {
        useText = opts.fallbackText;
        useLang = opts.fallbackLang || 'zh-CN';
      }
      if (!useText) { resolve(false); return; }
      synth.cancel();
      var u = new SpeechSynthesisUtterance(useText);
      u.lang = useLang;
      u.rate = opts.rate != null ? opts.rate : 1.0;
      u.pitch = opts.pitch != null ? opts.pitch : 1.0;
      // 选择音色：优先用户指定，其次匹配当前语言
      var pool = SR.speech._voices || [];
      var chosen = null, i;
      if (opts.voiceURI) {
        for (i = 0; i < pool.length; i++) if (pool[i].voiceURI === opts.voiceURI) { chosen = pool[i]; break; }
      }
      if (!chosen) {
        var langRe = new RegExp('^' + useLang.slice(0, 2), 'i');
        var sameLang = [];
        for (i = 0; i < pool.length; i++) if (langRe.test(pool[i].lang)) sameLang.push(pool[i]);
        // 优先女声（名字含女性线索且不含男性线索），避免兜底时选到系统男声
        var femaleRe = /(\bfemale\b|\bwoman\b|\bgirl\b|huihui|yaoyao|xiaoxiao|xiaoyi|nanami|ayumi|haruka|momoko|女)/i;
        var maleRe = /(\bmale\b|\bman\b|\bboy\b|kangkang|\byun\b|yunyang|yunxi|yunjian|ichiro|keita|男)/i;
        for (i = 0; i < sameLang.length; i++) {
          var nm = sameLang[i].name || '';
          if (femaleRe.test(nm) && !maleRe.test(nm)) { chosen = sameLang[i]; break; }
        }
        if (!chosen) {
          for (i = 0; i < sameLang.length; i++) {
            if (!maleRe.test(sameLang[i].name || '')) { chosen = sameLang[i]; break; }
          }
        }
        if (!chosen && sameLang.length) chosen = sameLang[0];
      }
      if (chosen) u.voice = chosen;
      u.onstart = function () { if (opts.onstart) opts.onstart(); };
      u.onend = function () { if (opts.onend) opts.onend(); resolve(true); };
      u.onerror = function () { if (opts.onend) opts.onend(); resolve(false); };
      synth.speak(u);
    });
  }
};

/* ---------- 远端音频播放（预生成 mp3 等） ---------- */
SR.audioPlayer = {
  _el: null,
  // 直接播放音频；播放成功开始即 resolve(true)，加载失败/被自动播放策略拦截则 resolve(false)，由调用方兜底。
  play: function (src, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!src) { resolve(false); return; }
      if (!SR.audioPlayer._el) SR.audioPlayer._el = new Audio();
      var el = SR.audioPlayer._el;
      var settled = false;
      var done = function (ok) { if (!settled) { settled = true; resolve(ok); } };
      el.onplay = function () { if (opts.onstart) opts.onstart(); };
      el.onended = function () { if (opts.onend) opts.onend(); };
      el.onerror = function () { if (opts.onend) opts.onend(); done(false); };
      el.src = src;
      var p = el.play();
      if (p && p.then) {
        p.then(function () { done(true); })
         .catch(function () { if (opts.onend) opts.onend(); done(false); });
      } else {
        done(true);
      }
    });
  },
  stop: function () { if (SR.audioPlayer._el) { SR.audioPlayer._el.pause(); } }
};

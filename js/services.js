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
  // 若系统无 ja 音色且提供了 opts.fallbackText，则改用 fallbackLang（默认 zh-CN）朗读字幕，保证始终有声。
  speak: function (text, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var synth = window.speechSynthesis;
      if (!synth) { resolve(false); return; }
      var useText = text, useLang = 'ja-JP';
      if (!SR.speech.hasJaVoice() && opts.fallbackText) {
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
  play: function (src, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!src) { resolve(false); return; }
      if (!SR.audioPlayer._el) SR.audioPlayer._el = new Audio();
      var el = SR.audioPlayer._el;
      el.src = src;
      el.onplay = function () { if (opts.onstart) opts.onstart(); };
      el.onended = function () { if (opts.onend) opts.onend(); resolve(true); };
      el.onerror = function () { if (opts.onend) opts.onend(); resolve(false); };
      el.play().catch(function () { if (opts.onend) opts.onend(); resolve(false); });
    });
  },
  stop: function () { if (SR.audioPlayer._el) { SR.audioPlayer._el.pause(); } }
};

/* 主入口：启动引导、事件绑定、核心对话流程 */
window.SR = window.SR || {};

SR.main = (function () {

  function init() {
    SR.ui.cache();
    SR.speech.init();

    var state = SR.store.get();

    // 订阅 store -> 渲染
    SR.store.subscribe(function (s) { SR.ui.render(s); });

    // 初始立绘 + 问候
    applyPersonality(state.personalityId, true);
    SR.ui.preloadImages(); // 预加载立绘，消除切换性格/情绪时的等待

    bindEvents();
    syncSettingsUI();
    SR.ui.renderHistory(state);
  }

  /* ---- 切换性格 ---- */
  function switchPersonality(id) {
    var cur = SR.store.get().personalityId;
    if (cur === id) return;
    SR.speech.cancel();
    SR.store.set({ personalityId: id, emotion: 'normal', isSpeaking: false });
    applyPersonality(id, false);
  }

  /* ---- 应用性格：换立绘 + 说问候语 ---- */
  function applyPersonality(id, isInit) {
    var p = SR.getPersonality(id);
    SR.ui.setImage(id, 'normal');
    SR.store.set({ emotion: 'normal', subtitleZh: p.tagline, subtitleJa: '', replySource: '' }, { persist: false });
    SR.ui.typeSubtitle(p.tagline);
    SR.ui.setSubtitleJa('');
    // 开场白语音（优先预生成音频）
    if (SR.store.get().settings.autoSpeak) {
      var greetingSrc = 'assets/audio/' + id + '/greeting.mp3';
      speakLine(p.greetingJa, p.greetingZh, p, greetingSrc);
      SR.ui.typeSubtitle(p.greetingZh);
      SR.ui.setSubtitleJa(p.greetingJa);
    }
  }

  /* ---- 语音路由：远端 TTS -> 预生成音频 -> Web Speech(无日语音色时念中文字幕) ---- */
  function speakLine(textJa, textZh, personality, audioSrc) {
    var s = SR.store.get().settings;
    var onStart = function () { SR.store.set({ isSpeaking: true }, { persist: false }); };
    var onEnd = function () { SR.store.set({ isSpeaking: false }, { persist: false }); };

    // 1) 远端 TTS（需 Key）
    if (s.ttsEngine === 'remote' && s.apiKey) {
      return SR.remoteTTS.synthesize(textJa, personality, s).then(function (objUrl) {
        return SR.audioPlayer.play(objUrl, { onstart: onStart, onend: onEnd });
      }).catch(function (err) {
        if (SR.ui && SR.ui.toast) SR.ui.toast('远端 TTS 失败（' + (err && err.message ? err.message : '网络/Key') + '），已回退浏览器语音', 'warn');
        return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd);
      });
    }
    // 2) 预生成音频：直接播放（缺文件/播放失败才兜底 Web Speech），不再用易超时的 probe 预探测
    if (audioSrc) {
      return SR.audioPlayer.play(audioSrc, { onstart: onStart, onend: onEnd }).then(function (played) {
        if (played) return true;
        return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd);
      });
    }
    // 3) Web Speech
    return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd);
  }

  function webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd) {
    if (!SR.speech.supported()) { onEnd(); return Promise.resolve(false); }
    var rate = (s.rate || 1) * (personality.tts ? personality.tts.speed : 1);
    var pitch = (s.pitch || 1) * (personality.tts ? personality.tts.pitch : 1);
    onStart();
    return SR.speech.speak(textJa, {
      rate: rate,
      pitch: pitch,
      voiceURI: s.voiceURI,
      fallbackText: textZh,
      fallbackLang: 'zh-CN',
      onend: onEnd
    });
  }

  /* ---- 核心：提交烦恼 ---- */
  function submitWorry() {
    var el = SR.ui.el();
    var worry = el.input.value.trim();
    if (!worry) return;
    var state = SR.store.get();
    var personality = SR.getPersonality(state.personalityId);

    el.input.value = '';
    SR.speech.cancel();
    SR.store.set({ isThinking: true, isSpeaking: false }, { persist: false });

    var wantSpeak = state.settings.autoSpeak;
    var ttsStarted = false;
    var firstToken = false;
    var startSpeak = function (jaText, zhText, audioSrc) {
      if (ttsStarted || !wantSpeak || !jaText) return;
      ttsStarted = true;
      speakLine(jaText, zhText || jaText, personality, audioSrc || null);
    };

    // 流式回调：边到边显示字幕；JA 行一完成就并行去合成语音（不等整段回复）
    var hooks = {
      onPartial: function (full) {
        var pp = SR._parseBilingualPartial(full);
        if (pp.ja) SR.ui.setSubtitleJa(pp.ja);
        if (pp.zh) SR.ui.setSubtitleZh(pp.zh);
        if (!firstToken) { firstToken = true; SR.store.set({ isThinking: false }, { persist: false }); }
      },
      onJaReady: function (jaText) {
        var s = SR.store.get().settings;
        if (s.ttsEngine === 'remote' && s.apiKey) startSpeak(jaText, null, null);
      }
    };

    SR.getReply(worry, personality, state.settings, hooks).then(function (reply) {
      SR.store.set({ isThinking: false, emotion: reply.emotion, replySource: reply.source || 'mock' }, { persist: false });
      SR.ui.setImage(state.personalityId, reply.emotion);
      if (reply.source === 'real') {
        SR.ui.setSubtitleZh(reply.zh);   // 流式已渐进显示，这里定稿校正
        SR.ui.setSubtitleJa(reply.ja);
      } else {
        SR.ui.typeSubtitle(reply.zh);    // 离线 Mock：自适应快速打字
        SR.ui.setSubtitleJa(reply.ja);
      }

      // 记录历史
      var hist = SR.store.get().history.slice();
      hist.push({
        worry: worry, ja: reply.ja, zh: reply.zh,
        emotion: reply.emotion, personalityId: state.personalityId, ts: Date.now()
      });
      SR.store.set({ history: hist });
      SR.ui.renderHistory(SR.store.get());

      // 语音：若未提前触发（Mock / Web Speech / 预生成音频 / 流式回退），现在触发
      var replyAudio = reply.audioKey
        ? ('assets/audio/' + state.personalityId + '/' + reply.audioKey + '.mp3')
        : null;
      startSpeak(reply.ja, reply.zh, replyAudio);
    }).catch(function (err) {
      console.error(err);
      SR.store.set({ isThinking: false }, { persist: false });
    });
  }

  /* ---- 设置 UI 同步 ---- */
  function syncSettingsUI() {
    var el = SR.ui.el();
    var s = SR.store.get().settings;
    el.setAdapter.value = s.adapter;
    el.setApiKey.value = s.apiKey || '';
    el.setChatModel.value = s.chatModel || '';
    el.setTtsEngine.value = s.ttsEngine;
    el.setRate.value = s.rate;
    el.setPitch.value = s.pitch;
    el.setAutoSpeak.checked = !!s.autoSpeak;
    el.outRate.textContent = Number(s.rate).toFixed(2);
    el.outPitch.textContent = Number(s.pitch).toFixed(2);
  }

  function bindEvents() {
    var el = SR.ui.el();

    el.form.addEventListener('submit', function (e) { e.preventDefault(); submitWorry(); });
    // Ctrl+Enter 也可提交
    el.input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submitWorry(); }
    });

    document.getElementById('btn-history').onclick = function () {
      el.historyPanel.classList.toggle('hidden');
    };
    document.getElementById('btn-clear-history').onclick = function () {
      SR.store.set({ history: [] });
      SR.ui.renderHistory(SR.store.get());
    };

    document.getElementById('btn-settings').onclick = function () {
      el.settingsOverlay.classList.remove('hidden');
      SR.ui.populateVoices();
    };
    document.getElementById('btn-close-settings').onclick = function () {
      el.settingsOverlay.classList.add('hidden');
    };
    el.settingsOverlay.addEventListener('click', function (e) {
      if (e.target === el.settingsOverlay) el.settingsOverlay.classList.add('hidden');
    });

    // 设置项变更
    el.setAdapter.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { adapter: el.setAdapter.value }) }); };
    el.setApiKey.onchange = function () {
      var key = (el.setApiKey.value || '').trim();
      var next = Object.assign({}, SR.store.get().settings, { apiKey: key });
      var switched = null;
      if (key) {
        // 首次填 Key 且还停在 Mock：自动切到 StepFun 真模型
        if (next.adapter === 'mock') { next.adapter = 'stepfun'; switched = 'StepFun 真模型'; }
        // StepFun 的 Key 同时可用于远端 TTS
        if (next.adapter === 'stepfun' && next.ttsEngine !== 'remote') {
          next.ttsEngine = 'remote';
          switched = switched ? (switched + ' + 远端 TTS') : '远端 TTS';
        }
        if (next.adapter === 'aiping') switched = switched || '__aiping__';
      } else if (next.adapter !== 'mock' || next.ttsEngine !== 'webspeech') {
        // 清空 Key：回到离线 Mock，避免真模型调用一直失败
        next.adapter = 'mock'; next.ttsEngine = 'webspeech'; switched = '__offline__';
      }
      SR.store.set({ settings: next });
      syncSettingsUI();
      if (switched === '__offline__') SR.ui.toast('已清空 Key，切回离线 Mock 模式', 'info');
      else if (switched === '__aiping__') SR.ui.toast('aiping Key 已保存（仅对话；远端 TTS 需 StepFun Key）', 'info');
      else if (switched) SR.ui.toast('已启用：' + switched + '（可在设置里调整）', 'ok');
    };
    el.setTtsEngine.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { ttsEngine: el.setTtsEngine.value }) }); };
    el.setChatModel.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { chatModel: (el.setChatModel.value || '').trim() }) }); };
    el.setRate.oninput = function () {
      el.outRate.textContent = Number(el.setRate.value).toFixed(2);
      SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { rate: parseFloat(el.setRate.value) }) });
    };
    el.setPitch.oninput = function () {
      el.outPitch.textContent = Number(el.setPitch.value).toFixed(2);
      SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { pitch: parseFloat(el.setPitch.value) }) });
    };
    el.setVoice.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { voiceURI: el.setVoice.value }) }); };
    el.setAutoSpeak.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { autoSpeak: el.setAutoSpeak.checked }) }); };
  }

  return { init: init, switchPersonality: switchPersonality, submitWorry: submitWorry };
})();

document.addEventListener('DOMContentLoaded', SR.main.init);

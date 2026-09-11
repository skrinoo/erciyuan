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
    SR.store.set({ emotion: 'normal', subtitleZh: p.tagline, subtitleJa: '' }, { persist: false });
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
      }).catch(function () {
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

    SR.getReply(worry, personality, state.settings).then(function (reply) {
      SR.store.set({ isThinking: false, emotion: reply.emotion }, { persist: false });
      SR.ui.setImage(state.personalityId, reply.emotion);
      SR.ui.typeSubtitle(reply.zh);
      SR.ui.setSubtitleJa(reply.ja);

      // 记录历史
      var hist = SR.store.get().history.slice();
      hist.push({
        worry: worry, ja: reply.ja, zh: reply.zh,
        emotion: reply.emotion, personalityId: state.personalityId, ts: Date.now()
      });
      SR.store.set({ history: hist });
      SR.ui.renderHistory(SR.store.get());

      // 自动播语音（优先预生成女声音频）
      if (SR.store.get().settings.autoSpeak) {
        var replyAudio = reply.audioKey
          ? ('assets/audio/' + state.personalityId + '/' + reply.audioKey + '.mp3')
          : null;
        speakLine(reply.ja, reply.zh, personality, replyAudio);
      }
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
    el.setApiKey.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { apiKey: el.setApiKey.value }) }); };
    el.setTtsEngine.onchange = function () { SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { ttsEngine: el.setTtsEngine.value }) }); };
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

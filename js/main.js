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
    buildHistoryFilter();
    SR.ui.renderHistory(state);
    if (SR.stats) SR.ui.renderDiag(SR.stats.get());
    checkBuildFreshness();
  }

  /* ---- 版本自检：浏览器跑旧缓存/旧标签页是“双中文+中文语音”复发的历史根因，
     而旧代码无法被远端修复。故新代码启动时拉线上 index.html（no-store）比对 main.js 的 ?v=，
     过旧则提示并自动刷新一次；长开标签页每 5 分钟复查，部署后无需用户手动强刷 ---- */
  function deployedVersion() {
    return fetch('index.html?_sr=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) {
        var m = /js\/main\.js\?v=([A-Za-z0-9]+)/.exec(t || '');
        return m ? m[1] : '';
      })
      .catch(function () { return ''; });   // file:// 或断网时静默跳过
  }

  function checkBuildFreshness() {
    var run = function () {
      deployedVersion().then(function (v) {
        if (!v || v === SR.BUILD) return;
        console.warn('[SR] 页面版本过旧：本地 ' + SR.BUILD + ' / 线上 ' + v);
        var last = 0;
        try { last = Number(sessionStorage.getItem('sr_reload_ts') || 0); } catch (e) {}
        if (Date.now() - last < 60000) return;   // 60s 内不重复刷，防循环
        try { sessionStorage.setItem('sr_reload_ts', String(Date.now())); } catch (e2) {}
        if (SR.ui && SR.ui.toast) SR.ui.toast('检测到页面缓存过旧，自动刷新…', 'warn');
        setTimeout(function () { location.reload(); }, 900);
      });
    };
    run();
    setInterval(run, 5 * 60 * 1000);
  }

  /* ---- 切换性格 ---- */
  function switchPersonality(id) {
    var cur = SR.store.get().personalityId;
    if (cur === id) return;
    SR.speech.cancel();
    SR.store.set({ personalityId: id, emotion: 'normal', isSpeaking: false });
    applyPersonality(id, false);
  }

  /* ---- 应用性格：换立绘 + 说问候语 ----
     旧实现先打 tagline 再立刻打 greeting，前一个打字动画被同 tick 取消，tagline 永远看不到（死代码）。
     现在二选一：开自动语音→直接问候语；关自动语音→停留角色标语。 */
  function applyPersonality(id, isInit) {
    var p = SR.getPersonality(id);
    SR.ui.setImage(id, 'normal');
    SR.ui.setSubtitleJa('');
    if (SR.store.get().settings.autoSpeak) {
      SR.store.set({ emotion: 'normal', subtitleZh: p.greetingZh, subtitleJa: p.greetingJa, replySource: '' }, { persist: false });
      SR.ui.typeSubtitle(p.greetingZh);
      SR.ui.setSubtitleJa(p.greetingJa);
      // 开场白语音（优先预生成音频）
      speakLine(p.greetingJa, p.greetingZh, p, 'assets/audio/' + id + '/greeting.mp3', 'normal');
    } else {
      SR.store.set({ emotion: 'normal', subtitleZh: p.tagline, subtitleJa: '', replySource: '' }, { persist: false });
      SR.ui.typeSubtitle(p.tagline);
    }
  }

  var lastLine = null;   // 最近一条要播的台词：自动播放被拦后，用户点「开启声音」用它重播

  /* 自动播放策略拦截检测：只有在用户从未与页面交互过时才算“被拦”，
     此时显示「🔊 开启声音」；已交互过还失败就是别的原因（走原有 toast）。
     旧行为是静默失败，用户只当“没声音”，README 里只能写一句“请点地址栏允许”。 */
  function notePlayFailure(ok) {
    if (ok || !lastLine) return;
    var ua = navigator.userActivation;
    if (ua && ua.hasBeenActive) return;
    var s = SR.store.get().settings;
    var remote = (s.ttsEngine === 'remote' && s.apiKey);
    // 完全没有任何可播的东西时，给按钮也没用
    if (!remote && !lastLine.audioSrc && !SR.speech.supported()) return;
    if (SR.stats) SR.stats.hit('autoplayBlocked');
    SR.ui.showUnmute();
  }

  /* 用户点「开启声音」：此时已有用户手势，重播最近一条台词 */
  function enableSound() {
    SR.ui.hideUnmute();
    if (!lastLine) return;
    SR.speech.cancel();
    speakLine(lastLine.ja, lastLine.zh, lastLine.personality, lastLine.audioSrc, lastLine.emotion);
  }

  /* 历史面板重播：按下标取该条台词重新播放（有预生成音频就用，否则走当前语音引擎） */
  function replayLine(idx) {
    var h = (SR.store.get().history || [])[idx];
    if (!h) return;
    SR.speech.cancel();
    SR.ui.hideUnmute();
    SR.store.set({ emotion: h.emotion, replySource: '' }, { persist: false });
    SR.ui.setImage(h.personalityId, h.emotion);
    SR.ui.setSubtitleZh(h.zh);
    SR.ui.setSubtitleJa(h.ja);
    var src = h.audioKey ? ('assets/audio/' + h.personalityId + '/' + h.audioKey + '.mp3') : null;
    speakLine(h.ja, h.zh, SR.getPersonality(h.personalityId), src, h.emotion);
  }

  /* ---- 语音路由：远端 TTS -> 预生成音频 -> Web Speech(无日语音色时念中文字幕) ----
     emotion 会转成情绪专属的全局语境 instruction，让同一角色根据情绪“演”而不只是“念” */
  function speakLine(textJa, textZh, personality, audioSrc, emotion) {
    var s = SR.store.get().settings;
    lastLine = { ja: textJa, zh: textZh, personality: personality, audioSrc: audioSrc || null, emotion: emotion };
    var onStart = function () { SR.ui.hideUnmute(); SR.store.set({ isSpeaking: true }, { persist: false }); };
    var onEnd = function () { SR.store.set({ isSpeaking: false }, { persist: false }); };

    // 1) 远端 TTS（需 Key）：原文含（）演技指示，交给 stepaudio-2.5-tts 表演
    // 但日语台词为空时（JA 行违约且重写/翻译均失败）无内容可合成，直接走 Web Speech 念中文字幕，
    // 否则白跑一次 API 还会弹“远端 TTS 失败”的误导提示
    if (s.ttsEngine === 'remote' && s.apiKey && SR._stripCues(textJa)) {
      return SR.remoteTTS.synthesize(textJa, personality, s, emotion).then(function (objUrl) {
        return SR.audioPlayer.play(objUrl, { onstart: onStart, onend: onEnd });
      }).then(function (played) {
        notePlayFailure(played);
        return played;
      }).catch(function (err) {
        if (SR.ui && SR.ui.toast) SR.ui.toast('远端 TTS 失败（' + (err && err.message ? err.message : '网络/Key') + '），已回退浏览器语音', 'warn');
        return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd).then(function (ok2) {
          notePlayFailure(ok2);
          return ok2;
        });
      });
    }
    // 2) 预生成音频：直接播放（缺文件/播放失败才兜底 Web Speech），不再用易超时的 probe 预探测
    if (audioSrc) {
      return SR.audioPlayer.play(audioSrc, { onstart: onStart, onend: onEnd }).then(function (played) {
        if (played) return true;
        return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd).then(function (ok2) {
          notePlayFailure(ok2);
          return ok2;
        });
      });
    }
    // 3) Web Speech
    return webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd).then(function (ok3) {
      notePlayFailure(ok3);
      return ok3;
    });
  }

  function webSpeechFallback(textJa, textZh, personality, s, onStart, onEnd) {
    if (!SR.speech.supported()) { onEnd(); return Promise.resolve(false); }
    textJa = SR._stripCues(textJa) || textJa;   // 浏览器语音不懂（）演技指示，会当正文念出来
    textZh = SR._stripCues(textZh) || textZh;   // 无日语音色时会念中文兜底文本，同样要剔除
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
    SR.ui.setSubtitleZh('');   // 清空上一条字幕，避免“思考中”/流式 JA 阶段残留旧文本
    SR.ui.setSubtitleJa('');

    var wantSpeak = state.settings.autoSpeak;
    var ttsStarted = false;
    var firstToken = false;
    var startSpeak = function (jaText, zhText, audioSrc, emotion) {
      if (ttsStarted || !wantSpeak || !jaText) return;
      // 最后一道保险：无预生成音频时，绝不用非日语文本合成语音（防中文语音）
      if (!audioSrc && !SR._isJapanese(jaText)) { console.warn('[speak] 跳过非日语台词：', jaText); return; }
      ttsStarted = true;
      speakLine(jaText, zhText || jaText, personality, audioSrc || null, emotion);
    };

    // 流式回调：边到边显示字幕；JA 行一完成就并行去合成语音（不等整段回复）
    var zhPreview = false;   // 模型只给中文时把中文实时预览到中文槽；日文槽只收日语
    var hooks = {
      onPartial: function (full) {
        var pp = SR._parseBilingualPartial(full);
        if (pp.ja && SR._isJapanese(pp.ja)) {
          SR.ui.setSubtitleJa(pp.ja);   // （）演技指示由字幕层统一剔除
          if (zhPreview) { zhPreview = false; SR.ui.setSubtitleZh(''); }  // 收回开头纯汉字被误预览进中文槽的内容
        }
        if (pp.zh) { zhPreview = false; SR.ui.setSubtitleZh(pp.zh); }
        else if (pp.ja && !SR._isJapanese(pp.ja) && SR._isChinese(pp.ja) && !/^\s*(JA|ZH)\s*[:：]/i.test(full)) {
          zhPreview = true; SR.ui.setSubtitleZh(pp.ja);   // 无标签的纯中文回复：中文槽实时预览
        }
        if (!firstToken) { firstToken = true; SR.store.set({ isThinking: false }, { persist: false }); }
      },
      onJaReady: function (jaText, full) {
        var s = SR.store.get().settings;
        // emotion 已在首行给出，此刻就能拿到 → 提前合成也能用情绪专属 instruction
        var emo = SR.emotionRouter.parseTag(full || '').emotion;
        // 仅当 JA 行确为日语才提前合成，避免模型把中文放进 JA 行时提前播中文
        if (s.ttsEngine === 'remote' && s.apiKey && SR._isJapanese(jaText)) startSpeak(jaText, null, null, emo);
      }
    };

    SR.getReply(worry, personality, state.settings, hooks, state.history).then(function (reply) {
      SR.store.set({ isThinking: false, emotion: reply.emotion, replySource: reply.source || 'mock' }, { persist: false });
      SR.ui.setImage(state.personalityId, reply.emotion);
      if (reply.source === 'real') {
        SR.ui.setSubtitleZh(reply.zh);   // 流式已渐进显示，这里定稿校正
        SR.ui.setSubtitleJa(reply.ja);
      } else {
        SR.ui.typeSubtitle(reply.zh);    // 离线 Mock：自适应快速打字
        SR.ui.setSubtitleJa(reply.ja);
      }

      // 语音：若未提前触发（Mock / Web Speech / 预生成音频 / 流式回退），现在触发
      var replyAudio = reply.audioKey
        ? ('assets/audio/' + state.personalityId + '/' + reply.audioKey + '.mp3')
        : null;

      // 记录历史（audioKey 一并存下，历史面板重播时能用到同一条预生成女声）
      var hist = SR.store.get().history.slice();
      hist.push({
        worry: worry, ja: reply.ja, zh: reply.zh,
        emotion: reply.emotion, personalityId: state.personalityId,
        audioKey: reply.audioKey || null, ts: Date.now()
      });
      SR.store.set({ history: hist });
      SR.ui.renderHistory(SR.store.get());
      maybeBuildProfile(personality, hist);

      startSpeak(reply.ja, reply.zh, replyAudio, reply.emotion);
    }).catch(function (err) {
      console.error(err);
      SR.store.set({ isThinking: false }, { persist: false });
    });
  }

  /* ---- 长期记忆：每满 PROFILE_EVERY 轮把该角色的对话压缩成「关于你的备忘」。
     异步、失败静默、不阻塞当前回复；只带最近 3 轮的记忆块会让“聊久了也不记得你”，
     备忘存 localStorage，下次开页依旧认得你 ---- */
  function maybeBuildProfile(personality, hist) {
    var s = SR.store.get().settings;
    if (!s.apiKey || s.adapter === 'mock') return;   // 离线 Mock 无 Key，不生成
    var mine = 0, i;
    for (i = 0; i < hist.length; i++) if (hist[i].personalityId === personality.id) mine++;
    if (mine < SR.PROFILE_MIN || mine % SR.PROFILE_EVERY !== 0) return;
    SR.buildProfile(personality, s, hist).then(function (text) {
      if (!text) return;
      var profiles = Object.assign({}, SR.store.get().profiles || {});
      profiles[personality.id] = { text: text, ts: Date.now(), turns: mine };
      SR.store.set({ profiles: profiles });
      if (SR.ui && SR.ui.toast) SR.ui.toast(personality.nameZh + ' 记住了更多关于你的事', 'ok');
    }).catch(function () { /* 备忘失败不影响对话 */ });
  }

  /* 历史面板的角色筛选下拉（按 SR.PERSONALITIES 自动生成） */
  function buildHistoryFilter() {
    var el = SR.ui.el();
    if (!el.historyFilter) return;
    var html = '<option value="all">全部角色</option>';
    SR.PERSONALITIES.forEach(function (p) {
      html += '<option value="' + p.id + '">' + p.nameZh + '</option>';
    });
    el.historyFilter.innerHTML = html;
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
    if (el.setSessionOnly) el.setSessionOnly.checked = !!s.sessionOnly;
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

    // “仅本次会话”：Key 不写入 localStorage（明文存储，公用电脑上会被下一个人读到）
    if (el.setSessionOnly) el.setSessionOnly.onchange = function () {
      SR.store.set({ settings: Object.assign({}, SR.store.get().settings, { sessionOnly: el.setSessionOnly.checked }) });
      SR.ui.toast(el.setSessionOnly.checked
        ? 'API Key 仅本次会话保留，刷新/重开后需重填'
        : 'API Key 会保存在本机浏览器', 'info');
    };

    // 历史面板：角色筛选 / 导出
    if (el.historyFilter) el.historyFilter.onchange = function () { SR.ui.setHistoryFilter(el.historyFilter.value); };
    if (el.btnExport) el.btnExport.onclick = function () { SR.ui.exportHistory(); };

    // 声音首触：自动播放被拦时出现，点击即有用户手势，可正常播放
    if (el.unmute) el.unmute.onclick = function () { enableSound(); };

    // 诊断清零：重新计数（reset 内部会 draw，无需再手动 renderDiag）
    if (el.btnResetStats) el.btnResetStats.onclick = function () {
      if (!SR.stats) return;
      SR.stats.reset();
      SR.ui.toast('诊断计数已清零', 'info');
    };
  }

  return {
    init: init,
    switchPersonality: switchPersonality,
    submitWorry: submitWorry,
    replayLine: replayLine,
    enableSound: enableSound
  };
})();

document.addEventListener('DOMContentLoaded', SR.main.init);

/* 适配器层：统一接口 generateReply(worry, personality, history) -> {ja, zh, emotion}
   每个适配器失败时由调用方回退到 Mock，保证游戏不中断。 */
window.SR = window.SR || {};

/* ---------- Mock 适配器（离线） ---------- */
SR.adapters = SR.adapters || {};

SR.adapters.mock = {
  id: 'mock',
  name: 'Mock 离线语料库',
  generateReply: function (worry, personality) {
    return new Promise(function (resolve) {
      // 模拟思考延迟，增强"她在想"的感觉
      setTimeout(function () {
        var corpus = SR.MOCK_CORPUS[personality.id] || [];
        var hit = null, hitIndex = -1;
        for (var i = 0; i < corpus.length; i++) {
          var kws = corpus[i].keywords;
          for (var k = 0; k < kws.length; k++) {
            if (worry.indexOf(kws[k]) >= 0) { hit = corpus[i]; hitIndex = i; break; }
          }
          if (hit) break;
        }
        var audioKey = null;
        if (hit) {
          audioKey = 'c' + hitIndex; // 对应预生成女声音频 assets/audio/<pid>/c<i>.mp3
        } else {
          var fb = SR.MOCK_FALLBACK[personality.id] || [];
          if (fb.length) {
            var fi = Math.floor(Math.random() * fb.length);
            hit = fb[fi];
            audioKey = 'f' + fi; // 预生成兜底女声音频 assets/audio/<pid>/f<i>.mp3
          } else {
            hit = { emotion: 'normal', ja: '…うん。', zh: '……嗯。' };
          }
        }
        resolve({ ja: hit.ja, zh: hit.zh, emotion: SR.emotionRouter.normalize(hit.emotion), audioKey: audioKey });
      }, 500 + Math.random() * 500);
    });
  }
};

/* ---------- StepFun 适配器（真模型，需 Key） ---------- */
SR.adapters.stepfun = {
  id: 'stepfun',
  name: 'StepFun',
  baseUrl: 'https://api.stepfun.com/v1',
  chatModel: 'step-2-16k',
  generateReply: function (worry, personality, settings) {
    var url = SR.adapters.stepfun.baseUrl + '/chat/completions';
    var body = {
      model: SR.adapters.stepfun.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt },
        { role: 'user', content: worry }
      ],
      temperature: 0.9
    };
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (settings.apiKey || '')
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      var raw = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      var parsed = SR.emotionRouter.parseTag(raw);
      var ja = parsed.clean || raw;
      return {
        ja: ja,
        zh: '(真模型模式) ' + ja, // 真模型只回日语；字幕暂显示日语原文
        emotion: parsed.emotion || SR.emotionRouter.weighted(personality)
      };
    });
  }
};

/* ---------- aiping.cn 适配器（真模型，需 Key） ---------- */
SR.adapters.aiping = {
  id: 'aiping',
  name: 'aiping.cn',
  baseUrl: 'https://api.aiping.cn/v1',
  chatModel: 'DeepSeek-V3',
  generateReply: function (worry, personality, settings) {
    var url = SR.adapters.aiping.baseUrl + '/chat/completions';
    var body = {
      model: SR.adapters.aiping.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt },
        { role: 'user', content: worry }
      ],
      temperature: 0.9
    };
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (settings.apiKey || '')
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      var raw = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      var parsed = SR.emotionRouter.parseTag(raw);
      var ja = parsed.clean || raw;
      return {
        ja: ja,
        zh: '(真模型模式) ' + ja,
        emotion: parsed.emotion || SR.emotionRouter.weighted(personality)
      };
    });
  }
};

/* ---------- 远端 TTS（StepFun 语音端点，需 Key） ----------
   返回一个可播放的 objectURL；失败 reject，由调用方回退 Web Speech。 */
SR.remoteTTS = {
  synthesize: function (text, personality, settings) {
    var url = 'https://api.stepfun.com/v1/audio/speech';
    var body = {
      model: 'stepaudio-2.5-tts',
      input: text,
      response_format: 'mp3'
    };
    if (personality && personality.tts) {
      if (personality.tts.voiceId) body.voice = personality.tts.voiceId;
      if (personality.tts.instruction) body.instruction = personality.tts.instruction;
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (settings.apiKey || '')
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('TTS HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return URL.createObjectURL(blob);
    });
  }
};

/* 统一入口：按 settings.adapter 选择，失败回退 mock */
SR.getReply = function (worry, personality, settings) {
  var adapter = SR.adapters[settings.adapter] || SR.adapters.mock;
  if (adapter.id === 'mock') return SR.adapters.mock.generateReply(worry, personality);
  return adapter.generateReply(worry, personality, settings).catch(function (err) {
    console.warn('[SR] 真模型调用失败，回退 Mock：', err);
    return SR.adapters.mock.generateReply(worry, personality);
  });
};

/* 适配器层：统一接口 generateReply(worry, personality, history) -> {ja, zh, emotion}
   每个适配器失败时由调用方回退到 Mock，保证游戏不中断。 */
window.SR = window.SR || {};

/* ---------- Mock 适配器（离线） ---------- */
SR.adapters = SR.adapters || {};

/* 从失败响应中提取可读错误：HTTP 状态 + 服务端 error.message（OpenAI 兼容格式）。
   让“回退 Mock”的 toast 能显示真正原因（Key 无效 / 模型不存在 / 余额不足 / CORS）。 */
SR._httpError = function (r, prefix) {
  return r.text().then(function (body) {
    var detail = '';
    try {
      var j = JSON.parse(body);
      var e = j.error;
      detail = (e && (e.message || e.code || e.type)) || j.message || (typeof e === 'string' ? e : '') || '';
    } catch (err) { detail = (body || '').replace(/\s+/g, ' ').slice(0, 140); }
    throw new Error((prefix || '') + 'HTTP ' + r.status + (detail ? ' · ' + detail : ''));
  });
};

/* 真模型输出格式约定：追加到角色 systemPrompt 后，要求同时给出日语台词与中文字幕 */
SR._OUTPUT_RULE =
  '\n\n---\n' +
  '【最優先・出力フォーマット】他の説明は一切書かず、必ず以下の3行だけを出力すること：\n' +
  'JA: <キャラクターとしての日本語のセリフ（1〜2文）>\n' +
  'ZH: <上の日本語セリフの自然で口語的な中国語訳>\n' +
  '[emotion:normal または smile / angry / sad / love]';

/* 解析真模型的双语输出：拆出 JA / ZH / emotion，容错缺标签的情况 */
SR._parseBilingual = function (raw) {
  var parsed = SR.emotionRouter.parseTag(raw);
  var clean = (parsed.clean != null ? parsed.clean : (raw || '')).trim();
  var jaBuf = [], zhBuf = [], mode = null;
  var lines = clean.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (!ln.trim()) continue;
    var mja = /^\s*JA\s*[:：]\s*(.*)$/i.exec(ln);
    var mzh = /^\s*ZH\s*[:：]\s*(.*)$/i.exec(ln);
    if (mja) { mode = 'ja'; if (mja[1].trim()) jaBuf.push(mja[1].trim()); continue; }
    if (mzh) { mode = 'zh'; if (mzh[1].trim()) zhBuf.push(mzh[1].trim()); continue; }
    if (/^\s*\[?emotion\b/i.test(ln)) { mode = null; continue; }
    if (mode === 'zh') zhBuf.push(ln.trim()); else jaBuf.push(ln.trim());
  }
  var ja = jaBuf.join(' ').trim();
  var zh = zhBuf.join(' ').trim();
  if (!ja) ja = clean;
  if (!zh) zh = ja;
  return { ja: ja, zh: zh, emotion: parsed.emotion };
};

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
        resolve({ ja: hit.ja, zh: hit.zh, emotion: SR.emotionRouter.normalize(hit.emotion), audioKey: audioKey, source: 'mock' });
      }, 500 + Math.random() * 500);
    });
  }
};

/* ---------- StepFun 适配器（真模型，需 Key） ---------- */
SR.adapters.stepfun = {
  id: 'stepfun',
  name: 'StepFun',
  baseUrl: 'https://api.stepfun.com/v1',
  chatModel: 'step-3.7-flash',
  generateReply: function (worry, personality, settings) {
    var url = SR.adapters.stepfun.baseUrl + '/chat/completions';
    var body = {
      model: (settings && settings.chatModel) || SR.adapters.stepfun.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._OUTPUT_RULE },
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
      if (!r.ok) return SR._httpError(r);
      return r.json();
    }).then(function (data) {
      var raw = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      var r = SR._parseBilingual(raw);
      return {
        ja: r.ja,
        zh: r.zh,
        emotion: r.emotion || SR.emotionRouter.weighted(personality),
        source: 'real'
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
      model: (settings && settings.chatModel) || SR.adapters.aiping.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._OUTPUT_RULE },
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
      if (!r.ok) return SR._httpError(r);
      return r.json();
    }).then(function (data) {
      var raw = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : '';
      var r = SR._parseBilingual(raw);
      return {
        ja: r.ja,
        zh: r.zh,
        emotion: r.emotion || SR.emotionRouter.weighted(personality),
        source: 'real'
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
      if (!r.ok) return SR._httpError(r, 'TTS ');
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
    if (SR.ui && SR.ui.toast) SR.ui.toast('真模型对话失败（' + (err && err.message ? err.message : '网络/Key') + '），已回退离线 Mock', 'warn');
    return SR.adapters.mock.generateReply(worry, personality);
  });
};

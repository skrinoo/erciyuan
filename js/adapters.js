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

/* ---------- 流式对话（真模型）：边生成边上字幕，JA 行一完成就并行触发 TTS ---------- */

/* 从一条 SSE data 负载取增量文本（兼容 delta.content / text / message.content） */
SR._extractDelta = function (s) {
  if (!s) return '';
  try {
    var j = JSON.parse(s);
    var ch = j.choices && j.choices[0];
    if (!ch) return '';
    if (ch.delta && typeof ch.delta.content === 'string') return ch.delta.content;
    if (typeof ch.text === 'string') return ch.text;
    if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
    return '';
  } catch (e) { return ''; }
};

/* 从整段非流式 JSON 响应取 message.content（流式不可用时兜底） */
SR._contentFromJson = function (t) {
  try {
    var j = JSON.parse(t);
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch (e) { return ''; }
};

/* 增量探测 JA 行：JA 以换行结束即视为完成，可安全提前送 TTS */
SR._jaSoFar = function (full) {
  var m = /JA\s*[:：]\s*/i.exec(full || '');
  if (!m) return null;
  var rest = full.slice(m.index + m[0].length);
  var nl = rest.search(/\r?\n/);
  if (nl >= 0) return { text: rest.slice(0, nl).trim(), complete: true };
  return { text: rest.trim(), complete: false };
};

/* 增量解析双语：把已到达的 JA/ZH 片段（去标签）实时喂给字幕 */
SR._parseBilingualPartial = function (full) {
  var clean = (full || '').replace(/\[emotion:[^\]]*\]?/gi, '');
  var lines = clean.split(/\r?\n/);
  var ja = '', zh = '', mode = null;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var mja = /^\s*JA\s*[:：]\s*(.*)$/i.exec(ln);
    var mzh = /^\s*ZH\s*[:：]\s*(.*)$/i.exec(ln);
    if (mja) { mode = 'ja'; ja = mja[1]; continue; }
    if (mzh) { mode = 'zh'; zh = mzh[1]; continue; }
    if (/^\s*\[?emotion\b/i.test(ln) || /^\s*\[/.test(ln)) { mode = null; continue; }
    if (mode === 'zh') zh += (zh ? ' ' : '') + ln;
    else if (mode === 'ja') ja += (ja ? ' ' : '') + ln;
  }
  return { ja: ja.trim(), zh: zh.trim() };
};

/* 发起流式对话，resolve 完整 message.content；期间用 hooks 驱动 UI/TTS。
   hooks: { onPartial(fullText), onJaReady(jaText) }。
   浏览器不支持流式读取、或服务端未按 SSE 返回时，自动回退整段解析。 */
SR._chatStream = function (url, apiKey, body, hooks) {
  hooks = hooks || {};
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) return SR._httpError(r);
    var canStream = r.body && r.body.getReader && typeof TextDecoder !== 'undefined';
    if (!canStream) return r.text().then(function (t) { return SR._contentFromJson(t) || t; });
    var reader = r.body.getReader();
    var dec = new TextDecoder('utf-8');
    var full = '', rawAll = '', sseBuf = '', jaFired = false;
    var eat = function (line) {
      line = line.replace(/\r$/, '').trim();
      if (!line || line === 'data: [DONE]' || line === '[DONE]') return;
      if (line.indexOf('data:') === 0) line = line.slice(5).trim();
      var d = SR._extractDelta(line);
      if (!d) return;
      full += d;
      if (hooks.onPartial) hooks.onPartial(full);
      if (!jaFired) {
        var ja = SR._jaSoFar(full);
        if (ja && ja.complete && ja.text) { jaFired = true; if (hooks.onJaReady) hooks.onJaReady(ja.text); }
      }
    };
    var pump = function () {
      return reader.read().then(function (res) {
        if (res.done) return;
        var txt = dec.decode(res.value, { stream: true });
        rawAll += txt; sseBuf += txt;
        var parts = sseBuf.split('\n');
        sseBuf = parts.pop();
        for (var i = 0; i < parts.length; i++) eat(parts[i]);
        return pump();
      });
    };
    return pump().then(function () {
      if (sseBuf) eat(sseBuf);
      if (!full.trim()) full = SR._contentFromJson(rawAll) || '';
      return full;
    });
  });
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
      }, 260 + Math.random() * 300);
    });
  }
};

/* ---------- StepFun 适配器（真模型，需 Key） ---------- */
SR.adapters.stepfun = {
  id: 'stepfun',
  name: 'StepFun',
  baseUrl: 'https://api.stepfun.com/v1',
  chatModel: 'step-3.7-flash',
  generateReply: function (worry, personality, settings, hooks) {
    var body = {
      model: (settings && settings.chatModel) || SR.adapters.stepfun.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._OUTPUT_RULE },
        { role: 'user', content: worry }
      ],
      temperature: 0.9,
      max_tokens: 300,   // 台词很短，封顶避免冗长生成拖慢首字
      stream: true       // 流式：边生成边上字幕，JA 行完成即并行触发 TTS
    };
    return SR._chatStream(SR.adapters.stepfun.baseUrl + '/chat/completions', settings.apiKey, body, hooks)
      .then(function (raw) {
        if (!raw || !raw.trim()) throw new Error('空响应');
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
  generateReply: function (worry, personality, settings, hooks) {
    var body = {
      model: (settings && settings.chatModel) || SR.adapters.aiping.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._OUTPUT_RULE },
        { role: 'user', content: worry }
      ],
      temperature: 0.9,
      max_tokens: 300,
      stream: true
    };
    return SR._chatStream(SR.adapters.aiping.baseUrl + '/chat/completions', settings.apiKey, body, hooks)
      .then(function (raw) {
        if (!raw || !raw.trim()) throw new Error('空响应');
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
SR.getReply = function (worry, personality, settings, hooks) {
  var adapter = SR.adapters[settings.adapter] || SR.adapters.mock;
  if (adapter.id === 'mock') return SR.adapters.mock.generateReply(worry, personality);
  return adapter.generateReply(worry, personality, settings, hooks).catch(function (err) {
    console.warn('[SR] 真模型调用失败，回退 Mock：', err);
    if (SR.ui && SR.ui.toast) SR.ui.toast('真模型对话失败（' + (err && err.message ? err.message : '网络/Key') + '），已回退离线 Mock', 'warn');
    return SR.adapters.mock.generateReply(worry, personality);
  });
};

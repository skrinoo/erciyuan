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

/* 真模型输出格式约定：追加到角色 systemPrompt 后，要求同时给出日语台词与中文字幕。
   emotion 放首行：JA 一流完就能带着情绪去合成语音（不必等整段回复），不牺牲首响速度 */
SR._OUTPUT_RULE =
  '\n\n---\n' +
  '【最優先・出力フォーマット／絶対厳守】他の説明は一切書かず、必ず以下の3行をこの順番で出力すること：\n' +
  '[emotion:normal または smile / angry / sad / love]（←最初に、このセリフの感情を決める）\n' +
  'JA: <キャラクターとしての日本語のセリフ（長さは気分で自然に変える。通常1〜2文、時々短い一言だけ）>\n' +
  '（注意：ユーザーの入力が中国語でも、JA は必ず日本語で書くこと。中国語のまま書かない。）\n' +
  'ZH: <上のセリフを自然で口語的な簡体字中国語に訳した文。日本語ではなく必ず中国語。省略禁止。括弧の演技指示は訳さずセリフだけを訳す。中国語でもキャラクターの口調（ツンデレ/ヤンデレ/優しい等）を保つ>\n' +
  '例：\n' +
  '[emotion:angry]\n' +
  'JA: （舌打ち）べ、別に心配じゃないからね！\n' +
  'ZH: 哼，才、才不是担心你呢！\n' +
  '\n✗悪い例（絶対にやってはいけない失敗）：\n' +
  'JA: （指尖攥紧衣角）不许说这种傻话…… ← JA 行が中国語になっている。JA は必ず日本語で書く。\n' +
  'ZH: （指尖攥紧衣角）不许说这种傻话…… ← ZH が JA と同じ文のコピー。ZH は JA の中国語訳でなければならない。\n' +
  '注意：感情が強い・重い話題ほど、JA 行をうっかり中国語で書いてしまう失敗が起きやすい。' +
  '書き終わったら「JA 行にひらがな／カタカナが入っているか」を必ず自分で確認すること。入っていなければ書き直す。\n' +
  '演技指示の括弧は JA 行にだけ書くこと。ZH 行には括弧を書かず、セリフだけを訳すこと。';

/* 回复质量规则：追加在角色 prompt 后，专治“公式化”——
   具体回应 / 句式变化 / 反应多样 / 记忆体现（格式契约 _OUTPUT_RULE 仍放最末尾保合规） */
SR._STYLE_RULE =
  '\n\n---\n' +
  '【返信品質ルール／絶対厳守】\n' +
  '1. ユーザーのメッセージの具体的な内容に必ず反応すること：そこから細部や言葉を一つ拾って受け答える。誰にでも言える万能の空慰めは禁止。\n' +
  '2. 毎回、出だしと文型を変えること。最近の会話で使った出だしやテンプレートの再利用は禁止。\n' +
  '3. 反応は気分に応じて多様に：一言問い返す／からかう／話題をそらす／短い沈黙／先に行動してから口にする――毎回まっすぐ慰める・まっすぐ励ますだけはダメ。\n' +
  '4. 最近の会話がある場合は「覚えている」ことを自然に示す（前の話題や約束に触れる）。ただし原文をそのまま繰り返さない。\n';

/* 对话记忆块：只取同角色最近 3 轮，让模型有记忆并明令禁止复用旧句式；无历史返回 '' */
SR._memoryBlock = function (history, personalityId) {
  if (!history || !history.length) return '';
  var mine = [];
  for (var i = 0; i < history.length; i++) {
    if (!personalityId || history[i].personalityId === personalityId) mine.push(history[i]);
  }
  var recent = mine.slice(-3);
  if (!recent.length) return '';
  var lines = [];
  for (var j = 0; j < recent.length; j++) {
    lines.push('ユーザー: ' + String(recent[j].worry || '').slice(0, 80));
    lines.push('あなた: ' + String(recent[j].ja || '').slice(0, 80));
  }
  return '\n\n---\n【最近の会話記憶（あなたはこれらを覚えている。返信時、これらの返信と同じ出だし・文型の再利用は禁止）】\n' + lines.join('\n');
};

/* 声の演技指示ルール：把角色专属的安全 cue 词表告诉模型。
   stepaudio-2.5-tts 会把 input 里全角括号内容当表演指令（不朗读）；
   但审核对密着/性暗示词敏感（实测「甘くささやく」必被 HTTP 451 拦），故明确禁用 */
SR._cueRule = function (personality) {
  var cues = (personality && personality.tts && personality.tts.cues) || [];
  if (!cues.length) return '';
  return '\n\n---\n' +
    '【声の演技指示／任意】JA のセリフには、必要なら全角括弧の演技指示を最大2つまで入れてよい。' +
    '括弧の中は読み上げられず、声の演技（間・息づかい・抑揚）だけが変わる。\n' +
    '使ってよい指示：' + cues.join(' ') + '\n' +
    '禁止：（ささやく）（甘い息）（耳元で）（抱きしめる）など密着・性的な印象の指示は音声合成で弾かれるので絶対に使わない。' +
    '指示は毎回必ず入れる必要はなく、入れない回も作ること。\n';
};

/* 去掉台词里的（）演技指示：字幕显示与浏览器语音用（否则会把它当正文念出来） */
SR._stripCues = function (t) {
  return String(t == null ? '' : t)
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

/* cue 白名单强制：只保留角色 cues 里列出的括号指示，其余一律剥掉。
   实测模型会自创白名单外的指示（如「（指尖下意识攥紧他的衣角）」中文动作描写、
   「（少し背中をさすりながら）」身体接触描写）——前者泄漏成字幕噪音，后者随时触发 TTS 审核 451。
   匹配用双向包含，允许模型写「（少し小声で）」这类带修饰的变体。 */
SR._normalizeCues = function (t, personality) {
  var raw = String(t == null ? '' : t);
  var allow = (personality && personality.tts && personality.tts.cues) || [];
  var inner = function (s) { return s.replace(/[（）()]/g, '').replace(/\s+/g, '').trim(); };
  var allowInner = [];
  for (var a = 0; a < allow.length; a++) allowInner.push(inner(allow[a]));
  var bad = [];
  var out = raw.replace(/（[^（）]*）|\([^()]*\)/g, function (m) {
    var mi = inner(m);
    for (var i = 0; i < allowInner.length; i++) {
      if (mi && allowInner[i] && (mi.indexOf(allowInner[i]) >= 0 || allowInner[i].indexOf(mi) >= 0)) return m;
    }
    bad.push(m);
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  if (bad.length) {
    console.warn('[cue] 剥离白名单外的演技指示：' + bad.join(' '));
    if (SR.stats) SR.stats.hit('cueStripped', bad.length);
  }
  return out;
};

/* 合成全局语境 instruction：角色基调 + 当前情绪，上限 200 字符（stepaudio-2.5-tts 硬限制） */
SR.ttsInstruction = function (personality, emotion) {
  var t = (personality && personality.tts) || {};
  var base = t.instruction || '';
  var map = t.emotionInstructions || {};
  var emo = map[emotion] || map.normal || '';
  var s = (base + (emo ? '；' + emo : '')).replace(/\s+/g, '');
  return s.slice(0, 200);
};

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

/* 取推理/思考增量（思考型模型放在 delta.reasoning_content）。
   思考也消耗 max_tokens：思考把额度用尽时正文会空——用于诊断与重试决策 */
SR._extractReasoning = function (s) {
  if (!s) return '';
  try {
    var j = JSON.parse(s);
    var ch = j.choices && j.choices[0];
    if (ch && ch.delta && typeof ch.delta.reasoning_content === 'string') return ch.delta.reasoning_content;
    return '';
  } catch (e) { return ''; }
};

/* 非流式单次调用：流式正文空时的兜底重试 */
SR._chatOnce = function (url, apiKey, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) return SR._httpError(r);
    return r.text();
  }).then(function (t) { return SR._contentFromJson(t) || t; });
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
    var full = '', reasonBuf = '', rawAll = '', sseBuf = '', jaFired = false;
    var t0 = Date.now(), ttftDone = false;   // 首 token 耗时：思考型模型的“空等”到底多久，靠这个量化
    var eat = function (line) {
      line = line.replace(/\r$/, '').trim();
      if (!line || line === 'data: [DONE]' || line === '[DONE]') return;
      if (line.indexOf('data:') === 0) line = line.slice(5).trim();
      var d = SR._extractDelta(line);
      if (!d) { reasonBuf += SR._extractReasoning(line); return; }
      if (!ttftDone) { ttftDone = true; if (SR.stats) SR.stats.time(Date.now() - t0); }
      full += d;
      if (hooks.onPartial) hooks.onPartial(full);
      if (!jaFired) {
        var ja = SR._jaSoFar(full);
        if (ja && ja.complete && ja.text) { jaFired = true; if (hooks.onJaReady) hooks.onJaReady(ja.text, full); }
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
      return { text: full, reasoning: reasonBuf };
    });
  });
};

/* 判断文本是否为“真中文”（含汉字且不含假名）：用于检测模型是否漏给/错给中文字幕 */
SR._isChinese = function (t) {
  t = t || '';
  return /[\u4e00-\u9fff]/.test(t) && !/[\u3040-\u30ff]/.test(t);
};

/* 判断文本是否为日语（含假名）：用于检测模型是否漏给/错给日语台词 */
SR._isJapanese = function (t) {
  return /[\u3040-\u30ff]/.test(t || '');
};

/* 轻量翻译兜底：dir='ja2zh'(日→中) 或 'zh2ja'(中→日)；返回译文，失败返回 '' */
SR._translate = function (text, dir, baseUrl, apiKey, model) {
  if (!text) return Promise.resolve('');
  var sys = (dir === 'zh2ja')
    ? 'あなたは翻訳者です。以下の中国語セリフを、自然で口語的な日本語（アニメの少女のセリフ調）に訳し、訳文だけを1行で返してください。説明・タグ・接頭辞は不要。'
    : 'あなたは翻訳者です。以下の日本語セリフを自然で口語的な簡体字中国語に訳し、訳文だけを1行で返してください。説明・タグ・接頭辞は不要。';
  var body = {
    model: model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: text }
    ],
    temperature: 0.3,
    // 思考型模型的思考也吃 max_tokens：200 会被思考用尽而正文空（翻译静默失败 → 日文槽空白 + 无声）
    max_tokens: 1024
  };
  return fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) return Promise.resolve('');
    return r.json();
  }).then(function (data) {
    var c = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    c = String(c).replace(/\[emotion:[^\]]*\]?/gi, '').replace(/^\s*(JA|ZH|中文|中国語|日本語)\s*[:：]\s*/i, '').trim();
    if (dir === 'ja2zh') return SR._isChinese(c) ? c : '';
    return SR._isJapanese(c) ? c : '';
  }).catch(function () { return ''; });
};

/* 翻译带一次重试：第一次失败或译文语言不对时再试一次，仍失败返回 '' */
SR._translateTwice = function (text, dir, baseUrl, apiKey, model) {
  return SR._translate(text, dir, baseUrl, apiKey, model).then(function (t) {
    if (t) return t;
    return SR._translate(text, dir, baseUrl, apiKey, model);
  });
};

/* JA 行被写成中文时的治根手段：不走“中→日翻译”（译者人设会丢掉角色口吻），
   而是带着角色 systemPrompt 回灌，让模型只把这句重写成日语、保持人设与内容不变。
   实测高情绪输入下模型违约率明显升高，这一步能把“日文槽空白 + 完全无声”救回来。 */
SR._rewriteJa = function (zhLine, personality, baseUrl, apiKey, model) {
  if (!zhLine) return Promise.resolve('');
  var body = {
    model: model,
    messages: [
      { role: 'system', content:
        ((personality && personality.systemPrompt) ? personality.systemPrompt + '\n\n' : '') +
        '【作業】下のセリフは、本来日本語で書くべき JA 行に誤って中国語で書かれたものです。' +
        'キャラクターの口調・感情・言いたいことをそのまま保ち、自然な日本語のセリフに書き直してください。' +
        '出力は日本語のセリフ1行だけ。説明・タグ・接頭辞（JA: など）・括弧の演技指示は一切付けないこと。' },
      { role: 'user', content: String(zhLine).slice(0, 300) }
    ],
    temperature: 0.7,
    max_tokens: 1024
  };
  return fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (apiKey || '') },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) return '';
    return r.text();
  }).then(function (t) {
    var c = SR._contentFromJson(t) || '';
    c = String(c).replace(/\[emotion:[^\]]*\]?/gi, '').replace(/^\s*(JA|ZH|日本語)\s*[:：]\s*/i, '').trim();
    var nl = c.search(/\r?\n/);
    if (nl > 0) c = c.slice(0, nl).trim();
    return SR._isJapanese(c) ? c : '';
  }).catch(function () { return ''; });
};

/* 统一校正双语：保证 ja 是日语、zh 是中文；缺哪一边就用另一边翻译补齐。
   覆盖模型只给日语(漏中文)、只给中文(漏日语)、标签错配等所有情况。 */
SR._fixBilingual = function (r, baseUrl, model, apiKey, personality) {
  var jaJ = SR._isJapanese(r.ja) ? r.ja : (SR._isJapanese(r.zh) ? r.zh : '');
  var zhC = SR._isChinese(r.zh) ? r.zh : (SR._isChinese(r.ja) ? r.ja : '');
  var stat = function (k) { if (SR.stats) SR.stats.hit(k); };
  var chain = Promise.resolve();
  if (!zhC && jaJ) chain = chain.then(function () {
    return SR._translateTwice(jaJ, 'ja2zh', baseUrl, apiKey, model).then(function (z) { if (z) { zhC = z; stat('translateFix'); } });
  });
  if (!jaJ && zhC) {
    stat('jaViolation');   // 模型把 JA 行写成了中文：先带人设重写，失败再退回翻译
    chain = chain.then(function () {
      return SR._rewriteJa(zhC, personality, baseUrl, apiKey, model).then(function (j) {
        if (j) { jaJ = j; stat('jaRewrite'); return; }
        return SR._translateTwice(zhC, 'zh2ja', baseUrl, apiKey, model).then(function (j2) { if (j2) { jaJ = j2; stat('translateFix'); } });
      });
    });
  }
  return chain.then(function () {
    // 翻译彻底失败时宁可留空，也绝不把错误语言的文本填回字幕/语音（防“双中文/中文语音”复发）
    // 两边都救不回来 → 抛错让上层回退 Mock，而不是给用户一片空白 + 无声
    if (!jaJ && !zhC) throw new Error('双语输出均不可用（模型未遵守 JA/ZH 格式且补救失败）');
    return {
      ja: jaJ || '',
      zh: zhC || '',
      emotion: r.emotion || SR.emotionRouter.weighted(personality)
    };
  });
};

/* 预生成女声音频只有 c0~c7（每角色 8 条），语料表前 8 条与之按序对应；
   超出部分没有音频文件，返回 null 让语音路由走 Web Speech，避免 404 噪音 */
SR.MOCK_AUDIO_MAX = 8;
/* 兜底句同理：磁盘上只有 f0~f2 三个音频，语料已扩到 6 条，第 4 条起必须走 Web Speech。
   少了这个上限，扩语料就会静默换来 404 + 静音（audio.onerror 不提示，玩家只觉“没声音”） */
SR.MOCK_FB_AUDIO_MAX = 3;

/* Mock 匹配：按命中关键词打分（长词更具体、权重更高），取最高分，同分随机。
   旧实现是“第一个命中的条目直接返回”，条目顺序决定结果，多意图输入必然答非所问
   （例：「加班到十点，累死了」永远答“工作”，只因工作条目排在最前）。
   同时记录上次命中，避免离线连玩时连续重复同一条。 */
SR._mockLast = {};
SR._matchMock = function (worry, pid) {
  var corpus = SR.MOCK_CORPUS[pid] || [];
  var w = String(worry || '');
  var best = 0, tied = [], i, k;
  for (i = 0; i < corpus.length; i++) {
    var kws = corpus[i].keywords || [], score = 0;
    for (k = 0; k < kws.length; k++) {
      if (kws[k] && w.indexOf(kws[k]) >= 0) score += Math.max(1, Math.min(3, kws[k].length));
    }
    if (score > best) { best = score; tied = [i]; }
    else if (score > 0 && score === best) tied.push(i);
  }
  if (best > 0) {
    var idx = tied[Math.floor(Math.random() * tied.length)];
    if (tied.length > 1 && ('c' + idx) === SR._mockLast[pid]) idx = tied[(tied.indexOf(idx) + 1) % tied.length];
    SR._mockLast[pid] = 'c' + idx;
    return { entry: corpus[idx], audioKey: idx < SR.MOCK_AUDIO_MAX ? ('c' + idx) : null };
  }
  var fb = SR.MOCK_FALLBACK[pid] || [];
  if (!fb.length) return { entry: { emotion: 'normal', ja: '…うん。', zh: '……嗯。' }, audioKey: null };
  var fi = Math.floor(Math.random() * fb.length);
  if (fb.length > 1 && ('f' + fi) === SR._mockLast[pid]) fi = (fi + 1) % fb.length;
  SR._mockLast[pid] = 'f' + fi;
  return { entry: fb[fi], audioKey: fi < SR.MOCK_FB_AUDIO_MAX ? ('f' + fi) : null };
};

SR.adapters.mock = {
  id: 'mock',
  name: 'Mock 离线语料库',
  generateReply: function (worry, personality) {
    return new Promise(function (resolve) {
      // 模拟思考延迟，增强"她在想"的感觉
      setTimeout(function () {
        var m = SR._matchMock(worry, personality.id);
        resolve({
          ja: m.entry.ja, zh: m.entry.zh,
          emotion: SR.emotionRouter.normalize(m.entry.emotion),
          audioKey: m.audioKey, source: 'mock'
        });
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
  generateReply: function (worry, personality, settings, hooks, history) {
    var body = {
      model: (settings && settings.chatModel) || SR.adapters.stepfun.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._STYLE_RULE + SR._memoryBlock(history, personality.id) + SR._profileBlock(personality.id) + SR._cueRule(personality) + SR._OUTPUT_RULE },
        { role: 'user', content: worry }
      ],
      temperature: 0.9,
      max_tokens: 2048,  // 思考型模型余量：思考也消耗 max_tokens，不足则正文空（“空响应”回退 Mock）
      stream: true       // 流式：边生成边上字幕，JA 行完成即并行触发 TTS
    };
    return SR._chatStream(SR.adapters.stepfun.baseUrl + '/chat/completions', settings.apiKey, body, hooks)
      .then(function (res) {
        var raw = res && res.text;
        if (!raw || !raw.trim()) {
          // 正文空（思考用尽额度 / SSE 异常）：非流式重试一次
          if (SR.stats) SR.stats.hit('emptyResp');
          var body2 = Object.assign({}, body, { stream: false });
          return SR._chatOnce(SR.adapters.stepfun.baseUrl + '/chat/completions', settings.apiKey, body2).then(function (t) {
            if (!t || !t.trim()) throw new Error('空响应' + (res.reasoning ? '（模型思考用尽 max_tokens，重试仍空）' : ''));
            return t;
          });
        }
        return raw;
      })
      .then(function (raw) {
        var r = SR._parseBilingual(raw);
        return SR._fixBilingual(r, SR.adapters.stepfun.baseUrl,
          (settings && settings.chatModel) || SR.adapters.stepfun.chatModel, settings.apiKey, personality)
          .then(function (f) { f.source = 'real'; return f; });
      });
  }
};

/* ---------- aiping.cn 适配器（真模型，需 Key） ---------- */
SR.adapters.aiping = {
  id: 'aiping',
  name: 'aiping.cn',
  baseUrl: 'https://api.aiping.cn/v1',
  chatModel: 'DeepSeek-V3',
  generateReply: function (worry, personality, settings, hooks, history) {
    var body = {
      model: (settings && settings.chatModel) || SR.adapters.aiping.chatModel,
      messages: [
        { role: 'system', content: personality.systemPrompt + SR._STYLE_RULE + SR._memoryBlock(history, personality.id) + SR._profileBlock(personality.id) + SR._cueRule(personality) + SR._OUTPUT_RULE },
        { role: 'user', content: worry }
      ],
      temperature: 0.9,
      max_tokens: 2048,
      stream: true
    };
    return SR._chatStream(SR.adapters.aiping.baseUrl + '/chat/completions', settings.apiKey, body, hooks)
      .then(function (res) {
        var raw = res && res.text;
        if (!raw || !raw.trim()) {
          if (SR.stats) SR.stats.hit('emptyResp');
          var body2 = Object.assign({}, body, { stream: false });
          return SR._chatOnce(SR.adapters.aiping.baseUrl + '/chat/completions', settings.apiKey, body2).then(function (t) {
            if (!t || !t.trim()) throw new Error('空响应' + (res.reasoning ? '（模型思考用尽 max_tokens，重试仍空）' : ''));
            return t;
          });
        }
        return raw;
      })
      .then(function (raw) {
        var r = SR._parseBilingual(raw);
        return SR._fixBilingual(r, SR.adapters.aiping.baseUrl,
          (settings && settings.chatModel) || SR.adapters.aiping.chatModel, settings.apiKey, personality)
          .then(function (f) { f.source = 'real'; return f; });
      });
  }
};

/* ---------- 远端 TTS（StepFun 语音端点，需 Key） ----------
   返回一个可播放的 objectURL；失败 reject，由调用方回退 Web Speech。
   emotion 用于选情绪专属的全局语境 instruction（角色基调 + 情绪叠加）。
   内容审核（HTTP 451 censorship_blocked）实测为组合式概率判定：演技指示/instruction
   都可能触发，故失败时降级重试一次（去括号指示 + 去 instruction），避免语音静默丢失。 */
SR.remoteTTS = {
  synthesize: function (text, personality, settings, emotion) {
    var url = 'https://api.stepfun.com/v1/audio/speech';
    var voice = (personality && personality.tts && personality.tts.voiceId) || '';
    var mkBody = function (input, instruction) {
      var b = { model: 'stepaudio-2.5-tts', input: input, response_format: 'mp3' };
      if (voice) b.voice = voice;
      if (instruction) b.instruction = instruction;
      return b;
    };
    var post = function (body) {
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
    };
    // cue 白名单强制：模型自创的括号指示（中文动作描写 / 身体接触类）在这里被剥掉
    var safeText = SR._normalizeCues(text, personality) || SR._stripCues(text);
    return post(mkBody(safeText, SR.ttsInstruction(personality, emotion))).catch(function (err) {
      var msg = String((err && err.message) || '');
      if (SR.stats) { SR.stats.noteErr(msg); SR.stats.hit(/451|censorship|blocked/i.test(msg) ? 'err451' : 'ttsFail'); }
      // 只对内容审核类失败降级重试；Key/网络/音色错误重试也是白花钱
      if (!/451|censorship|blocked|content/i.test(msg)) throw err;
      var plain = SR._stripCues(safeText);
      if (!plain) throw err;
      console.warn('[TTS] 审核拦截（' + msg + '），去演技指示与 instruction 重试：', plain);
      return post(mkBody(plain, ''));
    });
  }
};

/* 统一入口：按 settings.adapter 选择，失败回退 mock */
SR.getReply = function (worry, personality, settings, hooks, history) {
  var adapter = SR.adapters[settings.adapter] || SR.adapters.mock;
  if (adapter.id === 'mock') return SR.adapters.mock.generateReply(worry, personality);
  return adapter.generateReply(worry, personality, settings, hooks, history).then(function (reply) {
    if (SR.stats) SR.stats.hit('realOk');
    return reply;
  }).catch(function (err) {
    console.warn('[SR] 真模型调用失败，回退 Mock：', err);
    if (SR.stats) { SR.stats.hit('fallback'); SR.stats.noteErr(err && err.message); }
    if (SR.ui && SR.ui.toast) SR.ui.toast('真模型对话失败（' + (err && err.message ? err.message : '网络/Key') + '），已回退离线 Mock', 'warn');
    return SR.adapters.mock.generateReply(worry, personality);
  });
};

/* ---------- 长期记忆：把该角色的历史压缩成「关于你的备忘」，跳会话注入 system ----------
   只带最近 3 轮的记忆块会造成“切角色就归零、聊久了也不记得你”；备忘存 localStorage，
   让角色能自然提起你之前说过的压力源与偏好，是这类产品最强的亲密感杆杆。 */
SR.PROFILE_EVERY = 10;   // 每多少轮刷新一次
SR.PROFILE_MIN = 4;      // 少于这么多轮不值得生成

SR._profileBlock = function (personalityId) {
  var st = SR.store ? SR.store.get() : null;
  var p = st && st.profiles && st.profiles[personalityId];
  if (!p || !p.text) return '';
  return '\n\n---\n【長期記憶・あなたについて覚えていること】\n' + p.text +
    '\n（これは前の会話から覚えていること。自然に触れてよいが、原文をそのまま読み上げない。今の話題と無関係なら無理に使わない。）\n';
};

/* 生成备忘：仅在真模型可用时执行（离线 Mock 无 Key）。异步、失败静默，不影响当前对话。 */
SR.buildProfile = function (personality, settings, history) {
  if (!settings || !settings.apiKey || settings.adapter === 'mock') return Promise.resolve('');
  var mine = [], i;
  for (i = 0; i < (history || []).length; i++) {
    if ((history || [])[i] && history[i].personalityId === personality.id) mine.push(history[i]);
  }
  if (mine.length < SR.PROFILE_MIN) return Promise.resolve('');
  var recent = mine.slice(-SR.PROFILE_EVERY);
  var lines = [];
  for (i = 0; i < recent.length; i++) lines.push('ユーザー: ' + String(recent[i].worry || '').slice(0, 100));
  var adapter = SR.adapters[settings.adapter] || SR.adapters.stepfun;
  var body = {
    model: settings.chatModel || adapter.chatModel,
    messages: [
      { role: 'system', content:
        'あなたは記憶の要約係です。下のユーザーの発話だけを読み、この人について長期的に覚えておくべき事実を' +
        '日本語で3〜5項目の箇条書きにしてください。範囲は「悩みやストレスの原因」「大切にしているもの・好み」「最近の状況」だけ。' +
        '各項目は「・」で始めて25字以内。発話に無い推測・助言・慰めは書かない。箇条書き以外を出力しない。' },
      { role: 'user', content: lines.join('\n') }
    ],
    temperature: 0.2,
    max_tokens: 1024
  };
  return fetch(adapter.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
    body: JSON.stringify(body)
  }).then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (t) {
      var c = String(SR._contentFromJson(t) || '').replace(/```/g, '').trim();
      if (!c || c.length < 8) return '';
      if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(c)) return '';   // 不是日/中文就不当备忘用
      return c.slice(0, 400);
    }).catch(function () { return ''; });
};

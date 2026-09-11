/* 轻量状态管理：发布-订阅 */
window.SR = window.SR || {};

SR.store = (function () {
  var listeners = [];
  var state = {
    personalityId: 'yandere',
    emotion: 'normal',
    subtitleZh: '……',
    subtitleJa: '',
    isThinking: false,
    isSpeaking: false,
    replySource: '',      // 'real' = 本条回复来自真模型；'' / 'mock' = 离线
    history: [],          // [{worry, ja, zh, emotion, personalityId, ts}]
    profiles: {},         // 长期记忆：{ <personalityId>: { text, ts, turns } }，跨会话保留
    settings: Object.assign({}, SR.CONFIG.DEFAULT_SETTINGS)
  };

  // 从本地存储恢复
  var saved = SR.storage.load();
  if (saved) {
    if (saved.personalityId) state.personalityId = saved.personalityId;
    if (saved.history) state.history = saved.history;
    if (saved.profiles) state.profiles = saved.profiles;
    if (saved.settings) state.settings = Object.assign({}, SR.CONFIG.DEFAULT_SETTINGS, saved.settings);
  }

  function persist() {
    var s = Object.assign({}, state.settings);
    // “仅本次会话”：Key 不落盘（localStorage 是明文，公用电脑上会被下一个人读到）
    if (s.sessionOnly) s.apiKey = '';
    SR.storage.save({
      personalityId: state.personalityId,
      history: state.history.slice(-50), // 只保留最近 50 条
      profiles: state.profiles,
      settings: s
    });
  }

  return {
    get: function () { return state; },
    set: function (patch, opts) {
      Object.assign(state, patch);
      if (!opts || opts.persist !== false) persist();
      for (var i = 0; i < listeners.length; i++) listeners[i](state);
    },
    subscribe: function (fn) {
      listeners.push(fn);
      fn(state); // 立即触发一次，便于初始渲染
      return function () {
        listeners = listeners.filter(function (f) { return f !== fn; });
      };
    }
  };
})();

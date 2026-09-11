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
    settings: Object.assign({}, SR.CONFIG.DEFAULT_SETTINGS)
  };

  // 从本地存储恢复
  var saved = SR.storage.load();
  if (saved) {
    if (saved.personalityId) state.personalityId = saved.personalityId;
    if (saved.history) state.history = saved.history;
    if (saved.settings) state.settings = Object.assign({}, SR.CONFIG.DEFAULT_SETTINGS, saved.settings);
  }

  function persist() {
    SR.storage.save({
      personalityId: state.personalityId,
      history: state.history.slice(-50), // 只保留最近 50 条
      settings: state.settings
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

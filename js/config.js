/* 全局配置与常量（经典脚本，挂载到 window.SR 命名空间） */
window.SR = window.SR || {};

/* 构建戳：与 index.html 的 ?v= 保持一致；main.js 用它与线上 index.html 比对，
   发现浏览器在跑旧缓存时提示并自动刷新（“双中文/中文语音”复发的根因就是旧缓存） */
SR.BUILD = '20260911f';

SR.CONFIG = {
  // 情绪枚举（与立绘文件名一一对应）
  EMOTIONS: ['normal', 'smile', 'angry', 'sad', 'love'],

  // 情绪中文标签（用于徽章显示）
  EMOTION_LABELS: {
    normal: '平静',
    smile: '开心',
    angry: '生气',
    sad: '难过',
    love: '心动'
  },

  // 立绘路径模板
  imageFor: function (personalityId, emotion) {
    return 'assets/characters/' + personalityId + '/' + emotion + '.jpeg';
  },

  // 默认设置
  DEFAULT_SETTINGS: {
    adapter: 'mock',        // mock | stepfun | aiping
    apiKey: '',
    chatModel: '',          // 空 = 用适配器默认模型；可覆盖为你的 Key 支持的模型
    ttsEngine: 'webspeech', // webspeech | remote
    rate: 1.0,
    pitch: 1.0,
    voiceURI: '',           // 空 = 自动选择 ja-JP
    autoSpeak: true
  },

  STORAGE_KEY: 'sr-game-state-v1'
};

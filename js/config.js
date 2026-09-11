/* 全局配置与常量（经典脚本，挂载到 window.SR 命名空间） */
window.SR = window.SR || {};

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
    ttsEngine: 'webspeech', // webspeech | remote
    rate: 1.0,
    pitch: 1.0,
    voiceURI: '',           // 空 = 自动选择 ja-JP
    autoSpeak: true
  },

  STORAGE_KEY: 'sr-game-state-v1'
};

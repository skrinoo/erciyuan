# こころのよりどころ · 心灵依靠 | 解压小游戏

一个二次元美少女解压小游戏：输入你的烦恼，选择不同性格的美少女（病娇 / 傲娇 / 温柔大姐姐），
她会用**日语语音 + 中文字幕 + 表情变化**回应你。

纯静态 HTML/CSS/JS，**无需安装 Node.js、无需构建**，双击 `index.html` 即可玩。

---

## 快速开始

1. 双击打开 `index.html`（推荐 Chrome / Edge）。
2. 底部选择性格 → 在输入框写下烦恼 → 点「倾诉 💬」（或 `Ctrl + Enter`）。
3. 美少女会切换表情、打出中文字幕、播放语音。

> 首次打开若浏览器拦截本地音频/语音，请点击地址栏允许即可。

---

## 三种性格

| 性格 | 角色 | 主题色 | 特点 |
|---|---|---|---|
| 病娇 | 绫音（アヤネ） | 深红 | 占有欲强，甜蜜中带着危险 |
| 傲娇 | 千夏（チナツ） | 草莓粉 | 嘴硬心软，别扭的关心 |
| 温柔大姐姐 | 美咲（ミサキ） | 薰衣草紫 | 包容、治愈、母性 |

每种性格有 5 种表情立绘：`normal / smile / angry / sad / love`，
位于 `assets/characters/<性格>/`。

---

## 语音方案（重要）

全部语音均为**女声**，并按性格匹配日漫典型声线（StepFun 官方音色）：

| 性格 | 音色 ID | 声线参考 |
|---|---|---|
| 病娇 · 绫音 | `tianmeinvsheng` | 甜美女声，可转病态执拗（类病娇役） |
| 傲娇 · 千夏 | `livelybreezy-female` | 活力高亢少女（类傲娇役） |
| 温柔大姐姐 · 美咲 | `wenroushunv` | 温柔熟女，包容母性（类大姐姐役） |

语音按以下优先级自动选择：

1. **远端 TTS**：设置里选「远端 TTS」并填 API Key → 实时调 StepFun 语音接口（带上述音色 + 角色语气指令）。
2. **预生成女声音频（默认 Mock 模式即用）**：
   - 开场白：`assets/audio/<性格>/greeting.mp3`
   - 语料回复：`assets/audio/<性格>/c0.mp3 ~ c7.mp3`（与 `mockCorpus.js` 条目一一对应）
   离线即可播放真·日语女声。
3. **Web Speech 兜底**：当某条回复没有预生成音频（如兜底句）时走浏览器 Web Speech；
   无日语语音包时改念中文字幕，保证始终有声。

### 想换音色 / 全实时日语？

- 改 `js/personalities.js` 里各性格的 `tts.voiceId`（StepFun 官方女声还有
  `qingchunshaonv` 清纯少女、`jingdiannvsheng` 经典女声、`elegantgentle-female` 高雅女声等）。
- 填 API Key 并选「远端 TTS」，则每条回复都实时合成日语女声。

---

## AI 后端（可插拔）

设置面板可切换：

- **Mock（默认）**：离线语料库，按关键词匹配回复，零成本、零依赖、永远可用。
- **StepFun / aiping.cn**：填 API Key 后接真模型实时生成回复（日语角色扮演）。
  调用失败会自动回退 Mock，游戏不中断。

真模型的系统提示词在各性格配置里（`js/personalities.js` 的 `systemPrompt`），
要求模型返回 1–2 句日语台词 + `[emotion:xxx]` 情绪标签，前端据此切换表情。

---

## 目录结构

```
test/
├── index.html                 # 入口（经典脚本，file:// 可直接打开）
├── styles/
│   ├── main.css               # 布局 / 字幕 / 输入 / 面板
│   ├── character.css          # 立绘呼吸 / 交叉淡入 / 情绪 pop / 说话晃动
│   └── themes.css             # 三性格主题色（CSS 变量）
├── js/
│   ├── config.js              # 情绪枚举 / 路径模板 / 默认设置
│   ├── personalities.js       # 三性格配置（提示词 / 音色 / 情绪偏好）
│   ├── mockCorpus.js          # 离线语料库（关键词匹配 + 兜底）
│   ├── services.js            # 存储 / 情绪路由 / Web Speech / 音频播放
│   ├── adapters.js            # Mock / StepFun / aiping 适配器 + 远端 TTS
│   ├── store.js               # 轻量发布-订阅状态管理
│   ├── ui.js                  # DOM 渲染组件
│   └── main.js                # 启动 / 事件 / 核心对话流程 / 语音路由
└── assets/
    ├── characters/<性格>/     # 5 张表情立绘（normal/smile/angry/sad/love）
    └── audio/<性格>/          # 女声音频：greeting.mp3 + c0~c7.mp3
```

---

## 扩展指南

- **加新性格**：在 `js/personalities.js` 加一项；在 `assets/characters/<id>/` 放 5 张表情图；
  在 `js/mockCorpus.js` 加语料；在 `styles/themes.css` 加主题色；在 `index.html` 无需改动（切换按钮自动生成）。
- **加新表情**：在 `config.js` 的 `EMOTIONS` / `EMOTION_LABELS` 加项，并放同名图片。
- **调语料**：直接编辑 `js/mockCorpus.js`。

---

## 已知限制

- Web Speech 兜底的日语音色取决于操作系统；未装日语语音包时兜底句念中文。主回复与开场白均为预生成日语女声，不受影响。
- 真模型 / 远端 TTS 需要自备 API Key；女声音色 ID 已在 `personalities.js` 配好，可自行替换。
- `file://` 协议下个别浏览器对 localStorage 支持有限；如遇设置不保存，可改用本地服务器（如 `python -m http.server`）打开。

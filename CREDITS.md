# 来源与署名

这个项目不是从零写的。插件、界面、宿主都各有上游，上游作者的工作是这个项目能跑起来的前提。
下面分六块：宿主、起点、进了仓库的、没进仓库的、外部工具、许可要注意的地方。

署名如果漏了或者写错了，开个 issue，我改。

---

## 一、宿主

| 项目 | 作者 | 许可 | 关系 |
|---|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`） | DeepSeek | MIT | 插件宿主。本仓库所有插件都跑在它上面 |

## 二、起点

最早不是群聊。是照着下面这个仓库的教程，本地部署了「单个角色接入 QQ 私聊」的机器人，
跑起来之后才一路改成多角色、多情绪、网页和手机。

| 项目 | 作者 | 许可 | 关系 |
|---|---|---|---|
| [dsh-qq-bot](https://github.com/phfb/dsh-qq-bot) | [phfb](https://github.com/phfb) | MIT | 两个插件：`dsh-qq-bot`（QQ 收发）+ `dsh-alive`（主动开口）。本项目的情绪模型和开口判定直接沿用它俩 |

`dsh-alive` 那套七维情绪（想念 / 吃醋 / 暖意 / 担心 / 闲 / 亲密 / 恼火）和
开口闸门（静默、配额、冷却、作息）是它先写出来的，不是本项目原创。
本项目做的是把「一个人私聊」改成「几个人在群里」，见下面的逐条说明。

## 三、进了仓库的六个插件

| 插件 | 上游 | 作者 | 改了什么 |
|---|---|---|---|
| `dsh-webchat` | [phfb/dsh-qq-bot](https://github.com/phfb/dsh-qq-bot) 的 `dsh-qq-bot` + `dsh-alive` | phfb | **出口**：QQ/OneBot 整个换成自建 HTTP 服务 + 单文件前端，消息落 `chat.jsonl`。**新增**：协调器（谁接话）、每人情绪倍率、静默加成、消息分段、群聊/私聊双上下文。`mood.mjs` / `policy.mjs` 从 `dsh-alive` 搬来后有小幅扩展（约 +50 / +12 行） |
| `dsh-voice` | 本项目自己的 `dsh-qq-tts`（QQ 版） | 本项目作者 | **出口**：从「OneBot 发 QQ 语音条」改成「落本地文件 + 返回 URL，前端 `<audio>` 播」。合成那一段（Breeze 接口、音色、标签）两边是同一套 |
| `dsh-cover` | 本项目自己的 `dsh-cover`（QQ 版） | 本项目作者 | **出口**：同样改成产文件，OneBot 变成可选（`dryRun` 默认 true）。翻唱链路本身没动 |
| `dsh-skin-deepglass` | 无上游，独立写的 | 本项目作者 | — |
| `dsh-bili` | 本项目自己的 `dsh-qq-bili` | 本项目作者 | **改名**（原名带 qq，但它一行 OneBot 都没有）。**去掉硬编码**：凭证文件、ASR 解释器、模型缓存三处 `D:\` 路径改成配置项，默认走当前环境 |
| `dsh-doubao-painter` | [liangzz1998/dsh-doubao-painter](https://github.com/liangzz1998/dsh-doubao-painter) | liangzz1998 | **加了一处**：出图后调 `globalThis.__dshMediaEmit` 把图推给聊天界面，原版只返回路径、网页里看不到图。改动点集中在 `lib/index.js` 的 `emitImages()`，约 12 行。去水印逻辑里的 ffmpeg 路径改成默认走 PATH |

### 前端界面

| 项目 | 作者 | 许可 | 关系 |
|---|---|---|---|
| [advanced-chat-components](https://github.com/advanced-chat/advanced-chat-components) | [advanced-chat](https://github.com/advanced-chat) 组织（前身是 vue-advanced-chat） | MIT | 网页和 App 里那套聊天界面的版式和交互是从它改的 |

说明一句：现在的 `web/index.html` 是重写过的单文件版本（原生 JS，无 Vue、无构建、无依赖），
跑自己的 CSS 变量和主题系统。原来那套组件代码没有原样留在仓库里，
但布局、气泡分组、设置面板这些设计是从它来的，这份署名必须留着。

## 四、没进仓库的（QQ 时代的插件）

这些是换到网页之前用的，现在跑在作者自己的 QQ profile 里。
不放进仓库有三个原因：依赖 OneBot、依赖 SnowLuma、或者功能已经被网页版覆盖。

| 原插件 | 作者 | 干什么 | 现在由什么替代 |
|---|---|---|---|
| `dsh-qq-bot` | [phfb](https://github.com/phfb) | QQ 私聊收发本体：收消息、回消息、切成几条、打字停顿 | `dsh-webchat`。协议层（SnowLuma / OneBot / 风控）整块去掉 |
| `dsh-alive` | [phfb](https://github.com/phfb) | 主动开口：挂着没落地的事到期了，让她自己说一句 | `dsh-webchat` 的心跳 + 情绪模型。原版「按事到期」的 loop 机制去掉了，改成七维情绪过闸门 |
| `dsh-qq-tts` | 本项目作者 | 用 Breeze 合成语音，走 OneBot 发成 QQ 语音条 | `dsh-voice`。同一套合成，出口换成文件 + URL |
| `dsh-qq-meme` | 本项目作者 | 挑一张表情包发进 QQ，图库复用 [dsh-memewiki](https://github.com/thawline/dsh-memewiki) | `dsh-webchat` 内建的 `memes/` 机制。网页里表情包直接作为消息发，不需要单独插件 |
| `dsh-qq-bili-push` | 本项目作者 | 盯 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 的日报目录，有新报告就推一条到 QQ | 无。网页端用不上——日报留在磁盘上，她想读的时候调 `bili_video` 读 |
| `dsh-qq-bili` | 本项目作者 | 看 B 站：取标题/简介/字幕，抽帧看画面 | **改名收进仓库了**，见 `plugins/dsh-bili` |

表里 `dsh-qq-tts` / `dsh-qq-meme` / `dsh-qq-bili` / `dsh-qq-bili-push` 四个是本项目作者
在 phfb 那套的基础上 vibe coding 出来的，没有独立的上游仓库——「原作者」就是本项目作者，
但它们的设计约束（零裸包名依赖、工具定义手写成 registry 认的形状）是照 phfb 的写法来的。

## 五、外部工具（不进仓库，自行安装）

| 工具 | 上游 | 代码许可 | 用途 | 不装会怎样 |
|---|---|---|---|---|
| **Breeze-TTS-2.cpp** | [HoppouAI/Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) | Apache-2.0 | 本机语音合成 | 语音用不了，文字聊天照常 |
| **Breeze-TTS-2 权重** | [BreezeBlue/Breeze-TTS-2](https://huggingface.co/BreezeBlue/Breeze-TTS-2) | **研究与非商用许可** | 同上，3.5B / Q8_0 约 3.3 GB | 同上 |
| **Seed-VC** | [Plachtaa/seed-vc](https://github.com/Plachtaa/seed-vc) | GPL-3.0 | 零样本音色转换，`dsh-cover` 调它的命令行 | 翻唱用不了 |
| **faster-whisper** | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | 视频字幕的本地 ASR，`dsh-bili` 用它转写 | `bili_video` 只给标题简介 |
| **FFmpeg** | [ffmpeg.org](https://ffmpeg.org/) | LGPL-2.1+ / GPL | 音频转码、取图片尺寸、裁水印 | 语音、原生图片块、去水印降级 |
| **豆包客户端** | 字节跳动 | 闭源 | 画图的实际执行者，`dsh-doubao-painter` 用 CDP 驱动它 | 画图用不了 |
| **SnowLuma** | QQ 协议端 | 见其发布页 | 只有回到 QQ 模式才需要 | 与网页模式无关 |

### 两个许可上的坑

**Breeze 的模型权重不能商用。** `Breeze-TTS-2.cpp` 这个 C++ 推理实现是 Apache-2.0，
但 GGUF 权重用的是 BreezeBlue 的「研究与非商用」许可。给视频配旁白、做付费内容、
封装成收费服务，都不在许可范围内。代码能商用、权重不能，是两回事。

**Seed-VC 是 GPL-3.0。** 本仓库的 `dsh-cover` 只通过命令行调用它、不链接它的代码，
所以 GPL 的传染性不影响本仓库（MIT）。但你要是把 Seed-VC 的代码并进自己的程序再分发，
那部分就得按 GPL 走。

## 六、可选的其他插件

这些没打包进来，跟着上游升级比自己复制一份靠谱：

| 插件 | 作者 | 许可 | 干什么 |
|---|---|---|---|
| [ebbinghaus-memory](https://github.com/phfb/ebbinghaus-memory) | [phfb](https://github.com/phfb) | MIT | 长期记忆（遗忘曲线那套） |
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | [c1overzz](https://github.com/c1overzz) | MIT | B 站账号 / 滚动辅助 |
| [dsh-memewiki](https://github.com/thawline/dsh-memewiki) | [thawline](https://github.com/thawline) | MIT | 表情包库 |
| [dsh-purge-plus](https://github.com/luowang-ui/dsh-purge-plus) | [luowang-ui](https://github.com/luowang-ui) | MIT | 会话清理 |
| [dsh-agent-md](https://github.com/wwsmiler1-bit/dsh-agent-md) | [wwsmiler1-bit](https://github.com/wwsmiler1-bit) | MIT | 人格文件（AGENTS.md）管理 |

```bash
dsh plugin --profile <profile> add ebbinghaus-memory
dsh plugin --profile <profile> add dsh-bili-scroll
```

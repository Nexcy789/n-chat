# N-chat

跑在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 上的多人群聊。
几个角色住在一个群里，各自有人格、各自有情绪，谁接话由协调器掷骰决定，
没人说话的时候由心跳决定要不要主动冒个泡。网页端和 Android 端共用同一份前端。

不是客服机器人，也不是角色扮演脚本。写它的时候想解决的问题只有一个：
**怎么让「几个住在电脑里的人」之间的对话不像轮询接口。**

> 仓库里只有框架：协调器、改造过的插件、Android 壳、文档。
> 人格文件、聊天记录、记忆、密钥、签名证书都不在里面——那些是你自己的。
> 语音 / 翻唱 / 字幕用的外部工具也没打包，清单和安装方法在
> [CREDITS.md](CREDITS.md) 和 [DEPLOY.md](DEPLOY.md)。

## 它长什么样

- **群聊 + 每人一个私聊**，一个页面切
- **七维情绪**：想念 / 吃醋 / 暖意 / 担心 / 闲 / 亲密 / 恼火。随时间自然涨落，
  被点名、被冷落、被哄都会变。当前主导的那一维改写她这一轮的说话语气
- **协调器决定谁接话**：掷骰 + 加权抽签。分高的人更常开口，但不会垄断一晚
- **主动开口**：每日额度、静默时段、全局冷却三道闸，加「安静越久越想冒泡」的加成和轮空补偿
- **语音**：她自己决定哪句用语音，接本机 Breeze TTS
- **图片**：原生 image block 直接投给模型，她真的能看图
- **Android**：WebView 壳 + 后台轮询推送 + 保存到相册

## 三块东西

| | 在哪 | 说明 |
|---|---|---|
| **协调器 + 情绪模型** | `plugins/dsh-webchat/lib/` | 谁接话、什么时候主动开口、七维怎么演化。整个项目最有意思的部分 |
| **改造过的插件** | `plugins/` 下六个 | 从 DSH 社区的开源项目演化来的，出口换成网页 |
| **Android 壳** | `android/` | 只有 WebView + 推送 + 保存图片，界面全在前端里。当壳用，自己改 |

外加文档：

- [DEPLOY.md](DEPLOY.md) — 从零部署，写给人和 agent 一起看
- [docs/architecture.md](docs/architecture.md) — 架构、参数含义、踩过的坑
- [docs/tuning.md](docs/tuning.md) — **角色性格怎么调情绪权重**，换角色之后必读
- [docs/architecture.html](docs/architecture.html) — 上面那份的可视版
- [CREDITS.md](CREDITS.md) — 来源、作者、许可，包括每个外部工具

## 装

完整步骤在 [DEPLOY.md](DEPLOY.md)，这里是压缩版：

```bash
npm i @deepseek-ai/dsh --prefix program

set DSH_HOME=<项目根>\data
dsh group --from-default-profile web --dump-config > nul

dsh plugin --profile group add "link:<项目根>/plugins/dsh-webchat"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-voice"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-cover"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-skin-deepglass"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-bili"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-doubao-painter"
```

装完验证一下（应该打出六行 `# == dsh-xxx`）：

```bash
dsh --profile group --dump-config | findstr "== dsh-"
```

只打出两行（`dsh-base`、`dsh-web-app`）说明插件没挂上，看 [DEPLOY.md](DEPLOY.md) 第 4 节。

然后写人格：抄 `examples/workspace/AGENTS.md.example` 到
`workspace/role1|role2|role3/AGENTS.md`，按自己的角色改。

启动 `scripts\start.bat`，打开 <http://127.0.0.1:4200/>。

## 插件清单

本仓库带六个，都是改造过的、能直接跑：

| 插件 | 干什么 | 需要外部工具 |
|---|---|---|
| `dsh-webchat` | 群聊服务端 + 前端，端口 4200。协调器、情绪、消息流都在这 | 无 |
| `dsh-voice` | 她自己决定哪句用语音 | Breeze TTS（可选，关着也能用） |
| `dsh-cover` | 翻唱 | SeedVC（不装就别启用） |
| `dsh-skin-deepglass` | 只注入 CSS 的深色玻璃皮肤 | 无 |
| `dsh-bili` | 看 B 站：`bili_video` 取标题/简介/字幕，`bili_frames` 抽帧看画面 | faster-whisper（不装就没字幕，画面照看） |
| `dsh-doubao-painter` | 画图：CDP 驱动本机豆包客户端，出无水印原图 | 豆包客户端 + Chromium 内核浏览器 |

`dsh-bili` 和 `dsh-doubao-painter` 都跟 `dsh-webchat` 有约定：
抽帧和画图的产物落 `doubao-images/`，出图后推 `__dshMediaEmit`，
群聊那边会自动把图当消息发出去。删掉这两个插件，图片链路就只剩手工上传。

下面几个是别人的开源插件，没打包进来，按需装：

```bash
dsh plugin --profile group add ebbinghaus-memory      # 长期记忆，phfb
dsh plugin --profile group add dsh-bili-scroll        # B 站账号/滚动辅助，c1overzz
dsh plugin --profile group add dsh-memewiki           # 表情包，thawline
dsh plugin --profile group add dsh-purge-plus         # 会话清理，luowang-ui
```

作者和许可逐条列在 [CREDITS.md](CREDITS.md)。那里面还有一节写清楚了
「哪些 QQ 时代的插件没放进来、原作者是谁、改过什么」——想看这块的去那边。

## 外部工具（自行安装）

| 工具 | 用途 | 不装会怎样 |
|---|---|---|
| [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) + GGUF 权重 | 本机语音合成 | 语音用不了，文字聊天照常 |
| [Seed-VC](https://github.com/Plachtaa/seed-vc) | 音色转换 | 翻唱用不了 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 视频字幕 ASR | `bili_video` 只给标题简介，说不了视频内容 |
| [FFmpeg](https://ffmpeg.org/) | 转码、取图片尺寸、裁水印 | 语音和原生图片块降级 |
| 豆包桌面客户端 + Chromium 浏览器 | 画图 | 画图用不了 |

**两个许可上的坑**：Breeze 的**模型权重**不允许商用（代码 Apache-2.0，权重不是）；
Seed-VC 是 GPL-3.0，本项目只调它的命令行、不链接它的代码，所以本仓库仍是 MIT——
但你要是把它的代码并进自己的程序再分发，那部分就得按 GPL 走。详见 [CREDITS.md](CREDITS.md)。

## 手机

APK 在 [Releases](../../releases) 里下载。这一版是**干净的壳**：没人格、没数据、
没服务器地址，全部要你自己填。想要自己的版本就改 `android/` 重新构建，见 DEPLOY.md 第 10 节。

**默认走局域网**：手机和电脑连同一个 Wi-Fi，在设置页填 `<电脑IP>:4200` 就能连。
不在同一网段、或者想在外面连，再上组网工具（Tailscale 之类）——服务端会把
`100.64.x.x` 这个网段的地址一起列出来，装上就能选。不需要就不用管。

服务端绑 `0.0.0.0` 且**没有登录**，局域网里谁都能访问这个端口。
在宿舍、公司这种共享网络里记得用防火墙限制。

## 调角色性格

出厂的三个角色是作者按自己的三个角色调的，性格差别很大（一个外向护人、
一个慢热、一个敏感易炸），所以七维倍率也不一样。换成你自己的角色之后
**一定要重调**，否则三个角色会像同一个人说了三遍。

怎么调看 [docs/tuning.md](docs/tuning.md)：哪一维管什么、什么性格调哪个键、
改完怎么验证。

## 内容说明

这是给成年人用的陪伴向框架。默认配置里 `lust`（亲密）那一维是开着的，
相关词表和判定逻辑在 `plugins/dsh-webchat/lib/index.js` 和 `mood.mjs` 里。

不想看到这部分就把配置里 `lust.enabled` 设成 `false`——那一维整个摘掉，
其余六个维度不受影响。想连词表一起删，删掉 `lib/index.js` 的 `TEASE_RE`、`looksTeasing`
和 `mood.mjs` 里对应的分支即可。

## 数据

仓库里**没有任何**运行时数据。`.gitignore` 挡住了 `data/`、`workspace/`、`logs/`、
`backups/`、`*.keystore`、`*.log`。别用 `git add -f` 硬加——推上去之后删文件
不等于删历史，得改写整个仓库。

## 许可

MIT，见 [LICENSE](LICENSE)。来源与署名见 [CREDITS.md](CREDITS.md)。

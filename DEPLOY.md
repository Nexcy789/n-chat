# 部署

从零到「手机上能聊」的完整步骤。写给人和 AI 一起看——把这一份整个丢给 agent，
说「按 DEPLOY.md 帮我装」，它照着做就行。

**先说清楚一件事**：下面所有版本号、模型大小、显存需求都只是参考。
你的显卡、内存、系统跟作者的不一样，模型选哪个、要不要开语音、开几个角色同时跑，
这些得你自己定。别照抄参数，先看第 0 节。

---

## 0. 硬件与模型

| 部件 | 最低 | 说明 |
|---|---|---|
| 系统 | Windows 10/11、Linux、macOS | 本项目的启动脚本是 Windows 的 `.bat`；其他系统照着命令手敲 |
| Node.js | 22+ | DSH 的硬要求 |
| 内存 | 8 GB | 三个角色同时跑，上下文也不小 |
| 模型 | 任意 DSH 支持的 | **不指定**。图片理解要模型本身认图，否则她看不到你发的图 |
| 显卡 | 不用 | 只有开语音（Breeze TTS）才吃 GPU，Vulkan 或 CPU 都能跑 |

模型选型是**你自己的事**：本地 7B 和云端大模型在这套框架里表现差别很大——
本地小模型容易在长上下文里丢人格，云端模型贵但稳。先跑通再换，别一上来就调参。

---

## 1. 目录约定

下文用 `<项目根>` 指 clone 下来的目录。

```
<项目根>/data/         DSH 的运行时数据（DSH_HOME 指这里）
<项目根>/workspace/    每个角色一个子目录，放人格文件
<项目根>/program/      DSH 本体装在这里（可选，也可全局装）
```

把 `DSH_HOME` 指到 `<项目根>/data` 的好处是所有数据都在项目里，
不污染用户目录，删项目就等于删干净。

---

## 2. 装 Node 和 DSH

```bash
node -v            # 要 v22 以上
npm i @deepseek-ai/dsh --prefix program
```

装完 DSH 的命令在 `program/node_modules/@deepseek-ai/dsh/lib/bin.js`。
下文写 `dsh` 的地方，用 `node <项目根>/program/node_modules/@deepseek-ai/dsh/lib/bin.js` 代替即可。

想省事就全局装，然后直接用 `dsh`：

```bash
npm i -g @deepseek-ai/dsh
```

**版本提醒**：DSH 目前还是 rc 阶段，`npm i` 会装到最新版，接口和插件行为可能变。
本项目是在 `0.2.1-rc.2` 上测的。要是装完发现插件加载报错、或者皮肤只剩光晕，
先锁回这个版本试试：

```bash
npm i @deepseek-ai/dsh@0.2.1-rc.2 --prefix program
```

---

## 3. 建一个 profile

DSH 的 profile 是「一组插件 + 一份配置」。新建一个从 `web` 模板复制：

```bash
set DSH_HOME=<项目根>\data
dsh group --from-default-profile web --dump-config > nul
```

验证：`<项目根>\data\profiles\group\` 这时候应该出现了 `package.json` 和 `cordis.patch.yml`。

（`--dump-config` 只是为了让它初始化完就退出，不真的启动。）

---

## 4. 装插件

六个插件都在 `<项目根>\plugins\` 下，用 `link:` 挂进去，改代码不用重装。
**`link:` 后面要写绝对路径**，pnpm 不会按 profile 目录去推相对路径：

```bash
dsh plugin --profile group add "link:<项目根>/plugins/dsh-webchat"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-voice"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-cover"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-skin-deepglass"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-bili"
dsh plugin --profile group add "link:<项目根>/plugins/dsh-doubao-painter"
```

`<项目根>` 换成真实路径，例如 `D:/n-chat`。装完 `dsh plugin` 会把插件名写进
`data/profiles/group/package.json` 的 `dsh.profile.bundles`，这一步通常自动完成。

**如果报 `cannot resolve profile bundle "dsh-webchat"`**：pnpm 的软链还没建好，
reconcile 就先去读了。补两步就好：

```bash
dsh plugin --profile group install
dsh plugin --profile group add "link:<项目根>/plugins/dsh-webchat"
```

还不行就手改 `<项目根>\data\profiles\group\package.json`，在
`dsh.profile.bundles` 数组里加六行（这一定有效，实测过）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-webchat",
        "dsh-voice",
        "dsh-cover",
        "dsh-skin-deepglass",
        "dsh-bili",
        "dsh-doubao-painter"
      ]
    }
  }
}
```

顺序有讲究：`@deepseek-ai/dsh-base` 和 `dsh-web-app` 必须在前，插件在后。
没有 SeedVC 就在配置里把 `dsh-cover` 的 `dryRun` 保持 true；
没有豆包客户端就把 `dsh-doubao-painter` 的 `enabled` 设 false——不设也不至于崩，
但它会一直连不上 9225 端口刷日志。

验证（应该打出六行 `# == dsh-xxx`）：

```bash
dsh --profile group --dump-config | findstr "== dsh-"
```

打出来六行就对了。

---

## 5. 配模型

配置文件在 `<项目根>\data\profiles\group\cordis.patch.yml`。

**先注意这个文件的结构**：它本身是一个 **YAML 数组**，新建出来的内容是一个 `[]`
（上面几行是注释）。要加配置，**把 `[]` 换成你的条目**，不要往文件末尾追加——
直接在后面追加会变成两个 YAML 文档，启动时报 `parsePatchList` 解析失败。

```
# 错：保留 []
[]
- id: dsh-webchat
  config:
    port: 4299

# 对：把 [] 替换掉
- id: dsh-webchat
  config:
    port: 4299
```

模型相关的项长这样，自己换 provider 和 model：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: low
```

API Key 不用手写进 YAML。DSH 把凭据存在 `data/.credentials.yaml` 里，由它自己管——
在 DSH 界面里登录/填 Key，或者用 `dsh` 的命令行登录流程。**别手改那个文件**，
格式不对会让整个 profile 起不来。

---

## 6. 写人格

每个角色一个目录，目录名要和配置里的 `dir` 对上：

```
workspace/role1/AGENTS.md
workspace/role2/AGENTS.md
workspace/role3/AGENTS.md
```

模板在 `examples/workspace/AGENTS.md.example`，抄过去改。
不写也能启动，但三个角色会像同一个人说了三遍。

写人格是最影响最终效果的一步，比调参数重要得多。见 [`docs/tuning.md`](docs/tuning.md)。

---

## 7. 启动

Windows 上双击 `scripts\start.bat`，或者手敲：

```bash
set DSH_HOME=<项目根>\data
set NCHAT_HOME=<项目根>
dsh group --port 3090 --no-open
```

浏览器打开 <http://127.0.0.1:4200/>。第一次会白屏几秒，等 DSH 起来。

验证服务真的活了：

```bash
curl http://127.0.0.1:4200/api/state
```

返回 JSON（里面有 `hosts` 字段列出本机地址）就说明群聊服务起来了。

停：`scripts\stop.bat`，或者直接关窗口。

---

## 8. 手机连（默认局域网）

**默认就是局域网**，同一个 Wi-Fi 就行，不用装任何组网工具。

1. 电脑上 `ipconfig`，记下 IPv4 地址（一般是 `192.168.x.x` 或 `10.x.x.x`）
2. 装 APK，首次打开会跳到设置页
3. 填 `<电脑IP>:4200`，点进入

连不上先查这三条：

- 电脑防火墙有没有放行 4200（Windows 第一次跑会弹窗问你，点允许）
- 手机和电脑是不是同一个网段（一个连 5G 一个连 2.4G 也可能不在同一段）
- `curl http://<电脑IP>:4200/api/state` 在电脑上能不能通

组网工具（Tailscale、ZeroTier 之类）是备用方案：不在同一个网段、
或者想在外面也能连的时候才用。服务端会把 `100.64.x.x` 这个网段的地址也列进 `hosts`，
装了组网工具的话设置页会看到它。不需要就不用管。

**注意**：服务端绑的是 `0.0.0.0`，局域网内任何人都能访问这个端口，没有登录。
在宿舍、公司这种共享网络里，记得用防火墙只放行你自己的设备。

---

## 9. 可选功能

按需装，不装的插件记得在配置里设 `enabled: false`，否则启动会报错。

### 语音（Breeze TTS）

1. 下 [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) 的 Windows Vulkan 版 Releases
2. 下 GGUF 权重（Q8_0，约 3.3 GB），放 `models\`
3. 解压到**纯英文路径**，不能有中文和空格
4. 起服务：

```bash
breeze-server.exe breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8137 --voices-dir voices
```

5. 在 `cordis.patch.yml` 里把 `dsh-voice` 的 `enabled` 改 true，`voices` 里填你 `voices/` 目录下的音色名

**许可提醒**：代码 Apache-2.0，但模型权重是「研究与非商用」。商用要另找方案。

### 翻唱（SeedVC）

1. 装 [Seed-VC](https://github.com/Plachtaa/seed-vc)，Python 3.10 + `pip install -r requirements.txt`
2. 准备你自己的翻唱脚本（本项目的 `dsh-cover` 调的是 `kge.py` 这种 CLI，
   输入输出走 JSON——你可以换成任何自己的实现，只要约定对得上）
3. 改 `dsh-cover` 配置里的 `pythonExe` / `script` / `cwd` 指向你的
4. 先设 `dryRun: true` 跑通，再接 QQ 发送

这是一堆注意里最容易翻车的一环，因为 SeedVC 的安装本身就不轻。不想折腾就跳过。

### 字幕 / B 站（faster-whisper）

```bash
pip install faster-whisper
```

第一次跑会自动下模型（small 约 500 MB）。CPU 也能跑，10 分钟以内的视频还行。

**建议用独立 venv**：faster-whisper 对 `av` 的版本挑剔，主环境里已有别的 `av` 版本时会 import 失败。

```bash
python -m venv .venv-asr
.venv-asr\Scripts\pip install faster-whisper
```

然后把 `dsh-bili` 配置里的 `asrPython` 指向 `.venv-asr\Scripts\python.exe`（写绝对路径）。
写 `'python'` 就走 PATH，那要求你的主环境里直接装了 faster-whisper。

不装也能用 `bili_video`，只是没有字幕——只有标题、UP、简介、时长。

### 画图（豆包）

不需要装任何东西，但要求本机有：

1. 豆包桌面客户端，**已登录**
2. 一个 Chromium 内核浏览器（Chrome / Edge 都行），或者直接用豆包客户端本身

改 `plugins/dsh-doubao-painter/cordis.patch.yml` 里的 `appExe` 指向你的浏览器主程序。
默认写的是 Windows 上 Edge 的位置。

插件会自己用 `--remote-debugging-port=9225` 拉起一个无头浏览器，不用你手动开。
出图落在 `workspace/<角色>/doubao-images/`，`dsh-webchat` 扫到会自动当消息发出去。

没有豆包客户端就把这个插件 `enabled: false`，否则它会一直连不上 9225 刷日志。

### FFmpeg

语音转码、取图片尺寸、裁豆包水印都要它。装完确认在 PATH 里：

```bash
ffmpeg -version
ffprobe -version
```

配置里 `ffmpegPath: 'ffmpeg'` 就是走 PATH；要指定路径就写绝对路径。

### 其他插件（记忆 / 表情包 / 清理）

这几个是别人的，没打进本仓库，按需装：

```bash
dsh plugin --profile group add ebbinghaus-memory      # 长期记忆，phfb
dsh plugin --profile group add dsh-bili-scroll        # B 站账号/滚动辅助，c1overzz
dsh plugin --profile group add dsh-memewiki           # 表情包，thawline
dsh plugin --profile group add dsh-purge-plus         # 会话清理，luowang-ui
```

装完同样要确认进了 `dsh.profile.bundles`。作者和许可见 [CREDITS.md](CREDITS.md)。

---

## 10. 打 APK

`<项目根>\scripts\build-apk.bat`，或者 Android Studio 打开 `android/` 直接 Run。

命令行构建需要 JDK 17 + Android SDK 34 + Gradle 8。先造个证书（**目录要先建**，
keytool 不会自己创建）：

```bash
mkdir <项目根>\keystore
keytool -genkeypair -v -keystore <项目根>\keystore\my.keystore -alias mykey -keyalg RSA -keysize 2048 -validity 10000
```

然后把路径和密码写进 `android\local.properties`（这个文件不进仓库）。
注意 `NCHAT_KEYSTORE` 是**绝对路径，反斜杠要写两遍**：

```properties
NCHAT_KEYSTORE=D\:\\keys\\my.keystore
NCHAT_STORE_PASSWORD=你的密码
NCHAT_KEY_ALIAS=mykey
NCHAT_KEY_PASSWORD=你的密码
```

四样缺一样，构建不会报错，但产物是 `app-release-unsigned.apk`——装不上。
看到这个名字就是证书没配上。

跑 `scripts\build-apk.bat`，产物在 `<项目根>\dist\N-chat.apk`。

**改了前端记得同步**：`plugins/dsh-webchat/web/index.html` 改完要拷一份到
`android/app/src/main/assets/index.html`，两个文件必须一模一样，否则手机和网页表现不一致。
`build-apk.bat` 会自动拷，Android Studio 里手动 Run 的话不会。

---

## 11. 排错

| 现象 | 先看这里 |
|---|---|
| 启动报 `parsePatchList` / YAML 解析失败 | 第 5 节：`cordis.patch.yml` 是数组，别在 `[]` 后面追加，要替换 |
| 启动报 `cannot resolve profile bundle` | 第 4 节：先 `install` 再 `add`，或者手写 `bundles` |
| 网页 4200 打不开，但 3090 正常 | `dsh-webchat` 没启用，或者端口被占（`netstat -ano \| findstr :4200`） |
| 产物是 `app-release-unsigned.apk` | 证书没配上，warn 不报错。查第 10 节四行 |
| 她说的话不带情绪 | `moodInjection` 关着，或者人格文件里没写情绪表现 |
| 主动开口一次都不发生 | 看 `maxPerDay`、`quietHours`、`globalCooldownMin` 三道闸，以及日志 |
| 手机填了地址还是连不上 | 第 8 节三条，先 curl 确认服务端通 |
| 发图报 `Messages transport failed` | 图片目录混了 `objects` 和 `file-objects`，见 `docs/architecture.md` 9.2 |
| 语音没声 | `breeze-server.exe` 起没起、8137 通不通、音色名对不对 |
| 皮肤没生效 / 只剩光晕 | DSH 升级改了 CSS 类名，见 `plugins/dsh-skin-deepglass/client.js` 顶部注释 |

日志在 `<项目根>\data\webchat\webchat.log`，本地时间，出问题先翻这个。

正常启动的日志长这样（三个角色、情绪、心跳都齐了才算起来）：

```
[dsh-voice] 就绪：Breeze http://127.0.0.1:8137，音色 default，输出 data/webchat/audio
[INFO] 启动 port=4200 角色=role1/role2/role3 历史 0 条
[INFO] 情绪已载入：role1/role2/role3
[INFO] 心跳已启动：每 60 秒看一次谁想说话
[INFO] webchat 就绪：http://127.0.0.1:4200/
```

---

## 12. 交给 AI agent 装

把这一份文档丢给 agent，说「按 DEPLOY.md 装」。它需要知道的三件事：

1. **`DSH_HOME` 每一步都要设**，这是最容易漏的一步，漏了 profile 会建到用户目录里去
2. **第 4 步装完要验证**：`--dump-config | findstr "== dsh-"` 打出六个插件名才算成。
   报 `cannot resolve profile bundle` 就 `install` 后重 `add` 一次，别再往里硬推
3. **第 0 节的参数不要替用户决定**。模型选哪个、开不开语音、几个角色，
   都问用户。不同机器差别很大，照抄作者的配置大概率跑不动

装完让它跑一次 `curl http://127.0.0.1:4200/api/state`：返回 JSON（含 `roles` 和
`moods`）才算成功，再让用户打开浏览器看。返回 000 说明服务没起来，翻上面的日志。

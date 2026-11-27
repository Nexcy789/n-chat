# AGENTS.md

给 AI agent 看的入口。人请读 [README.md](README.md) 和 [DEPLOY.md](DEPLOY.md)。

## 这个仓库是什么

DSH（DeepSeek Harness）上的多人群聊框架。四个插件 + 一个 Android 壳 + 一份前端。
没有数据、没有人格、没有密钥——那些是使用者自己的。

## 你要做事的话

**部署**：照 [DEPLOY.md](DEPLOY.md) 一步步走。三个必守点：

1. 每一步都先设 `DSH_HOME=<项目根>/data`，漏了会把 profile 建到用户目录
2. 插件用 `link:` 绝对路径装，装完**必须验证** `dsh <profile> --dump-config | findstr "== dsh-"`
   打出六个插件名才算成。报 `cannot resolve profile bundle` 就
   `dsh plugin --profile <p> install` 后重 `add` 一次；实在不行手写
   `profiles/<p>/package.json` 的 `dsh.profile.bundles`
3. `<项目根>/data/profiles/<p>/cordis.patch.yml` 是 **YAML 数组**，新建出来内容是 `[]`。
   加配置要把 `[]` 换掉，往后追加会变成两个文档、启动直接解析失败
4. 模型选型、开不开语音、几个角色——**问用户**，不要照抄文档里的默认值。
   不同机器差别很大

装完跑 `curl http://127.0.0.1:4200/api/state` 确认，再让用户开浏览器。

**改人格**：`workspace/<角色>/AGENTS.md`，模板在 `examples/workspace/AGENTS.md.example`。
第二人称，管「怎么说话」和「什么不能做」，不管生平。

**调性格**：读 [docs/tuning.md](docs/tuning.md)。改倍率之前先确认用户要的是
「反应快慢」还是「表现方式」——后者属于人格文件，不该动倍率。

**改前端**：`plugins/dsh-webchat/web/index.html` 是单文件、无构建、原生 JS。
改完必须同步到 `android/app/src/main/assets/index.html`，两个文件要一模一样。

**改后端**：`plugins/dsh-webchat/lib/` 下每个文件职责单一，见
[docs/architecture.md](docs/architecture.md)。里面第 9 节列了已知问题和死代码，
动之前先看。

## 别做的事

- 不要往仓库里写 `data/`、`workspace/`、`*.keystore`、`*.log`——`.gitignore` 挡着，别用 `-f` 绕过
- 不要把密钥写进 YAML。DSH 自己管 `data/.credentials.yaml`，手改会让 profile 起不来
- 不要凭猜测改情绪参数。改完至少观察一天，或者看日志统计
- 不要在用户装 SeedVC 之前打开 `dsh-cover`（保持 `dryRun: true`），
  没豆包客户端就别开 `dsh-doubao-painter`——它们会一直连不上端口刷日志
- `dsh-bili` 的抽帧和 `dsh-doubao-painter` 的出图都落 `doubao-images/`，
  这是和 `dsh-webchat` 的约定（`collectPainted` 按这个名字扫）。改目录名图片就不会出现在聊天里

## 许可

MIT。四个插件分别演化自 DSH 社区的开源项目，来源和作者见 [CREDITS.md](CREDITS.md)。
外部工具（Breeze / Seed-VC / faster-whisper）不在本仓库，各有自己的许可，
其中 Breeze 的模型权重不允许商用。

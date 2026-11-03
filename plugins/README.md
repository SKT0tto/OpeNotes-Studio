# 插件（plugins/）

OpeNotes Studio 的可选功能以插件形式单独发布，**主下载包里不含任何插件**。装了插件，编辑器里才会出现它的按钮和面板；没装，一切照旧。

## 安装一个插件

（本说明在发布包里是 `docs/PLUGINS.md`；发布包里没有 `plugins/` 文件夹，解压插件时会自动创建。）
1. 从 Releases 下载 `openotes-plugin-<名字>-v<版本>.zip`。
2. 解压到本软件文件夹里：压缩包里已经是 `plugins/<名字>/…`，解压后得到 `plugins/<名字>/plugin.json` 即对。
3. 重启（关掉黑色窗口再运行 Start-Windows.cmd / start.sh）。
4. 删除插件：删掉 `plugins/<名字>/` 文件夹再重启。插件自己的设置在 `data/plugins/<名字>/`，更新软件时 `plugins/` 和 `data/` 都不会被动。

坏掉的插件只会在启动日志里报一行并被跳过，不会影响软件；`/api/plugins` 会列出已加载的插件和各自的错误。

官方插件：

- `gpt-sovits`：用你自己的 GPT-SoVITS 给对白自动配日语（见 `plugins/gpt-sovits/README.md`）。

## 给开发者：插件长什么样

```
plugins/<id>/
  plugin.json   { id, name, version, description, minStudioVersion?, server?: "server.mjs", web?: "web.js" }
  server.mjs    默认导出 register(ctx)            （Node 端，可选）
  web.js        默认导出 { activate(host) }       （浏览器端，可选；可带 web.css）
  src/server.ts, src/web.tsx   源码（开发时直接用；npm run build 打成上面两个文件）
```

接口类型都在 `shared/plugins/api.ts`（插件直接 import 类型）：

- **Node 端** `register(ctx)`：`ctx.router`（挂在 `/api/plugins/<id>/`）、`ctx.dataDir`（`data/plugins/<id>/`）、`ctx.voice`（读写项目的配音文件 `data/projects/<项目>/voice/`，网页上以 `/api/projects/<项目>/voice/<文件>` 提供）、`ctx.llm.callJson(...)`（用用户已配置的 AI 做一次结构化 JSON 调用，与导演共用缓存）、`ctx.log`。
- **浏览器端** `activate(host)`：`host.registerTopBarButton`（顶栏按钮 + 对话框）、`host.registerInspectorSection`（检查器里「选中台词」的分区）、`host.useStudio()`（当前项目与选择）、`host.applyBeatVoice(...)`（把 `beat.voice` 写进项目，一步可撤销；插件只能改这个字段）、`host.notify`、`host.fetchPlugin`、`host.ui`（Modal / Section / Row）。React 与编辑器共用一份（打包时 `react` 被映射到 `window.__OPENOTES_HOST__`）。
- 核心只认 `beat.voice = { src, file?, seconds?, spoken?, spokenEdited?, hash?, by? }`：有音频文件的台词，播放器会在该台词开始时播放（支持拖动进度、倍速、音量，说话人的嘴随音量开合）。手工录好的配音文件同样可用。

开发：`npm run dev` 时服务端直接加载 `plugins/<id>/src/server.ts`，网页由 vite 直接加载 `src/web.tsx`（热更新）。`npm run build` 会构建所有插件（产物 `plugins/<id>/server.mjs`、`web.js`，已被 git 忽略）；`npm run package-plugin -- <id>` 生成 `release/openotes-plugin-<id>-v<版本>.zip`，只含 `plugins/<id>/{plugin.json, server.mjs, web.js, README.md}`。发布流程（`release.yml`）会把插件包一并传到同一个 Release。

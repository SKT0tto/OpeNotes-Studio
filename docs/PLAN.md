# Our Notes AI Story Studio — 实施计划

> 读者：执行编码的 Sonnet 子代理与验收负责人。事实依据见 `docs/RESEARCH.md`，**每个阶段开始前先读 RESEARCH.md 相关小节**。
> 原则：AI 只做决策（意图）；坐标、插值、资源校验、渲染全部由确定性代码完成。不做假功能：未实现的按钮不出现；无 AI 时明确标注"规则生成（非 AI）"。

---

## 0. 全局约定（所有阶段必须遵守）

### 0.1 技术栈（已定，不要替换）
| 层 | 选择 | 说明 |
|---|---|---|
| 语言 | TypeScript（strict），ESM | Node v24 直接用 `tsx` 跑服务端 TS |
| 前端 | Vite 6 + React 19 | 编辑器面板用 React；**渲染引擎不依赖 React**（纯 TS 类） |
| 状态 | Zustand + Immer（`enablePatches`） | 用 Immer patches 实现撤销/重做 |
| 渲染 | pixi.js 8.x + `untitled-pixi-live2d-engine@1.4.0`（`/cubism` 入口） | 版本精确锁定；Cubism Core 运行时从官方 CDN 加载 |
| 服务端 | Express 5 | 素材扫描/索引、只读静态挂载、项目存储、LLM 代理与缓存 |
| 校验 | zod 4（前后端共享 schema） | |
| LLM | `@anthropic-ai/sdk`（Claude）+ 原生 `fetch`（OpenAI 兼容） | |
| 测试 | Vitest（单元/集成）+ Playwright（`channel: 'msedge'`，浏览器 E2E） | Windows 自带 Edge，免下载浏览器 |

### 0.2 目录结构（目标形态）
```
D:\OurNotesStudio
├─ package.json  tsconfig.json  vite.config.ts  vitest.config.ts  playwright.config.ts
├─ .gitignore  .env.example  studio.config.example.json  THIRD_PARTY.md  README.md
├─ .claude/launch.json                 # 供浏览器预览工具启动 dev server
├─ docs/  PLAN.md  RESEARCH.md
├─ shared/        # 纯 TS，无 DOM、无 Node API；前后端共用；必须 100% 可单测
│  ├─ schema/     # zod：assets.ts project.ts ai.ts settings.ts
│  ├─ data/       # characters.json bands.json（公开设定事实）
│  ├─ catalog/    # costume.ts motionNames.ts expressionNames.ts（名字解析/家族归类）
│  ├─ staging/    # world.ts framing.ts facing.ts ground.ts formation.ts
│  ├─ timeline/   # time.ts compile.ts evaluate.ts easing.ts
│  └─ director/   # intents.ts expand.ts validate.ts repair.ts mergeLocks.ts ruleDirector.ts ids.ts
├─ server/
│  ├─ index.ts config.ts
│  ├─ assets/     indexer.ts motionStats.ts routes.ts
│  ├─ projects/   store.ts routes.ts
│  ├─ settings/   store.ts routes.ts
│  └─ llm/        provider.ts anthropic.ts openaiCompat.ts cache.ts director.ts prompts/
├─ web/
│  ├─ index.html main.tsx
│  ├─ engine/     cubismCore.ts Live2DActor.ts ParamOverride.ts ModelProbe.ts Stage.ts Camera.ts
│  │              BackgroundLayer.ts Transitions.ts Player.ts AudioEngine.ts DialogBox.ts debugHooks.ts
│  ├─ editor/     panels/… timeline/… storyboard/… stageTools/…
│  ├─ store/      projectStore.ts history.ts selection.ts
│  └─ lab/        ActorLab.tsx StageLab.tsx（开发验证页，保留作为回归入口）
├─ tests/
│  ├─ unit/       （vitest，绝不依赖真实素材）
│  ├─ integration/（vitest，依赖 ASSET_ROOT；缺失时 skip 并打印原因）
│  ├─ e2e/        （playwright，依赖 ASSET_ROOT + 网络加载 Core）
│  └─ fixtures/   （手写的合成小数据：假 model3.json 结构、假目录，不含任何游戏文件）
└─ data/          # gitignored：index 缓存、projects、llm-cache、calibration、settings.local.json、user-audio 索引
```

### 0.3 配置
- `studio.config.json`（gitignored；提供 `studio.config.example.json`）与环境变量，环境变量优先：
  - `ASSET_ROOT`（默认上面 RESEARCH §1 路径）、`AUDIO_ROOTS`（可多个，`;` 分隔，可空）
  - `CUBISM_CORE_URL`（默认官方 CDN）
  - `PORT`（服务端 5274），Vite dev 5273 代理 `/api` 与 `/assets` 到服务端
  - `ANTHROPIC_API_KEY`、`LLM_PROVIDER`、`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`
- **ASSET_ROOT 只读**：服务端对其只做读与流式输出，任何写操作写 `data/`。路由需防路径穿越（`path.resolve` 后校验前缀）。

### 0.4 通用验收要求
- 每阶段结束：`npm run typecheck`、`npm test`（unit）、`npm run test:integration`、相关 `npm run test:e2e -- <spec>` 全部通过。
- **浏览器验证**：用浏览器预览工具（`.claude/launch.json` 中的 `studio` 配置）实际打开页面，截图核对验收项，检查 console 无 error。在交付报告中列出截图对应的检查项与结论。
- 前端在 `window.__studio`（仅 dev 构建）暴露调试钩子：`getActorParams(actorId)`、`getRenderState()`、`getCamera()`、`listLoadedModels()`、`snapshotPixels(x,y,w,h)`、`player.seek(t)` 等，供 Playwright 精确断言（参数值、坐标），避免只靠肉眼。
- 不得向仓库加入任何游戏文件、Cubism Core；`git status` 中不得出现素材。提交节奏由主控决定，编码代理不要自行 push。
- 新增依赖必须精确版本，并更新 THIRD_PARTY.md。

### 0.5 Sonnet 编码代理通用注意事项
1. 不要复制 ournotes-player（AGPL）任何代码；不要搬旧 Codex 项目代码（可参考其文档结论）。
2. 引擎 API 名以安装后的 `node_modules/untitled-pixi-live2d-engine` 类型定义为准，**先读 d.ts 再写**，不要凭记忆。
3. Windows 路径：服务端用 `path` 处理文件、对外 URL 一律 `/`；素材路径很长，避免拼接时多次编码；文件名含 `--`、motion 名可能含末尾空格（`encodeURIComponent` 处理）。
4. 所有"选择资源"的地方（AI、规则、UI）都只能从索引里取 ID，写入前过 `validate`。
5. 浏览器内大量模型会耗显存：同屏 ≤6 个，LRU 缓存 ≤10 个已加载模型，卸载时 `destroy({ children:true, texture:true })`。
6. 不能用 `scale.x = -1` 做朝向；有 E2E 断言会扫描所有角色容器的世界变换。

---

## 1. 核心数据模型（P7 落地，但从 P0 起按此设计）

### 1.1 来源与锁
所有可编辑单元带 `meta`：
```ts
type Source = 'ai' | 'rule' | 'user' | 'default';
interface Meta { source: Source; locked: boolean; genId?: string; reason?: string; updatedAt: number }
```
- `ai`：LLM 决策；`rule`：确定性展开/规则导演产生；`user`：人工改过；`default`：系统默认。
- 用户修改任一字段 → `source='user'`（不自动加锁；UI 提供锁按钮，也可设"修改即锁"偏好）。
- `locked=true` 的单元在任何 AI/规则重新生成中**原样保留**（服务端 mergeLocks 强制）。
- 轨道（Track）也带 `meta`（P7.1 补）：`track.locked` = 整条轨道（含关键帧的有无）原样保留；`key.locked` 只保护该关键帧。

### 1.2 层级
```ts
Project {
  schemaVersion: 1; id; title; createdAt; updatedAt;
  catalogVersion: string;                      // 索引哈希，导入时比对
  settings: { aspect: '16:9'; fps: 30; textSpeedCps: number; defaultLineGap: number };
  source: { text: string; format: 'novel' | 'script' };
  cast: CastMember[];                          // { id:'c_001', characterKey:'001', displayName, meta }
  scenes: Scene[];
  generation: { runs: GenerationRun[] }        // 记录每次 AI 调用（提供方、模型、耗时、缓存命中、警告）
}
Scene {
  id; title; sourceSpan: { start: number; end: number }; meta;
  background: { assetId: string; framing: { zoom: number; offsetX: number; offsetY: number }; meta };
  wardrobe: Record<CastId, { modelId: string; meta }>;     // 场景起始服装；场景内换装走 costume 轨道
  blocking: Record<CastId, { slot: number /* -1..1 横向 */; depth: number /* 0 前..1 后 */; meta }>;
  transitionIn: { kind: 'cut'|'fade_black'|'fade_white'|'crossfade'|'wipe'; duration: number; meta };
  audio: { bgm?: { assetId; volume; meta }; ambience?: { assetId; volume; meta } };
  beats: Beat[];
  tracks: Track[];
}
Beat {
  id;                                         // 稳定 ID：hash(sceneId, sourceOffset, speaker, ordinal)
  kind: 'dialogue'|'narration'|'action'|'pause';
  speakerId?: CastId; text: string; sourceOffset?: number;
  duration: { mode: 'auto'|'fixed'; seconds: number };   // auto = 按文本长度 + 停顿计算
  emotion?: string;                                      // AI 情绪标签（仅供展开与显示）
  shot: { type: ShotType; focus: CastId[]; move: CameraMove; dof: 0|1|2|3|4|5|6; meta };
  meta;
}
type ShotType = 'closeup'|'bust'|'medium'|'two_shot'|'group'|'wide'|'insert';
type CameraMove = 'static'|'push_in'|'pull_out'|'pan'|'track'|'shake';

Track { id; target: { kind:'actor'; castId } | { kind:'camera' } | { kind:'background' } | { kind:'audio' } | { kind:'screen' };
        channel: Channel; keys: Keyframe[] }
type Channel =
  | 'motion' | 'expression' | 'head' | 'body' | 'gaze' | 'position' | 'opacity' | 'costume'   // actor
  | 'camera' | 'background' | 'se' | 'bgm' | 'fade' | 'flash';                               // 其它
Keyframe { id; at: { beatId: string; offset: number };       // 相对节拍起点（改台词时长时关键帧自动跟随）
           value: ChannelValue; duration: number; ease: EaseName; meta }
```
通道取值（全部是"意图层"单位，由确定性代码映射到参数）：
- `head` / `body`：`{ mode:'target', target: CastId|'camera'|'away' } | { mode:'angle', yaw: -1..1, pitch?: -1..1 }`
- `gaze`：`{ target: CastId|'camera'|'down'|'away' } | { x:-1..1, y:-1..1 }`
- `motion`：`{ name: string }`（真实 motion 名，可写 family 如 `nod01`，展开时解析为带 `_L/_C/_R` 的真实名）
- `expression`：`{ name: string }`；`position`：`{ slot, depth }`；`opacity`：`0..1`；`costume`：`{ modelId }`
- `camera`：`{ shot: ShotType, focus: CastId[] } | { manual: { x, y, zoom } }`

### 1.3 运行时管线（确定性）
```
Project ──compile(scene)──► SceneTimeline（绝对时间、已解析 motion 变体、已求解的镜头坐标）
SceneTimeline ──evaluate(t)──► RenderState（每个角色：世界位置/比例/透明度/头身眼目标值；相机；背景；字幕）
RenderState ──Stage.apply()──► Pixi + Live2D（只在此处碰引擎）
```
`compile` 与 `evaluate` 位于 `shared/`，纯函数，可单测、可 seek。动作（motion）是事件：evaluate 输出"t 时刻应在播放的 motion 及已播放时长"，Stage 负责触发（seek 时从最近事件重启，见 P7 注意事项）。

### 1.4 AI 输出 schema（P12/P13 落地）
AI 只输出**意图**：
- Pass 1 `Breakdown`（全文一次或按章节分块）：
  `{ cast: [{ nameInText, characterKey | null, evidence }], scenes: [{ title, startParagraph, endParagraph, location: { backgroundId, reason }, timeOfDay, presentCast: CastId[], wardrobe: [{ castId, modelId, reason }], mood, isPerformance, band?: string }] }`
- Pass 2 `SceneDirection`（每场景一次调用）：
  `{ blocking: [{ castId, slot: 'far_left'|'left'|'center_left'|'center'|'center_right'|'right'|'far_right', depth: 'front'|'mid'|'back' }], beats: [{ paragraph, kind, speaker?, text, emotion, shot: { type, focus, move, dof }, actors: [{ castId, motion?: family, expression?: name, attention: CastId|'camera'|'away'|'down', enter?: bool, exit?: bool, move?: slot }], pauseAfter? }], transitionIn, bgm?: assetId|null, costumeChanges?: [{ beatIndex, castId, modelId, reason }] }`
- 校验与修复流程：`zod 解析 → 语义校验（ID 存在、说话人在场、motion/表情在该服装模型中存在、live-mode 无表情） → 确定性修复（同 family 换变体/编号、降级到 idle01、去掉不存在表情，并记录 warning） → 仍有结构性错误则带错误列表做 1 次 LLM 修复调用 → 仍失败则该场景标红保留旧内容，绝不写入非法 ID` → `expand()` 意图展开为 tracks（source='ai' 的决策 + source='rule' 的派生关键帧） → `mergeLocks()`。

---

## 2. 阶段计划

阶段顺序：资源导入（P0–P2）→ Live2D 演出（P3–P7）→ 可视化编辑与实时预览（P8–P10）→ AI Director（P11–P14）→ 完整小说自动演出（P15）。
每阶段约为一个编码代理一次可完成并验证的量。依赖严格按序。

---

### P0 工程脚手架
**交付**：`package.json`（scripts：`dev`（concurrently 跑 server+vite）、`build`、`start`、`typecheck`、`test`、`test:integration`、`test:e2e`、`lint`）、tsconfig（paths：`@shared/*`）、vite/vitest/playwright 配置、`.gitignore`（按 RESEARCH §6 全量）、`.env.example`、`studio.config.example.json`、`server/index.ts`（`GET /api/health` 返回版本、ASSET_ROOT 是否可读）、`server/config.ts`、`web/main.tsx`（空壳页面显示 health 结果）、`.claude/launch.json`（name `studio`，`npm run dev`，port 5273）、`THIRD_PARTY.md`、`README.md`（如何配置 ASSET_ROOT 与 Core）、`git init`。
**验收**
- 浏览器：打开 5273，页面显示 "ASSET_ROOT: OK（241 models / 341 backgrounds 目录可读）"；把 ASSET_ROOT 改成不存在路径时显示明确错误。
- 自动化：unit `config.test.ts`（环境变量优先级、路径穿越拒绝工具函数）；e2e `smoke.spec.ts`（页面加载、无 console error）。
- `git status` 干净且无素材；`git check-ignore data/x vendor/live2dcubismcore.min.js` 均命中。
**注意**：Playwright 用 `channel:'msedge'`；webServer 配置复用 `npm run dev`。不要装 React Router 之外的 UI 大框架（可用轻量 CSS）。

**实施备注（已完成）**
- 依赖：Vite 精确锁定 6.4.2（npm 默认会装到 8.x，已降回计划版本）；TypeScript 6.0.3 不再接受 `baseUrl`，`@shared/*` 用相对 `paths` 声明。
- Vite 开发服务器绑定 `127.0.0.1`（Windows 上 `localhost` 可能解析到 ::1，导致 Playwright 的 webServer 探测超时）；代理键必须写成正则 `^/api/`，否则 `/api.ts` 源文件请求会被转发到后端而 404。
- `.env.example` 仅作变量文档，服务端不自动加载 .env（无 dotenv）；请用环境变量或 `studio.config.json`。
- `.gitignore` 的 `data/`、`vendor/`、`assets/` 已加根锚点（否则会误伤 `shared/data/`、`server/assets/`），并对 `tests/fixtures/**` 取反（手写假素材含 model3.json 等被兜底规则命中的文件名）。
- 内置浏览器预览工具读取的是会话工作目录下的 `.claude/launch.json`；本项目的 `.claude/launch.json` 供在项目根目录打开会话时使用。

### P1 素材索引器（服务端）
**交付**：`shared/schema/assets.ts`（`ModelEntry, MotionEntry, ExpressionEntry, BackgroundEntry, AudioEntry, CharacterEntry, Catalog`）、`shared/data/characters.json` + `bands.json`（RESEARCH §1.5 表；bands 含成员与默认舞台编队，见下）、`shared/catalog/costume.ts`（解析 costume 字符串 → `{ base:'casual'|'school'|'roomwear'|'live'|'suits'|'virtual'|..., season?, school?:'hs'|'jhs', grade?, glasses, quality, mode, still }`）、`shared/catalog/motionNames.ts`（`mtn_nod01_L` → `{ family:'nod01', side:'L' }`，不规则名 side=null 并保留原名）、`server/assets/indexer.ts`（扫描 models/backgrounds/media/AUDIO_ROOTS；**以 model3.json 为准**；合并 manifest.json 中的名字/乐队/颜色/背景描述（存在时）；计算 catalogVersion 哈希；结果缓存到 `data/index/catalog.json`，按目录 mtime 增量失效）、`server/assets/motionStats.ts`（解析每个 motion3.json：时长、首帧/均值 `ParamAngleX`、`ParamBodyAngleX`、`ParamEyeBallX` → 用于 P4 朝向解算）、路由：`GET /api/catalog`（精简版）、`GET /api/catalog/models/:id`、`GET /assets/*`（只读静态，`Cache-Control`、支持 Range）。
bands.json 编队（舞台 x：-1 左 … +1 右，depth 0 前 … 1 后）：主唱/吉他主唱 x=0 depth 0；吉他手 x=±0.55 depth 0.1；贝斯 x=±0.55（与吉他对侧）depth 0.1；鼓 x=0 depth 0.8；键盘 x=±0.8 depth 0.6；DJ 同键盘。具体左右按乐队写死在数据里，标注 "editable default"。
**验收**
- 浏览器：`/api/catalog` 返回 241 模型、341 背景、≥1 音频；`/assets/models/001_casual_spring_01/model3.json` 可直接打开；`/assets/../package.json` 返回 400/404。
- 自动化：unit 用 `tests/fixtures/fake-assets/`（手写 3 个假模型目录，含带空格的 motion 名、缺 physics、缺 expressions、`_low`、`_still`、live-mode 情况）测 indexer；unit 测 costume/motion 名解析全部不规则样例；integration 对真实 ASSET_ROOT 断言计数（241/341）、每个模型 `motions.length>0`、`001_casual_spring_01` 含 `mtn_idle01_L` 且 `angleX(L)>15`、`angleX(R)<-15`。
- 首次全量索引耗时打印；二次启动命中缓存 <1s。
**注意**：241×~60 个 motion 文件 ≈ 1.5 万次读取，用并发上限（如 32）的 promise 池；不要把 motion 曲线全部塞进 catalog，只存统计值。

**实施备注（已完成）**
- model3.json 中带空格的 motion 的**键**是字面量 `mtn_haruhikage01_C%20`（含 `%20` 三个字符），而 `File` 是真实空格 `motions/mtn_haruhikage01_C .motion3.json`。索引保留原始键作 `MotionEntry.name`（Live2D 引擎按该键播放），`family/side` 由解码+trim 后的名字解析；请求文件 URL 时对 `file` 做 `encodeURIComponent`。
- 实测真实素材：241 模型/341 背景/1 音频；low 26、live-mode 52、无物理 58、NPC 模型 39，所有模型引用文件齐全（`missingFiles` 恒为空，集成测试断言）。全量首次索引约 1 s（15k motion 文件，并发 32），缓存命中约 0.1 s，远优于验收要求。
- `mode` 以目录名 `live-mode_` 前缀推导（与 manifest 的 52/189 一致）；`arbeit/caretaker/detective/idol/birthday2627/child/soundonly` 等非常规服装归入 `base:'other'`，名称片段留在 `tags`。
- `/api/catalog` 精简版只含计数（`motionCount/expressionCount`），motion/表情清单与朝向统计（首帧与时间加权均值的 `angleX/bodyAngleX/eyeBallX`）走 `/api/catalog/models/:id`。缓存文件 `data/index/catalog.json` 带 schema 版本，名称解析逻辑变化时需递增 `CACHE_SCHEMA`；仅由目录名推导的字段每次启动重新计算。
- 音频 ID：素材库内为 `media/<相对路径>`（URL `/assets/media/...`），用户目录为 `user<序号>/<相对路径>`（URL `/audio/<序号>/...`，只读、同样防穿越）。
- bands.json 编队：三个吉他/贝斯成员的“吉他 ±0.55”规则无法容纳每队 2 吉他 + 1 贝斯，故第二吉他放在 x=-0.28、depth=0.22（均标注 editable default）。
- 资源浏览器：背景列表分页每次 60 张（“显示更多”），音频用原生 `<audio controls>`；未引入路由库，P3 需要 `/lab/*` 时再加。

### P2 资源浏览器（最小前端）
**交付**：`web/editor/panels/AssetBrowser.tsx`：标签页 角色/服装、背景、音频；角色按乐队分组 → 服装卡片（preview.png，显示 costume 解析标签、mode、motion/表情数量，默认隐藏 `_low`）；背景按 kind/setting/time 筛选 + 多词搜索（名称/别名/描述）；音频列表可试听。选中模型显示 motion/表情列表。
**验收**
- 浏览器：能看到 25 名角色 + NPC；搜索 "RiNG 夜间" 命中 RiNG 外观夜间背景；点击音频可播放；切换"显示低画质"后 `_low` 出现。截图存档。
- 自动化：e2e `asset-browser.spec.ts`（搜索、筛选、计数断言）。
**注意**：缩略图懒加载（`loading="lazy"`）；背景原图 2048 宽，列表里用 CSS 缩放即可，不在服务端生成缩略图文件到 ASSET_ROOT（如需缩略图缓存写 `data/thumbs/`）。

**实施备注（已完成）**
- 同上，P0–P2 的验证截图存于 `.verify/`（gitignored）：`p2-characters.png`、`p2-low-quality.png`、`p2-bg-ring-night.png`、`p2-audio.png`、`p0-asset-root-error.png`。


### P3 Live2D 单模型运行时 + 参数覆盖层
**交付**：`web/engine/cubismCore.ts`（注入 `<script src=CUBISM_CORE_URL>`，等待全局，检查 `csmGetLatestMocVersion()>=5`，失败抛带指引的错误并在 UI 显示）、`web/engine/Live2DActor.ts`（加载/卸载模型，播放 motion（按名字作为 group，index 0）、设置表情、fade 参数、读取参数表 `{id,min,max,default}`、暴露 `container`）、`web/engine/ParamOverride.ts`（RESEARCH §3.3 的注入点：在 saveParameters 后、physics 前加头/身/眼加性偏移；关闭内置 focus；值按参数真实 min/max 夹紧；只写存在的参数 ID）、`web/lab/ActorLab.tsx`（路由 `/lab/actor`：选模型 → 播 motion/表情 → 三个滑块 headYaw/bodyYaw/gazeX/gazeY（意图 -1..1）→ 实时显示 core 中实际 `ParamAngleX/BodyAngleX/EyeBallX` 值）。
**验收**
- 浏览器：`/lab/actor` 加载 `001_casual_spring_01`，idle 循环、自动眨眼、呼吸、头发物理正常；拖动 headYaw 头转而身体不动；gaze 只动眼球；拖动时头发随头摆动（证明注入点在物理前）；切换 motion 有淡入淡出无跳变；连续拖滑块 30 秒后回到 0，参数值回到 motion 原值（无累积漂移）。对 `001_live-mode_live_01`、`sub_bota_casual_spring_01_still`（无物理）、`002_casual_spring_01_glasses` 各截一张图。
- 自动化：e2e `actor-lab.spec.ts`：通过 `__studio.getActorParams` 断言 headYaw=+1 时 `ParamAngleX` 与 headYaw=0 时差值 ≈ 映射量（容差 2°）；设回 0 后 2 秒内差值 <0.5°（无累积）；断言 actor 容器 `worldTransform.a > 0`（无翻转）。unit：ParamOverride 的映射/夹紧纯函数。
**注意**：Core 未加载完成前不得 import 引擎的 cubism 入口执行初始化（顺序：load core → `configureCubismSDK({memorySizeMB: 32})` → `extensions.add(Live2DPlugin)` → `Live2DModel.from`）。如模型加载报内存不足，调大 memorySizeMB。模型 URL 用 `/assets/models/<id>/model3.json`。

### P4 朝向校准 + motion 朝向解算
**交付**：`web/engine/ModelProbe.ts`（加载后：(a) 记录默认姿态 drawable 包围盒 → 模型底部（接地点）与总高；(b) 扫 `ParamAngleX` ±30 找位移最大的 drawable 集合 → 头部包围盒、头部中心、头部高度（"头单位"）；(c) 扫 `ParamAngleX`、`ParamBodyAngleX`、`ParamEyeBallX` 正值时头/身/眼质心屏幕 x 位移的符号 → `headSign/bodySign/eyeSign`；探测完恢复所有参数）、结果 POST 到 `data/calibration/<modelId>.json`（服务端 `GET/PUT /api/calibration/:modelId`，含 `verified:false|true`、可人工覆盖）、`shared/staging/facing.ts`：
- `desiredYaw(self, target)`：基于**世界坐标头部位置**（相机无关）；面对目标 yaw = sign(dx)·base(|dx|)（base 在 0.6–1.0，近距离更大），看镜头 yaw≈0（略偏向对方 0.1–0.2）。
- `chooseMotionVariant(family, desiredYawScreen)`：结合 motionStats 中各变体的 angleX 名义值与 headSign，选最接近的 `_L/_C/_R`。
- `residualOffset = desired − variantNominal`（转为参数单位并夹紧），交给 ParamOverride 加性施加，随 motion 淡入时间同步过渡。
- ActorLab 增加"校准"面板：显示探测结果、一键"左右各演示"（播放 _L 与 _R 并截图对比）、人工确认按钮写 `verified:true`。
**验收**
- 浏览器：对 MyGO 5 人的 casual 模型 + 1 个 NPC + 1 个 live-mode 模型执行探测，截图确认：`_L` 变体人物面朝画面哪一侧（记录到 calibration），与 headSign 推导一致；头部包围盒叠加显示框正确框住头部。
- 自动化：unit `facing.test.ts`（A 在左 B 在右 → A 选面朝右的变体、B 选面朝左的变体；相机平移不影响结果；目标在正前方 → C 变体）；integration：对 5 个模型跑 `motionStats` 断言 L/R 名义角符号相反。e2e：`probe.spec.ts` 对 001 跑探测，断言头部高度在模型总高 10%–20% 区间、底部 y 合理。
**注意**：探测要在 motion 暂停的状态下做（或用独立离屏实例），否则 idle 动作干扰质心；只对存在的参数做；无 `ParamEyeBallX` 的模型 eyeSign=0 并在 UI 标注"无眼球轴"。

**实施备注（P3/P4 已完成）**
- 引擎 API 以 d.ts/源码为准：`Live2DModel.from(url,{autoFocus:false,autoHitTest:false,breathDepth,ticker})`；注入点实现为替换 `internalModel.updateFocus`（位于 saveParameters/表情之后、breath 与 physics 之前），整帧末尾引擎的 `loadParameters` 使偏移不累积（单测 + e2e 回零 <0.5° 验证）。
- **SDK 默认 breath 会给 ParamAngleX 加 ±7.5° 的正弦摆头**，与朝向覆盖冲突；改 `breathDepth=0.05`（只保留胸部 ParamBreath 与极小头部摆动）。
- 因 `loadParameters` 在帧末恢复，帧后读 core 只得到“基值”；调试钩子在 `beforeModelUpdate` 抓取“实际值”（含覆盖+物理），`getActorParams` 同时返回 applied/base，断言用二者之差。
- 参数只通过 `getParameterIndex` 对应的真实 id 表（`_model.parameters.ids`）按下标读写，避免框架对不存在 id 创建伪参数。
- 探测（ModelProbe）：同步在一个 JS 任务内设参数→`coreModel.update()`→读顶点→恢复，渲染循环不可见。方向符号 = 位移加权的头/身/眼质心 x 位移符号（+1：正值朝画面右）。头框初版取“移动 drawable 并集”，长发/双马尾会使头高达 33–40%；改为用眼球 drawable 质心估计下巴（眼线≈头顶到下巴 56%），头高落在 16–18%。几何单位为模型局部像素（画布像素，约 7000px 高），容器缩放恒为正。
- 实测（浏览器截图）：001–005 casual、sub_bota still、001 live-mode、002 glasses 全部 headSign/bodySign/eyeSign=+1（still NPC 无头/眼参数 → 全 0 并标注“无眼球轴”）；`_L` 面朝画面右、`_R` 面朝画面左，与符号推导一致。live-mode 模型的 idle 无 L/R 变体，演示按钮只对有 L/R 的模型有效。
- `GET /api/calibration/:id` 未校准时返回 200 `null`（404 会在浏览器控制台产生 error，影响 e2e 的无 error 断言）。
- 实验室无路由库：`App` 按 `location.pathname` 判断 `/lab/actor`，`?model=<id>` 选模型。截图见 `.verify/p3-*`、`.verify/p4-*`。

### P5 舞台合成：背景层、相机、人物放置与接地
**交付**：`shared/staging/world.ts`（世界坐标：以背景图像素为单位，原点背景左上；`groundY(depth)`：背景的地平线参数 `{ horizonY, floorY }` 默认值按 setting 推断，可按背景覆盖，存 `data/backgrounds/<id>.json`）、`shared/staging/ground.ts`（actor 世界位置 = slot→x、depth→y(脚底)与比例 `scale(depth)=lerp(1, 0.6, depth)`；人物比例 = 目标头高(world)·scale(depth) / 模型头高；按角色身高系数微调（characters.json 可选 heightFactor，默认 1））、`web/engine/Camera.ts`（2D 正交相机：center(x,y)、zoom；`worldToScreen/screenToWorld`）、`web/engine/BackgroundLayer.ts`（背景 sprite 独立层；**相机变换以视差系数 0.85 作用于背景**；夹紧使视口始终被背景完全覆盖）、`web/engine/Stage.ts`（层级：background → actors（按 depth 排序 zIndex）→ fx → overlay；`apply(RenderState)`）、`web/lab/StageLab.tsx`（`/lab/stage`：选背景、加 2–4 个角色、拖 slot/depth 滑块、相机 zoom/pan 滑块）。
**验收**
- 浏览器：RiNG 咖啡厅背景 + 灯（左）+ 爱音（右）面对面交谈：两人头部同高级别、脚底落在地面上、头部朝向相反且相互注视（使用 P4 解算，不翻转）；把爱音 depth 调到 0.8 → 变小且脚底上移到更远地面，不浮空、不陷地；相机 zoom 3× 推到灯的脸，画面任何边缘都不露背景外空白，背景放大倍数小于人物（视差）。
- 自动化：unit `ground.test.ts`、`world.test.ts`（坐标往返、夹紧）；e2e `stage.spec.ts`：断言两人 `ParamAngleX` 实际值符号相反；在 zoom 1/2/3 时 `snapshotPixels` 取视口四角像素均非清屏色；所有 actor `worldTransform.a>0`。
**注意**：Live2D 模型锚点用模型局部坐标的"脚底中心"（来自 P4 的底部探测），不要用画布中心；修改 depth 只改 zIndex 与比例，不重建模型。

### P6 构图求解器、景深、透明度与转场
**交付**：`shared/staging/framing.ts`：`solveShot({ type, focus[], actors(世界头部框/身体框), viewport 16:9, safe })` → `{ x, y, zoom }`。预设：closeup（头高占视口 0.42，眼线在上 1/3）、bust（0.26，含肩）、medium（0.17，到腰）、two_shot（两人头框并集 + 边距 0.08）、group（全部 focus 的上半身并集）、wide（头高 0.10，全身尽量入画）；加夹紧（背景覆盖约束）与"人物优先完整"规则；`CameraMove` 生成起止两组参数（push_in：zoom×1.08 等）。`web/engine/Transitions.ts`：场景转场（snapshot 旧画面到 RenderTexture → 新场景渲染其下 → 旧画面 sprite alpha 1→0；fade_black/fade_white 用全屏 Graphics 叠层；cut）；角色淡入淡出用 `AlphaFilter`；景深 `dof 0..6` → 背景 BlurFilter 强度（参考原作等级表 RESEARCH §2），非焦点且 depth 差大的角色轻微模糊。
**验收**
- 浏览器（StageLab 增加镜头下拉与转场按钮）：对 3 人场景依次切 wide→two_shot→closeup→bust，截图核对构图符合预设；closeup 时背景明显虚化而焦点角色清晰；角色淡出过程中**看不到身体内部重叠图层/头发后层**（与直接设 alpha 的对照截图比较）；crossfade 转场中没有黑帧、没有旧角色残影停留；镜头运动平滑（录 1 秒多帧截图）。
- 自动化：unit `framing.test.ts`（每种镜头的头高比例落在目标±10%；focus 头框完全在安全区内；视口不越出背景）；e2e：淡出中途 `snapshotPixels` 无纯透明孔洞（与 AlphaFilter 期望一致）、转场期间每帧非全黑（fade_black 除外）。
**注意**：Filter 会让该容器离屏渲染，注意 `filterArea`/padding，否则物理摆动的头发会被裁掉——给角色容器设足够的 `filterArea` 或 padding；转场 snapshot 用 `renderer.generateTexture(stage)`，用完 destroy。

### P7 时间轴模型、求值器与播放器（第一部可播放演出）
**交付**：`shared/schema/project.ts`（§1 全量 zod）、`shared/timeline/time.ts`（beat 绝对开始时间：auto 时长 = 文本字数/textSpeedCps + 最小时长 1.2s + 行间隔）、`compile.ts`（解析 motion family→真实变体（调用 facing）、相机意图→solveShot 坐标、keyframe 绝对时间）、`evaluate.ts`（连续通道插值：easing 表 linear/inQuad/outQuad/inOutQuad/inOutSine；离散通道取最近之前的值；输出 RenderState）、`web/engine/Player.ts`（play/pause/seek/rate，30fps 逻辑时钟，驱动 Stage；motion 事件触发；预加载下一场景模型）、`web/engine/DialogBox.ts`（原作风格对话框：名字牌用角色颜色、逐字显示、点击/空格推进、自动模式）、伪口型（说话者在文字显示期间驱动 `ParamMouthOpenY`）、`web/engine/AudioEngine.ts`（WebAudio：BGM 交叉淡入、SE 单发、音量）、`tests/fixtures/demo-project.json`（**原创**3 场景短剧：MyGO 两人咖啡厅对话 → 换场到练习室 3 人 → 一人换装；手写意图，覆盖所有通道）、播放页 `/play/:projectId` 与 `/play/demo`。
**验收**
- 浏览器：`/play/demo` 完整播放：对话框逐字、说话人嘴动、听者在说话者开口后 0.2–0.4 s 转头看向说话者、头和眼朝向分离（一个角色头朝对方而眼睛向下）、镜头按 beat 切换/推进、场景 crossfade 转场、场景内换装无闪烁、BGM 播放并在换场时交叉淡入；拖进度条 seek 到任意 beat，画面状态与顺序播放到该点一致（位置/朝向/相机/服装/表情）。
- 自动化：unit `evaluate.test.ts`（插值、离散通道、seek 幂等：evaluate(t) 与顺序步进到 t 结果一致）、`compile.test.ts`（改 beat 时长后 keyframe 跟随）、schema 往返；e2e `play-demo.spec.ts`（播放 5 s 后 seek 到第 3 场景，断言 `getRenderState()` 中服装 modelId、相机 zoom、角色参数符号）。
**注意**：seek 时 motion：找到 t 时刻应在播放的 motion，从头重新触发并尝试设置已播放时长（若引擎内部 queue entry 支持改 startTime 则用，否则重启并在报告中说明）；物理在 seek 后连续 update 若干帧（例如 0.5 s 的 dt）以稳定，不要出现头发甩动。动作播完后回到 `mtn_idle01_<variant>` 循环（选与当前朝向一致的变体）。

**实施备注（P5/P6/P7 已完成）**
- 世界坐标=背景像素；zoom 1 时视口高=`min(bgH, bgW·9/16)`。背景层缩放 `zoom^0.85`（视差）、中心夹紧使视口恒被覆盖；人物层用完整 zoom，不夹紧。透视：脚底 y = `horizonY + (floorY−horizonY)·scale(depth)`，故远景脚底随比例等比上移（单测断言）。头高目标=zoom1 视口高的 0.10（depth 0），按模型 `head.height` 归一，夹在“全身基准比例”的 0.75–1.3 内。背景地面线可覆盖：`GET/PUT/DELETE /api/backgrounds/:id/ground` → `data/backgrounds/<id>.json`，StageLab 有滑块。
- 构图预设：closeup/bust/medium 头高占 0.42/0.26/0.17，头中心在视口 0.33/0.30/0.27 处（closeup 眼线≈上 1/3）；two_shot/group 用“头+胸”框并集 + 边距；wide 头高 0.10、zoom∈[1,1.35] 且全员全身入画；头框始终夹在安全区内，其后再做背景覆盖夹紧。镜头运动：push_in/pull_out ×1.08，pan/track 水平 ±4%/2.4%，shake 为确定性正弦；zoom 在对数空间插值。
- 转场：旧画面 `generateTexture` 成快照 sprite，新场景在其下实时渲染；crossfade=旧 alpha 1→0，wipe=旧画面遮罩从左向右收缩，fade_black/white=旧→色→新（无快照时仅从色淡入）。转场是场景的“前导段”（`leadIn`）：新场景的 beats 在转场结束后开始。**已知限制**：seek 进入转场窗口时没有旧画面快照，crossfade/wipe 直接显示新场景，fade_* 仅从色淡入（排期到 P10，见 ACCEPTANCE D1）。
- 角色淡入淡出/模糊用包裹容器上的 `AlphaFilter`/`BlurFilter`（只有 alpha<1 或 blur>0 时才挂），并设 `filterArea`（躯干框外扩 35%）避免甩动的头发被裁；e2e 断言 50% 透明度≈实体与背景的均值。**Pixi v8 坑**：不要对背景 BlurFilter 设 `clipToViewport=false`（会生成巨大离屏纹理）；默认的“裁到视口 + padding”已能避免边缘变暗（角点像素实测）。
- 管线：`compile`（shared/timeline/compile.ts）把意图解析成绝对时间、真实 motion 变体（L/C/R 选择）、世界坐标朝向（head→期望 yaw，gaze→绝对方向，由 evaluate 减去头部已转角度，所以“头朝对方、眼睛向下”互相独立）和已求解相机位姿；`evaluate(compiled,t)` 是纯函数（单测：乱序求值 == 顺序求值）。头/身覆盖量=期望 yaw − 当前变体自带 yaw（在 0.45s 内从上一变体过渡）；大幅转向时自动换 idle 变体使残差保持小。通道范围：已实现 motion/expression/head/body/gaze/position/opacity/costume/camera/bgm/se/fade；schema 暂不含 `background`/`flash`（无对应功能，不做假字段）。
- 播放器：`ModelLibrary`（LRU≤10，缺校准时探测并保存）、`Stage`（唯一碰 Pixi 的地方；进场景前预载 motion 文件并 `whenSettled()`，场景/换装无空帧；换装是已加载模型的原子替换）、`Player`（30fps 逻辑时钟→连续时间；seek=进场景→apply→settle 0.5s 物理）。~~seek 时 motion 从头重启~~ → 验收发现引擎公开 `ACubismMotion.setOffsetTime`，在 P7.1 修正（M2）。手动推进：关闭“自动推进”后每句末尾停住，点击/空格先补全文字再换句。伪口型：说话者在文字显示期间 `ParamMouthOpenY` 随字数节奏开合（与 evaluate 同源，可 seek）。
- 示例剧情 `tests/fixtures/demo-project.json`（原创，3 场景 28 s，使用真实素材 ID：RiNG 咖啡厅 `adv_bkg_stage_000153` → 车库练习室 `…000001` → 傍晚 `…000002`；灯/爱音/乐奈；灯在场景 3 内 `001_casual_spring_01→001_school_winter_hs_1st` 换装）；集成测试对真实目录校验所有 ID/motion/expression。素材库只有 1 个音频，故 BGM 在场景 2 只调音量、场景 3 淡出，无法演示“两首曲子的交叉淡入”（AudioEngine 已实现交叉淡入）。
- `/play/:projectId` 目前只支持 `demo`（项目存储是 P8），其它 id 明确报“不存在”。调试钩子新增 `__studio.player`（seek/play/pause/time/duration/busy/state/sceneStarts/beatStarts）与 `getCamera()`。验证截图在 `.verify/p5-*`、`p6-*`、`p7-*`（含转场 25/50/75% 蒙太奇与相机滑移序列）。

### P7.1 第一次验收修正（P8 功能开发前必须完成）
详见 `docs/ACCEPTANCE.md`「第一次验收 P0–P7」§3，逐条实现并在实施备注记录：
- **M1** 单人镜头视线方向留白（`FramingActor.yaw`，LEAD≈0.12）+ 非焦点人物画面边缘侵入规则（可见比例 0.05–0.7 时平移排除/纳入，否则 warning）——`shared/staging/framing.ts`、`compile.ts`。
- **M2** seek 时 motion 从正确的已播放时长开始：`loadMotion` → `setOffsetTime(elapsed)` → 启动后复位 0；Stage 在 seek/进场景时强制 resync —— `Live2DActor.ts`、`Stage.ts`、`Player.ts`；新增 e2e（顺序 vs seek 的 base 参数差 <3°）。
- **M3** `Track.meta`（schema + 往返单测）。
- **M4** `gaze target 'camera'` 改为绝对方向（`w:1, dir:0`）+ 单测。
- **M5** demo 结尾黑场挪到台词显示完之后。
- 顺手：D2（快照 resolution）、D3（StageLab 面板溢出）。
**验收**：全套 typecheck/lint/unit/integration/e2e 通过；重新截 `/play/demo` 中 s1b3、s1b4、s3b2、s3b3 的 seek 帧与结尾帧，确认焦点人物在视线反侧、画面边缘没有被切成半个的人物、结尾台词完整后才黑场。

**实施备注（P7.1 已完成）**
- M1：`FramingActor.yaw` 必填，compile 取 `yawAt(t+0.5s)`（头转向略滞后于切镜）。单人镜头横向偏置 `yaw·0.12·W/zoom`；`solveShotDetailed` 返回 `{pose, edgeCut}`，`solveShot` 仍返回 pose。非焦点人物按“头+胸”框可见比例判断，0.05–0.7 视为被切；先在 ≤0.15·W 的横移里找最小的“排除”，再找“完整纳入”，焦点头框须留在安全区；都不行则保留原 pose 并写 `edge-cut` warning。实测 demo 的 s1b4/s3b3 变为“完整纳入”（两人相距近，15% 横移排除不掉），不再有半身人物。wide 不适用。
- M2：`playMotion(name,{offset})` 先 `loadMotion` 再 `setOffsetTime`（总是显式写入含 0，所以无需复位）；`Stage.resync(lead)` 由 Player.show 调用，偏移 = elapsed − 0.5 s（settle 会让模型时间再前进 0.5 s）。实测顺序播放与 seek 的 base 参数差 <0.6°；elapsed<0.5 s 的动作会比理想值多走一点。
- M3：规则见 §1.1。M4：`w:1, dir:0`。M5：新增固定 1.5 s 的 pause beat `s3b5`，fade 在其 +0.2 s。D2：快照用渲染器分辨率；D3：StageLab 改为可换行布局。

---

### P8 编辑器外壳、项目存储、撤销/重做、导入导出
**交付**：`server/projects/store.ts`（`data/projects/<id>/project.json`，保存前自动备份上一版本到 `history/`，最多 20 份；`GET/PUT/POST/DELETE /api/projects`）、导出 `.ournotes.json`（项目 JSON + catalogVersion + 引用的资源 ID 清单，不含素材）、导入时校验 schema 与资源 ID（缺失资源列出并允许替换）、`web/store/projectStore.ts`（Zustand+Immer，所有修改经 `applyEdit(recipe, label)` 产生 patches）、`history.ts`（undo/redo 栈，Ctrl+Z/Ctrl+Shift+Z，合并连续拖拽为一步）、编辑器布局：顶部栏（项目、保存状态、播放）、左侧资源浏览器（P2 复用）、中间实时预览（Stage）、右侧属性面板、底部时间轴区（P10 前先占位，不放假控件）。
**验收**
- 浏览器：新建项目 → 从 demo 导入 → 修改标题 → 保存 → 刷新页面数据仍在；撤销/重做标题修改；导出文件再导入得到相同项目（diff 为空）；导入一个引用不存在背景 ID 的文件 → 显示缺失清单而不是崩溃。
- 自动化：unit history（patch 撤销重做、合并）；integration projects API（保存、备份轮转、非法 JSON 拒绝）；e2e `project-io.spec.ts`。
**注意**：保存使用 `If-Match` 版本号防覆盖；自动保存可选（默认关闭，避免误覆盖）。

**实施备注（P8 已完成）**
- 路由：`/` 与 `/editor/:id` 为编辑器（项目列表 → 工作区），素材浏览器移到 `/assets`（e2e 已改）；`/play/:id` 现在能播放已存储的项目（`demo` 仍是内置示例）。
- 存储：`server/projects/store.ts`。版本号 = 文件内容 sha1 前 16 位，作为 `ETag`；`PUT` 必须带 `If-Match`，过期或缺失返回 412；覆盖前把旧文件写入 `history/<时间戳>.json`，最多 20 份；写入走临时文件 + rename。存的是 `ProjectSchema.parse` 之后的规范化结果，所以导出再导入 diff 为空。项目 id 限 `[A-Za-z0-9_-]{1,64}`（防路径穿越）。
- 导出格式 `.ournotes.json`：`{format, formatVersion, exportedAt, catalogVersion, refs:{models,backgrounds,audio}, project}`（`shared/project/exchange.ts`）；导入也接受裸项目 JSON。缺失资源逐项列出，可从同角色服装/背景/音频中替换或原样导入；id 已存在时作为新项目导入。
- 撤销/重做：`web/store/history.ts`（Immer patches + inverse，上限 200 步）；同一字段连续输入/拖动用 `coalesce` 键合并为一步，`seal()`（失焦/松手）结束合并。所有改动经 `projectStore.applyEdit(recipe,label,opts)`，并把被改单元的 `meta.source` 置为 `user`（`touch`）。保存后撤销到保存点仍显示“有未保存的更改”（按对象引用判脏，不做内容比较）。
- 预览联动：`web/play/usePlayerHost.ts`（从 PlayPage 抽出）；项目变化经 120 ms 防抖调用 `Player.reload(project)` 重新编译并回到当前时间，编译结果无变化（如只改标题）时不重绘；编译失败只在状态栏报错，旧画面保留。
- 外壳：采用 PLAN_REVISION §4 的设计 token（`web/styles/tokens.css`）与布局（顶栏 / 左栏剧本+素材 / 预览+传输条 / 右侧检查器 / 底部总览 / 状态栏，面板可拖宽并记忆）。检查器已覆盖项目、场景（标题、转场、背景与取景、服装、站位、BGM）、台词（类型、说话人、文本、时长、景别/运镜/dof/焦点）的全部现有字段，数值字段支持拖动标签、键入与算式，字段带来源徽标与锁按钮（锁的合并语义在 P13）。底部时间轴区只显示只读的场景总览并明确标注“多轨时间轴在 P10”，不放假控件。空白项目没有场景，场景增删属于 P9，界面如实说明。
- 数据模型预留：`project.style`、`scene.style`、`beat.style`（`{preset?, overrides, meta}`，三层，PLAN_REVISION P7.2 之前无人读取）。
- 已知：预览里旧样式对话框按视口宽度缩放，在 16:9 画框内偏大，留给 P7.2 V2 重做。

### P7.2 原作演出还原（V1–V8，已完成）
**实施备注**
- **风格系统**：`shared/style/ournotes.ts` 是唯一数值来源：嵌套默认值 + `STYLE_FIELDS` 字段表（路径/范围/单位/分组，驱动校验与检查器；单测保证两者一一对应）。`resolveStyle(project.style, scene.style, beat.style)` 按“预设 → 项目 → 场景 → 台词”合并点路径覆盖，返回每个值的来源层；非法值忽略并报告、越界值夹紧。预设：`ournotes`（默认）、`bandori-plate`（旧面板主题 + 旧节奏）。检查器“风格”分组可折叠，覆盖项带强调色条与 ↺ 恢复继承，继承项显示来源层；改动经 `applyEdit` → 120 ms 防抖重编译，预览即时变化（e2e 覆盖）。
- **V1 景别**：`establishing/group/two_shot/mcu/cu/ecu/insert`；旧名 closeup→cu、bust/medium→mcu、wide→group（含警告）。求解器按“眼线 y”定位，头高/眼线/头顶留白/视线留白/背景放大全部来自风格表；人物不再受背景裁边限制（背景层自行夹紧），`MAX_ZOOM` 14。**实测发现标定头框 ≠ 可见头**：发顶在框顶上方 3%、下巴在框内 85%、眼睛 59%，故 `framing.eyeFrac/headTop/headChin` 为可调字段，表中 headH 指发顶到下巴。`CameraPose.bgZoom`：背景放大由景别表给定（双人 1.45×，cu 2.5×，ecu 3.2×），不再是 zoom^0.85。
- **V2**：`DialogBox`（全比例 H 单位的 DOM，名字基线用零尺寸内联盒精确测量）、`HudLayer`（圆形菜单：自动/日志/跳过/隐藏界面，旋转 Auto 图标，地点标题条）。独白自动加全角括号、画外音名字模板、`A & B` 多人名字。渲染器分辨率 1.5（720×1.5=1080 行）。
- **V3**：auto 时长 `max(minLine 1.8, 字数/readingCps 6.5 + tail 0.8, 打字时长+0.3)`，逐字 10 字/秒；`minShotSeconds 4`：短句沿用上一机位（手改/锁定/dip 切入的镜头不受影响），完全相同的取景不产生新镜头。无语音，未实现“语音时长+0.6”。
- **V4**：转场 `dip_black`（0.2/0.2/0.25）、`scene_black`（停 0.5/渐黑 0.8/纯黑 1.2/渐亮 0.9，前三段是场景前导，渐亮在内容内）；beat 级 `cutIn: dip_black` + `cutInKeepDialog`；`scene.location` 触发自动建立镜头 beat（`<scene>:est`，时长 = 渐亮+0.9+2.35+0.5）与标题条（纯函数于时间，seek 一致）。
- **V5**：`shot.dof` 可选，缺省取风格表（暗背景 `luma<0.15` +1，上限 6，手填优先，空镜 0）；人物乘色 0.92（Stage 用 ColorMatrixFilter）。`luma` 由编译上下文提供（客户端尚未计算背景亮度，暗背景加成目前仅在提供 luma 时生效）。
- **V6**：`blocking.enter/exit`（0.2 s 淡入 + 0.04H 滑入；0.25 s 淡出）、`empty`/`silent`/`establishing` 节拍、入场时多人镜头的 0.8 s outCubic 重构图；规则导演（`performance.ruleDirector`）：句首按 emotion 换表情、每 N 句换手势（不连续重复）、无手工 head 轨道时听者延迟 0.3 s 转头。眨眼使用 Live2D 自带眨眼，未单独生成。
- **V7**：`fx` 轨道（`vignette_anxiety` / `memory_glow` / `dutch`）；GLSL 滤镜（烟雾暗角+去饱和、黑位抬升、径向 RGB 色差、泛光）与人物白色外发光；荷兰角旋转 sceneRoot 并按 `rollCoverScale` 放大以覆盖四角。`insert` 景别目前只有尺寸参数，没有身体部位探测。
- **V8**：demo 重写（约 85 s，原创台词，换场黑场+地点条、空景节拍、dip、独白 CU、不安暗角、±10° 倾斜 ECU+色差+泛光、三人入场重构图）。对比图 `.verify/p72-compare-*.png`（左原作右我们）。ECU（头高 0.95H）纹理清晰度见验收结论。
- 调试钩子新增 `player.project()/reload()`；e2e `tests/e2e/p72.spec.ts` 量化断言对话区几何（±6 px）、底边像素、标题条、dip 帧数、入场帧数、背景高频能量、乘色、暗角/荷兰角。
- G11 结论：ECU（头高 0.95H，渲染分辨率 1.5）下纹理线条清晰，无需降低 ECU 上限（见 .verify/p72-compare-v1-ecu.png）。e2e 在本机用独立端口 5275 的 vite 跑过（5273 的 vite 代理目标不可用）。

### P7.3 第二次验收修正（P9 开工前必须完成）
详见 `docs/ACCEPTANCE.md`「第二次验收 P7.2」§4，逐条实现并在实施备注记录：
- **N1** 同场景换镜改为硬切：原作预设 `glideSeconds` 默认 0；beat 级 `shot.transition: cut|glide`；demo 去掉 push_in。
- **N2** 对话区在连续台词之间不闪灭（显隐只由 `hiddenDialog` 决定）。
- **N3** 双人 / 群像按原作屏幕位置排布（faceX ±0.47H、群像 −0.50/+0.19/+0.70H，作为镜头内偏移）+ 高差压缩 `heightEqualize`；framing/compile 的剩余魔数进入 STYLE_FIELDS。
- **N4** 边缘侵入判定改用可见包围盒（含长发），排除不了的非焦点人物在单人镜头中隐去。
- **N5** 最短镜头规则不吞掉"景别变近 / 换焦点 / 有运镜"的镜头；检查器与大纲显示 `shotHeld` 徽标和"强制切镜"按钮。
- **N6** 检查器增加句子 emotion 字段，并只读显示规则导演的表情 / 手势结果。
- **N7** 菜单按钮按圆心定位；**N8** Auto 图标跟随对话区显隐、旋转按时间计算、HUD 不每帧重排；**N9** 不安暗角的烟雾纹理 + 雾色；**N10** dof 行布局。
- 顺手：E1（泛光段亮度）、E2（地点条描边）、E3（demo 内容）。
**验收**：全套测试通过；新增 e2e：换镜无过渡帧、句间对话区常显、两人眼线差 ≤0.07H、边缘 3% 像素带无非焦点人物、s3b6 为 CU、菜单圆心 0.064H。重新采集 `.verify/accept2.mjs` 的播放与转场帧，与 `ref/t051/t071/t094/t043/t125` 并排对比，由验收方复验。

**实施备注（P7.3，已完成，N1–N10 状态见 ACCEPTANCE.md「P7.3 修正状态」）**
- **换镜**：compile 的 `glide` 仅在 `shot.transition==='glide'`（或 style `glideSeconds>0` 且未显式 cut）时 >0；入场 `reframeSeconds` 不变。显式 glide 而 `glideSeconds=0` 时用 0.5 s 兜底。
- **多人镜头布局**：`solveShotDetailed` 返回 `shifts{dx,dy,s}`（两人/群像：脸中心落在 style 的屏幕 x，眼线按 `heightEqualize` 拉向均值，双人头高按 `sizeEqualize` 拉平），compile 写成 `CompiledActor.shiftX/Y/S` 关键帧（与相机 key 同时长/缓动），`evaluate` 输出到 `ActorRender`，Stage 以头心为轴缩放再平移。blocking 不变，seek 安全；`fit` 约束取消。手动 camera 轨道的相机关键帧不带偏移。
- **边缘判定**：`visibleShare(a,bg,pose,framing,shift)` 的盒 = 高度（头 + `chestHeads` 头高）× 宽度（模型 bounds ∪ 头框 ± `hairSpread`·头宽）。`avoidEdgeCuts` 对已钉在屏幕位置的多人镜头焦点人物不再做横向安全检查。单人镜头排除不了时，`CompiledActor.shotVisible`（0/1 阶跃）隐去，warning 文本含 "hidden for this shot"（相关 unit/integration 对这类 warning 放行）。
- **最短镜头**：closer / 焦点变化 / 非 static 不 hold；`shotHeld` 也包含"取景相同"的沿用，检查器徽标文案相应。`usePlayerHost` 现在把最新 compile 结果作为 React state（`compiled`）暴露，Inspector / Outline 据此显示 held 徽标与规则导演产出（不再读 ref，满足 react-hooks/refs）。
- **HUD / 对话区**：HudLayer.update 只在 ui 引用 / 对话区显隐 / 黑场状态变化时 `relayout`；Auto 图标角度 = `t · autoSpinDegPerSec`。DialogBox 仅在 ui / 有无名字 / 高度变化时重排。
- **烟雾暗角**：SCREEN_FRAGMENT 的 anxiety 分支改为 fbm 云（3 倍频、随 `t·anxietySmokeSpeed` 流动）驱动的不规则边宽与雾密度，按 `anxietyTint`（默认 #2A2830，原作为深灰黑烟）混色，角部 +0.6·mx·my。
- **遗留**：E1（泛光段亮度）；s3 地点条（E3）；手动相机 / 每人偏移的人工覆盖入口仍在 P9；e2e 的双人眼线差用真实标定在 integration 中断言（e2e 只做像素 / 状态级断言）。

### P9 剧本编辑器、属性面板、舞台直接操作
**交付**：剧本编辑器（场景列表 + beat 列表：编辑文本、说话人下拉（仅场景在场角色）、kind、时长模式；增删/拖动排序 beat；增删场景）、属性面板（按选中对象显示：角色→服装（只列该角色真实模型）、表情、motion、头/身/眼目标或角度、位置；镜头→类型/焦点/运动/dof；背景→选择/取景；转场→类型/时长；每个字段显示 source 徽标（AI/规则/人工/默认）与锁按钮）、舞台直接操作（在预览上拖动角色改 slot/depth（相机逆变换）；选中角色出现朝向手柄：拖动设头 yaw，Alt 拖动设视线；滚轮改 depth）。所有修改即时反映到预览（同一 Player，暂停态实时 evaluate）。
**验收**
- 浏览器：在 demo 中选中爱音，把服装从 casual 换成 school_winter → 预览立即替换（无需 AI）；拖动她到画面左侧 → 两人朝向自动重算（灯转向右侧看她）；手动把灯的头 yaw 设为背对、锁定 → 拖动爱音时灯保持锁定朝向；修改台词文本后 auto 时长改变，后续关键帧跟随；所有操作可撤销。
- 自动化：e2e `editor-basic.spec.ts`（换装、拖动、锁定后参数不变、撤销）；unit：source/locked 在 applyEdit 中的置位规则。
**注意**：拖拽中只做预览不入历史，松手时提交一次；属性面板的资源下拉必须来自 catalog（禁止自由输入未知 ID）。
**追加（第二次验收，"人工可调所有功能"）**：
- **镜头**：手动相机位姿 x/y/zoom/roll，可从求解结果"烘焙"后手改（烘焙后 source=user，可一键"恢复自动"）；镜头切换方式 cut/glide；多人镜头每人的屏幕 x 偏移与眼线微调（覆盖 N3 的自动排布）；插入镜头的目标部位框（在预览上画框）。
- **规则导演产出可见可改**：每句为每个角色选出的表情、手势、听者转头延迟都在检查器中显示，带"规则"徽标；可单项"烘焙为关键帧"或锁定；全局 / 角色 / 句子三层的规则导演开关与强度。
- **风格预设管理**：复制、另存为、重命名、导入导出预设 JSON；字段右键"设为预设默认""复制值 / 粘贴值"；style 数值以 px@1080 显示（内部仍存 /H），可切换单位（ACCEPTANCE E6）；scene/beat 层的 preset 选择要么实现、要么从 UI 中移除（E5）。
- **检查器结构**：按选中对象分标签（项目 / 场景 / 句子 / 角色 / 镜头 / 风格），不再是一条长单列；每组标题显示"覆盖了 N 项"（PLAN_REVISION §4.3）。
- **预览叠加**：安全区、三分线、SR 眼线带（0.36–0.45H）、参考帧洋葱皮（可选 `.verify/ref/` 或用户图片，透明度 / 差值模式）。
- **验收补充**：e2e 抽查 5 个自动值（相机位姿、dof、句时长、规则导演表情、多人脸位置），都能在检查器中找到、修改、锁定，且重编译后保持；把 `ref/t051.jpg` 叠在双人镜头上，通过拖动相机框和人物偏移完成对齐，并截图。

**实施备注（P9 已完成）**
- **数据层**：`shared/project/mutate.ts` 是纯函数的编辑库（可对 Immer draft 使用）：`anchorAt/absTime`（绝对时间 ↔ `{beatId, offset}`，拖过句边界自动换锚；落在自动空镜上时锚到第一句的负偏移）、轨道 / 关键帧增删改、`insertBeat/duplicateBeat/removeBeat/moveBeat`、`insertScene/removeScene/moveScene`、`setActorInScene`。id 取最小未用的 `<前缀>_<n>`，无随机数。删句子会带走锚在它上面的关键帧并把入退场标记挪到相邻句。`structuredClone` 不能复制 Immer proxy，统一用 `clone()`（单测抓到过）。
- **动作层**：`web/store/actions.ts` 是编辑器所有改动的入口（舞台手柄、时间轴、剧本、检查器共用）：一次手势 = 一次 `applyEdit`（拖动按 `coalesce` 合并为一步），统一置 `meta.source='user'`，并执行锁：锁定的关键帧 / 轨道 / 站位 / 句子镜头拒绝修改，状态栏 toast 说明原因（不静默失败）。`writeKey` = 更新播放头处（或其过渡区间覆盖播放头）的关键帧，否则新建；舞台上直接操作新建的关键帧时长为 0，立即生效。
- **预览直接操作**（`web/editor/stageTools/StageOverlay.tsx`，叠在画面上的 SVG，坐标 = 舞台像素）：拖动人物 = 站位（slot/depth，由 `feetToSlotDepth` 逆变换，播放头处有 position 关键帧则改该关键帧，否则改场景 blocking）；Shift+拖动 = 镜头内偏移（新字段 `shot.offsets`，单位画面高度，叠加在 N3 自动排布之上）；滚轮 = 纵深；头顶刻度盘 = 头部 yaw（写 `head` 角度关键帧），Alt 拖 = 视线；头上的圆环 = 视线方向；相机工具（V/C 切换）：拖动平移、滚轮缩放、Alt+拖动背景取景，首次编辑把本句镜头变为手动（`camera` 轨道上句首的 `manual` 关键帧），"恢复自动" 删除它，"烘焙为手动" 把求解结果固化为数值。选中人物后预览下方出现快捷条（表情 / 手势 / 服装 / 头 / 视线），与检查器"角色"标签是同一组控件（`ActorFields.tsx`），每行带来源徽标与锁。
- **检查器**按对象分标签：项目（含角色增加 / 改名）/ 场景（含在场角色勾选、站位、服装、入退场、BGM）/ 句子 / 角色（播放头处的表演）/ 镜头（景别、运镜、换镜方式、dof、焦点、手动镜头 x/y/缩放、每人偏移）/ 关键帧 / 风格。风格标签：数值单位可切 H ↔ px@1080（E6）；字段右键菜单（复制值 / 粘贴值 / 恢复继承 / 设为项目默认）；风格预设的另存 / 应用 / 复制 / 重命名 / 删除 / 导入 / 导出（预设 = 某层 overrides 的命名副本，存在浏览器 localStorage，文件格式 `ournotes-style-preset`，导入时逐项校验字段名与取值）。E5：场景 / 句子层从来没有预设下拉，保持。
- **剧本编辑器**（左栏）：场景增删 / 上下移 / 改标题，台词增删 / 复制 / 拖动或按钮排序，选中台词后原位编辑说话人（只列在场角色）/ 类型 / 时长模式 / 文本。空项目：先在"项目"标签加角色，再"添加场景"，场景自带一句示例台词，新场景沿用上一场景的背景与站位（首场景用项目角色的默认服装）。
- **叠加层**：安全区（93% / 90%）、三分线、SR 眼线带 0.36–0.45H、参考帧（用户选图，透明度滑块 + 差值模式）。**快捷键**（`useShortcuts.ts`，`?` 查看）：空格、J/K/L（J 为逐步回跳，不是真倒放）、←/→ 帧步进（Shift = 1 s）、↑/↓ 上下一句、Home/End、Ctrl+Z/Y/Shift+Z、Ctrl+S、Delete、Ctrl+C/V、V/C 切工具、Esc。
- **规则导演产出**可见可烘焙：compile 为每个人物输出 `ruleKeys`（换表情、手势、听者转头，形状同真实关键帧），烘焙后效果不变（单测：烘焙全部幽灵关键帧，表情 / 动作 / yaw 编译结果逐项相等）。
- **E1**：泛光默认 黑位抬升 0.15→0.26、强度 0.35→0.6，新增 `fx.glowDialogAlpha`（0.55）：泛光期间对话区渐变按此比例淡出（对照 t146：整体更亮更白、底部渐变发灰而不是深紫）。
- **性能 / 稳定性**：`Player.reload` 只在背景 / 模型 / 动作集合变化时重进场景，其余编辑只重绘（否则拖动人物会闪烁）；舞台手势开始时先收口上一手势的撤销分组（滚轮的延迟收口曾把拖动切成两步）。
- **已知取舍**：自动构图的镜头里，改 slot 会被求解器重新居中（相机跟人），屏幕上变化很小——要精确移动画面位置请 Shift+拖动（镜头内偏移）或切到手动镜头；`bgZoom`（景别表给的背景放大）目前没有传到渲染器（`evaluate` 的 `camera` 丢了该字段，P7.2 起如此），手动镜头因此只存 x/y/zoom；E7（背景亮度 luma）、插入镜头的目标部位框、角色级规则导演开关仍未做。

### P10 多轨时间轴与分镜编辑器
**交付**：`web/editor/timeline/`：按场景显示时间尺（以 beat 分段）、轨道分组（每个角色：motion/expression/head/body/gaze/position/opacity/costume；camera；background；audio；screen）、关键帧增删/拖动（拖动改 `offset`，跨 beat 自动换锚 beatId）、缓动与时长编辑、多选、复制粘贴、轨道静音/独奏预览、播放头联动；`web/editor/storyboard/`：场景/镜头卡片网格（每个 beat 一张卡：离屏渲染缩略图——用 Stage 在 seek 到 beat 中点后 `generateTexture` 缩成 320×180，缓存到内存并在编辑后失效），卡片上可改镜头类型、焦点、转场。
**验收**
- 浏览器：在时间轴上给灯的 head 轨道加一个关键帧（0.5 s 后转向镜头），播放可见；拖动关键帧到下一 beat，播放时机改变；分镜视图显示 demo 全部 beat 缩略图，改某卡镜头为 closeup 后缩略图与预览都更新；锁定某关键帧后拖动无效并有提示。
- 自动化：unit 关键帧重锚算法；e2e `timeline.spec.ts`（加/拖/删关键帧后 `getRenderState` 断言）。
**注意**：缩略图渲染不要阻塞 UI：队列化，每帧最多渲 1 张；大项目分镜虚拟滚动。
**追加（验收 D1）**：seek 落在 scene i 的转场 lead-in 内时，先进入 scene i−1 在 `start_i−ε` 处 apply+settle 并 `captureSnapshot`，再进入 scene i；缩略图渲染复用此路径。e2e：seek 到 crossfade 50% 时画面像素≠纯新场景。
**追加（第二次验收）**：
- **轨道**：fx 轨道（anxiety/glow/dutch 每次出现的强度、进出时长、roll 方向，荷兰角按镜头交替）；beat 级镜头切入轨道（cut/dip/glide 及三段时长）；地点条轨道（出现延迟 / 停留可拖）；规则导演产出以"幽灵关键帧"显示，双击即可烘焙成真实关键帧。
- **分镜卡片**：显示景别徽标、dof、`shotHeld`（沿用上一机位）标记；支持多选卡片后批量改景别、切入方式、风格覆盖。
- **验收补充**：时间轴上把一次不安暗角的强度从 1 改为 0.5、进入时长从 0.3 改为 1.0 s，seek 与顺序播放的画面都随之变化；对一个被 hold 的镜头点击"强制切镜"，分镜卡片与预览同时更新。

**实施备注（P10 已完成）**
- **时间轴**（`web/editor/timeline/`，底部，默认 290 px 高，可拖）：显示选中场景（随播放头），顶部时间尺按句分段并标句号，Ctrl+滚轮 / ＋－ / "适合场景" 缩放。轨道分组：剧本与镜头（对白块、转场块、镜头块 + 手动镜头关键帧、地点条）、特效与音频（fx、黑白场、BGM、音效）、每个人物（动作 / 表情 / 头部 / 身体 / 视线 / 位置 / 透明度 / 服装；默认只展开选中的人物，在舞台上点人物会展开其轨道）。轨道头带 M（静音）、S（独奏）、锁；静音 / 独奏只改预览用的项目副本（状态栏有提示），不改保存的项目。
- **关键帧**：点击选中（Shift 加选，空白处拖框多选），拖动移动（跨句自动换锚，吸附句边界 / 播放头 / 其他关键帧，Ctrl 关闭吸附，Alt 复制），关键帧后面的小手柄拖动过渡时长，双击空轨道在该时刻添加（默认值取自该人物的真实模型，如第一个手势 / 不同于当前的表情），Ctrl+C/V、Delete。检查器"关键帧"标签编辑值、时间、过渡时长、缓动（带曲线预览）、锁。锁定的关键帧或轨道拒绝拖动 / 修改 / 删除并在状态栏提示。拖动期间每次移动都写入项目（同一 `coalesce` 键合并为一步），预览即时跟随。
- **转场与镜头切入**：转场块右缘可拖，改的是该转场真正的参数（crossfade 等改 `transitionIn.duration`；dip / 换场黑场改场景层 `transitions.dipHold` / `sceneHold`，所以整个场景后面的时间都跟着移动，可撤销）；句子的 `cutIn: dip_black` 在转场行以 ◆ 标出；地点条块可拖（出现延迟 / 停留写入场景层 `location.delay/hold`）；对白块右缘拖动 = 改成固定时长。
- **幽灵关键帧**：规则导演自己加的表情 / 手势 / 听者转头以虚线空心菱形显示，双击烘焙成真实关键帧（头部转向烘焙整组，因为规则导演在有手工头部关键帧时整体让位）。
- **分镜**（`web/editor/storyboard/`，顶栏"预览 / 分镜"切换）：每句一张卡，缩略图取自活的 Player（seek 到句中点后把画布复制成 320×180，逐张生成，预览画布此时在后台）；缩略图缓存键 = 该场景编译结果的哈希，改动只让受影响的场景失效；卡片显示景别 / dof / 沿用机位 / 切入 / 锁定徽标和时长，可直接改景别、切入方式、焦点；Ctrl / Shift 多选后批量改景别 / 切入；拖动重排（同场景内）、＋ 插入、⧉ 复制、✕ 删除；场景头可改转场。卡片用 `content-visibility: auto` 做浏览器级虚拟化。
- **D1**：`Player.show` 在"跳转落进场景转场前导"时，先进入上一场景并在 `start_i − 1ms` 处 apply + settle + 截快照，再进入新场景（缩略图复用同一 seek 路径）。e2e：跳进换场黑场的停顿段，画面构图与上一场景末帧一致而不是新场景。
- **测试**：unit `mutate`（锚定、关键帧、增删排序）、`actions`（锁、撤销、合并、复制粘贴、手动镜头、规则导演烘焙等价、人物偏移）；e2e `editor-basic`（站位拖动 + 撤销 + 锁、刻度盘 / 表情 / 服装 / 视线、相机工具、剧本编辑、风格单位与预设、叠加层与参考帧、键盘、两种窗口尺寸无溢出、保存重开）、`editor-blank`（从零写一个项目）、`timeline`（加 / 拖 / 换锚 / 锁 / 时长 / 复制 / 删除、框选、幽灵烘焙、fx 强度与时长、转场边缘、静音独奏、D1、E1、分镜）。

### P10.1 第三次验收修正（P11 开工前必须完成）
详见 `docs/ACCEPTANCE.md`「第三次验收 P7.3–P10」§5，逐条实现并在实施备注中记录：
- **F1** evaluate 不再丢弃 `bgZoom`（`evaluate.ts:144`），使风格表的背景放大真正生效；手动相机增加可选的 `bgZoom` / `roll`；修好后对照原作重调 `DOF_BLUR`。
- **F2** 统一锁定语义（见下文 §1.1 补充），检查器与结构类操作都经过锁检查；删除或移出操作若会连带删掉锁定单元，则拒绝。
- **F3** 在自动构图镜头里拖动人物，人物要跟手移动：拖动期间冻结相机，或提供显式的"站位 / 画面位置"模式；建立镜头期间使用相机工具时不得悄悄改第一句的镜头。
- **F4** 预览上的滚轮必须配合修饰键才改纵深。**F5** `insert` 景别实现目标部位框，否则先从下拉中移除。**F6** id 单调递增，删除过的 id 不再复用。**F7** 离散修改到预览 <100 ms。**F8** 中文标签、单色图标、截断与自动滚动等界面一致性。
- 顺手：E4（`/play` 全屏自适应 + 画幅选择）、E7（背景 luma）。
**锁定语义（§1.1 补充，F2 的依据）**：`locked` 的单元，AI 和规则导演永不覆盖；人工修改被拒绝，并以 toast 提示，提示内带"解锁"按钮；解锁本身总是允许。删除台词或场景、把角色移出场景等结构类操作，如果会连带删掉锁定单元，就拒绝并说明原因。场景"标题"行的锁只锁标题。
**验收**：全套测试通过；新增 e2e：背景层缩放 = 风格表 bgZoom（±3%）、改 `shots.mcu.bgZoom` 立即生效；锁定服装后换装被拒、锁定台词后在检查器和剧本面板改文字都被拒、删除"带锁定关键帧的台词"被拒；自动双人镜头中拖动 300 px，人物在屏幕上至少移动 250 px；普通滚轮不改项目；"选择表情 → 预览更新"<120 ms。重新采集 `.verify/accept3-play.mjs`，与 t043/t051 并排对比背景尺度，由验收方复验。

**实施备注（P10.1 已完成，F1–F8 + E4/E7）**
- **F1**：`evaluate` 输出 `camera.bgZoom`（并把手动镜头的 `roll` 加进 `fx.roll`）；`CameraValue.manual` 增加可选 `bgZoom`（1–12）与 `roll`（±30°），检查器「手动镜头」和镜头标签都有“背景放大 / 倾斜”；相机工具平移保留这两项；`StageOverlay` 的背景拖动比例尺用显式 bgZoom。`getCamera()` 带 `bgZoom` 和实际生效的 `bgViewZoom`（e2e 用）。`DOF_BLUR` 按 STYLE_REFERENCE 实测重调为 `[0, 1, 1.8, 3.5, 5.5, 8, 11]`（MCU/双人 σ≈2 px@1080 → 1.8 px@720，CU 8，ECU 11）；对照 t043 与 `accept3` 帧确认背景桌椅窗框尺度和虚化级别接近原作。
- **F2**：新增 `shared/project/locks.ts`，是**唯一的锁闸门**：`projectStore.applyEdit` 对每一次编辑比较前后两份项目，凡是前一份里已锁定的单元，其“自身内容”（去掉 `meta`、去掉嵌套的有自己锁的子单元）被改动或被删除，整次编辑被拒绝，提示 toast 带「解锁」按钮（只解锁被命中的单元）。单元 = 带 `meta` 的对象；轨道的锁覆盖其所有关键帧；场景「标题」行的锁只管标题（`title/sourceSpan`）；解锁（只改 `meta`）与重排永远允许；`idSeq` 不算内容。所有入口（检查器直接 `applyEdit`、`ActorFields` 换装、`deleteBeat/deleteScene/toggleActorInScene`、`bakeRuleKeys`、`editScene`…）因此自动受保护，AI 之后合并时也可复用同一函数。`applyEdit` 返回 boolean，`deleteBeat/deleteScene` 被拒绝时不改选中。`editScene` 不再因场景锁拒绝全部修改。
- **F3**：自动构图里，属于当前镜头焦点的人物，普通拖动写 `shot.offsets`（“画面位置”，人物 1:1 跟手，松手后保持），Ctrl+拖动才改站位（相机跟随）；非焦点人物仍是“拖动=站位 / Shift=画面位置”。画面左上角有当前模式提示（`stage-hint`）。建立镜头（空镜头）期间相机工具提示“空镜头不可编辑”，不再悄悄改第一句。`beatAtTime` 在建立镜头时返回 null。大纲点击台词改为 seek 到句首 +0.01 s。
- **F4**：滚轮必须配合 Alt 才改纵深（并在状态栏提示“纵深 a → b”）；普通滚轮不改任何数据。
- **F5**：实现 `shot.insertBox {x,y,w,h}`（相对焦点人物整体轮廓，头到脚）；求解器以框为目标（框中心 + 刚好装下框的缩放）；默认框为胸/手区域；检查器「镜头」标签在景别为插入时出现 4 个滑块。`insert` 因此可以在 P13 的词汇表里开放。
- **F6**：`nextId` 按前缀单调递增：场景上 `idSeq`（句子 / 轨道 / 关键帧）和项目上 `idSeq`（场景 / 角色）保存“发过的最大编号”，删除后不复用；保存、读取、撤销重做都稳定。旧项目没有该字段，按现有最大编号起算。
- **F7**：去掉 120 ms 防抖，改为下一帧（rAF）启动重载，同时最多一个重载在跑，跑完若有更新的项目再跑一次；e2e 实测“选表情 → state() 变化”中位数远小于 120 ms。
- **F8**：新增 `shared/catalog/labels.ts`（景别、句子类型、转场、表情家族、动作家族、服装中文名；原始 id 放 title）；时间轴 / 分镜 / 检查器全部使用中文；`LockIcon` 单色 SVG 取代 emoji；转场块窄于文字时显示“◐”并带 tooltip；分镜卡片下拉只显示短名；选中人物后时间轴滚动到其轨道组；toast 在下一次成功编辑时清除。
- **E4**：`/play` 窗口按视口自适应并有“全屏”；“画幅”可选 16:9 或宽画幅 2.16:1。`Stage` 带 `aspect` 参数，`Camera/BackgroundLayer/ScreenFx` 按实际宽度，`bgView` 在更宽的窗口下自动多放大一点保证背景盖满；对话区左侧锚点相对 16:9 中心区居中，HUD 本来就按实际宽度。**E7** 背景 luma（暗场 dof 加成）此前已在 compile 中实现，未改动。
- **工程注意**：Windows 上 vite 对连续两次写同一文件偶尔不刷新缓存，改完 `shared/project/mutate.ts` 这类被多处引用的文件后若浏览器行为不对，先 `touch` 一下文件。

---

### P11 LLM 提供方层、设置面板、缓存
**交付**：`server/llm/provider.ts`（接口 `generateStructured<T>({ system, cacheablePrefix, input, schema, schemaName, maxTokens, signal }) → { data, usage, cached, raw, warnings }`）、`anthropic.ts`（`@anthropic-ai/sdk`；默认模型 `claude-sonnet-5-5`；`messages.parse` + `output_config.format: zodOutputFormat(schema)`；输出大时用 `messages.stream(...).finalMessage()` 再自行 zod 校验；系统提示 + 目录前缀加 `cache_control`；不传 temperature、不强制 tool_choice、不传 thinking:disabled；检查 `stop_reason`：max_tokens→抛 `TruncatedError`、refusal→抛明确错误；类型化异常分类）、`openaiCompat.ts`（fetch `/chat/completions`；json_schema → json_object → 文本提取 三级降级；超时与重试；支持无 key 的 LM Studio）、`cache.ts`（`data/llm-cache/<sha256>.json`，key = provider+model+promptVersion+schemaName+规范化输入（JSON 键排序））、`server/settings/*`（`data/settings.local.json`；GET 返回掩码 key；`POST /api/llm/test` 用极小请求测试连通性）、前端设置面板（提供方切换、模型、base URL、key 输入、测试按钮、当前状态）。无可用提供方时所有 AI 按钮显示"未配置 AI：请在设置中填写 ANTHROPIC_API_KEY 或 OpenAI 兼容地址；也可使用『规则生成（非 AI）』"。
**验收**
- 浏览器：无 key 时 AI 入口显示上述提示；配置 Claude key（若环境有）后"测试连接"成功显示模型名与延迟；切换到 OpenAI 兼容并填 `http://localhost:1234/v1`：LM Studio 未运行时显示连接失败的明确原因（不是转圈不停）。
- 自动化：unit 用 mock fetch/mock SDK 测：结构化输出解析、三级降级、截断与拒绝处理、缓存命中（第二次不发请求）、key 不出现在任何 API 响应与日志中；integration（仅当环境存在 `ANTHROPIC_API_KEY` 时运行）对 Claude 做一次极小结构化调用。
**注意**：先读 `@anthropic-ai/sdk` 安装版本的类型确认 `messages.parse`/`zodOutputFormat` 与 zod 4 的兼容；若 helper 不兼容 zod 4，改用 `output_config.format: { type:'json_schema', schema: z.toJSONSchema(schema) }` + 手动 zod 校验。key 只存服务端，前端永不持有明文。

**实施备注（P11 已完成）**
- **文件**：`server/llm/provider.ts`（接口、`LlmError`/`TruncatedError`、`stableStringify`、`modelJsonSchema`、`extractJson`）、`anthropic.ts`（`@anthropic-ai/sdk@0.133.0`，默认 `claude-sonnet-5-5`，`output_config.format = json_schema`（`z.toJSONSchema` 去掉边界/默认等后端不接受的关键字，返回后再用 zod 校验），`output_config.effort=medium`，不传 temperature / thinking / tool_choice；系统提示 + 目录前缀在 `system` 末块加 `cache_control: ephemeral`；`max_tokens>16000` 走 `messages.stream().finalMessage()`；`stop_reason` max_tokens→`TruncatedError`、refusal→`LlmError('refusal')`；SDK 类型化异常→auth / rate_limit / timeout / network / bad_request / server，消息里的 key 会被替换为 `***`）、`openaiCompat.ts`（`/chat/completions`；`json_schema → json_object → text` 三级降级，只在 400 时降级并记住可用模式；429/5xx/网络错误指数退避重试 2 次，超时不重试；`finish_reason=length`→截断；ECONNREFUSED 等给出可读原因；key 可空；`maxTokensCap` 默认 8192）、`cache.ts`（`data/llm-cache/<sha256>.json`，键 = provider+model+promptVersion+schemaName+system+前缀+规范化输入，**不含 max_tokens**，只缓存成功且通过 schema 的结果）、`fixtureProvider.ts`（仅 `NODE_ENV=test` 注册）。
- **设置**：`server/settings/store.ts`：`data/settings.local.json`（gitignored，0600，明文 key 只在服务端）叠加环境变量 / `.env`（`index.ts` 启动时 `loadDotEnv('.env')`，容忍 BOM/引号/注释，不覆盖已有环境变量）。**面板保存的值优先，环境变量只给默认值**（所以 `.env` 里写了 `LLM_PROVIDER=openai` 也能在面板切到 Claude）。`GET/PUT /api/llm/settings` 只返回掩码（`sk-…087b`）与来源（env/file），`POST /api/llm/test` 恒返回 200，`ok:false` 带 `{kind,message}`。`LLM_SETTINGS_FILE` 可改文件位置（e2e 用）。无可用提供方时所有 AI 入口显示『未配置 AI：请在设置中填写 ANTHROPIC_API_KEY 或 OpenAI 兼容地址；也可使用『规则生成（非 AI）』』。
- **前端**：`SettingsDialog`（提供方切换、模型/地址/key 只写不回显、测试连接、清除已存 key），项目列表与工作区顶栏都有「AI 设置」。
- **DeepSeek（OpenAI 兼容）实测**：`response_format: json_schema` 返回 400（"unavailable now"），`json_object` 与纯文本 JSON 均可；服务端对 base URL 含 `deepseek` 的配置直接从 `json_object` 起步（省一次探测请求），schema 写进系统提示。工具调用不使用（结构化输出路径更稳）。输入约 1.9 万 token 的目录前缀可正常处理，且自动命中 DeepSeek 的前缀缓存（`prompt_cache_hit_tokens`）。输出上限按 8192 处理（`maxOutputTokens`），导演层据此把长场景拆成多个跨度。
- **测试**：`tests/unit/llm.test.ts`（mock fetch：json_schema/降级/截断/拒绝/重试/401 不泄露 key/ECONNREFUSED 说明/无 key；SDK 走 mock fetch 的请求体断言与流式；缓存命中与失败不缓存；路由与日志不含 key；`.env` 解析与优先级）；`tests/integration/anthropic.test.ts`（仅有 `ANTHROPIC_API_KEY` 时跑一次极小结构化调用）。

### P12 AI Director Pass 1：全文拆解（场景/角色/背景/服装）
**交付**：`server/llm/prompts/breakdown.ts`（系统提示：BanG Dream 乐队与成员关系、职位与舞台编队规则、"只能使用给定 ID"、服装选择要考虑季节/学校/日常/演出/全文连续性并可跨场景换装、`live-mode` 只用于正式演奏）、目录压缩器 `shared/director/catalogDigest.ts`（角色：key、名、别名、乐队、职位；服装：每角色 modelId + 解析标签（隐藏 `_low`）；背景：id、名称、地点、室内外、时间、简述，341 条约 15–20k tokens，作为可缓存前缀；本地小模型模式下先用关键词粗筛背景候选 ≤60 条）、段落切分（按空行/对白引号，给每段编号）、`shared/director/validate.ts` 的 breakdown 校验与确定性修复（未知 characterKey→null 作为"未映射角色"，仅旁白；不存在 background→同地点/同 setting 最相近；服装不属于该角色→该角色默认 casual）、`POST /api/director/breakdown`（返回结果 + warnings + 缓存命中信息）、编辑器中"AI 拆解"视图：显示场景划分、地点与理由、在场角色、服装与理由，可逐项修改/锁定后再继续。
**验收**
- 浏览器：粘贴 `tests/fixtures/story-short.txt`（原创 ~2000 字，MyGO 成员放学后在 RiNG 讨论新歌，然后换到夜晚天台）→ 得到 2–3 个场景，背景分别为 RiNG 相关与天台夜间，服装为校服→（放学后）合理；理由可见；再次点击命中缓存（<200 ms，标注"缓存"）。
- 自动化：unit 用录制的 LLM 响应 fixture（`tests/fixtures/llm/breakdown-*.json`，含故意错误 ID）测校验与修复；断言输出中所有 ID 都在 catalog；integration（有 key 时）真实调用一次并断言 ID 合法。
**注意**：长文本按章节/约 2 万字分块调用，分块间传递已识别 cast 与最后场景信息以保持连续；不要把背景图片发给 LLM。

**实施备注（P12 已完成）**
- `shared/director/paragraphs.ts`（按行切段、过长行在句末切分且不切引号内、char 偏移精确、`traceability` 用字符二元组衡量文本能否回溯到原文）、`catalogDigest.ts`（角色/别名/乐队/职位、乐队编队、服装 `modelId〔标签〕`（隐藏 `_low`/still，live-mode 单独标注）、背景 id｜名称｜地点｜室内外｜时间｜简述；341 条背景约 3 万字符≈1.9 万 token，按 catalog 字节稳定，作为可缓存前缀；`backgroundLimit` 在本机小模型时用关键词粗筛到 60 条）、`resources.ts`（查表、默认服装、背景相似度排序）、`validate.ts#validateBreakdown`（未知 characterKey→null 未映射；不存在的背景→按场景标题/理由/时间在背景中找最相近；服装不存在/不属于该角色/低质量/非演出用 live-mode/演出场景非 live-mode→该角色默认服装；在在场名单与服装互相补齐；段落范围排序、去重叠、补空缺并夹紧；每一步产生 warning，无法修复才进 errors）、`fromBreakdown.ts`（拆解→项目骨架：cast、场景（`Scene.brief` 记录时间/气氛/是否演出/乐队）、背景与服装带理由、演出场景按乐队编队站位、其余均匀站位、原文逐段作为 `rule` 来源的旁白节拍，骨架即可播放）。
- `server/llm/prompts/breakdown.ts`（规则：只用目录 ID、服装依据全文与前后连续性且允许跨场景换装、live-mode 只给正式演奏、乐队编队、cast.evidence）、`pipeline.ts#runStep`（缓存 → zod → 语义校验/确定性修复 → **至多一次** LLM 修复调用，修复调用带上一次输出与问题清单；修复成功后的答案同时按**原始请求键**缓存，下次零调用）、`director.ts#runBreakdown`（约 2 万字分块，块间传递已识别 cast 与上一场景末状态；截断时对半拆分重试）、`POST /api/director/breakdown`（返回 `breakdown`、`project` 骨架、`warnings`、`runs`（提供方/模型/耗时/token/缓存/是否修复））。
- 前端「AI 拆解…」对话框：粘贴/载入文本 → 场景划分、背景与理由、在场、服装与理由、未映射角色、修复警告、缓存标记 → 「创建项目并继续」。**真实 DeepSeek（deepseek-flash）实测**：`tests/fixtures/story-short.txt`（~1400 字）得到 4–5 个场景，夜间天台 → 夜间背景，服装为校服并给出理由，约 14 s、1.9 万输入 token；再次拆解命中缓存（<200 ms，标注“缓存”）。
- 测试：`tests/unit/director.test.ts`（用 `tests/fixtures/llm/breakdown-story.json` 录制输出 + 含故意错误的 `breakdown-bad.json` 断言所有 ID 合法、warning 条目、范围修复、编队）；fixture 目录 `tests/fixtures/llm/`（`index.json` 映射 schemaName + 输入子串 → 文件，内容是 DeepSeek 对该故事的真实输出）。

### P13 AI Director Pass 2：逐场景演出指导 + 意图展开 + 锁合并
**交付**：`prompts/sceneDirection.ts`（输入：场景段落、在场角色及其**该服装真实可用的** motion family 与表情列表、上一场景结束状态摘要、锁定约束清单（"以下内容已锁定，必须保持"）、镜头语法说明：普通对白多用 bust/two_shot，情绪高点 closeup，环境交代 wide，沉默 hold，不要每句机械切镜；日常站位按人物关系、演出按乐队编队）、`shared/director/expand.ts`（意图→完整 Scene：blocking slot→坐标；每 beat：说话人与听者的 head/gaze 目标（听者延迟 0.2–0.4 s 反应，偶尔视线下移/移开体现情绪）、motion family→变体、表情、镜头关键帧（solveShot 留给 compile）、enter/exit→opacity 轨道、costumeChanges→costume 轨道、beat 时长 auto；决策项 source='ai'，派生项 source='rule'；全部 ID 用 `ids.ts` 稳定生成）、`mergeLocks.ts`（按稳定 ID 匹配：locked 单元原样覆盖新结果；被锁 beat 的文本/说话人不变；找不到匹配的锁 → 报告冲突，保留旧场景，不得静默丢弃）、`POST /api/director/scene`（单场景）、`POST /api/director/scenes`（批量，并发 2–3，逐场景进度 SSE）。
**验收**
- 浏览器：对 P12 结果点"生成演出"→ 得到可直接播放的完整演出：说话人与听者互相看、情绪对应表情与动作（如 "笑着说" → smile 系）、镜头有节奏变化、远处角色接地正确；锁定第 1 场景的相机与灯的服装后"重新生成第 1 场景"→ 锁定项完全不变，其余变化。
- 自动化：unit `expand.test.ts`（每个 beat 都有说话人 gaze→听者、听者 gaze→说话人；不存在的 motion 不会出现；没有任何 actor 使用水平翻转标记）、`mergeLocks.test.ts`（锁定保留、冲突报告、ID 稳定性：同一输入展开两次 ID 一致）、`validate.test.ts`（fixture 中的非法 motion/表情被修复并产生 warning）；e2e：加载录制 fixture 生成的项目并播放 10 s 无 console error。
**注意**：每个场景一次调用（不逐句）；超长场景（>60 beat）拆两半调用并传前半结束状态；Pass 2 输出 token 估算后设 `max_tokens`，截断时自动拆分重试一次。AI 给出的 `text` 必须能回溯到原文段落（旁白可精简，对白尽量原文），校验段落号范围。
**追加（第三次验收，AI 前置条件与词汇更新）**：
- **镜头词汇以 P7.2 风格系统为准**：提示词与 schema 只使用 `establishing/group/two_shot/mcu/cu/ecu`（`insert` 要等 F5 的目标框实现后才开放），切入方式用 `cut | dip_black(+keepDialog)`，运镜默认 `static`。不要再出现 bust/closeup/wide/crossfade。"不要每句机械切镜"由 compile 的 `minShotSeconds` 与 hold 规则兜底，AI 只表达意图（景别 + 焦点 + 情绪 + 是否特效）。情绪特效（`fx` 轨道：anxiety/glow/dutch）与 `beat.emotion` 都属于 AI 可以输出的意图。
- **规则导演按区间让位**（开工前改 `compile.ts` 约 245 行）：听者转头目前只要该人物有任意一个 head 关键帧就整场让位，需要改成按句或按关键帧覆盖区间让位。这样 AI 或人工只改一句时，其余句子的规则转头仍然保留。手势和表情已经是按句让位，不用改。
- **锁粒度**：在 `MetaSchema` 增加可选的 `lockedFields?: string[]`，用于台词（`text/speakerId/kind/duration/emotion/cutIn`）和镜头（`type/focus/move/dof/offsets`）；`mergeLocks` 先看整单元锁，再看字段锁。检查器字段旁的锁按钮写入字段锁。
- **id**：`expand.ts` 生成的 id 与编辑器 `mutate.ts` 的 id 必须同一规则且单调递增（F6）；合并时一律按 id 匹配，不按数组下标。
- **范围映射集中定义**：新增 `shared/director/scope.ts`，导出 `SCOPES = { camera: {tracks:['camera'], beatFields:['shot','cutIn','cutInKeepDialog']}, performance: {tracks:['motion','expression','head','body','gaze'], beatFields:['emotion']}, costume: {sceneFields:['wardrobe'], tracks:['costume']}, staging: {sceneFields:['blocking'], tracks:['position','opacity']}, fx: {tracks:['fx','fade']} }`。P13 合并与 P14 局部重新生成共用这一份定义，各自写各自的就会不一致。

**实施备注（P13 已完成）**
- **前置条件**：`compile.ts` 的规则导演（听者转头）改为**按句让位**——某人物在某句的时间区间内有手工/AI 的 head 关键帧，才跳过该句的规则转头，其余句保留（单测 `listener turns yield per line`）；`MetaSchema.lockedFields`（字段级锁），`locks.ts` 的统一锁闸门同时识别 `lockedFields`（被锁字段被改动→拒绝并提示“…的「文本」已锁定”），检查器台词（文本/镜头切入/情绪/时长）与镜头（景别/运镜/景深/焦点）字段旁有字段锁按钮；`shared/director/scope.ts` 是**唯一**的范围映射（`SCOPES` + `resolveScope`，P13 合并与 P14 局部重新生成共用）；`mutate.ts#nextId` 导出，`expand` 与编辑器 id 规则一致（`<scene>b_<n>` / `tr_<n>` / `k_<n>`，单调递增，`idSeq` 持续增长）。新增 `Scene.brief`（可选）保存时间/气氛/演出信息。
- **词汇**：`shared/director/vocab.ts`——镜头 `group/two_shot/mcu/cu/ecu/insert`（insert 已因 F5 开放），运镜 `static/push_in/pull_out`，切入 `cut/dip_black`，转场 `cut/dip_black/scene_black`，情绪即 `EMOTION_TAGS`，`fx` 三种；站位词 7 个横向 slot × 3 个纵深（`SLOT_X`/`DEPTH_Y`）。`SceneDirectionSchema`（`shared/schema/ai.ts`）：blocking、transitionIn、bgm、beats（keepId/paragraph/kind/speaker/text/emotion/reason/shot/cutIn/fx/actors[motion,expression,attention,enter,exit,move]）、costumeChanges。
- **校验/修复**（`validateDirection`）：说话人不在场→旁白；段落号夹紧；文本回溯检查（对白/旁白阈值不同，换到别的段落能对上则更正段落号，否则 warning；>40% 对白无法回溯→errors→一次 LLM 修复；`keepId` 复现的锁定/人工节拍免检）；景别旧名映射；focus 过滤；motion 按“同族→同字母前缀→情绪表→丢弃”修复，expression 同理，live-mode 无表情、只允许 play/action/finish；attention/BGM/换装 ID 校验；每项修复产生 warning。
- **expand**（`shared/director/expand.ts`）：每个导演节拍→节拍（`ai` 决策）；说话人 head/gaze→听者（最近者或 `attention`）、其余在场者 0.2–0.4 s 后转向说话人（确定性哈希）、情绪为 sad/shy/thinking 时偶尔视线下移，这些派生键 `source='rule'`，AI 明确的 attention/motion/expression/move/enter/exit/costume/fx 为 `ai`；演出场景站位保持乐队编队（AI 的 slot 被忽略）并在首拍给 live-mode 演员 `play*` 动作；节拍 id 通过 `keepId` → (段落,说话人,序号) → 同文本三级匹配复用旧 id。**重放提供方（fixture）产生的决策一律标 `rule`，绝不标成 AI**。
- **mergeLocks**（`shared/director/mergeLocks.ts`）：受保护 = `locked` 或 `source==='user'`（`overwriteUser` 可放开 user，永不放开 locked）或字段锁；`scene` 范围替换节拍列表（匹配到的受保护节拍保留结构字段，人工新增的无锁节拍留在原位，找不到对应的**已锁定**节拍→冲突，整次不应用并返回旧场景）；其它范围只替换 `SCOPES` 里列出的轨道通道/节拍字段/场景字段；`beatIds` 限制到所选句子；受保护关键帧所在句在该轨道上屏蔽新关键帧；指向被删节拍的锁定关键帧→冲突；最后用 `findLockViolations(old,new)` 做硬校验。返回报告（替换/保留的节拍与轨道、受保护保留项）。
- **服务端**：`server/llm/sceneRunner.ts#runScene`（每场景一次调用；按提供方输出上限拆成连续跨度（DeepSeek 8192 → 每跨度约 11 段）；截断→小跨度加倍 token 重试一次、或对半拆分；局部范围把现有节拍作为 `fixedBeats` 发给模型，要求逐一 `keepId` 对应）、`runScenes`（并发 3，逐场景进度，单场景失败不影响其它）、`POST /api/director/scene`、`POST /api/director/scenes`（SSE：`progress`/`done`）。
- **前端**：工作区左栏新增「AI 导演」标签：范围（整个场景/镜头/表演/服装/站位/特效）、“只重做选中的台词”、“也覆盖我手改过的内容”、生成本场景/生成全部、逐场景进度、每个场景的结果卡（已应用/锁定冲突、缓存、提供方·模型·耗时·token、修复警告、模型给出的演出意图 JSON）；整次生成是**一个**撤销步骤。
- **真实模型实测**（DeepSeek deepseek-flash，`LLM_LIVE=1 npm run test:integration -- llm-live`，报告写入 `data/reports/`）：4 场景/48–56 节拍，5 次调用（每场景一次，最长场景拆 2 跨度），无效资源 ID 率 0–4%（motion `note01`/`look02` 被修复），重复运行 0 次请求，锁定节拍/服装/人工改动全部保留。在浏览器里用真实 deepseek-flash 生成并播放（截图 `.verify/p13-live-*.png`）。
- **测试**：unit `director.test.ts`（校验/修复、expand 的 gaze/head、source 标注、确定性、id 规则、编队、整部故事 compile 无非法资源 warning）、`mergeLocks.test.ts`（范围表、整场景/局部合并、字段锁、锁冲突、人工内容、id 单调）、`directorPipeline.test.ts`（按场景批量：4 场景 5 次调用；缓存命中 0 调用；修复流至多一次额外调用且失败不落盘；截断拆分；锁定贯穿服务端）、`directorRoutes.test.ts`（含 SSE）；e2e `ai-workflow.spec.ts`（测试模式双服务器 5373/5374，设置面板、拆解、生成、播放 10 s、撤销、锁与局部重新生成）。
- **遗留 / 后续（P14+）**：整套“接受/拒绝”差异视图与 AI 徽标按范围粒度、规则导演 `ruleDirector.ts`、`ai-workflow` 里按 scope 的 diff 展示尚未做；章节检测与断点续跑属 P15。Anthropic 路径只在 mock 层验证（本机无 key），首次使用真实 Claude 时请先在设置里“测试连接”。

### P14 编辑器内 AI 工作流：查看/修改/锁定/撤销/局部重新生成 + 规则导演
**交付**：AI 面板：一键"从文本生成全部"（Pass1→可选人工确认→Pass2 批量）、每步结果查看（拆解、每场景的原始意图 JSON 与理由、warnings、缓存/耗时/token）、局部重新生成范围：整个场景 / 选中 beat 范围 / 仅某通道（如只重做镜头、只重做表情动作、只重做服装）——请求携带当前项目片段与锁，返回结果只合并到请求范围；每次 AI 应用作为**一个**撤销步骤；"接受/拒绝"预览差异（高亮被改字段）；`shared/director/ruleDirector.ts`（确定性规则导演：引号/冒号识别对白、按别名匹配说话人、默认 casual 服装、按关键词匹配背景、镜头按固定节奏；产物 source='rule'，UI 明显标注"规则生成（非 AI）"）。
**验收**
- 浏览器：生成后撤销一次即回到生成前；只重做第 2 场景镜头时角色动作/表情/服装未变（diff 视图证明）；无 key 时仍可用规则导演得到可播放结果，且所有徽标为"规则"不是"AI"；锁定的任何字段在所有重生成路径下不变。
- 自动化：unit 范围合并（scope=camera 时只改 camera 轨道与 beat.shot）、ruleDirector 基本对白识别；e2e `ai-workflow.spec.ts`（使用服务端的 mock provider：`LLM_PROVIDER=mock` 读取录制 fixture，**仅测试环境可用，UI 中标明 mock**）。
**注意**：mock provider 只在 `NODE_ENV=test` 注册，生产 UI 不出现；不得把 mock 结果标为 AI。
**追加（第三次验收）**：diff 视图直接复用编译结果里的 `ruleKeys`（与真实关键帧同构）和关键帧 `{beatId, offset}` 锚点：按 `scope.ts` 列出"将被改 / 被锁跳过 / 规则补位"三类。AI 应用后，被 AI 改过的单元显示 AI 徽标；人工再改时变为"人工"（`touch`）。"接受 / 拒绝"按 scope 粒度生效。验收补充：锁定字段在"重新生成本句镜头 / 本场景表演 / 全部"三条路径下逐字段不变（e2e 断言 JSON 相等）。

### P15 完整小说自动演出与收尾
**交付**：长文本导入（.txt/.md，UTF-8/GBK 自动识别）、章节检测、分块 Pass1 + 并发 Pass2 + 进度条/取消/断点续跑（已完成场景缓存）、生成后整体连续性检查（`shared/director/continuity.ts`：同一角色跨场景服装无故变化需有 costumeChange 或场景切换理由；离场角色不再说话；背景时间顺序合理，输出 warnings 列表可点击定位）、播放器"放映模式"（全屏 16:9、自动推进、跳过、对话记录）、模型预加载策略（下一场景所需模型在当前场景后半段加载；LRU 卸载）、性能面板（FPS、显存估计、已加载模型数）、README 完整使用说明。
**验收**
- 浏览器：导入 `tests/fixtures/story-long.txt`（原创，约 1.5 万字，5–8 场景，含一次正式演出场景：乐队 live-mode 编队，主唱居中前排、鼓后排）→ 一键生成 → 从头到尾放映无卡死、无 console error、FPS ≥ 45（记录）；演出场景使用 `live-mode` 模型与 `mtn_play*` 动作、编队正确；中途取消后再继续只生成剩余场景；人工修改并锁定后"重新生成全部"保留锁定。
- 自动化：e2e `full-novel.spec.ts`（mock provider，录制 fixture；断言场景数、所有资源 ID 合法、连续性 warnings 为空或在预期列表内、放映 30 s 无错误）；integration（有 key 时）对 story-long 真实跑一次，记录耗时与 token 至 `data/reports/`（不入库）。
- 最终回归：`npm run test:all` 全绿；`git ls-files` 中无素材/Core；THIRD_PARTY.md 完整。
**注意**：大批量调用要限速并处理 429（SDK 自带重试 + 自身退避）；断点续跑依赖缓存键稳定（输入规范化）。
**追加（第三次验收）**：放映模式需要全屏自适应，并提供画幅选择：16:9，或原作的宽画幅约 2.16:1（参考帧为 1920×890）。宽画幅下按 H 比例的构图与 UI 保持不变，左右多露出的背景由背景层覆盖并夹紧（E4）；对话区与 HUD 的水平锚点按画幅重新计算。

---

## 3. 风险与对策（按严重度）
1. **朝向/视线正确性**（核心需求）：motion 自带绝对朝向，覆盖层注入点错误会导致累积漂移或物理不响应。对策：P3 固定注入点并有无漂移 E2E；P4 逐模型探测 + 人工确认 + 变体选择 + 残差加性偏移。
2. **Cubism Core 依赖外网 CDN 与 moc v5**：离线或版本不符即全黑。对策：P3 启动检查 + 明确 UI 提示 + 本地 `CUBISM_CORE_URL` 覆盖。
3. **透明/转场/滤镜的视觉瑕疵**（露图层、裁头发、残影）：对策：AlphaFilter + filterArea/padding + snapshot 转场，P6 截图对照验收。
4. **构图与接地的通用性**（241 模型留白不一、头饰/面具/静态 NPC）：对策：探测头单位 + 比例夹紧 0.75–1.3 + 背景地面参数可人工覆盖并持久化。
5. **LLM 输出质量与合法性**（尤其本地小模型）：对策：意图化 schema、目录裁剪、确定性修复、一次 LLM 修复、失败不落盘；规则导演兜底且诚实标注。
6. **性能/显存**（每模型 ~32 MB 纹理，2.8 GB 素材）：对策：同屏上限、LRU、预加载、纹理 LOD（引擎 `single-auto`）。
7. **seek 时 motion 精确性**：已确认引擎的 `ACubismMotion.setOffsetTime` 可从中途开始，P7.1 实现（见 ACCEPTANCE M2）。

**实施备注（P14 已完成）**
- **规则导演**：`shared/director/ruleDirector.ts`（按章节标题/分隔线/时间地点词切场景，关键词匹配背景与服装——校服/便服/演出 live-mode，引号识别对白，说话人取引号前后最近的已知名字，其余按"对话另一方"，情绪关键词→`EMOTION_EXPR/GESTURE`，镜头固定节奏：开场 group、对白 mcu、情绪高点 cu、每 4 句 two_shot）。它以 `server/llm/ruleProvider.ts#RuleProvider`（`id: 'rule'`）实现和模型相同的 `LlmProvider` 接口，所以校验/修复、expand、mergeLocks、SSE、缓存之外的整条管线完全复用；产物 `source: 'rule'`（`isModelAi()` 只对 anthropic/openai 返回 true），UI 标"规则 / 规则生成（非 AI）"。入口：三个 director 接口的 `engine: 'rule'`；未配置模型时 AI 导演页与拆解对话框自动选规则引擎。
- **差异视图 + 接受/拒绝**（`shared/director/diff.ts`、`AiResultCard.tsx`、`AiPanel.tsx`）：每个提案默认只预览不写入（"先预览差异"开关）；差异按 `scope.ts` 分组（台词结构/转场/音乐、镜头、表演、服装、站位、特效），列出 前→后，另显示"保留了 N 项锁定/人工内容"和"规则补位 N 个关键帧"；"全部接受"、"接受选中的范围"（用更少的 scope 重新 `mergeLocks`，结构变化时只能整体接受）、"拒绝"，批量时"接受全部 N 个场景"。接受时对**当前**场景重新跑 `mergeLocks`（生成期间的人工改动也受保护），一次撤销步骤。
- **进度/取消/记录**：进度条 + 逐场景状态；SSE `progress.done` 带 `result`，取消后保留已完成场景；运行记录（每个场景调用数、耗时、修复/警告、错误）；连续性检查（`shared/director/continuity.ts`：无理由换装、说话人不在场、离场后说话、非演出场景穿 live-mode / 演出场景非 live-mode、主唱不在前排中央 / 鼓手不在后排、时间与背景不符、仅有原文旁白的场景；点击定位）。
- **测试**：unit `ruleDirector.test.ts`（引号对白、示例小说 5–6 章、全部 `rule` 标注、编译无非法资源、锁定节拍经规则重生成不变、diff 只含 camera、部分范围合并、连续性、章节检测/分块、宽画幅脸位布局）；e2e `ai-workflow.spec.ts` 新增 P14（预览不改项目→拒绝→接受→一次撤销、规则引擎标注）。

**实施备注（P15 已完成）**
- **宽画幅重排**：`CompileContext.aspect`（播放器按 Stage 的画幅传入）→ `solveShotDetailed({aspect})`：`faceLayout` 的脸位按 `aspect/(16/9)` 横向拉开，边缘检查、`clampCamera`、`cameraMove` 的宽度都用实际画幅；16:9 结果不变。乐队正式演出站位沿用 `bandFormation`（主唱前排居中、鼓手后排），连续性检查会报告偏离。
- **一键生成**（`AiBreakdownDialog`）：载入 `.txt/.md`（`web/textImport.ts`：UTF-8 / GBK 自动识别）、章节标题检测与分块优先在章节边界切（`chunkParagraphs`）、`一键生成完整演出`＝拆解→创建并保存项目→逐场景 3 并发→逐批保存；进度/取消/`继续生成剩余场景`（已完成场景已保存，其余靠缓存键稳定续跑）；统计非缓存调用数、缓存命中、修复数、token、耗时；完成后连续性清单、`放映`（/play/<id>）、`在编辑器中精修`。拆解输出预算改为 `min(模型上限, 4000+120×段数)`（原来的 3000+40×段数在 48 段时会被截断，被迫对半拆分，导致重复运行缓存不稳）。对白文本入库前去掉引号。`insert` 默认目标框上移到胸腹手部（原来落在大腿）。
- **示例输入**：`examples/mygo-rehearsal.txt`（原创，约 1900 字，6 章：教室 → RiNG 前台 → 排练室 → 夜晚天台 → 后台 → 正式演出，含校服→便服→演出服换装、3–5 人对话、一次争执、演出场景）。
- **真实生成（DeepSeek deepseek-flash，通过 UI 一键生成，示例小说）**：首次 7 场景/104 节拍，11 次调用，输入 7.1 万 / 输出 4.3 万 token，179 s（同时在跑 e2e）；另一次 5 场景 9 次调用 4.8 万 / 4.0 万 token，112 s；集成测试 `LLM_LIVE=1 … llm-live`：5 场景 96 节拍 9 调用 86 s，4.4 万 / 3.7 万 token；全部缓存命中的重跑 21 s（7 命中 + 1 次调用）。连续性检查 0 条。
- **放映验证**（1920×890 宽画幅，连续放映 395 s，0 console error，实时 1×，78 张抽帧，截图 `.verify/p15-sheet01..07.png`，对照 `.verify/ref/`）：构图——对话以单人胸像/近景为主、多人同框时人脸按宽画幅横向展开，后台 5 人群像居中展开；表情动作——悲伤低头闭眼、微笑、"记忆发光"特效与台词情绪一致；换装——校服（教室、RiNG 前台）→ 便服（排练室、天台）→ 演出服（后台）→ live-mode（舞台），立希穿 RiNG 打工服，理由与原文相符；演出场景主唱前排居中、鼓手后排。已知不足：①AI 偏爱 `insert` 且默认目标框原先落在腿部（已改）；②群像里偶尔有人被画面边缘切掉一半；③舞台场景 AI 只给 8 个节拍，演奏过程缺少乐器特写；④原作的灯光/色调匹配（D4）与对话框质感（D5）仍未做。
- **局部重新生成与锁定（真实模型，`.verify/p14-live-locks.mjs`）**：整行锁、字段锁（文本）、人工改的镜头景别、被锁定的服装；分别以"表演""镜头""整个场景"重新生成并接受：预览阶段项目未变；三条路径下锁定节拍逐字段相同、文本字段锁保持、人工景别保留、服装保持；接受后一次撤销回到原状。截图 `.verify/p14-live-*.png`。
- **遗留**：Anthropic 路径仍只在 mock 层验证；`StageOverlay.screenToWorld` 仍假定 16:9（编辑器无宽画幅）；放映模式的对话记录/跳过、性能面板（FPS/显存）、模型 LRU 预加载未做（FPS 通过连续放映未掉帧间接验证，未量化）；章节检测只识别中文章节与 markdown 标题。

## P16 实施备注（Sonnet）
- 局部重生成：`sceneRunner` 在 focus 模式按"选中句 ± 1 段"构造请求，分组 / 对半降级；`SCENE_PROMPT_VERSION` 升到 `scene-2`，缓存按版本隔离。
- 缓存：`LlmCache` 条目可带 `truncatedAt`；`generateCached` 对截断请求写标记并在同等或更小 max_tokens 时直接抛 `TruncatedError`。
- insert：`shared/director/vocab.ts` 的 `INSERT_BOX / INSERT_HINT`，`validate.ts` 降级，`expand.ts` 写 insertBox。
- 部分接受：`shared/director/diff.ts` 的 `alignToOld` + `DiffNames`；`AiPanel` 的接受选中范围走对齐后的合并。
- 首页：`EditorApp.tsx`（卡片网格、搜索、批量删除），项目摘要新增 beats / cast / coverBackground。

---

### P17 背景资产标注落地（乐队归属 / 地点 / 舞台）
**目标**：给每张背景标注"哪些乐队可以用"，避免 AI 导演或规则导演把乐队放进别的乐队的私人住宅或专属练习室（例如把 Ave Mujica 之外的乐队放进若叶家地下录音室）。草案为 `docs/bg-labels.draft.json`（341 张，confirmed 49 / likely 185 / unknown 107），待确认问题见 `docs/BG_QUESTIONS.md`（Q1–Q10）。用户答复后再落地；未答复的组保持 `unknown`。

**数据**
- 存放：`asset-labels/backgrounds.json`（仓库根，入库）。**不放 `data/`**，因为 `.gitignore` 里的 `/data/` 是运行时目录、不入库。文件只含背景 id 与标签，不含任何素材、URL 或图片。顶层 `version`，`labels: { [backgroundId]: BgLabel }`。
- `BgLabel`（`shared/schema/assetLabels.ts`，zod）：`bands: string[]`（乐队 key；`["generic"]` 表示通用；`[]` 表示未知）、`affinity?: string[]`（软偏好，不构成限制）、`access: 'public'|'school'|'band'|'private'|'abstract'`、`placeType`、`placeName: string|null`、`indoor: 'indoor'|'outdoor'|'abstract'|'screen'`、`time: 'day'|'dusk'|'night'|'unspecified'`、`stage: boolean`、`confidence: 'confirmed'|'likely'|'unknown'`、`evidence: string`、`source: 'draft'|'user'`、`updatedAt`。乐队 key 沿用 catalog（mygo/avemujica/mewtype/millsage/dumbrock），另外为经典 7 队预留 key（popipa/afterglow/pasupare/roselia/hhw/morfonica/ras）。
- 迁移：一次性脚本 `scripts/import-bg-labels.ts` 读取草案和用户答复，生成 `asset-labels/backgrounds.json`；同时修正 catalog 描述错误（016 实为水瀬女子学園，018 实为都立芸術学院中学校，121 实为码头，181/182/220 补上花咲川女子学園校名）。修正写成 label 里的覆盖字段 `nameOverride/descriptionOverride`，不改外部 manifest。
- 素材更新时：标签中有、素材中已不存在的 id 记为 warning；素材中新出现、尚无标签的背景视为 `unknown`。

**Catalog API**
- `server/assets/indexer.ts` 在索引时读取 `asset-labels/backgrounds.json`，将标签合并为 `BackgroundEntry.labels`（可选字段，`shared/schema/assets.ts`），并加入 catalog `version` 的签名（标签变化后客户端缓存失效）。
- `PUT /api/asset-labels/backgrounds/:id`：编辑单张；`PATCH /api/asset-labels/backgrounds`：批量修改，body 为 `{ ids, patch }`。服务端 zod 校验，原子写入（沿用 P-final 的唯一临时文件名方案），写入后让 catalog 失效重建。保存时 `source` 置为 `'user'`。
- `GET /api/asset-labels/backgrounds/stats`：各置信度数量、未知数量、各乐队拥有的背景数，供 UI 显示。

**资源浏览器 UI**（`web/editor/panels/AssetBrowser.tsx`）
- 背景卡片角标显示乐队色点；"通用"显示灰点，"未知"显示问号；舞台背景另加标记。
- 筛选条件：乐队、`access`、地点类型、时段、仅看未知、仅看舞台。
- 详情侧栏可编辑全部标签字段（乐队多选与 affinity 多选、置信度、依据）。
- 批量标注：多选（Shift/Ctrl，或"选中同一地点的全部时段变体"：按 `placeName` 或 `location` 分组）后统一设置乐队、access、置信度。整个批量操作只占一个撤销步骤（仅限本次会话）。
- 所有操作只改标签，不触碰素材文件。

**AI Director 约束（两层）**
- 统一判定函数 `shared/director/bandFit.ts#bgAllowedFor(label, sceneBands)`：
  - 没有标签或 `bands` 含 `generic`：允许。
  - `bands` 为空（未知）：不允许自动选用。若用户在 Q10 选 B，则作为兜底候选，并在连续性检查中给出 warning。
  - 否则要求"场景出场乐队 ⊆ bands"。访客例外：原文明确写到"去某某家"时，Pass1 在 `location.guestOf` 中填写主人所属乐队，此时只要求主人乐队 ∈ bands。
  - 子角色（isSub）不计入出场乐队。
- 场景出场乐队：取 Pass1 场景 `cast` 中主角色的 `bandKey` 去重。
- **Pass1 提示**：`breakdownDigest` 的背景行增加一列 `乐队`（`通用`/乐队名/`未知`）和 `舞台` 标记，并加入规则文字："只能选用乐队列包含本场景全部出场乐队、或标为通用的背景；私人住宅/专属练习室不得给其他乐队；正式演出必须选舞台=是的背景"。`backgroundLimit`（本地小模型）筛选时先按乐队过滤，再按相关度排序。
- **服务端校验修复**（`shared/director/validate.ts`）：背景不存在，或 `bgAllowedFor` 为假时，在允许集合内调用 `rankBackgrounds`（同时把时段与室内外作为偏好）取最近的背景，并给出 warning："场景「X」的背景 Y 属于 Z，与出场乐队冲突，已换成 W"。演出场景（含 live-mode 编队）的背景必须是 `stage=true`，否则同样修复。修复结果须可确定性复现。
- **Pass2 / 局部重生成**：沿用 Pass1 的背景，不另行选择；如果人工锁定的背景与出场乐队冲突，不改动，只在连续性检查中给出 warning（人工选择优先）。
- **规则导演**（`ruleDirector.ts`）：调用 `rankBackgrounds` 前先用 `bgAllowedFor` 过滤（场景出场乐队取关键词识别出的角色所属乐队）；过滤后为空时退回通用背景，不选未知背景。
- **连续性检查**新增两条：背景与出场乐队冲突（包括人工指定的情况）；演出场景使用了非舞台背景。
- 缓存：Pass1 的提示词发生变化，需把 `BREAKDOWN_PROMPT_VERSION` 升一版。标签内容进入 digest，标签变化后缓存自然失效。

**测试**
- unit `bandFit.test.ts`：generic、未知、单乐队、多乐队、访客例外、子角色忽略。
- unit `validate.test.ts`：给场景 cast=[MyGO 成员] 指定若叶家地下录音室（avemujica）→ 被替换为允许集合中同为室内的背景，并带 warning；演出场景指定非舞台背景 → 替换为舞台背景；锁定背景不被修改，但连续性检查给出 warning。
- unit `ruleDirector.test.ts`：含"练习室"和 Ave Mujica 角色的段落命中若叶家；同样文字配 MyGO 角色时不命中若叶家。
- unit `catalogDigest.test.ts`：背景行含乐队列；digest 在相同输入下字节稳定。
- unit `assetLabels.test.ts`：zod 校验；草案 341 条全部合法；标签与 catalog 的 id 一一对应（多余或缺失的 id 进入 warnings）。
- integration：`PUT`/`PATCH` 标签 → `/api/catalog` 的 `version` 改变，且返回新标签；并发 PUT 不出现 500。
- e2e `asset-labels.spec.ts`：在资源浏览器中筛选"Ave Mujica"→ 批量把三张背景设为通用 → 刷新后状态保留 → 撤销。
- e2e（mock provider）：示例小说 `examples/mygo-rehearsal.txt` 一键生成后，所有场景背景均对 MyGO 合法（为通用或含 mygo），连续性检查不出现乐队冲突警告。

**验收**
- `asset-labels/backgrounds.json` 入库，覆盖 341/341；用户已答复组的 `confidence` 改为 `confirmed`；剩余 `unknown` 的数量写入 ACCEPTANCE。`git ls-files` 中仍无素材。
- 浏览器：资源浏览器可以看到并编辑标签，批量标注一次完成；筛选正确。
- 真实模型（有 key 时）：用"MyGO 在练习室排练"与"Ave Mujica 在练习室排练"两段原创文本分别生成，前者不得出现若叶家地下录音室、Win-Wing 等专属地点，后者允许出现若叶家；修复次数和 warnings 记入报告。
- 规则导演：结果同上。
- `npm run test:all` 全绿。

## P17 实施备注（Sonnet）
- 数据：`asset-labels/backgrounds.json`（341 条，confirmed 152 / likely 165 / unknown 24；`bands: []` 的未知条目 24）由 `scripts/import-bg-labels.ts` 从 `docs/bg-labels.draft.json`（仅作生成来源）加第二轮答复生成；此后只改 asset-labels 那份。顶层 `rules.unknownPolicy`（avoid 默认 / allow / forbid）可配置主人不明房间的处理（`PUT /api/asset-labels/rules`）。
- 字段扩展：`ownerKey`、`residents`（私宅住户，在场才能用；Peace之家住户为整个一家Dumb Rock!）、`usage`（通用的使用条件：moods/activity/rarity，267 阿拉蕾衣柜暗室仅在阿拉蕾情绪低落且剧情涉及唱歌时才可作低优先候选）、`nameOverride/descriptionOverride`（016/018/121/181/182/220）。
- 第二轮答复：车辆通用；046=祥子家；Roarin' Nest（数字 id 27/28 与 022）homeBand=dumbrock、任何乐队可用；VR Floor（数字 id 20 与 257）、320 蓝色虚拟舞台=MewType 专属（320 可作舞台）；律的房间仅 313/314；267=阿拉蕾；266 主人不明（R2-9 按 B）。
- 判定：`shared/director/bandFit.ts#bgFit` 返回 ok/fallback/no（exclusive 硬约束、住户在场、访客 `location.guestOf`、usage 条件、unknown 政策）。接入：digest（新增乐队/舞台列，不列未知与带 usage 的背景；`breakdown-2`）、`validateBreakdown`（冲突/非舞台背景确定性替换并写 warning）、规则导演（先过滤，空则退回通用）、连续性检查（`bg_band_conflict / bg_unknown_owner / bg_not_stage`，手选允许但提示）、编辑器背景选择器（⚠ 标注与警告）。局部重生成不改背景，只受连续性检查约束。
- 服务端：`server/assets/labels.ts`（`LabelStore` 串行原子写，Windows 下 rename 遇 EPERM 重试）、`PUT/PATCH /api/asset-labels/backgrounds`、`/stats`；标签哈希进入 catalog `version`；素材缺失 id / 未标注背景进 warnings。测试用 `LABELS_FILE` 环境变量指向临时文件。
- UI：资源浏览器背景页按乐队/地点/置信度/仅舞台/仅未知筛选，Ctrl/Shift 多选、选中同一地点全部、批量保存（PATCH 仅发送改动字段）、撤销上次保存（会话内）。e2e `asset-labels.spec.ts` 在 afterAll 把标注文件还原。首页“素材库未找到”增加“如何设置素材库”说明。
- 未做：live 测试（`llm-live.test.ts` 中新增 P17 用例，需 LLM_LIVE=1 与用户自填 key，当前 .env 无 key，未运行）。


---

### P18 素材获取：素材源适配器 + 本地导入 + Core 本地选择
**事实依据**：`docs/RESEARCH.md` §7。**关键结论**：Haneoka 的 robots 没有限制，但使用条款 §2 明确禁止"未经权利人或法律许可，下载素材用于再利用/改编/批量重新打包"，而本工具下载素材的目的就是再利用。因此 **P18 不实现从 Haneoka 自动下载素材文件**。Haneoka 适配器的流程是：读取公开元数据 → 按分类生成"清单"（链接到站点页面）→ 用户在站点上手动下载 → 通过本地文件夹/zip 一键导入。通用下载引擎放在 P18b，**需主会话与用户确认后才做**，而且只服务于用户自有、条款允许自动下载的来源。

**P18a 交付（默认范围）**

1. **适配器接口** `server/assets/sources/types.ts`
   ```ts
   interface SourceAdapter {
     id: string; name: string; homepage: string;
     policy: 'auto-download' | 'manual-only' | 'local';   // Haneoka = 'manual-only'
     disclaimerVersion: string | null;                    // 非 null 时首次使用必须确认
     listCatalog(ctx): Promise<SourceCatalog>;            // 角色/乐队/服装/背景分类 + 本项目 id
     planFiles?(ctx, selection): Promise<FilePlan[]>;     // 仅 auto-download 实现；{relPath,url,bytes,sha256}
     manualLinks?(selection): ManualLink[];               // manual-only：每个所选项 → 站点页面链接 + 说明
   }
   ```
   - 注册表 `server/assets/sources/index.ts`：内置 `local-folder`、`local-zip`、`haneoka`（`enabled:false`）。设置写入 `data/settings.local.json` 的 `assetSources: { [id]: { enabled, disclaimerAcceptedVersion, acceptedAt } }`，沿用 `server/settings/store.ts` 的原子写。
   - **服务端闸门**：源未启用，或 `disclaimerAcceptedVersion !== adapter.disclaimerVersion` 时，该源的所有路由返回 403 `{code:'disclaimer_required'}`。不能只在前端拦截。
   - **policy 硬约束**：调度器只会对 `policy==='auto-download'` 的适配器调用 `planFiles`。manual-only 的适配器不实现这个方法，单测要断言它不存在。另设**主机名拒绝表**（`haneoka.org` 等），作为 P18b 通用引擎的兜底，防止用户把旧 manifest 中的站点 URL 当作"自定义清单"喂进来。

2. **Haneoka 适配器** `server/assets/sources/haneoka.ts`（manual-only）
   - 只请求 3 个公开 JSON：`/api/v1/live2d`、`/api/v1/story-assets/views/backgrounds`、`/api/v1/backgrounds`。先读 `X-Haneoka-Release-Id`，之后的请求都带 `?release=`。结果缓存在 `data/sources/haneoka/<release>.json`，24 h 内不重复请求，请求时带 `If-None-Match`。UA 为 `OpeNotesStudio/<version> (+https://github.com/<OWNER>/OpeNotesStudio)`，仓库地址做成 `shared/meta.ts` 中的常量，开源前替换。请求一律串行，不做探测、HEAD 扫描或逐文件请求。
   - id 映射：模型 = `live2dKey`；剧情背景 = `assetName`（`adv_bkg_stage_NNNNNN`）；名片背景 = `String(backgroundId)`。这与 `asset-labels/backgrounds.json` 中的 341 个 id 一致，见 RESEARCH §7.2。
   - 分类层级：乐队（bandId → `shared/data` 乐队 key）→ 角色（characterKey）→ 服装（label/mode，`_low` 默认隐藏）。背景分为剧情背景和名片背景，并显示 P17 标签（乐队归属/地点），未标注的显示"未知"。
   - 输出 `manualLinks`：每项给出站点**页面**链接（Live2D 查看器页面或背景页）、本项目 id，以及"下载后放哪里/怎么导入"的说明。**不输出素材直链，不提供"复制全部链接"或导出 URL 列表的功能。** 查看器的深链接格式**待验证**：由实施者在浏览器里手动打开一次站点确认；无法确认时，链接到 `https://haneoka.org/intl/<locale>/live2d/` 并显示 key，让用户自己搜索。
   - 已有/缺失对照：与当前 catalog 比较，标出"已在库 / 未导入"，清单默认只列出未导入的项。
   - 体积：站点索引中没有文件大小，所以清单**不显示预估体积**，只显示条目数，并注明"单个模型通常 5–50 MB"。准确的文件数和大小在导入时显示。

3. **本地导入**（不依赖任何站点）`server/assets/import/`
   - 输入有两种：服务端可访问的本地文件夹路径，或上传的 `.zip`（服务端流式写入 `data/import-tmp/<uuid>/`，大小上限可配置，默认 2 GB）。zip 解析新增**一个** MIT 依赖，在 `yauzl` 和 `fflate` 中二选一，并写入 THIRD_PARTY.md。必须防御 zip-slip（拒绝绝对路径、`..`、盘符）、zip 炸弹（限制解压总量和条目数）和符号链接。
   - 识别：递归查找 `*.model3.json`，每个视为一个模型。PNG 按背景规则识别：文件名为 `adv_bkg_stage_\d{6}` 或纯数字；文件名为 `bg_*` 时，用 Haneoka 缓存的名片背景索引反查 `backgroundId`，查不到就提示用户手动指定 id。模型 id 依次尝试：所在目录名 → 与 `live2dKey` 匹配的文件名或父目录名 → 用户在预览表格中手填。
   - **model3.json 规范化**（`normalizeModel3.ts`，纯函数，必须有单测）：
     - `Textures` 不论是站点绝对路径（`/runtime/...`）、`../` 还是 URL，都按 basename 在包内查找，复制到 `textures/<basename>`。找不到时报错，该模型不导入。
     - `Motions`：某个组如果有多个条目（例如站点的单一 `"Motion"` 组），就拆成**每个 motion 一组**，组名 = 文件 basename 去掉 `.motion3.json`，并对 `%20` 等做 decode。原本已经是一个 motion 一组的，**保留原组名不动**（比如 `mtn_haruhikage01_C%20` 这类不规则名，见 RESEARCH §1.2）。
     - Expressions、Physics、Moc 的路径改为相对路径，并检查文件存在；`Groups` 保留。
     - moc3 文件头必须是 `MOC3`，版本字节 ≥ 5；否则给出 warning："需要 Core 5.x"。
   - 预览确认：返回 `ImportPlan { models[], backgrounds[], conflicts[], skipped[], errors[], fileCount, totalBytes }`。UI 显示文件数、总大小和冲突：id 已存在但 sha256 不同时，让用户选跳过或覆盖，默认跳过。sha256 相同则**增量跳过**。
   - 写入：先写临时目录，再按模型目录原子 rename 到目标位置（Windows 遇 EPERM 时重试，做法同 `labels.ts`）。完成后调用 `catalog.invalidate()` 重建索引。进度通过 SSE 推送（`progress {phase, done, total, bytes}` / `done {report}`）；可以取消，取消时删除临时目录，已完成的模型保留。
   - 用户本机有旧 `manifest.json` 时，可选"用 manifest 校验"：按 `path` 比对 `bytes/sha256`，列出不一致的文件。**manifest 中的 URL 一律不读取。**

4. **存储位置与 ASSET_ROOT**
   - 现有约定：`assetRoot` 只读、不写（见 `server/config.ts` 注释）。新增配置 `libraryRoot`（可写，环境变量 `LIBRARY_ROOT`，默认 `./assets`，已在 gitignore 中），导入只写到这里。
   - 有效根列表为 `[assetRoot, libraryRoot]`（两者相同时去重）。`indexer` 合并两个根的内容；`/assets/*` 按顺序在各根中查找第一个存在的文件，`sendFromRoot` 改为接收多个根，**每个根都要做路径穿越防护**。id 冲突时 assetRoot 优先，并记 warning。
   - 首次使用、还没有任何素材时，`assetRoot` 默认就是 `./assets`，与 `libraryRoot` 相同，即开即用。设置中允许把 `libraryRoot` 改成用户选择的目录：服务端校验可写后写入 `studio.config.json`，并提示需要重启或热更新 catalog。

5. **Cubism Core 本地选择**（不使用第三方镜像）
   - 首页环境检查：Core 加载失败时（`cubismCore.ts` 已经会抛 `CubismCoreError`），卡片上提供两个入口："打开 Live2D 官网下载页"（官方 SDK 页面）和"选择本地 live2dcubismcore.min.js"。
   - `POST /api/core/upload`：校验文件 ≤ 2 MB、文件头含 `Live2D Cubism Core`、包含 `csmGetLatestMocVersion`，通过后写入 `vendor/live2dcubismcore.min.js`（gitignored），由 express 在 `/vendor/` 下静态提供，并把 `cubismCoreUrl` 写入 `studio.config.json`。前端重新加载后，再以 `csmGetLatestMocVersion() >= 5` 做最终校验，失败则回滚配置。**不设哈希白名单**（官方会更新 Core）。
   - 代码和文档中都不得出现 viewer 仓库或其它镜像的 Core URL。

6. **UI**
   - 首页的"环境检查"卡片增加一行"素材库：N 个模型 / M 张背景"，以及"导入素材"和"素材来源"两个入口。素材为空时突出显示导入入口。
   - 设置中新增"素材下载/导入"向导（`web/editor/dialogs/AssetSourcesDialog.tsx`）：
     - 第 1 步，选择来源：本地文件夹 / zip / 内置源列表（Haneoka 标注"默认关闭、仅清单"）。
     - 第 2 步，**免责确认**（仅对有 disclaimer 的源）：全文显示以下内容——素材权利属于 Bushiroad / Craft Egg 等；素材由第三方站点提供；该站条款 §2 禁止未经许可下载再利用；用户需自行确认有权使用并遵守该站条款；本项目不提供、不托管任何素材。滚动到底部后"我已阅读并同意"按钮才可用。记录确认时的版本，文本有改动就要重新确认。
     - 第 3 步，分类选择：乐队 → 角色 → 服装的树形勾选；背景可按类型、乐队、地点筛选。显示所选条目数（导入时再显示文件数和大小）。
     - 第 4 步：Haneoka 显示清单（逐项"在站点打开"链接 + 导入说明）。本地导入依次显示 ImportPlan 预览 → 确认 → 进度条（可取消）→ 报告（导入/跳过/冲突/错误），并提供"在资源浏览器中查看"按钮。
   - 资源浏览器：新导入的条目显示"新"标记（按本次导入报告中的 id 判断）。背景卡片的 P17 标签照常显示。

7. **配置**（同步更新 `studio.config.example.json` 和 README）：`libraryRoot`、`importMaxBytes`、`sources.haneoka.server`（`intl`/`jp`）、`sources.haneoka.locale`。不提供关闭免责确认的配置项。

**P18b（可选，需主会话与用户确认后才做）通用下载引擎**
- `server/assets/download/queue.ts`：输入 `FilePlan[]`，每项必须带 `bytes` 和 `sha256`。
  - 并发：全局默认 2，上限 4。限速：按主机做令牌桶，默认 4 req/s，可另设带宽上限。
  - 断点续传：写 `.part` 文件，续传时发 `Range: bytes=<n>-` 和 `If-Range: <ETag>`；服务端返回 200 时从头重下。
  - 完成后先校验 sha256 再原子 rename。已存在且 sha256 一致的文件增量跳过。
  - 失败处理：指数退避 1/2/4… s（上限 60 s，最多 5 次）；429/503 遵守 `Retry-After`；同一主机连续失败 N 次就熔断，暂停整个任务。
  - 取消用 AbortController，保留 `.part` 以便续传。进度通过 SSE 推送。
- 唯一的适配器是 `http-manifest`：用户填写**自己控制的**清单 URL 或本地清单文件（格式 `{files:[{path,url,bytes,sha256}]}`），清单中的 host 先过拒绝表。下载完成后走与本地导入相同的规范化和索引流程。
- 用户不需要的话就不做。P18a 本身已经完整可用。

**测试**（CI 中**禁止访问任何真实外网**）
- unit：
  - `normalizeModel3.test.ts`：站点格式（绝对纹理路径 + 单一 Motion 组）转成本地格式；保留不规则组名；缺纹理时报错；moc 版本检查。
  - `haneokaAdapter.test.ts`：使用 `tests/fixtures/sources/haneoka/*.json` 中**手写的合成**小样本，只有 3–5 个假 key。覆盖 id 映射、分类、release 固定、ETag 缓存命中；断言 `manualLinks` 中没有 `/runtime/` 或 `/assets/` 直链、适配器没有 `planFiles`。
  - `importPlan.test.ts`：目录和 zip 识别；拒绝 zip-slip、zip 炸弹、符号链接；sha 增量跳过；冲突默认跳过。
  - `sourcesGate.test.ts`：未启用或未确认时返回 403；免责文本版本变化后需要重新确认。
  - `coreUpload.test.ts`：非 Core 文件被拒绝；合法文件写入 vendor 并更新配置。
  - `multiRoot.test.ts`：双根合并、assetRoot 优先、路径穿越防护。
- 如果做 P18b：`downloadQueue.test.ts` 用本地 `http.createServer` 起 mock 服务，模拟 Range、ETag 变化、429 + Retry-After、断连、sha 不符，覆盖并发上限、限速、续传、退避、取消和熔断。
- 网络守卫：在 vitest setup 中包装 `globalThis.fetch`，目标不是 `127.0.0.1`/`localhost` 时直接 throw；仅当 `ALLOW_NET=1` 时放开，CI 不设置。适配器的 fetch 必须可注入，沿用 `AppExtras.fetch`。
- e2e `asset-import.spec.ts`：把 `tests/fixtures/` 中已有的手写合成模型（非游戏素材）打成 zip，通过向导导入到临时 `LIBRARY_ROOT`。检查：资源浏览器中出现并能渲染；背景 id 与 labels 对齐；第二次导入全部跳过；Haneoka 未确认时被拦截，确认后显示清单（通过 fetch 注入 mock fixture）。

**验收**
- 自动化：`npm run test:all` 全绿；`git ls-files` 中没有素材和 Core，也没有新增成段的第三方 URL 列表（只允许 3 个 API 路径常量和站点首页地址）。
- 浏览器（由实施者完成，主会话验收）：
  1. 首页环境检查 → 素材向导 → Haneoka。未确认免责声明时，任何清单请求都返回 403。确认后选择"MyGO!!!!! / 高松灯 / casual_spring_01 + 2 张剧情背景 + 1 张名片背景"生成清单，链接都指向站点页面。整个过程中，对 haneoka.org **只发出不超过 4 个请求**（用 network 面板或服务端日志核对）；再次打开走缓存，请求数为 0。
  2. 本地导入：从用户已有素材（例如当前 `studio.config.json` 指向的旧 ASSET_ROOT）中**复制** 2 个模型目录和 3 张背景，打成 zip，导入到临时 `LIBRARY_ROOT`（例如 `%TEMP%\ons-p18\`）。检查：资源浏览器中能看到；Stage 能渲染其中一个模型并播放 idle；背景标签正确。再导入一次应全部跳过。完成后删除临时目录、恢复配置。
  3. 如果用户愿意从站点手动下载 1 个模型 ZIP（必须用户本人点击，代理不得代劳），就用它跑通"站点 ZIP → 规范化 → 渲染"整条链路，并把 ZIP 的实际目录结构补记到 RESEARCH §7.2。
  4. Core：把 `cubismCoreUrl` 临时改成不可用的地址，首页应给出明确提示；选择本地的官方 Core 文件，重新加载后正常渲染；最后还原配置。
- 截图存为 `.verify/p18-*.png`（不入库）。

**给 Sonnet 的坑点**
1. **不要**写任何从 haneoka.org 下载 `/runtime/` 或 `/assets/` 文件的代码，包括"只是测试一下"的脚本。不要把旧 manifest 中的 URL 读进代码或 fixture。这是使用条款带来的约束，不是技术限制。
2. 站点的 model3.json 是"绝对纹理路径 + 单一 Motion 组"。indexer 只取每组的 `list[0]`，如果不做规范化，只会索引出 1 个动作，而且不会报错。规范化之后，要用 indexer 核对 motion 数与原始条目数相等。
3. 背景有两套 id：数字 id（名片背景的 `backgroundId`）和 `adv_bkg_stage_NNNNNN`（剧情背景的 `assetName`）。**不要**用站点的 `assetId`（形如 `background-<hash>`）作 id，否则 P17 的标签会全部对不上。
4. motion 名可能带尾随空格或 `%20`：例如 004 中组名 `mtn_haruhikage01_C%20` 与文件 `mtn_haruhikage01_C .motion3.json` 同时存在。拆组时以文件 basename 为准，已有的组名不改。Windows 会去掉文件名末尾的空格，写文件前要检查。
5. `assetRoot` 仍然只读，导入只写 `libraryRoot`。多根情况下，`/assets/*` 必须对每个根分别做路径穿越检查。
6. 免责确认的闸门放在**服务端**，确认的版本号写入设置；免责文本一改就同步更新 `disclaimerVersion`。
7. zip 安全要覆盖：zip-slip、zip 炸弹、符号链接、超长路径（Windows 260 字符限制）、仅大小写不同的文件名冲突（Windows 不区分大小写）。
8. Core 上传只按官方文件的特征校验，不要内置任何哈希或第三方 URL。`csmGetLatestMocVersion` 的最终判断在浏览器端完成。
9. 测试 fixture 一律用手写的合成数据（假 key、假路径、几百字节的 JSON），不得把站点的真实索引整份放进仓库。
10. 不要动 5273/5274 上正在运行的 dev server；e2e 使用测试端口 5373/5374。

#### P18 实施备注（2026-10-10，Sonnet）

实际做成的范围与 P18a 原方案的差异：

- **导入目标 = `ASSET_ROOT`**（按用户确认的方案），没有做 `libraryRoot` 与多根合并；可在向导里换目录，写入 `studio.config.json`，重启生效（`ASSET_ROOT` 环境变量优先）。写入走 `<assetRoot>/.import-tmp/<uuid>/` 暂存，再按目录/文件 rename（EPERM/EBUSY 重试），旧版本先移入暂存区的 `_old/`，结束后整体删除。
- **没有适配器注册表 / SSE / `policy` 枚举**。Haneoka 只是 `server/assets/sources/haneoka.ts` 里一个只含只读元数据方法的类（无 `planFiles`、无下载函数，单测断言）；导入是同步请求（扫描 → 预览 → 运行），不做进度推送和取消（扫描阶段的会话 1 小时过期，可 `DELETE /api/import/:id`）。P18b 未做。
- **zip**：新增 MIT 依赖 `yauzl@3.4.0`（+ `pend`），`server/assets/import/zip.ts` 拒绝 zip-slip（含 yauzl 自身的路径检查）、绝对/盘符路径、仅大小写不同的重名、超长路径、超条目数；符号链接跳过；按**实际**解压字节数限流（默认 2 GB，`IMPORT_MAX_BYTES` / `importMaxBytes`）。浏览器上传走 `POST /api/import/upload`（流式写盘，同样封顶）。
- **规范化**（`normalizeModel3.ts`，纯函数）：纹理按 basename 在包内查找（优先同目录/最近目录）并复制到 `textures/`；多条目的 Motions 组（含站点的单一 `Motion` 组）拆成一动作一组、组名 = 文件名去后缀并 decode；单条目的原组名保留；写目标副本。预览里的 `motions` 数就是写出后 indexer 能看到的数量（单测、e2e、浏览器验证都用 indexer 核对：64 = 64）。
- **重复/冲突**：model3.json 按 JSON 规范化后比较 + 逐文件 SHA-256；相同 → `duplicate` 自动跳过，不同 → `conflict` 默认跳过，勾选「覆盖」才替换。背景同理。id 无法识别的模型/背景可在预览表格里手填，`/api/import/plan` 带 `ids` 重新分析。名片背景 `bg_*` 文件名会借助 Haneoka 缓存（若有）反查数字 id。
- **Haneoka 清单**：UA 为 `OpeNotesStudio/<version> (+https://github.com/SKT0tto/OpeNotes-Studio)`；串行 3 个请求，缓存 `data/sources/haneoka/cache.json` 24 h，过期后带 `If-None-Match`。**实测站点的全局接口不接受 `?release=`（400 `invalid_release`，要用带服务器 slug 的路由），所以不做 release 固定**，只记录 `X-Haneoka-Release-Id`。链接只到页面：模型 `/intl/<locale>/live2d/<live2dKey>/`（实测 200，不存在的 key 404）、名片背景 `/intl/<locale>/backgrounds/<id>/`（实测 200）；剧情背景没有验证过的详情页（`/backgrounds/adv_bkg_stage_*` 404），清单链接到 `/intl/<locale>/assets/` 并提示搜索 id。免责闸门在服务端，状态存 `data/setup.local.json`（`SetupStore`），文字改动靠 `HANEOKA_DISCLAIMER_VERSION`。
- **Core**：`server/setup/routes.ts`。获取只用官方 URL（`DEFAULT_CUBISM_CORE_URL`），官方失败给出明确提示并引导选本地文件；两条路径都要先确认许可协议（服务端记录），文件校验头部声明 + `csmGetLatestMocVersion` + 2 MB 上限，写 `vendor/`，设置 `cubismCoreUrl=/vendor/live2dcubismcore.min.js`；浏览器随后真实加载并检查 moc ≥ 5，失败自动 `reset` 回官方地址。新增 `/vendor` 静态路由（vite 代理同步）。
- **向导**：`web/setup/`。三步（Core → 素材 → AI），每步有状态；首页环境检查卡片改为真实探测 Core，并提供「配置向导 / 导入素材 / 获取 Core」入口；素材库为空（或 assetRoot 不可用）时，App 直接进入独立向导，完成前不跳走，方便看导入报告。
- **新增环境变量**（主要为测试隔离）：`STUDIO_CONFIG_FILE`、`VENDOR_DIR`、`SETUP_FILE`、`HANEOKA_BASE_URL`（e2e 指向本地 mock）、`IMPORT_MAX_BYTES`。
- **未复用任何第三方代码**：没有复制 haneoka（MPL-2.0）或 altair-plugin-haneoka（GitHub 标 NOASSERTION，未核实许可证）的任何文件，规范化思路只来自对站点 model3.json 的观察（见 RESEARCH §7.2）；THIRD_PARTY.md 已写明。
- **测试**：unit +30（`normalizeModel3` / `importPlan` / `sources`，网络全部走 mock fetch 或本地假服务）；e2e `asset-import.spec.ts` 使用独立的"首次运行"服务器（5375/5376，空素材库 + 隔离的配置/vendor/setup 文件）和本地 mock（5377），不碰 5273/5274。
- **浏览器验收**（临时目录 `D:\ons-p18`，已删除）：从本地素材库复制 1 个模型 + 2 张背景，改造成站点原始结构（绝对纹理路径 + 单一 Motion 组，64 个动作 / 32 个表情）→ 向导导入 → 报告 64 / 32 一致；Actor Lab 渲染并播放待机；再次扫描全部 duplicate；Core 勾选许可后从官方获取 207,155 B 并以本地副本加载；Haneoka 免责 → 真实索引（247 个模型 / 349 张背景，对 haneoka.org 共 3 次成功请求 + 1 次因 `?release=` 失败的请求）→ 勾选并生成清单。截图在 `.verify/p18-*.png`。
- **整包素材包（追加）**：native layout（`models/ backgrounds/ media/ manifest.json`，在 zip 根或唯一外包目录下）无需规范化直接导入；`media/` 与 `manifest.json` 一并导入（相同跳过，不同默认跳过）。可选 `openotes-pack.json`（`shared/schema/pack.ts`：format/version/generatedAt/generator?/counts/totalBytes/files?[{path,bytes,sha256}]），存在时校验数量、大小与 SHA-256，失败则 `run` 拒绝。导入改为后台任务：`scan|upload|plan|run` 返回 `jobId`，`GET /api/import/jobs/:id` 轮询进度（解压/校验/写入），`DELETE` 取消（逐文件检查中止信号，取消的扫描会删除临时目录）。yauzl 流式解压（支持 ZIP64），上限默认 16 GB。`npm run pack-assets -- --out <zip>`（`scripts/pack-assets.ts`、`server/assets/pack.ts`，yazl，惰性逐个打开文件，输出禁止在仓库内）。
- **遗留**：站点 ZIP 的真实包内结构尚未由人手动下载确认（RESEARCH §7.2 待补）；规范化对未知包结构按 basename 查找，已覆盖常见情形但未用真实站点包验证；`.zip` 解压整体落盘后再扫描，超大包占用临时磁盘（data/import-tmp，会话过期或导入完成后删除）。

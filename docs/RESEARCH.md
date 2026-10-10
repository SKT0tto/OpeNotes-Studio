# RESEARCH — 对编码有用的事实（2026-10-09 调研）

> 本文只记事实与结论。所有"已验证"均为本次实际读取文件/运行命令得到；"待验证"必须由编码阶段在浏览器中确认。

## 1. 外部素材库（只读）

路径（下称 `ASSET_ROOT`）：
`<ASSET_ROOT>`

| 目录 | 内容 | 体积 |
|---|---|---|
| `models/` | 241 个模型目录 | 2.8 GB |
| `backgrounds/` | 341 张 PNG，文件名 `<id>.png`（id 为数字字符串） | 613 MB |
| `media/` | 仅 1 个文件 `millsage-blessing.wav`（12 MB，疑似乐曲） | 12 MB |
| `manifest.json` | 旧项目生成的元数据（6.4 MB），见 §1.4 | |

**没有语音、没有音效（SE）、没有 BGM 库。** 音频功能必须支持用户自行导入外部音频目录；AI 只能从真实存在的音频 ID 中选，库为空时不得编造。口型用"伪口型"（按文本显示驱动 `ParamMouthOpenY`，与原作无语音时的行为一致）。

### 1.1 模型目录命名
`<characterKey>_<costume>[_<variant>]`，例：
- `001_casual_spring_01`、`002_casual_spring_01_glasses`、`002_roomwear_01`、`001_school_winter_hs_1st`、`004_school_winter_jhs`
- `001_live_01`（剧情演出服，adv 模式，有完整 motion/expression）
- `001_live-mode_live_01`（**演奏形态**：9 个 motion `mtn_idle_01/mtn_action_01/mtn_finish_01/mtn_play01_01..03/mtn_play02_01..03`，**0 个表情**，无 physics）
- `*_low`：低画质副本（26 个），AI 不应选择，编辑器默认隐藏
- `sub_<name>_<costume>[_still]`：NPC（39 个）；`_still` 只有 1 个 motion（`mtn_idle01_C`），无表情
- characterKey 001–025 = 25 名乐队成员；`sub_*` = 配角

统计：mode adv 189 / live 52；quality "" 215 / low 26；58 个模型没有 physics3.json。

### 1.2 model3.json（Cubism 3+ 格式，Version 3）
```
FileReferences: { Moc: "model.moc3", Textures: ["textures/texture_00--Texture2D-<n>.png", ...],
                  Physics: "physics3.json"(可缺), Expressions: [{Name, File}], Motions: { "<motionName>": [{File, FadeInTime, FadeOutTime}] } }
Groups: [ {Name:"EyeBlink", Ids:["ParamEyeLOpen","ParamEyeROpen"]}, {Name:"LipSync", Ids:["ParamMouthOpenY"]} ]
```
- **每个 motion 是一个独立的 group**（group 名 = motion 名，各含 1 个条目），没有 "Idle" 组。播放时 `model.motion(name, 0)`。
- 无 HitAreas、无 Layout。纹理 2048×2048，一般 2 张/模型（≈32 MB 显存/模型）。
- **moc3 文件头 `MOC3` + 版本字节 `05`** → moc3 v5 = Cubism 5.0，**必须使用 Cubism Core 5.x**（旧 Core 4 无法加载）。
- 模型是**全身立绘**（preview 显示头到鞋），上半身/特写构图需要靠相机裁切实现，不得裁切模型本身。
- 命名有不规则项：`mtn_haruhikage01_C `（**名字末尾带空格**）、`mtn_check01_R2`、`mtn_look02_R_omit`、`mtn_play02_03_old`、`mtn_ide01`、`mtn_forget`、一些 `exp_*` 名的 motion。**索引必须以 model3.json 为唯一事实来源**，不要靠目录列表或正则猜测；解析 family/variant 时保留原始名。

### 1.3 动作与表情
- 常见 motion family（出现次数）：`mtn_idle01`、`angry01`、`smile01/02`、`check01`、`cry01`、`denial01/02`、`nod01/02`、`sad01`、`thinking01`、`kime01`、`question01`、`serious01`、`surprised01`、`bye01`、`look01/02`、`nervous01`、`join01`、`note01`、`sing01`、`maskoff01`（Ave Mujica 摘面具）、`misc_tear01` 等。几乎都有 `_L/_C/_R` 三个变体。
- 常见表情：`exp_idle01..05`、`smile01..07`、`bsmile01..06`、`surprised01..05`、`sad01..07`、`angry01..06`、`cry01..07`、`kime01..03`、`pale01..03`、`shadow01/02`、`shy01..04`、`serious01..03`、`thinking01..03`、`kirakira01`、`panic01/02`、`heart01`、`question01/02`、`upset01/02`、`jitome01` 等。**每套服装的可用集合不同**，必须按模型校验。
- motion3.json：30 fps，`Meta.Loop=false`，idle 约 6 s。曲线包含 `ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`、`ParamEyeBallX/Y`、`ParamEyeLOpen/ROpen`、`ParamBreath`、`ParamBodyPositionX`、手臂/手指参数等。
- **关键事实：motion 在曲线里写入了绝对朝向。** `mtn_idle01_L` 首帧 `ParamAngleX≈+22, ParamBodyAngleX≈+10`；`_C` ≈ 0；`_R` ≈ −22 / −10（001、005 实测）。旧项目对 7 个模型截图验证："`_L` 朝画面右，`_R` 朝画面左"——**本项目须对每个模型重新验证（见 PLAN P4），不能从文件名推导**。
- 参数（001 实测，来自旧项目 Core 读取）：`ParamAngleX [-30,30]`、`ParamBodyAngleX [-10,10]`、`ParamEyeBallX/Y [-1,1]`、`ParamEyeLOpen/ROpen [0,1.5]`。另有 `ParamAngleXPlus15/Minus15`（可能是额外转头修正层），特定模型存在 `ParamNote*` 等。
- 表情 exp3.json：`FadeInTime 0.5 / FadeOutTime 1`，参数 Blend 有 Multiply / Add。

### 1.4 manifest.json（旧项目产物，可作为**可选**元数据来源）
顶层：`source, fetchedAt, catalog, models[241], backgrounds[341], files[16751]`。
- `models[i]`：`id, name(中文名), nickname, characterKey, characterId, bandId, bandName, color(#hex), costume, mode(adv|live), quality(""|low), subCharacter, aliases[多语言], url, preview, motions[], motionCounts, expressions[], source`。
- `backgrounds[i]`：`id, name, aliases, kind(scene 293 | insert 35 | decorative 13), assetName(bg_adv_xxxx), location, category, setting(室内/室外/抽象/屏幕), time(日间/夜间/傍晚/未指定), weather, description(人工描述), tags, width, height, url`。尺寸：312 张 2048×1119，28 张 1600×900，1 张 256×256。
- `files[]` 中有 `vendor/live2dcubismcore.min.js` 记录，但 Core **不在** ASSET_ROOT，且不得入库。
- 设计要求：索引器在 manifest 缺失时也必须能工作（只靠扫描目录），manifest 存在时合并其中的人名/乐队/背景描述。

### 1.5 角色 → 乐队/职位（manifest + 旧项目 character-roles.json）
| key 角色 | 乐队 | 职位 |
|---|---|---|
| 001 高松灯 | MyGO!!!!! | Vo. |
| 002 千早爱音 | MyGO!!!!! | Gt. |
| 003 要乐奈 | MyGO!!!!! | Gt. |
| 004 长崎爽世 | MyGO!!!!! | Ba. |
| 005 椎名立希 | MyGO!!!!! | Dr. |
| 006 三角初华（Doloris） | Ave Mujica | Gt.&Vo. |
| 007 若叶睦（Mortis） | Ave Mujica | Gt. |
| 008 八幡海铃（Timoris） | Ave Mujica | Ba. |
| 009 祐天寺若麦（Amoris） | Ave Mujica | Dr. |
| 010 丰川祥子（Oblivionis） | Ave Mujica | Key. |
| 011 仲町阿拉蕾 | 梦限大MewType | Vo. |
| 012 宫永野乃花 | 梦限大MewType | Gt. |
| 013 峰月律 | 梦限大MewType | Gt. |
| 014 藤都子 | 梦限大MewType | Key. |
| 015 千石由乃 | 梦限大MewType | DJ&Mp. |
| 016 汐见萤 | millsage | Key.&Vo. |
| 017 伊泽枣 | millsage | Gt. |
| 018 琴平凪 | millsage | Gt. |
| 019 滨崎茉幌 | millsage | Ba. |
| 020 和泉朋花 | millsage | Dr. |
| 021 须贺蕾叶 | 一家Dumb Rock! | Gt.&Vo. |
| 022 马桥心玖 | 一家Dumb Rock! | Gt.&Vo. |
| 023 矢仓蓬咲 | 一家Dumb Rock! | Ba. |
| 024 梅里千樱梨 | 一家Dumb Rock! | Dr. |
| 025 四宫宁月 | 一家Dumb Rock! | Key. |

NPC（sub_*）：koharu, kanata, mana, mortis（若叶睦的另一人格 Mortis，含 live/mask/silhouette 变体）, a_ko, bota, katsuura, viola, kiyotsugu, logout, bell, mikus_father/mother, marukun, mizuho, minami, raikas_fathers_secretary, raki, raikas_grandmother, shifune, sadaharu, substitute, shizukus_maid, utami, popo, ririko, yumemita_manager。manifest 中这些只有罗马字名。
> 该表是公开作品设定事实，可写入仓库的 `shared/data/characters.json`；**不是**游戏素材。成员名中文写法以 manifest 为准，编码代理不得自行"纠正"。

## 2. empty-sekai/ournotes-player

- 审计提交：`a24c6fddbeb4bf546efc9b2d0a557e463fd36d44`，npm `ournotes-player@0.1.6`。
- **许可证：AGPL-3.0-only** + LICENSE-EXCEPTION：仅允许"在浏览器中加载未修改的 npm `dist/` 构建并与自己的前端代码链接"而不传染；修改或在 Node 中运行则完全适用 AGPL。
- **结论：不复制其任何源码**（包括数值常量表之外的实现）。只参考其文档描述的原作行为语义，自行实现。
- **不能直接用它播放我们的素材**：它需要 nnnotes 导出的 Unity prefab（`model.json` format 2 + `model.prefab.json`、游戏 GLSL、stage/scene、episode 指令）。旧项目实测：喂 model3.json 报 `format undefined is not supported`；改成 format 2 后报 `asset not found: model.prefab.json`。我们只有标准 Cubism 文件 → 必须自研演出引擎。
- 可借鉴的**原作演出语义**（来自其 docs/源码注释，均为对游戏行为的描述）：
  - ADV 帧率 30 fps；原作 ADV 相机视口 **13:6**（我们默认 16:9，可选 13:6 作为后续选项）。
  - 角色槽位 `PositionType` 1/3/5/7/9（5 个横向槽）；命令集：In/Out（整体合成后淡入淡出）、Talk、Motion、Expression、Look、LookTarget、Angle、Focus、Zoom、PanV2、Track、MoveToDirection、FadeIn/FadeOut、Costume、EyeBlink、Bgm/Se、Stage、Pedestal、Shake、Dof、Brightness 等。
  - **Angle**：头部角度与身体角度是**加性覆盖**（additive override），按 Duration 用 InOutQuad 缓动，可 DelaySeconds 延迟；新旋转会先取消正在进行的旋转。
  - **Look**：眼球 (x,y) ∈ [-1,1]，SmoothChangeToLook 用 InOutSine；"stop" 回到原始视线。
  - **LookTarget**：x = clamp((目标头部.x − 自身头部.x) × 0.2, −1, 1)，y = clamp(目标头部.y − 自身头部.y)，基于**世界坐标头部位置**（不是相机后的屏幕坐标）→ 相机移动不改变朝向关系。
  - **Focus**：相机移到槽位/角色头部高度，按 CameraDistance 0..6 设缩放与背景模糊（模糊半径表 `[0.75, 2.25, 3.75, 5.5, 7.75, 9.75, 12.0]`）——**即"景深等级 0–6"**，可作为我们镜头 `dof` 字段的取值域。
  - 角色 In/Out 是对**整个角色合成结果**做透明度（per-slot alpha in field renderer composite），不是逐网格 alpha——这正是避免"暴露错误图层/残影"的关键。
  - 换装（Costume）：预加载后替换。
  - 无语音时：台词按文本长度推进，说话者嘴型跟随文本（伪口型）。

## 3. Live2D 渲染栈

### 3.1 Cubism Core（闭源）
- 官方 CDN（已验证 HTTP 200，`Access-Control-Allow-Origin: *`）：
  `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`
  文件头注明属于 Live2D Proprietary Software License 的 "Redistributable Code"。
- 策略：**运行时从官方 CDN `<script>` 加载**；支持配置项 `CUBISM_CORE_URL` 指向用户自备的本地副本（放在 gitignored 的 `vendor/`）。**仓库中不得包含该文件**。
- 加载后必须检查 `Live2DCubismCore.Version.csmGetLatestMocVersion() >= 5`，否则给出明确错误（moc3 v5 需要 Core 5.x）。
- 离线时 CDN 不可用 → UI 给出清晰提示及本地文件配置方法，不得静默失败。

### 3.2 渲染库选择：`untitled-pixi-live2d-engine@1.4.0`（MIT）
- npm 已验证：license MIT，peer `pixi.js ^8.13.1`（当前 pixi.js 8.22.0）、`@pixi/sound ^6`（可选，仅口型/动作音频用）。支持 Cubism 2–5，PixiJS v8 原生 Render Pipe，支持 Filter / RenderTexture / zIndex、并行动作、末帧冻结、纹理 LOD、高精度遮罩自动检测、`configureCubismSDK({ memorySizeMB })`。
- 入口：`import { Live2DModel, Live2DPlugin, configureCubismSDK } from 'untitled-pixi-live2d-engine/cubism'`（只用 Modern 运行时），`extensions.add(Live2DPlugin)`。
- 旧项目已用它成功加载全部 241 模型（旧 THIRD_PARTY 记录），可信。
- 备选 `pixi-live2d-display@0.4.0` 只支持 Pixi v6 + Cubism 4，**不要用**。

### 3.3 该引擎每帧更新顺序（读 dist/cubism.es.js 确认）
```
InternalModel.update(dt, now):
  updateMotions()            // emit beforeMotionUpdate → motionManager.update → emit afterMotionUpdate
  model.saveParameters()     // 保存"动作后"的参数
  expressionManager.update()
  eyeBlink（仅当无动作更新时）
  updateFocus()              // 内置焦点：AngleX += fx*30, AngleY += fy*30, BodyAngleX += fx*10, EyeBall += f
  updateNaturalMovements()   // breath
  lipSync（仅有音频时）
  physics.evaluate()
  pose.updateParameters()
  emit beforeModelUpdate
  model.update()
  model.loadParameters()     // 恢复到 saveParameters 时的值 → 之后加的值不会跨帧累积
```
**朝向覆盖的正确注入点**：在 `saveParameters()` 之后、`physics.evaluate()` 之前（例如替换实例上的 `updateFocus` 或包装 `updateNaturalMovements`），用 `addParameterValueById` 加上我们的头/身/眼偏移。理由：(1) 物理（头发摆动）能响应转头；(2) 由于末尾 `loadParameters()`，偏移不会跨帧累积。
**不要**在 `afterMotionUpdate` 里加（会被 saveParameters 保存，动作淡入淡出时累积漂移）；**不要**在 `beforeModelUpdate` 里加（物理不响应）。同时关闭内置焦点/鼠标跟随（`autoFocus/autoInteract=false` 或把 focusController 置零）。具体 API 名以安装版本 d.ts 为准，编码时先读类型定义。

### 3.4 其它渲染要点
- 禁止 `scale.x < 0` 水平翻转；朝向只能通过 motion 变体 + 参数加性偏移实现（需求硬约束，加自动化断言）。
- 角色整体透明度：在角色 Container 上用 `AlphaFilter`（离屏合成后再乘 alpha），**不要**设模型 alpha（逐网格半透明会露出内部重叠图层，旧项目踩过）。
- 换装：先加载新模型、预热 1–2 帧，再原子替换，复制朝向/位置/表情状态，避免空帧和闪烁。
- 背景 2048×1119（≈1.83:1）比 16:9 略宽；相机推拉/平移需夹紧，任何时刻视口都被背景覆盖（不露边）。

## 4. 旧尝试中值得保留的经验（只取结论，不搬架构）

旧项目（React + Pixi8 + untitled engine + Express，`早期原型项目`）文档 FRAMING/STAGING/CINEMATIC 的教训：
1. 背景与人物必须分层、独立缩放；否则特写时背景一起被放大。
2. 远景人物要按**模型底部/虚拟接地点**定位，按纵深计算比例；只对齐头部会导致"浮空"。
3. 模型按"头部单位"归一化比例（各模型画布留白不同，直接用画布高度会大小不一），校准倍率限制在 0.75–1.3。
4. 头部位置测量：在加载时用参数响应探测（例如扫 `ParamAngleX`/`ParamEyeBallY` 观察哪些 drawable 顶点移动）得到头部包围盒，探测后恢复参数。
5. 相机平移/缩放不得改变人物世界坐标和对话朝向关系；拖拽需先做相机逆变换。
6. "_L 朝画面右、_R 朝画面左"在 7 个模型上截图验证；朝向符号需逐模型校准并持久化。
7. 加性偏移不得每帧累积到持久基线；同一 motion 不应因切换台词被重播。
8. 锁定合并必须在服务端于 AI 返回后**再做一次**，不能依赖 AI 遵守提示。
9. Windows Edge 实测可运行 WebGL（D3D11）。
10. 正式演奏需区分 `mode=live`（`live-mode` 演奏形态）与 `*_live_01`（剧情演出服）；后者不带乐器。

## 5. LLM 接入事实

### 5.1 Claude（`@anthropic-ai/sdk`）
- 用户指定默认模型 `claude-sonnet-5-5`（有效 ID，1M 上下文，128K 输出）。模型名可在设置中改。
- 结构化输出：`client.messages.parse({ model, max_tokens, messages, output_config: { format: zodOutputFormat(schema) } })`，`import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'`；结果在 `response.parsed_output`（失败为 null，必须判空）。旧参数 `output_format` 已弃用。
- JSON Schema 限制：不支持递归 schema、`minLength/maxLength` 等字符串约束（SDK 会剥离并在客户端校验）。
- Sonnet 5.5 注意：**不支持强制 `tool_choice: any/tool`（400）**；**不支持非默认 temperature/top_p（400）**；`thinking: {type:"disabled"}` 会 400（默认自适应思考即可，不传 thinking）；可用 `output_config.effort`（low..max，默认 high）。不支持 assistant prefill。
- 长输出用流式：`client.messages.stream(...).finalMessage()`；非流式 `max_tokens` ≈16000 以内。
- 先检查 `stop_reason`：`max_tokens`（截断，需拆小批次重试）、`refusal`（明确报错）。
- 提示缓存：把稳定内容（系统提示 + 排序后的素材目录 JSON）放在前面并加 `cache_control: {type:"ephemeral"}`；可变内容（场景文本）放后面；用 `usage.cache_read_input_tokens` 验证命中。
- 错误处理用 SDK 的类型化异常（`Anthropic.RateLimitError` 等），SDK 默认重试 2 次。

### 5.2 OpenAI 兼容（含 LM Studio）
- `POST {baseURL}/chat/completions`，`response_format: { type: "json_schema", json_schema: { name, schema, strict: true } }`；若服务端拒绝（400），降级为 `{type:"json_object"}`，再降级为纯文本 + 从文本提取首个 JSON 块。LM Studio 默认 `http://localhost:1234/v1`，无需 key。
- 本地模型上下文小：目录必须可裁剪（按场景只给相关角色的服装/动作，背景先做候选筛选）。

## 6. 许可与仓库卫生
- 仓库只含自写代码 + 公开设定事实数据（角色/乐队/职位表）。
- `.gitignore` 必须排除：`data/`、`vendor/`、`.env*`（保留 `.env.example`）、`*.local.json`、`node_modules/`、`dist/`、`test-results/`、`playwright-report/`，以及任何 `assets/`、`*.moc3`、`*.motion3.json`、`*.exp3.json`、`*.physics3.json`、`*.model3.json`、`textures/` 兜底模式。
- 第三方：pixi.js（MIT）、untitled-pixi-live2d-engine（MIT，内含 Cubism Framework 部分适用 Live2D Open Software License）、Cubism Core（专有，运行时加载）。写入 `THIRD_PARTY.md`。
- ournotes-player（AGPL）：仅参考文档语义，不复制代码，不打包。

## 7. 素材源调研（2026-10-10，为 P18 准备）

> 访问方式：只用 `curl`/WebFetch 读取了少量页面，UA 为 `OpeNotesStudio-research`，每两次请求之间间隔约 2 s。共读取 robots.txt、首页、/en/terms/、/en/about/、/intl/en/live2d/、docs.haneoka.org 的 6 个页面、4 个 JSON 索引，另外 GET 了 1 个 model3.json（8 KB），HEAD 了 1 张背景图。没有批量抓取，也没有下载任何模型二进制、纹理或背景图。Core 的两份副本只是为了比对哈希临时下载，比对完已删除。

### 7.1 结论先行
| 问题 | 结论 |
|---|---|
| robots.txt | `User-agent: * / Allow: /`，带 Sitemap。文件里有 Cloudflare 的 content-signal 说明模板，但**没有声明任何 signal**（`search` / `ai-input` / `ai-train` 都未设置）。也就是说，robots **不限制**自动访问。 |
| 使用条款（/en/terms/，2026-09-27 生效） | **§2 明确禁止为再利用而下载素材**，原文大意是：除非权利人或适用法律明确允许，否则不得下载素材用于再利用、复制、再发布、改编、分发、商用、放进模型或数据集，或以其他方式利用。§2 还禁止"批量重新打包（bulk repackaging）"。§7 只禁止"给服务造成负担的规模"的抓取/自动化，以及绕过限速或 robots；对"有文档的公开接口"允许在其声明的限制内合理使用。§4 规定服务的使用许可仅限个人、非商业、合法用途。 |
| API 文档（docs.haneoka.org） | 公开读接口免 key，没有按客户端设的限速，要求"从服务端调用时用描述性 User-Agent"、遵守 ETag/Cache-Control，并写明 "do not mirror media in bulk without pinning a release"。还写明 "Game assets and text belong to their respective rights holders"，以及 API "exists to support fan tools and community projects"。 |
| **综合判断** | **自动访问本身没有被禁止**（只要不造成负担、遵守接口限制），**但下载素材拿来再利用是被明确禁止的，除非权利人或法律另有许可**。OpeNotes Studio 下载素材的唯一目的就是用它做演出，属于再利用或改编。所以按主会话的约束 3：**不实现从 Haneoka 自动下载素材文件**。Haneoka 适配器降级为"只读公开元数据并生成清单，由用户在站点上自己手动下载，再用本地导入"。站点自带的 Live2D 查看器有"Download model ZIP"按钮，背景页也能直接看图，用户可以自己决定是否下载、怎么下载，责任也在用户自己。 |

### 7.2 站点结构（事实）
- 站点用 Astro + Cloudflare Workers/R2 构建，代码以 MPL-2.0 开源（`github.com/haneoka-gakuen/haneoka`）。服务器 slug：`intl`（默认）、`jp`；`intl-cbt` / `jp-cbt` 只做历史保留。权威列表在 `GET /api/v1/releases`。
- **发布与固定（pinning）**：每个服务端响应都带 `X-Haneoka-Release-Id: r-<20 hex>` 和 `X-Haneoka-Source-Id`。本次实测值为 `r-aa183ad61d076695052e` 和 `v56-e9f2…`；旧 manifest 中是 `v50-…`，说明素材已经更新过。加上 `?release=r-…` 后，响应变成 `Cache-Control: public, max-age=31536000, immutable`，不固定时是 `max-age=0, must-revalidate`。检测是否有新版本：`HEAD /api/v1/servers/{server}/release?projection=identity`。
- **媒体**：`GET|HEAD /{tree}/{server}/{path}`。`tree=assets` 是 Unity 导出（路径以 `Assets/` 开头），`tree=runtime` 是解码后的 Live2D、音视频等。所有响应都带 `ETag`、`Accept-Ranges: bytes`、`Access-Control-Allow-Origin: *`，单个 Range 返回 206。文档要求"按 API 给出的路径原样请求，不要自行拼路径"。
- **Live2D 索引**：`GET /api/v1/live2d`（336 KB，247 项），以 `live2dKey` 为键，例如 `001_casual_spring_01`、`001_live-mode_live_01`、`*_low`、`sub_*`。**`live2dKey` 与本项目的 model id（目录名）一一对应**：旧 manifest 的 241 个 id 都能在索引里找到，索引另外新增了 6 个（`018_child_casual_spring_01`、`019_child_…`、`sub_itsuki_*` ×3、`sub_kanata_child_…`）。字段包括 `characterKey/characterId/bandId/costumeId/label/mode/quality/subCharacter/characterName[5 语言]/nickname/mocSourcePath/preview.runtime（预览图路径）/preview.sha256`。**索引里没有逐文件列表和文件大小。**
- **模型文件**：`/runtime/{server}/live2d/{key}/model3.json`、`model.moc3`、`physics3.json`（58 个模型没有）、`motions/*.motion3.json`、`expressions/*.exp3.json`；预览图在 `/runtime/{server}/previews/live2d/{key}.png`。纹理不在模型目录下，路径为 `/runtime/{server}/unity/Assets/AddressableResources/Character/Live2D/<dir>/<prefab>/model/<prefab>.prefab/texture_0N--Texture2D-<n>.png`。
- **站点上的 model3.json 与本项目所需格式不同**（实测 001_casual_spring_01）：① `Textures` 是**以 `/runtime/...` 开头的站点绝对路径**；② `Motions` **只有一个组 `"Motion"`**，64 个动作都放在这一个组里。本项目的 ASSET_ROOT 版本（旧项目重写过）是 `textures/<basename>` 相对路径，并且**每个 motion 单独一组、组名等于 motion 名**。`server/assets/indexer.ts` 只取每组的 `list[0]`，直接用站点原版会被索引成 1 个 motion。**导入时必须规范化**（见 P18）。
- **剧情背景**：`GET /api/v1/story-assets/views/backgrounds`（157 KB，现有 321 项），字段为 `assetId(background-<hash>)/assetName(adv_bkg_stage_NNNNNN)/url(/assets/intl/Assets/AddressableResources/Adv/Stage/<name>/data/<name>.png)`。**本项目的背景 id = `assetName`**，旧 manifest 和 `asset-labels/backgrounds.json` 都用 `adv_bkg_stage_000001` 这种 id，313 个全部对得上；站点新增的 8 个在本项目里没有标签，会按 `unknown` 处理。
- **名片背景**：`GET /api/v1/backgrounds`（17 KB，28 项），键是数字 `backgroundId`，字段为 `image(/assets/intl/Assets/AddressableResources/Image/Background/bg_*.png)/thumbnail/name[5 语言]/description`。**本项目的数字背景 id（1–28）= `backgroundId`**，28 个全部能对上，例如 `14 → bg_adv_0101`。
- 目录总表：`GET /api/v1/servers/{server}/catalog`（55 KB，48 个 resource，含 `live2d`、`backgrounds`、`story-assets` 等）。
- 体积（来自旧 manifest）：241 个模型共约 2.9 GB，单个模型最小 0.15 MB、中位 11.8 MB、最大 49 MB；文件 16,409 个。341 张背景约 642 MB（2048×1119 的约 1.7–2.2 MB/张）。
- 样例验证：`HEAD /assets/intl/…/Background/bg_adv_0101.png` 返回 200、`image/png`、`Content-Length: 2188669`，与旧 manifest 记录的 `bytes` 一致。

### 7.3 旧 manifest.json 能不能直接当下载清单
- 结构：`files[16751]`，每项 `{path, url, bytes, sha256}`，字段齐全；共 3.58 GB。其中 16,750 个 url 指向 haneoka.org，另有 1 个指向 GitHub 上的 Core 副本。`models[].source` 记录了站点 model3.json 的地址（**model3.json 本身不在 `files` 里**，旧项目是自己重写后生成的）。
- **不能也不应该作为仓库内置清单**：① 体积 6.4 MB，且固化了 1.6 万个第三方 URL；② 绑定的是旧 release（v50），当前已经是 v56，sha256 会逐渐对不上；③ 按 7.1 的结论本来就不做自动下载。
- 可以利用的地方：用户本机已有旧 manifest 时，P18 的"本地导入"可以用它的 `path/bytes/sha256` 对已有文件做**完整性校验**，并合并中文名、背景描述（indexer 已经支持读 manifest 元数据）。**其中的 URL 一律不使用。**

### 7.4 Cubism Core 来源
- `haneoka-gakuen/bangdream-live2d-viewer`：应用代码采用 **MIT** 许可（`LICENSE`，2026 年，作者署名 bangdream-live2d-viewer contributors）。README 写明该许可**不覆盖** BanG Dream! 的角色、模型素材和商标，并且不得商用。素材来自私有 Cloudflare R2（Bestdori 风格的 `live2d/chara/*/buildData.asset` 布局），README 提醒公开部署时 API 路由也是公开的。
- 它的 Core 是**仓库内直接放了一份副本**：`public/live2dcubismcore.min.js`，206,678 B，sha256 `944988f1…8004`，2025-05-09 随 Initial commit 加入，之后没有更新。文件头注明 "(C) 2019 Live2D Inc." 并引用 Live2D Proprietary Software License 的 "Redistributable Code"。**MIT 许可不覆盖这个文件**，它的再分发是否合规取决于 Live2D 的协议（Redistributable Code 允许随"应用"分发，但是否适用于这类再托管，本项目不做判断）。这个副本与官方 CDN 当前版本**不是同一个文件**：官方为 207,155 B，sha256 `25ae938c…792f`，即 viewer 用的是较旧的版本。
- 旧 manifest 里 `vendor/live2dcubismcore.min.js` 的 url 正指向这份 GitHub 副本，是旧项目留下的做法。
- **结论**：P18 **不从** viewer 仓库或任何第三方镜像获取 Core。维持现有策略：`DEFAULT_CUBISM_CORE_URL` 使用官方 CDN（`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`，200，CORS `*`）。官方不可用时，引导用户从 Live2D 官网下载 Cubism SDK for Web，然后在 UI 中选择本地 `live2dcubismcore.min.js`：复制到 gitignored 的 `vendor/` 并写入 `cubismCoreUrl`。同时**校验文件头和 `csmGetLatestMocVersion() >= 5`**，不做哈希白名单，因为官方会更新。

### 7.5 风险
1. **法律/条款风险（最高）**：即使只"生成清单"，也等于为一个条款禁止再利用的素材站提供便捷入口。对策：Haneoka 适配器默认关闭；首次使用必须阅读并确认免责声明（素材权利归 Bushiroad / Craft Egg 等，第三方站点条款 §2 禁止未经许可下载再利用，用户自行确认有权使用）；清单只链接到站点的**页面**（查看器/背景页），不输出可批量下载的直链列表，不提供"复制全部链接"。
2. **站点变动**：API、路径和 release 都可能变化（条款 §12）。适配器把所有路径和字段解析集中在一个文件，用 zod 宽松解析，失败时降级为"打开站点首页"，不影响本地导入。
3. **格式差异**：站点的 model3.json 和 ZIP 与本项目布局不同（7.2）。导入器负责规范化；站点"Download model ZIP"的包内结构**待验证**，需要由人在浏览器中手动下载一个确认，不允许自动化下载。
4. **id 漂移**：新 release 会新增或修改 id（Live2D +6，剧情背景 +8）。新 id 在标签里属于 unknown，标签中有、素材里没有的 id 已经会被记为 warning（P17）。
5. **本文 §1 更正**：§1 中"背景文件名为数字 id"的说法不准确。实际 341 张里只有 28 张是数字 id（名片背景），313 张是 `adv_bkg_stage_NNNNNN`。以本节为准。

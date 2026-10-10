# 验收记录

## 第一次验收 P0–P7

- 日期：2026-10-09；验收人：Opus（PLAN.md 作者）；基线提交 `cd3c04e`。
- 结论：**有条件通过**。P0–P7 的交付物与自动化验收全部成立，可以进入后续阶段；但下列"必须修复项" M1–M5 须作为 **P7.1** 在 P8 功能开发前完成（已写入 PLAN.md）。

### 1. 自动化结果（本机实跑）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过（0 告警） |
| `npm test`（unit） | 14 文件 / 125 用例 通过 |
| `npm run test:integration`（真实 ASSET_ROOT，无 skip） | 3 文件 / 14 用例 通过 |
| `npm run test:e2e`（Edge） | 25 / 25 通过（3.0 min） |
| 浏览器 console error（资源浏览器、两个 lab、/play/demo 全程含 seek 与播放） | 0 |

截图：`.verify/accept1-*.png`（采集脚本 `.verify/accept1.mjs`，均 gitignored）。`seek-NN-<beat>` 为每个 beat 中点的 seek 画面；`trans1-*`（crossfade）/`trans2-*`（wipe）为顺序播放穿过转场的连续帧；`play-*` 为从头播放约每 2 s 一帧；`seek-into-trans1` 为直接 seek 进转场。

### 2. 通过项

- **仓库卫生**：`git ls-files` 共 133 个文件，无游戏素材与 Cubism Core；`tests/fixtures/fake-assets` 均为手写的合成文件（moc3 只有 4 字节魔数、纹理 4×4、背景 PNG 只有伪造的文件头）。无调试残留（仅服务端启动日志用 `console.log`）；`window.__studio` 只在 `import.meta.env.DEV` 下注册。
- **无假功能**：`/play/:id` 遇到非 demo 的 id 会明确说明"项目存储（P8）尚未实现"；schema 没有放入没有实现的 `background`/`flash` 通道；没有占位按钮。
- **朝向覆盖层注入时机正确**：核对了引擎源码 `dist/cubism.es.js:11941` 的 `update()`：`updateMotions → saveParameters → expression → eyeBlink → updateFocus → breath → physics → pose → beforeModelUpdate → model.update → loadParameters`。`Live2DActor.hook()` 替换的是 `updateFocus`，所以叠加量在 motion 和表情之后、物理之前生效（头发会跟着转头摆动），帧末的 `loadParameters` 又保证叠加量不会逐帧累积；回零后漂移小于 0.5°，有 e2e 覆盖。参数只按真实 id 表的下标读写，不会凭空创建参数。`breathDepth=0.05` 关掉了 SDK 默认 ±7.5° 的摆头，处理正确。Player 的 tick 比模型更早注册到同一个 ticker，所以叠加量当帧就生效，没有一帧延迟。
- **compile / evaluate 是纯函数**：没有用到时间、随机数或任何全局可变状态，warnings 只写入局部数组；evaluate 只依赖 `(compiled, t)`，单测已证明乱序求值与顺序求值结果一致。资源只取自 ctx，找不到时丢弃该项并记 warning，不会自行编造资源。
- **朝向**：人物从不镜像（容器缩放恒为正，e2e 扫描世界变换确认）。L/R 变体选择与残差叠加实测正确：两人面对面时头部 yaw 符号相反；e2e 断言了"头朝对方、眼睛向下"这种头与视线分离的情况。大幅转向时会自动换 idle 变体。
- **构图（多人）**：two_shot（seek-01、05、08）和 group（seek-09）的人物占比、留白、头部高度都接近原作的中近景。closeup（seek-04、13）的头高约占画面 0.42，眼线在上 1/3，背景按 dof 明显虚化，焦点人物清晰。
- **比例与接地**：wide（seek-00、06、10）里人物与桌椅、钢琴、楼梯的比例合理，脚底落在地面上。纵深靠后的乐奈变小，脚底随透视上移，既不浮空也不陷地。背景视差（`zoom^0.85`）加上覆盖夹紧后，任何镜头下画面边缘都不会露出空白。
- **转场**：crossfade 和 wipe 的中间帧（trans1-2/3、trans2-2/3）只有"扁平化快照"与"新场景"两层，看不到人物内部图层透出，没有黑帧，转场结束后没有残影（trans1-4 起画面干净）。人物半透明用的是包裹容器上的 AlphaFilter，e2e 证明 50% 透明度时画面等于人物与背景的真实混合。
- **换装**：场景 3 中灯从 casual 换成冬季校服时没有空帧（seek-11、12）；表情在新模型上存在时会被保留。
- **对话框**：名字牌使用角色颜色，逐字显示，读完后出现 ▼，旁白居中显示，seek 后显示的字数正确。手动推进（点击先补全文字、再进入下一句）有 e2e 覆盖。质感属于"干净可用"，进一步打磨见 D5。
- **数据模型 meta**：`MetaSchema{source,locked,genId?,reason?,updatedAt}` 已经覆盖 cast、scene、background、wardrobe、blocking、transitionIn、audio.bgm/ambience、beat、beat.shot、每个 keyframe，足以支撑 P9 的徽标与锁定、P13 的 mergeLocks。缺口见 M3。

### 3. 必须修复项（P7.1，P8 功能开发前完成；按严重度排序）

**修复状态（P7.1，已全部完成）**：M1 已修复（look-room + 边缘侵入规则，对比截图 .verify/p71-before-* 与 p71-after-*）；M2 已修复（setOffsetTime + Stage.resync，e2e 覆盖）；M3 已修复（Track.meta）；M4 已修复（gaze camera 为绝对方向）；M5 已修复（demo 末尾追加 1.5 s pause beat s3b5，黑场挪到其上）。D2、D3 顺手修完。

**M1（高，演出质量）单人镜头没有视线方向留白，非焦点人物被画框切成半个。**
- 现象：seek-03（爱音 bust）、seek-12（爱音 medium）、play-03 中，焦点人物被放在画面正中，而另一位角色的半张脸和半个身体露在画面边缘，且没有虚化（dof 低）。seek-02、11 中，灯看向画面右侧的对方，却被放在正中，视线方向前方没有留白。原作的单人中近景要么把对方完全排除在画外，要么做成明确的过肩镜头，不会出现这种"误入半身"。
- 位置：`shared/staging/framing.ts` 中 `solveShot` 的单人分支（只把头框居中）；`shared/timeline/compile.ts` 中的 `frameActor`/`poseOf`（没有传入朝向）。
- 修复：
  1. `FramingActor` 增加 `yaw:number`，由 compile 传入该时刻的期望 yaw（`yawAt(t)`）。
  2. 单人镜头：横向锚点设为 `x = headCenter.x + yaw·LEAD·W/zoom`，其中 `LEAD≈0.12`，使人物落在看向方向的反侧，大约画面宽度的 0.38 或 0.62 处。
  3. 画面边缘侵入规则：solveShot 接收 `all`，算出单人或双人镜头的 pose 后，对每个非焦点人物计算其"头框加上半身框"在视口内的可见比例 f。若 `0.05<f<0.7`，先把相机平移去排除他（最多平移 0.15·W/zoom，且焦点头框必须仍在安全区内）；仍无法排除时，改为把他完整纳入（反向平移）；两者都做不到时保留原 pose，并在 CompiledScene.warnings 中记录 `edge-cut`。
  4. 单测：在 framing.test.ts 中断言（a）yaw>0 时焦点头中心落在视口 0.35–0.45；（b）对 seek-03 的布局，非焦点人物的可见比例 ∉(0.05,0.7)。截图复核 `/play/demo` 的 s1b4、s3b3。

**M2（中高，seek 一致性）seek 时 motion 总是从头播放，但引擎其实支持偏移量。**
- 实施备注称"引擎队列项不暴露 startTime"，这一说法不成立：`ACubismMotion.setOffsetTime(sec)` 已在 `types/index.d.ts:2736` 中公开，`setupMotionQueueEntry` 以 `userTime − _offsetSeconds` 作为开始时间（`dist/cubism.es.js:6871`），`motionManager.loadMotion(group,0)` 会返回该 motion 对象（d.ts:3479）。现在 seek 到一段 3 s 一次性动作的第 2.5 s 时，画面会显示第 0 s 的姿势，与"seek 等于顺序播放"相矛盾。P10 分镜缩略图（seek 到 beat 中点再截图）会直接受到影响。另外，在同一场景内 seek 时如果 eventKey 没有变化，motion 不会被重新定位。
- 位置：`web/engine/Live2DActor.ts` 中的 `playMotion`，`web/engine/Stage.ts` 中 `applyActor` 的 motion 段，`web/engine/Player.ts` 中的 `show`。
- 修复：
  1. `playMotion(name,{loop,offset})`：先 `const m = await motionManager.loadMotion(name,0)`；然后 `m.setOffsetTime(loop ? offset % m.getLoopDuration() : Math.min(offset, m.getDuration()))`；再调用 `model.motion(...)`；在 `onBeganMotion` 或下一帧把偏移恢复为 0（motion 对象有缓存且被共享）。
  2. Stage 增加 `resync` 标志：Player.show（seek 或进入场景）时把它置为 true，此时对所有 slot 无条件按 `a.motion.elapsed` 重新触发；连续播放时保持现有的 eventKey 逻辑（偏移量为 0）。
  3. 一次性动作如果 `elapsed ≥ length`，就直接播放其后的 idle（compile 中已经有对应事件）。
  4. e2e：在 play-demo 中加一条用例：顺序播放到某个一次性动作的中段并记录 ParamAngleX/ParamAngleY 的 base 值，再 seek 回同一时刻，两次差值 < 3°。
  5. 删除 PLAN.md 中"seek 时 motion 从头重启"的已知限制说明。

**M3（中，数据模型）轨道级 meta 缺失。**
- 现在只有关键帧带 meta。P14 的"只重做某通道"，以及用户"删掉 AI 的所有关键帧并锁定为空"这类意图，都无法表达；锁定一条空轨道后，重新生成时关键帧会被加回来。P8 会固化导出格式，所以必须在 P8 之前补上。
- 位置：`shared/schema/project.ts` 中的 `track()`。
- 修复：track 对象增加 `meta: MetaSchema`（有默认值，旧 fixture 不受影响）。在 PLAN §1.1 写明规则：track.locked 表示整条轨道（包括关键帧的有无）原样保留；key.locked 只保护该关键帧本身。补一条 schema 往返单测。

**M4（中，朝向语义）`gaze: {target:'camera'}` 现在是相对头部的"正视"，而不是看向镜头。**
- 位置：`shared/timeline/compile.ts` 中 gaze 的分支 `if (v.target === 'camera') return { ...base, w: 0, dir: 0, x: 0, y: 0 }`。
- 后果：头转向对方（yaw 0.8）时，眼睛跟着头一起看向对方，不会看向镜头，"头朝对方、眼看镜头"这一原作常见的演出做不出来。
- 修复：改为 `{ ...base, w: 1, dir: 0, x: 0, y: 0 }`（绝对方向 0，由 evaluate 减去头部已经转过的角度），并补一条单测：yaw=0.8 且 gaze=camera 时，`gaze.x ≈ −0.56`。

**M5（低，示例演出）结尾的黑场盖住了正在说的台词，对话框悬在黑屏上。**
- 现象：play-14、15 中，s3b4 的特写还在逐字显示时画面就已经全黑，只剩对话框。
- 位置：`tests/fixtures/demo-project.json` 中的 fade 关键帧 `k40`（`at: s3b4 + 0.5s`）。
- 修复：把黑场移到台词显示完之后，例如在末尾追加一个 `pause` beat（1.5 s），把 fade 放在该 beat 上；或者把 offset 设为 ≥ 该 beat 的 textEnd。对话框位于黑场之上是有意为之（原作有黑底文字的用法），不改渲染层级。

### 4. 可延后项

| # | 内容 | 位置 | 建议阶段 |
|---|---|---|---|
| D1 | seek 进转场窗口时没有旧场景快照（`seek-into-trans1` 直接显示新场景）。修复：seek 落在 scene i 的 lead-in 且转场不是 cut 时，先进入 scene i−1 并在 `start_i−ε` 时刻 apply 和 settle，再 `captureSnapshot`，然后进入 scene i。缩略图渲染也复用这一路径 | `Player.show/seek` | P10（与分镜缩略图一起） |
| D2 | 转场快照固定使用 `resolution:1`，HiDPI 屏上 crossfade 期间旧画面会变糊 | `Transitions.capture` 改为 `resolution: renderer.resolution` | P8 顺手修 |
| D3 | StageLab 在 1440 宽度下右侧控制面板被裁出视口（`accept1-lab-stage.png`） | `web/lab/StageLab.tsx` 和 styles 的布局 | P8 顺手修 |
| D4 | 傍晚、夜间背景下人物没有色调匹配（场景 3 的橙色背景前，人物仍是日光色） | 在 Stage 的人物包裹容器上加 ColorMatrixFilter，按背景 time 或 setting 给默认值，scene.background 可覆盖（带 meta） | P9（背景属性）/ P15 |
| D5 | 对话框质感：没有换句时的淡入淡出、▼ 没有呼吸动画、文字缺少描边或阴影、字体没有统一指定 | `DialogBox.ts`、`styles.css` | P15 |
| D6 | compile 遇到缺失的校准或背景时直接 throw；编辑器需要可恢复的错误（标红场景，其余场景照常预览） | `compile.ts` 中的 `calOf`、背景检查 | P8/P9 |
| D7 | `Transitions.update` 的 fade 分支缩进错乱（只影响观感） | `web/engine/Transitions.ts:58` | 任意 |
| D8 | 一次性动作的变体只按事件起始时刻的 yaw 选择；动作期间如果有大幅转向，残差可能过大 | `compile.ts` 中的 `resolveMotion` 调用 | P13 前评估 |

### 5. 对后续计划的调整（已写入 PLAN.md）
- 新增 **P7.1 验收修正**（M1–M5），作为 P8 的前置工作。验收方式：全套测试通过，并重新截取 `/play/demo` 中 s1b3、s1b4、s3b2、s3b3 的 seek 截图，以及结尾的帧。
- P7 实施备注中关于 motion seek 的"已知限制"，以及 §3 风险 7，改为"已用 setOffsetTime 解决（P7.1）"。
- P10 的交付物中加入 D1（seek 进转场时补快照）。
- §1.1 增加轨道级 meta 规则（M3）。

---

## 第二次验收 P7.2（原作演出还原 + 编辑器可调性）

- 日期：2026-10-09；验收人：Opus；基线 `a624cee`（P7.2 = `53494ab`）。最高标准：用户原话"要像原版剧情演出""前端要精致，人工要可以调整所有功能"。
- **结论：不通过（需 P7.3 修正后复验）。** 单帧构图、对话区、HUD、景深、ECU 特效已经接近原作，截一张静帧给看过原作的玩家，七成会认为"是那个味道"。但连续播放时，有几处问题会马上暴露"不是原作"：每次换镜都是 0.5 s 的推拉滑移，而不是硬切；每句开头对话区闪灭；双人镜头里人物偏小、两人高低差很大；画面边缘夹着一条别人的头发；作者指定的高潮 CU 被规则吞掉。另外，编辑器里检查器显示的值与预览画面不一致，这违反了"人工可调"的前提。

### 1. 自动化结果（本机实跑，复用用户 5273 dev server，未终止）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过（0 告警） |
| `npm test`（unit） | 18 文件 / 178 用例 通过 |
| `npm run test:integration` | 3 文件 / 14 用例 通过 |
| `npm run test:e2e`（Edge） | 41 / 41 通过（3.0 min） |
| 浏览器 console error（/play/demo 全程、转场加密、编辑器 1920/1440） | 0 |

截图（均在 gitignored 的 `.verify/`，采集脚本 `accept2.mjs`、`accept2-probe*.mjs`、`accept2-editor.mjs`）：
- `accept2-play-NN-tX.png`：1920×890 视口下从头顺序播放，每 2 s 一帧，共 47 帧；`accept2-play-montage-a/b.png` 为拼图。注意 /play 页面固定 1280×720 画布。
- `accept2-trans-<窗口>-NN.png` 与 `-montage.png`：s1/s2/s3 开场、s1b7/s2b6 dip、s1b3/s2b4 入场，每个窗口约 14 帧加密采样。
- `accept2-vs-ref-shots.png`（双人/MCU/CU/群像）、`accept2-vs-ref-fx.png`（ECU 泛光/不安暗角/地点条/场景 3 双人）、`accept2-vs-ref-banner-text.png`：与 `.verify/ref/` 原作帧逐行左右并排。
- `accept2-cut-glide-s1b5.png`：一次"换镜"的 4 帧（18.29→18.90 s）。
- `accept2-editor-{1920,1440}-{scene,beat,style}.png`：编辑器截图。

### 2. 逐项对照 STYLE_REFERENCE（看过原作的玩家会不会觉得像）

| 项 | 判断 | 证据 |
|---|---|---|
| MCU / CU / ECU 人物尺寸、眼线、头顶留白 | **像**。头高、眼线与 t043/t100/t146 基本一致，ECU 纹理清晰 | vs-ref-shots 第 2、3 行；vs-ref-fx 第 1 行 |
| 双人 | **不像**。人物明显偏小（目测头高约 0.30–0.33H，原作约 0.39H），两人头顶高差约 0.2H（原作 ≤0.07H），矮的一方看上去像蹲着或站得很远 | vs-ref-shots 第 1 行（t051）；vs-ref-fx 第 4 行（t071） |
| 群像重叠 | 基本像：有重叠，后排缩小。前排头高偏小（约 0.30H，原作 0.40H），边上的人物不敢被切 | vs-ref-shots 第 4 行（t094） |
| 背景虚化 / 色调 | 像。景深随景别变化，空镜清晰，人物乘色 0.92 自然。ECU 泛光段整体比原作暗、偏紫，原作更"白、通透" | vs-ref-fx 第 1 行 |
| 对话区 / 名字 / 分隔线 / 字体 | 像，几何与 SR 一致。**但每句开头约 0.1–0.15 s 整个对话区（渐变 + 名字）消失**，形成闪烁 | probe2：t=14.138/14.188 时 `display:none` |
| 菜单按钮 | 位置不对：圆心在 0.113H，规范是 0.064H。看起来比原作低了半个按钮 | vs-ref-* 右上角；像素实测 |
| Auto 图标 | 位置正确。但在黑场、空镜、结尾黑屏时它和菜单按钮仍常驻；原作空镜时整个对话区（含图标）都隐藏 | play-00、play-46、trans-s2start-10… |
| 节奏 | 像。平均约 4 s/句，空景、无声节拍有呼吸感 | play 全程 |
| **换镜（硬切）** | **最不像的一点。**同场景内每次换镜都是 0.5 s inOutSine 的相机推拉/横移（`performance.glideSeconds` 默认 0.5），原作约 70% 的换镜是 0 帧硬切，镜头内也不推拉。玩家第一眼就会觉得"镜头在飘" | cut-glide-s1b5（zoom 4.6→6.1 连续变化） |
| 换场黑场 / dip / 地点条 | 像。先隐藏对话区 → 停顿 → 渐黑 → 纯黑 → 渐亮到空镜 → 标题条，时序正确。标题条字号与原作相当，原作文字描边更粗、更亮 | trans-s2start、trans-s3start、vs-ref-banner-text |
| 入场 | 像：0.2 s 淡入 + 滑入，相机 0.8 s 重构图，对话同步出现 | trans-s1b3enter、trans-s2b4enter |
| 情绪特效 | 荷兰角、色差、泛光可以接受。不安暗角只是平滑的边缘压暗，没有原作那种灰色烟雾纹理和不规则边，"不安"的味道不足 | vs-ref-fx 第 2 行（t125） |
| 画面边缘 | **不像**。灯的 MCU 右缘夹着一条爱音的粉色头发；p72-compare-v1-mcu 右缘同样有半张脸 | play-11-t22、p72-compare-v1-mcu |
| 演出意图 | **demo 结尾高潮**：s3b6 作者写的是 `cu + push_in`（灯的独白式告白），实际被"最短镜头 4 s"规则吞掉，整句停在双人镜头上，直到结尾淡出时 CU 才出现 | probe：84.6–88.5 s 相机不变；vs-ref-fx 第 4 行 |

### 3. 通过项
- 风格预设系统结构正确：`STYLE_FIELDS` 与默认值一一对应、四层解析并报告来源、非法值忽略、越界夹紧；检查器"风格"分组可折叠，带继承来源与 ↺ 恢复；改动经 120 ms 防抖重编译，即时反映到预览（e2e V6/V8 覆盖，抽查截图一致）。
- DialogBox / HudLayer 的尺寸全部来自 style，并按画框高度比例计算；独白括号、画外音模板、多人名字连接符都已实现并可调。
- 换场黑场、dip、地点条、空景 / 无声节拍、入场重构图、ECU 泛光 + 色差 + 荷兰角，时序与 SR 一致，可 seek。
- 无调试残留：P7.2 改动文件中没有 `console.log` / `debugger` / TODO；调试钩子只在 DEV 下注册。
- 编辑器在 1920×1080 和 1440×900 下都没有横向滚动；暗色 token 体系统一，整体观感干净。

### 4. 必须修复项（P7.3，P9 开工前完成；按严重度）

**N1（极高，演出）同场景换镜改为硬切。**
- 位置：`shared/style/ournotes.ts` 中 `performance.glideSeconds: 0.5`；`shared/timeline/compile.ts` 约 486 行 `const glide = ...`。
- 修复：原作预设默认 `glideSeconds: 0`（`bandori-plate` 预设可保留 0.5）。只有"入场重构图"（`reframe`）使用 `reframeSeconds`。新增 beat 级 `shot.transition?: 'cut' | 'glide'`（默认 cut），选 glide 时才用 `glideSeconds`。demo 中 s1b7、s3b6 的 `push_in` 改为 `static`（SR §3：无推拉）。`push_in` 等运镜保留为可选项，原作预设不使用。
- 验收：e2e 在任意一次同场景换镜的前后各采样 1 帧（间隔 1/30 s），`getCamera()` 应直接跳到新位姿，中间没有过渡帧。对照 `ref/sheets/sheet05`（1:06、1:09 两处硬切）。

**N2（高，UI）每句开头对话区闪灭。**
- 位置：`web/engine/DialogBox.ts` 中 `update()` 的 `sub.visibleChars === 0 && !revealAll` 判断。
- 修复：只要当前 beat 是对话或旁白、不在 `hiddenDialog` 区间内、且 `sub` 存在，就显示渐变、名字和分隔线；正文为空即可。整体隐藏只由 compile 的 `hiddenDialog` 决定。
- 验收：e2e 在连续两句的交界处 ±0.1 s 内每 1/30 s 采样一次，`[data-testid=dialog]` 始终可见，底边像素始终 ≈#140C24。

**N3（高，构图）双人 / 群像：按原作的屏幕位置排布人物，并压缩两人的高低差。**
- 位置：`shared/staging/framing.ts` 中 `solveShotDetailed` 的 two_shot/group 分支（只取头框并集居中；`fit` 约束让人物缩小）；`compile.ts` 的 `frameActor`。
- 修复：
  1. 新增镜头内水平排布：two_shot 让两张脸中心落在 ±`shots.two_shot.faceX`（默认 0.47H）；group 落在 `groupFaceX`（默认 [-0.50, 0.19, 0.70]H，按画面从左到右排序）。实现为"该镜头内的人物 x 偏移量"，写入 `CompiledBeat`（seek 安全），不改 blocking；`fit` 约束取消，允许最外侧人物被画框切到肩膀（focus 也允许）。
  2. 新增 `framing.heightEqualize`（0..1，默认 0.6）：多人镜头里各人的眼线向参考眼线靠拢 `k·Δ`，原作的高差 ≤0.07H。
  3. 上面两项和 `TWO_SHOT_MARGIN`、`CHEST_HEADS`、`EDGE_MIN/MAX`、`MOVE_ZOOM`、`PAN_SHARE`、`SHAKE_AMPLITUDE`（compile.ts:20）一起进入 `STYLE_FIELDS`。
- 验收：unit 断言 two_shot 两人头高 0.39±0.03H、脸中心 ±0.47±0.04H、眼线差 ≤0.07H；group 前排头高 0.40±0.04H。截图与 `ref/t051.jpg`、`ref/t071.jpg`、`ref/t094.jpg` 并排对比。

**N4（高，构图）画面边缘不能夹着别人的头发或半张脸。**
- 位置：`framing.ts` 中 `visibleShare` / `upperBody`（判定框只包含"头框 + 胸"，长发和发梢在框外，所以漏判）。
- 修复：判定框改用模型可见包围盒（校准里的 body 框，或 `head.w×2.2` 的发型外扩框，外扩系数进入 style）。可见比例落在 (EDGE_MIN, EDGE_MAX) 时，先尝试排除；排除不了，就在单人镜头里把该人物的 opacity 设为 0（原作单人镜头里对手直接不在画内），并记 warning。
- 验收：`/play/demo` 在 s1b5（t≈20–22 s）以及 p72 的 MCU 对照帧中，左右边缘 3% 宽的像素带里没有非焦点人物的像素（用渲染层 id 或 alpha 掩码判断）。对照 `ref/t043.jpg`。

**N5（高，可调性 / 真实性）"最短镜头"规则悄悄吞掉作者写的镜头，检查器与预览不一致。**
- 现象：demo s3b6 写的是 `cu + push_in`，实际一直停在双人镜头；用户项目 `p_mv1d43m9jvhx` 的 s1b3，检查器显示"胸像 bust + 推近"，预览却是双人镜头，界面上没有任何提示。
- 位置：`compile.ts` 约 452–462 行（`held`）；`CompiledBeat.shotHeld` 只出现在 types.ts，UI 没有用到。
- 修复：
  1. 景别变近（例如 two_shot/mcu→cu/ecu）、焦点换人、或带非 static 运镜时，不触发 hold。
  2. 检查器"镜头"组在 `shotHeld` 时显示"沿用上一机位（最短镜头 4 s 规则）"徽标，并提供"强制切镜"按钮（写入 `shot.meta.source='user'`）。
  3. 剧本大纲中被 hold 的句子显示一个小图标。
- 验收：unit 断言 demo s3b6 的 `shotType==='cu'`；e2e 选中被 hold 的句子时出现徽标，点击"强制切镜"后预览相机改变。

**N6（中，可调性）句子的 `emotion` 在检查器中没有字段。**
- 规则导演按 emotion 换表情和手势，但 emotion 只能在 JSON 中改。这是 P7.2 新引入的"只能由数据决定"的量。
- 修复：`Inspector.tsx` 的 BeatFields 加 emotion 下拉（取值来自 schema 枚举）。规则导演为该句选出的表情 / 手势以只读方式显示在下方，标注"规则"来源（P9 再做烘焙成关键帧）。

**N7（中，HUD）菜单按钮纵向位置错误。**
- 位置：`web/engine/HudLayer.ts:176`，`top:${h.menuTop*H}px`。SR 7.2 中 menuTop 指的是"圆心距上边"，这里却当成了按钮上沿。
- 修复：改为 `top: (menuTop*H - d/2)`（与 `menuRight` 的圆心语义一致），并在字段 label 中写明"圆心"。e2e 断言圆心 y=0.064H±4 px。对照 `ref/t043.jpg` 右上角。

**N8（中，HUD）对话区隐藏时 Auto 图标仍常驻；黑场中 HUD 浮在黑屏上。**
- 位置：`HudLayer.relayout`（只看 `autoVisible`）。
- 修复：Auto 图标跟随对话区显隐（新增 style 字段 `hud.autoFollowsDialog`，默认 true）。菜单按钮在 `fade.alpha>0.95` 期间的显隐也做成字段（原作建立镜头 t039 中按钮可见，所以只在纯黑时隐藏）。
- 附带：`relayout()` 现在每帧整体重写 cssText，`update()` 只应在 ui 或尺寸变化时重排；Auto 图标的旋转按 rAF 计帧（`+1.2°/帧`），会随刷新率变化，播放器暂停时也在转，应改为按时间计算（deg/s 作为字段），暂停时停止。

**N9（中，特效）不安暗角缺少烟雾质感。**
- 位置：`web/engine/fx/FxFilters.ts` 的 `SCREEN_FRAGMENT` 中 anxiety 分支（fbm 只低频调制宽度，结果是平滑压暗）。
- 修复：边缘区加入可见的 fbm 烟雾层（2–3 个倍频、随时间缓慢流动，速度做成字段），混合灰色雾色，而不是纯乘黑；四边都覆盖，角部更重；新增 `fx.anxietySmoke`（纹理强度）、`fx.anxietyTint`（雾色）。对照 `ref/t125.jpg`、`ref/trans/g.jpg`。
- 附带：`Stage.applyScreenFx` 每帧 `new Rectangle`（改为复用）；外发光半径里的 `* 0.25` 魔数进入 style（`fx.anxietyGlowScale`）。

**N10（中，编辑器）检查器"景深 dof"一行布局破损。**
- 现象：1920 宽时复选框文字竖排成一列，滑块右侧数值被裁出面板（`accept2-editor-1920-style.png`）。
- 位置：`web/editor/panels/Inspector.tsx` 中 dof 的 Row 与 `editor.css` 的 `.chip.check`。
- 修复：chip 设 `white-space:nowrap`；dof 行改为"自动/手动"分段按钮 + 独立的一行滑块。

**P7.3 复验方式**：全套测试通过；重新采集 `accept2.mjs play/trans`，并与 `ref/t051/t071/t094/t043/t125` 重新并排对比；验收方逐帧确认换镜为硬切、对话区不闪、边缘干净、s3b6 为 CU。

### 5. 可延后项

| # | 内容 | 位置 | 阶段 |
|---|---|---|---|
| E1 | ECU 泛光段比原作暗、偏紫：底部渐变在泛光期间可降低 maxAlpha，黑位抬升 / 泛光默认值上调（对照 t146） | style 默认值 | P7.3 顺手 |
| E2 | 地点条文字描边比原作细、颜色偏暗：stroke 约 2px@1080，字号约 0.03H（对照 vs-ref-banner-text） | HudLayer、style | P7.3 顺手 |
| E3 | demo 内容：s2b6 进入不安暗角的 dip 应 `cutInKeepDialog: true`（SR §5 第 3 行、trans/g）；s3 是同地点的时间跳跃，用 dip 没错，但不应再出地点条（或改成时间条） | demo-project.json | P7.3 |
| E4 | `/play` 页面画布固定 1280×720，不随窗口放大；放映模式需要全屏 16:9 | PlayPage | P15 |
| E5 | `scene.style.preset` / `beat.style.preset` 被忽略（只读 project 的 preset），schema 允许却没有效果，应在 UI 中隐藏或实现 | resolveStyle | P9 |
| E6 | style 数值以 `/H` 小数显示（例如 0.0296），对人不友好；应显示为"px@1080"并可切换 | StyleFields | P9 |
| E7 | 暗背景 dof 加成依赖 `luma`，客户端没有计算（P7.2 备注已承认） | 背景元数据 | P9 |
| E8 | 首页项目列表过于朴素（没有缩略图、没有搜索），与工作区的精致度不一致；检查器是一条很长的单列（项目 + 场景 + 句子 + 三层风格），应按选中对象切换标签页 | EditorApp、Inspector | P9 |

### 6. 编辑器"人工可调所有功能"核查

已可调：项目 / 场景 / 句子三层风格覆盖（全部 STYLE_FIELDS：景别表、构图、节奏、对话区、HUD、地点条、转场、表演开关、特效全局参数）；场景转场类型；地点条文字与开关；背景与取景；服装；站位 slot/depth；入退场时机与方向；BGM 与音量；句子类型 / 形式 / 说话人 / 同时说话人 / 切入方式（含保留对话区）/ 文本 / 时长；镜头景别 / 运镜 / dof / 焦点。改动即时预览（120 ms 防抖）。

**缺失的可调项**（N5/N6 在 P7.3 修，其余已写入 PLAN P9/P10 的补充）：
1. 句子的 `emotion`（N6）。
2. 每句、每个角色的表情、motion、头 / 身 / 视线、位置微调、不透明度：轨道数据不可见、不可改。
3. 规则导演的产出（自动换的表情 / 手势、听者转头）不可见、不可"烘焙"成可编辑关键帧，也不能单独锁定。
4. 手动相机位姿（x/y/zoom/roll）、从求解结果"烘焙后手改"、镜头切换方式（cut/glide）、强制切镜（N5）。
5. 特效关键帧（anxiety/glow/dutch 的强度、进出时长、roll 方向）只能改全局参数，不能改某次出现。
6. 多人镜头的脸位置、高差压缩、后排缩放、重叠容许、边缘侵入阈值（N3/N4 进 style）。
7. 风格预设的复制 / 另存为 / 导入导出、"设为预设默认"。
8. 插入镜头的目标部位框。
9. 预览叠加层：安全区、三分线、SR 眼线带、参考帧洋葱皮；舞台直接操作。
10. 场景 / 句子的增删排序。

---

## P7.3 修正状态（Sonnet 实施，待验收方复验）

| # | 状态 | 做法与证据 |
|---|---|---|
| N1 | 已修 | `performance.glideSeconds` 默认 0（bandori-plate 保留 0.5）；beat 级 `shot.transition: cut\|glide`（检查器"换镜方式"）；demo 去掉 push_in。unit：camera key 时长为 0、切点前后无过渡帧；e2e：连续播放逐帧记录，相机变化只占单帧、无连续变化帧。 |
| N2 | 已修 | `DialogBox` 不再因 `visibleChars===0` 隐藏；显隐只由 compile 的 `hiddenDialog`。e2e：连续播放中每个渲染帧（含句交界）对话区与 Auto 图标均可见。 |
| N3 | 已修 | `framing.twoShotFaceX/groupFaceX0-2/heightEqualize/sizeEqualize` 等进 STYLE_FIELDS；镜头内人物偏移（x/y/缩放，缩放以头心为轴，双人拉平两人头高）写入 `CompiledActor.shiftX/Y/S` 随相机 key 缓动，blocking 不变。integration（真实标定）：双人头高 0.39±0.03H、脸中心 ±0.47±0.04H、眼线差 ≤0.07H；群像前排 0.40±0.04H。`CHEST_HEADS/EDGE_MIN/EDGE_MAX/MOVE_ZOOM/PAN_SHARE/SHAKE_AMPLITUDE` 也已进 style。 |
| N4 | 已修 | 判定框 = 模型宽度 ∪ 头框两侧外扩 `hairSpread`（头宽倍数，默认 0.9）；排除不了的人在单人镜头中被隐去（`shotVisible` 关键帧）并记 warning。integration：demo 所有单人镜头的非焦点人物可见比例 ≤0.05 或 ≥0.7。 |
| N5 | 已修 | hold 规则：景别变近、焦点变化、非 static 运镜都不 hold；demo s3b6 为 CU。检查器"镜头"组显示"沿用上一机位（取景相同或最短镜头规则）"徽标 + "强制切镜"按钮，大纲显示 ⏸ 图标（取自编译结果，与预览一致）。unit + e2e。 |
| N6 | 已修 | 检查器 emotion 下拉（取值取自规则导演的 `EMOTION_TAGS`，旧值保留），下方只读显示规则导演选出的表情 / 手势（"规则"来源徽标）。e2e。 |
| N7 | 已修 | 菜单按钮按圆心定位（pop 菜单位置同步）；字段 label 写明"圆心"。e2e：圆心 y=0.064H±0.004。 |
| N8 | 已修 | `hud.autoFollowsDialog`（默认开）、`hud.menuHideOnBlack`、`hud.autoSpinDegPerSec`（72°/s，按项目时钟计算，暂停即停）；HudLayer / DialogBox 仅在样式、显隐、尺寸变化时重排；隐藏界面时 ui 对象引用稳定。e2e：空镜隐藏 Auto、纯黑隐藏菜单、旋转角度 = f(t)。 |
| N9 | 已修 | 不安暗角加入 3 倍频 fbm 烟雾（随时间流动）、灰雾色、角部加重、不规则边；`fx.anxietySmoke/anxietyTint/anxietySmokeSpeed/anxietyGlowScale` 进 style；`Stage` 复用 filterArea Rectangle。e2e：关闭烟雾后边缘亮度分布不同。 |
| N10 | 已修 | dof 行改为"自动 N / 手动"分段按钮 + 独立一行滑块；`.chip` 禁止折行。e2e：按钮不竖排、滑块不出面板。 |
| E2 | 已做 | 地点条描边 2px@1080。 |
| E3 | 部分 | s2b6 已是 `cutInKeepDialog`；s3 的地点条仍在（关闭会同时去掉 s3 的建立镜头与时间轴，留待内容阶段）。 |
| E1 | 已做（P9） | 泛光默认值上调，新增 `fx.glowDialogAlpha`，泛光期间对话区渐变淡出；单测 + e2e。 |

复验素材：`.verify/p73-frames/`（1920×890，每 0.25 s 一帧，顺序 seek）、`.verify/p73-vs-ref-shots.png`、`.verify/p73-vs-ref-fx.png`、`.verify/p73-anx-vs-ref.png`、`.verify/p73-montage-*.png`。


### P9/P10 状态
E1、E5（场景/句子层本无预设下拉）、E6（px@1080）已处理；E8 检查器已按对象分标签（首页项目列表未改）；D1 已修。未做：E7（背景 luma）、插入镜头目标部位框、角色级规则导演开关、真倒放。详见 PLAN.md P9/P10 实施备注。

---

## 第三次验收 P7.3–P10（原作还原复验 + 编辑器手调验收）

- 日期：2026-10-10；验收人：Opus；基线 `7b968e6`（P7.3 = `91b5abf`，P9/P10 = `97c4be7` + `7b968e6`）。复用用户 5273/5274 dev server，未终止。
- **结论：P7.3 通过；P9/P10 有条件通过，须先完成下列 F1–F8（作为 P10.1，P11 开工前完成）。**
  - **像不像原作**：连续播放下，换镜是硬切，对话区不闪，双人和群像的比例、站位、重叠都接近 t051/t071/t094；建立镜头之后角色淡入、空景节拍前后角色淡出淡入，都与 `ref/trans/d`、`trans/a` 一致。看过原作的玩家看静帧和连续播放，大多会认出是"那个演出"。剩下最明显的破绽有两个。一是**所有有人物的镜头里，背景被放大了 2.5–3 倍**（F1，P7.2 起的 bug）：原作 MCU 背景里的桌椅、窗框还能看清，我们的只剩一片放大后又虚化的色块，第一眼就显得"贴图糊"。二是 `/play` 画布固定为 1280×720（E4），在 1920×890 窗口里只占中间一块。
  - **编辑器**：结构和视觉已经达到专业工具的水准：暗色 token 统一，分区清楚，检查器按对象分标签，字段带来源徽标和锁，时间轴、分镜可以直接操作，撤销可靠，保存和导出正常。但"人工可以调整所有功能、锁定可靠"这一条还没有做到：锁定可以从检查器和删除操作绕过（F2）；在自动构图的镜头里拖动人物，屏幕上几乎看不到变化（F3）；在预览上滚动滚轮会悄悄改纵深（F4）；`insert` 景别是半成品（F5）。

### 1. 自动化结果（本机实跑）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过（0 告警） |
| `npm test`（unit） | 21 文件 / 214 用例 通过 |
| `npm run test:integration` | 4 文件 / 18 用例 通过 |
| `npm run test:e2e`（Edge） | 64 / 64 通过（3.0 min） |
| 浏览器 console error（/play/demo 连续播放全程、编辑器手动操作 5 轮） | 0 |

### 2. P7.3 复验：连续播放（不是 seek）

方法（`.verify/accept3-play.mjs`）：1920×890 视口，`/play/demo` 从头**连续播放**。页面内 rAF 逐帧记录播放时间、相机、对话区显隐和人物偏移，共 10141 个渲染帧，覆盖 90.9 s；同时连续截图 580 张（约每 0.16 s 一张）。对每句开头取 −0.12 / +0.06 / +1.2 s 三帧拼图（`accept3-beats-s{1,2,3}.png`），并与原作帧左右并排（`accept3-vs-ref-shots.png`、`accept3-vs-ref-fx.png`）。逐帧数据在 `accept3-framelog.json`，补充 seek 探针图为 `accept3-probe-*.png`。

| 项 | 判断 | 证据 |
|---|---|---|
| N1 硬切 | **通过**。同场景内 15 次换镜都在**单个渲染帧**内完成。只有 3 处持续 0.6–0.7 s 的相机运动，都是入场重构图（s1b3、s2b2、s2b4，SR §4 规定的 0.6–1.0 s），其后有 <0.5% 的缓动尾巴 | framelog 分析（相机变化段长度） |
| N2 对话区不闪 | **通过**。有字幕时对话区隐藏的帧数为 0；对话区只在无声 / 空景 / dip / 换场时切换显隐，共 12 次，都是有意为之 | framelog |
| N3 双人 / 群像 | **像**。双人头高约 0.37H，两张脸的中心约在 0.28W / 0.68W，两人高差很小；群像有重叠，边上的人物被切到肩，与 t094 一致 | vs-ref-shots 第 1–3 行 |
| N4 边缘 | **通过**。单人 MCU / CU / ECU 的画面边缘没有夹带别人的头发或脸 | beats-s1/s2/s3 |
| N5 s3b6 | **通过**：CU | beats-s3 |
| 入场 / 空景节奏 | **像**。建立镜头硬切到 MCU 后角色淡入 0.2 s，与原作 `trans/d` 逐帧一致；空景前后角色淡出 / 淡入，与 `trans/a`、`trans/b` 一致 | probe-t70.86–70.96、t79–80.9 |
| 泛光 ECU / 不安暗角 / 地点条 | 像。泛光段整体高调、偏白，接近 t146；暗角有了灰色烟雾边 | vs-ref-fx |
| **背景放大** | **不像（F1）**。原作 MCU 的背景几乎不放大（t043：桌椅、窗框接近原尺寸），我们的 MCU 背景放大约 4.6 倍，再叠加 dof，结果是一片大色块 | vs-ref-shots 第 4 行、vs-ref-fx 第 1 行 |
| 画幅 | `/play` 固定 1280×720（E4）；原作是全屏宽画幅 | 全部帧 |

### 3. P9/P10 手动操作验收（`.verify/accept3-ed{1..5}.mjs`，真实鼠标与键盘事件，1920×1080 与 1440×900；项目 `p_mv1vdexsk91w`「第三次验收」保留在 data/projects，可删除）

| 操作 | 结果 |
|---|---|
| 转头拨盘 | 拖 150 px 后 yaw 从 1→0.44，生成 `angle` 关键帧，带"人工"徽标。✓ |
| 锁定头部关键帧后再拖拨盘 | 拒绝修改，toast 提示"已锁定"。✓ 再拖动爱音到最左，灯锁定的 yaw 保持不变。✓ |
| 拖动人物（自动双人镜头） | 拖 400 px，人物在屏幕上只移动约 5 px，是相机在跟着动（slot 0.15→−0.03）。✗ **F3** |
| 滚轮停在人物上 | 不按任何修饰键，纵深就被改了（0.08→0.12）。✗ **F4** |
| 表情 / 手势 / 服装快捷条 | 生效，可撤销；改动到预览更新约 200 ms（规范要求 <100 ms）。△ **F7** |
| 相机工具 | 拖动平移、滚轮缩放后变为手动镜头关键帧；"恢复自动"能回到求解位姿。✓ 没有 roll，没有 bgZoom（F1） |
| 时间轴 | 双击轨道加关键帧、逐步拖动（每 40 px ≈ 0.67 s，跟手）、锁定后拖动和删除都被拒绝并有提示、检查器缓动带曲线预览。✓ |
| 分镜 | 拖动卡片重排、撤销、插入、删除、批量修改。✓（e2e 也覆盖） |
| 保存 / 刷新 / 导出 | 刷新后修改仍在；导出 `ournotes-project v1`，refs 中 models 4 / backgrounds 3 / audio 1。✓ |
| **锁定可靠性** | 删除一句台词时，锚在这句上的**锁定**关键帧被一起删除，没有提示；检查器"场景"标签锁定服装后仍能换装；锁定台词后，检查器里仍能改文字，剧本面板却拒绝同样的修改；锁定的台词可以直接删除。✗ **F2** |
| `insert` 景别 | 可以选，但没有目标部位框，结果只是一张更大的脸部特写。✗ **F5** |
| UI 精致度 | 层级、对齐、密度、暗色 token 统一，空状态与 toast 都有。扣分项：时间轴和分镜混用英文枚举与原始资源 id（`silent`、`establishing`、`two_shot`、`exp_angry01`、`mtn_nod01_L`）；锁图标用彩色 emoji 🔒🔓，与其它扁平图标不一致；转场块的标签被截成 "d."；分镜卡片里的下拉被截断（"双人 two_sho"）；1440×900 下选中人物后，时间轴里该人物的轨道在可视区外，也不会自动滚过去。△ **F8** |

### 4. 代码抽查
- `shared/project/mutate.ts`：纯函数，注释准确，没有调试残留，单测覆盖锚定和增删。问题：`nextId` 从 `used.size+1` 开始找第一个未用的编号，删掉末尾一句后再新增，会**复用已删除的 id**（F6）。这与注释"smallest unused"也不一致，并且会破坏 P13 按 id 合并锁定。
- `web/store/actions.ts`：入口集中，toast 措辞清楚。问题：结构类操作（`deleteBeat/deleteScene/reorder*/toggleActorInScene` 以及 mutate 的 `removeBeat/setActorInScene`）完全不检查锁；`editBeat` 不检查场景锁，`editScene` 却会因 `scene.meta.locked`（检查器"标题"行的锁）拒绝该场景的**所有**修改，语义混乱（F2）。
- `web/editor/panels/Inspector.tsx`：`SceneFields/BeatFields` 直接调用 `applyEdit`，绕开了 actions 层的锁检查（F2 的根因之一）。"强制切镜"按钮的实现是 `sh('强制切镜', () => undefined)`，靠 `touch()` 把来源改成 user 来达到目的。这是隐式的副作用，应改为显式字段（可延后）。
- `web/editor/timeline/Timeline.tsx`（534 行）：所有 hooks 都在提前 return 之前，pointer capture 用法正确，`live` ref 避免了闭包过期。整个时间轴是一个组件，里面 9 类拖拽的状态互相独立；建议拆成 `useKeyDrag / useEdgeDrag / useMarquee`（可延后）。地点条整体拖动时，按光标的绝对位置写 delay，所以块会先跳到光标下（可延后）。`lanes.ts` 很干净。
- `web/editor/stageTools/StageOverlay.tsx`：结构清楚。问题：无修饰键的滚轮会写入数据（F4）；相机拖动的比例尺使用 `bgZoom(base.pose.zoom)`，修 F1 后必须改为同一个显式 bgZoom；`beatAtTime` 在建立镜头期间返回第一句，此时用相机工具会修改第一句的镜头，而画面上是空景（F3 一并处理）。
- 调试残留：只有 `storyboard/thumbs.ts:73` 的 `console.error`，属于真实的错误上报，可接受。没有 TODO 或 debugger；调试钩子只在 DEV 下注册。

### 5. 必须修复项（P10.1，P11 开工前完成；按严重度）

**F1（高，演出 + 假字段）背景放大倍率被 evaluate 丢弃。**
- 位置：`shared/timeline/evaluate.ts:144` 返回 `camera: { x, y, zoom: cam.zoom }`，把 `blendPose` 已经插值好的 `bgZoom` 丢掉了。`BackgroundLayer` 因此回退到 `zoom^0.85`：two_shot 实际约 3.7×（风格表 1.45×），mcu 约 4.6×（1.5×），cu 约 6×（2.5×）。风格字段 `shots.*.bgZoom` 改了没有任何效果，属于假字段。
- 修复：evaluate 输出 `bgZoom`；`RenderState.camera` 与 `getCamera()` 带上它；手动相机值 `CameraValue.manual` 增加可选的 `bgZoom` 和 `roll`，检查器"手动镜头"增加这两项，烘焙时一并写入；`StageOverlay` 背景拖动的比例尺改用显式 bgZoom。修好后重新调整 `DOF_BLUR`：背景不再被放大，同一档 dof 看起来会更清晰，需要对照 `ref/crops/blur_compare.png`。
- 验收：unit 断言 evaluate 输出的 bgZoom 等于风格表（two_shot 1.45、cu 2.5，±1%）；e2e 断言背景层实际缩放 = bgZoom × framing.zoom（±3%），并且修改 `shots.mcu.bgZoom` 后背景层缩放随之变化；重新生成 `accept3-vs-ref-shots`，MCU 背景物体尺寸与 t043 同量级。

**F2（高，锁定可靠性）锁定可以被绕过，而且各处语义不一致。**
- 现象见 §3。位置：`web/store/actions.ts`（`deleteBeat`、`deleteScene`、`reorderBeat`、`reorderScene`、`toggleActorInScene`、`bakeRuleKeys`、`editScene`/`editBeat`）；`shared/project/mutate.ts`（`removeBeat` 会删掉锁定的关键帧，`setActorInScene(false)` 会删掉锁定的轨道）；`web/editor/panels/Inspector.tsx`（`SceneFields`/`BeatFields` 的 `up()` 直接调用 `applyEdit`）。
- 修复：
  1. 在 PLAN §1.1 写明统一规则：锁定 = AI 和规则导演永不覆盖，人工修改被拒绝并 toast 提示，且提示里给出"解锁"按钮；解锁操作本身总是允许。
  2. 每个可锁单元的修改都走 actions 中带锁检查的入口，检查器不再直接调用 `applyEdit`。
  3. 结构类操作（删除台词或场景、移出角色、删除轨道）如果会删掉锁定的单元，就拒绝并说明原因；重排不改变内容，可以允许。
  4. 场景"标题"行的锁只锁标题。如果需要整场景锁，单独做一个开关。
- 验收：e2e 依次验证——锁定服装后换装被拒；锁定台词后，检查器和剧本面板改文字都被拒；删除"带锁定关键帧的台词"被拒；锁定后解锁总能成功；unit 覆盖 `removeBeat/setActorInScene` 遇到锁时的返回值。

**F3（高，直接操作）在自动构图镜头里拖动人物，屏幕上看不到变化。**
- 位置：`StageOverlay.tsx`（`move` 拖动 → `placeActorAt` → 改 slot，重新编译后求解器让相机跟着人）。
- 修复：拖动期间冻结本句相机（预览用的临时 pose，不写入项目），让人物跟手移动；松手后再重新求解，并显示 toast 说明"自动镜头已重新取景；要固定画面位置，请 Shift 拖动或切换为手动镜头"。或者在工具栏提供显式模式「拖动 = 站位 / 画面位置」，自动的多人镜头默认用"画面位置"（写 `shot.offsets`）。同时修正：建立镜头期间相机工具应提示"空镜头不可编辑"，或者编辑空镜头本身，而不是悄悄修改第一句的镜头。
- 验收：e2e 在自动双人镜头中拖动 300 px，拖动过程中人物在屏幕上至少移动 250 px；松手后的行为与所选模式一致，并有提示。

**F4（中）滚轮误改数据。** `StageOverlay` 的 wheel：鼠标停在人物上、不按修饰键就会改纵深。改为 Alt+滚轮（并写进叠加层右上角的提示文字），或者只对已选中的人物生效，并在状态栏显示"纵深 0.08→0.12"。e2e：普通滚轮不改变项目。

**F5（中，假选项）`insert` 景别没有目标框。** 景别下拉、分镜卡片和批量修改里都能选 `insert`，结果只是一个更大的脸部特写。要么在预览上画框（`shot.insertBox {x,y,w,h}`，相对人物包围盒；求解器以框为目标；检查器可以输入数值），要么在实现之前从所有下拉中移除，并对旧数据给出 warning。

**F6（中，AI 前置）id 会复用。** `mutate.ts` 中 `nextId` 改为"已有同前缀编号的最大值 + 1"（或在项目上保存 `idSeq`），保证同一项目内删除过的 id 永不复用。unit：删掉末尾一句再新增，id 不同；undo/redo 后不会产生冲突。

**F7（中，反馈）编辑到预览约 200 ms。** 规范要求 <100 ms（PLAN_REVISION §4.3）。离散修改（下拉、按钮、复选）跳过 120 ms 防抖，立即 reload；连续拖动按 rAF 节流。e2e 记录"选择表情 → `state().actors[].expression` 改变"的时间 <120 ms（留出测试开销余量）。

**F8（中，精致度）界面文案与图标一致性。**
1. 时间轴、分镜和检查器里的景别、句子类型、表情、手势统一显示中文标签，原始 id 作为次要灰字或 tooltip（`lanes.ts` 的 `valueLabel`、`Timeline` 对白块和镜头块、`Storyboard` 卡片）。
2. 🔒🔓 等彩色 emoji 换成与检查器一致的单色 SVG 图标（`Timeline.tsx`、`Outline.tsx`、`Storyboard.tsx`）。
3. 转场块宽度小于文字宽度时显示图标 + tooltip，不再截成 "d."。
4. 分镜卡片下拉只显示中文短名。
5. 选中人物（舞台、检查器或大纲）后，时间轴自动滚动到该人物的轨道组。
6. toast 自动消失，并且不残留到下一次操作。

### 5.1 P10.1 完成状态（2026-10-10，Sonnet 实施，待验收方复验）

| # | 状态 | 要点与证据 |
|---|---|---|
| F1 | 已完成 | `evaluate` 输出 `bgZoom`，手动镜头带 `bgZoom` / `roll`；`DOF_BLUR` 重调为 `[0,1,1.8,3.5,5.5,8,11]`。证据：unit（two_shot 1.45 / cu ≥2.5 / 手动值透传）；e2e `p101`（背景层实际缩放 = 风格表 ±3%，改 `shots.two_shot.bgZoom` 即时生效）；截图 `.verify/p101-bg-s1b2/s1b3/s3b6.png`（MCU 背景的桌椅窗框恢复为可辨认的尺度，CU 虚化与原作同级） |
| F2 | 已完成 | `shared/project/locks.ts` 为唯一锁闸门，`applyEdit` 统一拦截；toast 带「解锁」。证据：unit `locks.test.ts`（15 例：单元自身内容、轨道拥有关键帧、场景标题锁只管标题、删除/移出/重排、解锁、store 层多路径）；e2e：锁定服装后换装被拒、锁定台词后检查器与剧本面板改字被拒且删除被拒、带锁定关键帧的台词删除被拒、解锁后成功 |
| F3 | 已完成 | 自动镜头里焦点人物的普通拖动 = 画面位置（`shot.offsets`），Ctrl+拖动 = 站位；空镜头期间相机工具提示而不改第一句。e2e：拖动 300 px，拖动中和松手后人物都移动 >250 px |
| F4 | 已完成 | 必须 Alt+滚轮；e2e：普通滚轮项目 JSON 不变，Alt+滚轮改变并提示“纵深 a → b” |
| F5 | 已完成 | `shot.insertBox` + 检查器 4 个滑块 + 求解器；unit + e2e（改框后相机位置与缩放随之变化，截图 `p101-insert.png`） |
| F6 | 已完成 | `idSeq` 单调计数，删除后不复用；unit（删尾再加、轨道 / 关键帧 / 场景 / 角色、保存读取、撤销重做） |
| F7 | 已完成 | 去防抖，rAF + 单飞重载；e2e 4 次取中位数 <120 ms；实测 68 / 65 / 60 / 71 ms |
| F8 | 已完成 | 中文标签（`shared/catalog/labels.ts`）、单色 SVG 锁、转场块窄时显示“◐”+ tooltip、分镜下拉短名、选中人物时间轴滚动到其轨道、toast 下一次成功编辑即清除；截图 `p101-editor.png`、`p101-storyboard.png` |
| E4 | 已完成 | `/play` 视口自适应 + 全屏 + 画幅选择（16:9 / 宽画幅 2.16:1），截图 `p101-play-wide.png`；E7 先前已在 compile 中实现 |

自动化：typecheck / lint 通过；unit 22 文件 / 232 用例；integration 4 文件 / 18 用例；完整 e2e 75 / 75（3.0 min，含新增 `p101.spec.ts` 11 条）。已删除验收遗留项目 `data/projects/p_mv1vdexsk91w`。

遗留（不影响 P11）：宽画幅下相机取景仍按 16:9 求解，只是窗口更宽、背景盖满；若要原作那样在宽画幅里重新安排双人 / 群像站位，需要把 `faceLayout` 的参考宽度也参数化（建议 P15 放映模式时一并做）。`StageOverlay` 的 `screenToWorld` 仍假定 16:9（编辑器里没有宽画幅）。

### 6. 可延后项

| # | 内容 | 位置 | 阶段 |
|---|---|---|---|
| E4 | `/play` 全屏自适应，以及画幅选择（16:9 / 原作宽画幅） | PlayPage | P15（建议提前到 P10.1 顺手做） |
| E7 | 背景 luma（暗场 dof 加成） | 背景元数据 | P11 前顺手 |
| E8 | 首页项目列表缩略图与搜索 | EditorApp | P15 |
| E9 | 相机框手柄（拖框、缩放、旋转 roll），PLAN_REVISION §4.3 | StageOverlay | P10.1 后 |
| E10 | 关键帧贝塞尔曲线编辑器；句级 cutIn 三段时长在时间轴上拖动 | Timeline/KeyFields | P14 前 |
| E11 | 角色层 / 句子层的规则导演开关与强度（目前只有风格层的全局开关） | style、Inspector | P13 前 |
| E12 | "强制切镜"改为显式字段（如 `shot.hold: false`），不再依赖 `touch` 的副作用 | ShotFields、compile | P13 前 |
| E13 | 拆分 `Timeline.tsx` 的拖拽状态；地点条整体拖动改为按相对位移 | timeline | 任意 |
| E14 | J 键真倒放 | useShortcuts | P15 |

### 7. 对 AI 阶段（P11–P15）的前置检查
- **meta/locked 是否贯穿**：项目、场景各部件（背景、服装、站位、转场、地点条、BGM）、台词、镜头、轨道、关键帧都有 `meta`。缺口：台词只有一个整体锁，无法只锁文字或时长；`shot.offsets`、`blocking.enter/exit` 跟随上级的锁。P13 前需要决定是否引入字段级锁（建议 `meta.lockedFields?: string[]`，只用于台词与镜头）。**F2 必须先修**，否则"锁定后 AI 不覆盖"这条承诺在人工路径上就已经不成立。
- **规则导演能否被 AI 意图替换**：手势和表情的让位是按句判断的（这一句已有关键帧就不再生成），可以直接与 AI 产出叠加。**听者转头**的让位是按"场景 × 人物"整体判断的：只要该人物有任意一个 head 关键帧，整场的规则转头全部消失（`compile.ts:245`）。AI 只想改一句，就会让其余句子的听者都不再转头。P13 前要改为按句、按区间让位。规则导演的产出（`ruleKeys`）已经与真实关键帧同构，可以烘焙。这一点做得好，可以直接用来做 P14 的 diff 视图。
- **局部重新生成所需的粒度**：关键帧以 `{beatId, offset}` 锚定，句子和场景 id 稳定（F6 修复后不再复用），这对按句范围、按通道合并已经够用。通道到数据的映射如下：镜头 = `camera` 轨道 + `beat.shot`；表演 = `motion`/`expression`/`head`/`body`/`gaze` 轨道 + `beat.emotion`；服装 = `wardrobe` + `costume` 轨道。这个映射应写进 `shared/director/scope.ts`，避免 P14 各处各写一份。

---

## 最终验收（P0–P15，2026-10-10，Opus）

- 基线 `5cd0a89`。复用 5273/5274 dev server，未终止；测试期间由 Playwright 起的 5373/5374 已随测试退出。证据都在 `.verify/final/`（gitignored）和 `.verify/final-vs-ref.png`。
- **结论：基本达到用户需求，有条件通过。** 一键生成、原作风格演出、编辑器、锁定、保存和导入导出都能用真实模型跑通。下面的 H1、H2 是用户第一眼就会碰到的问题，建议作为 P16 先修。

### 1. 自动化
| 检查 | 结果 |
|---|---|
| typecheck / lint | 通过（0 告警） |
| unit | 29 文件 / 324 用例 通过 |
| integration | 4 通过，2 跳过（live） / 18 用例 |
| e2e（Edge，完整 83 条） | 第 1 轮 82/83：`probe.spec` 偶发 500，根因是并发 PUT calibration 时临时文件同名，已修（见 §5）。第 2 轮 82/83：`editor-blank` 偶发失败，单独重复 4 次都通过。第 3 轮 83/83 |
| `LLM_LIVE=1`（deepseek-flash） | 5 条中 4 条通过。Pass 1：4 场景，13.4 s；Pass 2：56 句 8 次调用，无效资源率 0，锁定冲突 0。小说整篇：6 场景 / 100 句，12 次调用，81.8 s。**失败的 1 条**：重跑仍然多发了 1 次请求（10 vs 9），原因是被截断的调用不进缓存（M2） |

### 2. 一键生成（浏览器，从首页开始，真实 deepseek-flash）
- 输入：`examples/mygo-rehearsal.txt` 加一行结尾，用来绕过缓存。结果：**140.4 s，9 次调用，缓存命中 0，修复 0，输入 46 964 / 输出 35 996 tokens**。生成 5 个场景、96 句，连续性检查"未发现问题"，console 错误 0。
- 内容：背景都是真实资源（教室 → RiNG 咖啡厅 → 录音室 → 夜景 → Live 舞台），带地点条。服装连续且合理：灯在第三章换上便服（`001_casual_spring_01`），立希穿打工制服，正式演出 5 人全部换成 `live-mode`，并按乐队站位，鼓在后面，灯拿麦。

### 3. /play 连续播放（1920×890，宽画幅）
- 360.9 s 的项目实际用时 364 s 播完，每 3 s 抽 1 帧，共 117 帧，console 错误 0（`sheet-00..07.png`）。
- 与原作并排对比（`final-vs-ref.png`）：MCU、双人、群像的头部比例、站位、留白、对话框、名字条、菜单钮、背景虚化，都与 t043 / t071 / t094 同一套语言。看过原作的玩家看到正常的对白镜头，会认出是"Our Notes 的演出"。
- 破绽（按出现频率）：
  - (a) **insert 镜头**拍到的是没有头的躯干或裙摆，而且常常配叙述或台词（f017–018、f032–034，H2）。
  - (b) 叙述句约占 50%（48/96），都显示在无名字的对话框里，节奏比原作慢、"读小说感"重（M4）。
  - (c) 叙述内容与姿态对不上，例如"灯趴在桌上"时角色是站着的。这是素材动作库的限制。

### 4. 编辑器全流程（真实鼠标和键盘，1920×1080，`.verify/final/ed-*.png`）
| 操作 | 结果 |
|---|---|
| 锁整句 + 锁台词文字（字段锁）+ 锁服装 → AI 重生成整场（先看差异） | 67 s 后出现差异视图，按结构 / 镜头 / 表演 / 服装 / 站位分组，显示前后值。接受后，三处锁定都保持不变 ✓ |
| 部分接受 | 整场重生成必然带台词结构变化，所有范围的复选框都被禁用（"只能整体接受"）。单一范围的重生成只有一个范围，按钮也不出现。**实际上没有办法按范围部分接受**（M1） |
| 只重做选中台词（表演） | 57 s 后报"模型输出被截断（达到 max_tokens）"，没有任何改动 ✗（H1） |
| 拖人 / 转头 / 表情 / 换装 / 景别 / 转场 / 时间轴双击加关键帧 | 都生效。拖 150 px，头框移动 143 px；状态栏有修饰键提示 ✓ |
| 撤销 3 步再重做 3 步 | 恢复完全一致 ✓ |
| 保存后刷新 | 只有 `updatedAt` 不同 ✓ |
| 导出再导入 | 导出 388 KB，导入前有确认框（列出素材是否齐全），导入后场景与导出完全一致 ✓ |
| 精致度 | 编辑器达到专业工具水准：暗色 token 统一，分区清楚，差异视图和来源徽标都很好。扣分项：首页只是朴素列表，没有缩略图、搜索或引导，开发期的测试项目（"p9 视觉"、"glow"…）堆在列表里；差异视图与检查器"规则导演"一行仍直接显示原始 id（`group cut`、`neutral`、`exp_idle01`）；左栏的差异表太窄，"第5句"会折行（M3） |

### 5. 仓库卫生
- `git ls-files` 共 259 个文件。素材只有 `tests/fixtures/fake-assets`，是手写的假文件，每个不超过 2 KB。没有 Cubism Core、`.env`、data 或大二进制文件（最大的是 package-lock 185 KB）。`git log --all -p` 中不含真实 key：用 .env 里的值做字面检索，0 处命中。
- 源码中没有 `console.log`（server 启动日志除外）、debugger 或 TODO；没有未被引用的模块；THIRD_PARTY 正确。**没有 LICENSE 文件**（L5，由用户决定用哪种许可证）。
- 本次已修复并提交：
  1. 原子写入的临时文件名加随机后缀（calibration、backgrounds、projects、llm-cache），避免并发写时 rename 失败返回 500。
  2. README 开头"只实现到 P2"的过时说明；".env 不会自动加载"的错误说法；补充 Node 22+ 与 Edge 要求；示例小说是 5 章，不是 6 章。

### 6. 待办（按严重度）
**H1 只重做选中台词时输出被截断（局部重生成在真实模型上不可用）。**
- 位置：`server/llm/sceneRunner.ts`。非结构模式下 `tokens = 1500 + 700 × fixedHere.length`（只重做一句时约 2200），而输入仍包含整场段落，模型多半会输出整场的节拍。截断后，只有 `paras.length < 4` 才会加倍重试，场景较长时直接失败；错误文案也不可操作。
- 修复：focusBeatIds 模式下只发送目标句所在段落及前后一段，并在 prompt 和 schema 中要求只输出 focus 节拍；maxTokens 下限设为 4000；非结构模式总允许一次加倍重试；错误提示改为"输出过长被截断：请缩小范围或重试"。
- 验收：在 live 测试中加入"单句表演重生成"一例。

**H2 insert 镜头产生无头躯干画面。**
- 位置：`server/llm/prompts/sceneDirection.ts` 只写了"insert=手部或物件特写"；`shared/staging/framing.ts` 的 `DEFAULT_INSERT_BOX` 固定框在胸前；validate 不检查。
- 修复：validate 中，insert 只允许用于"该句有手势或乐器动作，或者文本提到手、物件"的句子，否则降级为 cu 并给出警告；给 AI 一个 `insertTarget`（hands / instrument / face_lower）枚举，映射到 insertBox 预设；规则导演同样处理。
- 验收：对一键生成结果统计，insert 帧中头框为空、且没有手或乐器的比例为 0。

**M1 按范围部分接受实际上不可达。** 位置：`shared/director/diff.ts`（structural）、`web/editor/panels/AiResultCard.tsx`。修复：结构变化时允许"接受结构 + 所选范围"，未选范围对新句由规则导演补齐，对保留句维持原值；或者提供逐句接受。补一条 `ai-accept-sel` 的 e2e（目前没有任何测试覆盖）。

**M2 截断或失败的请求不进缓存，续跑会重发。** 位置：`server/llm/pipeline.ts` / `sceneRunner.ts`。修复：缓存"该请求会被截断"的标记（或者分段决策），续跑时直接走拆分路径；让 live 测试的缓存断言恢复通过。

**M3 原始 id 残留。** 差异视图的镜头 / 情绪 / 表情值，以及检查器"规则导演"一行，统一用 `shared/catalog/labels.ts` 的中文标签，原始 id 放进 tooltip；AI 面板的差异表加宽，或改用两行布局。

**M4 叙述比例过高。** 在 Pass 2 prompt 中要求把动作类叙述转成 silent 节拍和动作或表情，只保留必要的旁白（目标 ≤25%）；同时在检查器中提供"叙述 → 无声"的批量操作。

**L1** 章节检测把书名 `# 迷子们的排练日` 也算成章节（显示 6，实际 5 章）：`web/textImport.ts` 中，一级标题出现在首行且后面有 `##` 时，不计入章节。

**L2** 首页：缩略图、搜索、批量删除（E8）。另外，用户的 `data/projects` 中有约 15 个开发期遗留项目，建议用户自行清理（属于用户数据，验收方没有删除）。

**L3** e2e 在 3 个 worker 并行时偶发失败（editor-blank 的表情关键帧轮询）：轮询前先 `settled()`，或者把该 spec 设为串行。

**L4** 拖动的修饰键随镜头类型变化（自动构图时是 Ctrl，否则是 Shift），容易混淆：统一为一个修饰键，或者在工具栏提供显式的"站位 / 画面位置"切换。

**L5** 没有 LICENSE；`.env.example` 中的 `ASSET_ROOT` 是本机路径，建议改成占位符。

**L6** 编辑器会话中出现过 1 次 502（Vite 代理），之后后端健康，原因未定位；建议在 SSE 长请求两端加日志后观察。

### 7. 评分（10 分制）
- 原作还原 7.5
- AI 一键生成 8
- 编辑器功能 8
- 锁定与局部重生成 6.5（H1、M1）
- 保存与导入导出 9
- 前端精致度 7（编辑器 8，首页 5.5）
- 仓库卫生 9

## P16 修复状态（Sonnet，2026-10-10）

| 项 | 状态 | 做法 / 证据 |
|---|---|---|
| H1 只重做选中台词被截断 | 已修 | 局部模式只发目标句所在段落及前后各 1 段，只要求输出 focus 节拍；max_tokens 下限 4000；截断总允许一次加倍重试，再按"所选台词对半"降级；错误文案改为可操作。真实模型（deepseek-flash）：12 句场景选 1 句，1 次调用 6.7 s，锁定句、人工改写句、其余镜头全部不变。live 测试新增此例。 |
| H2 insert 无头躯干 | 已修 | AI 新增 `insertTarget`（hands / instrument / face_lower，映射 insertBox 预设）；validate：无手势/乐器演奏/原文物件提示时降级为 cu 并警告；prompt 限 1 个/场景。一键生成的 72 句里仅 1 个 insert（演奏吉他），画面为手与吉他。live 测试新增"insert 必有可拍之物"。 |
| M1 按范围部分接受 | 已修 | `alignToOld`：同说话人同文本的句子对应旧句 id，差异视图与部分接受都基于它；结构变化时结构只能整体接受，其余范围可单选，作用于台词没变的句子。新增 e2e（删一句后整场重生成，只接受镜头范围）。真实模型已验证。 |
| M2 截断请求不进缓存 | 已修 | 缓存存"该请求在 N tokens 被截断"标记，同样或更小的 max_tokens 不再发送；更大的会发送，成功后覆盖。LLM_LIVE 缓存断言通过（7/7）。 |
| M3 原始 id | 已修 | 差异视图的景别/切入/情绪/表情/动作/视线/服装/转场用中文名；表项改两行布局（位置+字段 / 前 → 后）；检查器"规则导演"用中文标签，原始值在 tooltip。 |
| M4 叙述占比 | 已修（prompt） | 旁白目标约 20%、≤25%，动作神态并入 actors 或 silent 节拍。真实模型整篇：72 句中旁白 11（15%），无声 21。未做"叙述→无声"批量按钮。 |
| L1 章节数 | 已修 | 首行 `# 书名` 后面有 `##` 时不计章节（5 章）。 |
| L2 首页 | 已修（缩略图、搜索、批量删除） | 见下。开发期遗留项目未删。 |
| L3 e2e 不稳定 | 已修 | `editor-blank` 表情关键帧：每次尝试前 `settled()`，改用 `toPass` 重选不同值直到关键帧出现。完整 e2e 连续 2 轮 85/85。 |
| L4 拖动修饰键 | 已修 | 统一为 Shift = 切换另一种拖动（自动构图默认画面位置、Shift 为站位；否则相反）。 |
| L5 | 部分 | `.env.example` 的 ASSET_ROOT 改占位符；LICENSE 仍由用户决定。 |
| L6 502 | 仅加日志 | Vite 代理失败时在 dev 终端打印方法、路径和原因；未复现。 |

**首页**：品牌头 + 一句话说明；四张起步卡（导入小说一键生成、新建、示例、导入文件）；"最近的项目"为卡片网格（第一场景背景当封面、场景/句/角色数、相对时间）、搜索、批量管理删除、空状态与无匹配提示。

**测试**：typecheck、lint 通过；unit 30 文件 / 327 用例；integration 18 通过（8 跳过=live）；e2e 85/85 连续 2 轮；`LLM_LIVE=1` 7/7（原 5 条 + 局部重生成 + insert）。截图 `.verify/p16-*.png`（home、editor、h2-insert、h1-m3-diff、m1-partial、m1-after）。
遗留：验证时生成的项目 `p_mv2aimrc02qt`（data/projects）按"不删用户数据"保留，可自行删除。

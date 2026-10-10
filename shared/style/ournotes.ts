/**
 * Style preset system (PLAN_REVISION P7.2). Every number that shapes the look of a shot, the dialogue UI, the
 * rhythm, transitions, performance and effects lives here, so engine / solver / compiler only READ it.
 *
 * Three inheritance layers: preset (global) -> project.style -> scene.style -> beat.style. A layer stores
 * `overrides` keyed by dotted field path (e.g. "dialog.nameSize"); `resolveStyle` merges them in order and
 * reports which layer each value came from, so the inspector can show "inherited / overridden" per field.
 * Vertical sizes are shares of the stage height H, horizontal ones share of H from an edge or the centre
 * (STYLE_REFERENCE: the game keeps its vertical field of view, widescreen only shows more at the sides).
 */

export const STYLE_SHOT_KEYS = ['establishing', 'group', 'two_shot', 'mcu', 'cu', 'ecu', 'insert'] as const;
export type StyleShotKey = (typeof STYLE_SHOT_KEYS)[number];

const shot = (headH: number, eyeY: number, topMargin: number, lookRoom: number, bgZoom: number, dof: number) => ({ headH, eyeY, topMargin, lookRoom, bgZoom, dof });

/** Defaults taken from STYLE_REFERENCE sections 1-8. */
const BASE = {
  shots: {
    /** No people; the background shows at 1x and sharp. */
    establishing: shot(0, 0.5, -1, 0, 1, 0),
    group: shot(0.4, 0.32, -1, 0.02, 1.35, 2),
    two_shot: shot(0.39, 0.37, 0.04, 0.02, 1.45, 2),
    mcu: shot(0.52, 0.4, 0.02, 0.07, 1.5, 2),
    cu: shot(0.7, 0.43, -1, 0.03, 2.5, 5),
    ecu: shot(0.95, 0.42, -1, 0.02, 3.2, 6),
    /** Body-part insert: head height only sets how large the box is; the face leaves the frame. */
    insert: shot(1.6, 0.1, -2, 0, 2.8, 5),
  },
  framing: {
    /**
     * The calibrated head box is not the visible head: measured on the real models the hair top sits 3% above the box top,
     * the chin 85% of the way down (the box also covers the neck) and the eyes 59% down. headH / eyeY / topMargin of the
     * shot table refer to the visible head (hair top to chin), like the measurements in the reference video.
     */
    eyeFrac: 0.59,
    headTop: -0.03,
    headChin: 0.85,
    /** Safe margin (share of frame) that single-person heads keep horizontally. */
    safeX: 0.06,
    darkDofBonus: 1,
    darkLuma: 0.15,
    /** Two-shot: both face centres sit this far (share of H) left / right of the frame centre (original t051: +-0.47H). */
    twoShotFaceX: 0.47,
    /** Group of three, screen left to right (original t094); more people are spread linearly between the outer two. */
    groupFaceX0: -0.5,
    groupFaceX1: 0.19,
    groupFaceX2: 0.7,
    /** 0..1: how far the eye lines of a multi-person shot are pulled towards their mean (original: height difference <= 0.07H). */
    heightEqualize: 0.75,
    /** 0..1: how far the head sizes of the two people of a two-shot are pulled together (model scale differs between characters). */
    sizeEqualize: 0.85,
    /** Chest line below the head, in head heights, used for the bystander visibility test. */
    chestHeads: 2.6,
    /** Hair / sleeves reach this many head widths beyond the head box on each side (bystander box). */
    hairSpread: 0.9,
    /** A bystander showing a share inside (edgeMin, edgeMax) is "cut in half" by the frame edge. */
    edgeMin: 0.05,
    edgeMax: 0.7,
    /** Zoom factor of push_in / pull_out, share of the frame width of a pan / track, and the shake amplitude (share of H). */
    moveZoom: 1.08,
    panShare: 0.04,
    shakeAmplitude: 0.006,
  },
  stage: {
    /** Environment multiply colour of actors (the dark corridor barely darkens people in the original). */
    actorTint: 0.92,
    /** Listeners are not dimmed. */
    listenerDim: 0,
  },
  rhythm: {
    textSpeedCps: 10,
    readingCps: 6.5,
    minLine: 1.8,
    tail: 0.8,
    lineGap: 0,
    minShotSeconds: 4,
    enforceMinShot: true,
    silentSeconds: 1.8,
    emptySeconds: 1.8,
  },
  dialog: {
    theme: 'ournotes' as 'ournotes' | 'plate',
    gradientY0: 0.7,
    gradientY1: 0.83,
    color: '#1A1030',
    maxAlpha: 0.75,
    nameSize: 32 / 1080,
    nameLeft: 426 / 1080,
    nameBaseline: 835 / 1080,
    nameColor: '#FFFFFF',
    nameWeight: 400,
    ruleY: 847 / 1080,
    ruleLeft: 414 / 1080,
    ruleLength: 1050 / 1080,
    ruleThickness: 2 / 1080,
    ruleColor: '#A2B6CE',
    textSize: 34 / 1080,
    textTop: 881 / 1080,
    textLeft: 426 / 1080,
    textWidth: 1070 / 1080,
    lineHeight: 45 / 1080,
    textWeight: 400,
    maxLines: 2,
    shadowAlpha: 0.5,
    monologueBrackets: true,
    offscreenNameTemplate: '{name}的声音',
    multiSeparator: ' & ',
  },
  hud: {
    menuVisible: true,
    menuDiameter: 0.1,
    menuRight: 0.135,
    menuTop: 0.064,
    menuColorTop: '#4B5382',
    menuColorBottom: '#555E9F',
    menuRing: '#8A93C8',
    autoVisible: true,
    autoRight: 269 / 1080,
    autoTop: 1001 / 1080,
    autoDiameter: 53 / 1080,
    autoAlpha: 0.8,
    /** The auto-play mark is part of the dialogue area: hidden whenever the dialogue is (empty shots, black screens). */
    autoFollowsDialog: true,
    /** Rotation speed of the auto-play mark (the original turns about 72 degrees per second). */
    autoSpinDegPerSec: 72,
    /** The menu button is hidden while the screen is (almost) pure black. */
    menuHideOnBlack: true,
    hideUi: false,
  },
  location: {
    centerY: 0.5,
    height: 58 / 1080,
    color: '#7F9BEA',
    alpha: 0.75,
    solidHalf: 0.4,
    fadeHalf: 0.6,
    textSize: 32 / 1080,
    textColor: '#FFFFFF',
    strokeColor: '#2A2E45',
    delay: 0.9,
    slideIn: 0.25,
    hold: 1.9,
    slideOut: 0.2,
    slideDistance: 40 / 1080,
    afterGap: 0.5,
  },
  transitions: {
    dipOut: 0.2,
    dipHold: 0.2,
    dipIn: 0.25,
    sceneHideDialog: true,
    scenePause: 0.5,
    sceneOut: 0.8,
    sceneHold: 1.2,
    sceneIn: 0.9,
    endFade: 1.5,
  },
  performance: {
    enterSeconds: 0.2,
    enterSlide: 0.04,
    exitSeconds: 0.25,
    reframeSeconds: 0.8,
    glideSeconds: 0,
    ruleDirector: true,
    gestureEvery: 1,
    exprAtLineStart: true,
    listenerTurnDelay: 0.3,
    /** Bystanders make a small reaction (nod, glance ...) when they have been still this long while somebody else speaks. */
    listenerReact: true,
    listenerReactGap: 5,
    mouthGain: 1,
  },
  fx: {
    anxietyDesat: 0.35,
    anxietyInset: 0.2,
    anxietyDarkness: 0.8,
    anxietyGlow: 6 / 1080,
    /** Smoke texture of the anxiety vignette: strength, fog colour, drift speed (clock multiplier) and the actor outer-glow radius factor. */
    anxietySmoke: 0.95,
    anxietyTint: '#2A2830',
    anxietySmokeSpeed: 0.06,
    anxietyGlowScale: 0.25,
    glowBlackLift: 0.26,
    glowChroma: 6 / 1080,
    glowBloom: 0.6,
    /** The dialogue gradient keeps this share of its opacity at full memory glow (the original's bottom gradient washes out with the picture). */
    glowDialogAlpha: 0.55,
    dutchRoll: 10,
  },
};

type Widen<T> = T extends number ? number : T extends string ? T : T extends boolean ? boolean : { [K in keyof T]: Widen<T[K]> };
export type StyleValues = Widen<typeof BASE>;

export const OURNOTES_STYLE: StyleValues = BASE;

/** Legacy look: the old plate dialogue box and the fast pre-P7.2 rhythm. */
export const PRESETS: Record<string, { label: string; values: StyleValues }> = {
  ournotes: { label: '原作风格', values: OURNOTES_STYLE },
  'bandori-plate': {
    label: '旧版面板 bandori-plate',
    values: { ...OURNOTES_STYLE, dialog: { ...OURNOTES_STYLE.dialog, theme: 'plate' }, performance: { ...OURNOTES_STYLE.performance, glideSeconds: 0.5 }, rhythm: { ...OURNOTES_STYLE.rhythm, textSpeedCps: 14, readingCps: 14, minLine: 1.2, tail: 0.45, minShotSeconds: 0, enforceMinShot: false } },
  },
};
export const DEFAULT_PRESET = 'ournotes';

// ---- field metadata (drives validation and the generic inspector) -----------------------------------------
export type FieldKind = 'number' | 'int' | 'bool' | 'color' | 'text' | 'enum';
export interface StyleField {
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<[string, string]>;
}

const G = { shot: '景别', frame: '构图', stage: '舞台', rhythm: '节奏', dialog: '对话区', hud: 'HUD', loc: '地点标题条', trans: '转场', perf: '表演', fx: '特效' };
const num = (path: string, label: string, group: string, min: number, max: number, step: number, unit?: string): StyleField => ({ path, label, group, kind: 'number', min, max, step, ...(unit ? { unit } : {}) });
const int = (path: string, label: string, group: string, min: number, max: number): StyleField => ({ path, label, group, kind: 'int', min, max, step: 1 });
const bool = (path: string, label: string, group: string): StyleField => ({ path, label, group, kind: 'bool' });
const color = (path: string, label: string, group: string): StyleField => ({ path, label, group, kind: 'color' });
const text = (path: string, label: string, group: string): StyleField => ({ path, label, group, kind: 'text' });

const SHOT_LABEL: Record<StyleShotKey, string> = { establishing: '空镜', group: '群像', two_shot: '双人', mcu: '胸像 MCU', cu: '近景 CU', ecu: '大特写 ECU', insert: '插入' };
const shotFields = (): StyleField[] =>
  STYLE_SHOT_KEYS.flatMap((k) => [
    num(`shots.${k}.headH`, `${SHOT_LABEL[k]} 头高/H`, G.shot, 0, 2.5, 0.01),
    num(`shots.${k}.eyeY`, `${SHOT_LABEL[k]} 眼线 y/H`, G.shot, 0, 1, 0.01),
    num(`shots.${k}.topMargin`, `${SHOT_LABEL[k]} 头顶最小留白/H`, G.shot, -2, 0.5, 0.01),
    num(`shots.${k}.lookRoom`, `${SHOT_LABEL[k]} 视线留白`, G.shot, 0, 0.3, 0.005),
    num(`shots.${k}.bgZoom`, `${SHOT_LABEL[k]} 背景放大`, G.shot, 1, 6, 0.05, '×'),
    int(`shots.${k}.dof`, `${SHOT_LABEL[k]} 景深 dof`, G.shot, 0, 6),
  ]);

export const STYLE_FIELDS: StyleField[] = [
  ...shotFields(),
  num('framing.eyeFrac', '眼睛在头框内位置', G.frame, 0.3, 0.9, 0.01),
  num('framing.headTop', '发顶相对头框顶', G.frame, -0.3, 0.3, 0.01),
  num('framing.headChin', '下巴在头框内位置', G.frame, 0.5, 1.2, 0.01),
  num('framing.safeX', '横向安全边距', G.frame, 0, 0.3, 0.005),
  int('framing.darkDofBonus', '暗背景 dof 加成', G.frame, 0, 3),
  num('framing.darkLuma', '暗背景亮度阈值', G.frame, 0, 1, 0.01),
  num('framing.twoShotFaceX', '双人 脸中心距画面中线/H', G.frame, 0, 1, 0.01),
  num('framing.groupFaceX0', '群像 左起第 1 人脸 x/H', G.frame, -1, 1, 0.01),
  num('framing.groupFaceX1', '群像 第 2 人脸 x/H', G.frame, -1, 1, 0.01),
  num('framing.groupFaceX2', '群像 最右人脸 x/H', G.frame, -1, 1, 0.01),
  num('framing.heightEqualize', '多人镜头 眼线拉平', G.frame, 0, 1, 0.05),
  num('framing.sizeEqualize', '双人镜头 头高拉平', G.frame, 0, 1, 0.05),
  num('framing.chestHeads', '胸线（头高倍数）', G.frame, 1, 5, 0.1),
  num('framing.hairSpread', '头发/衣袖外扩（头宽倍数）', G.frame, 0, 3, 0.05),
  num('framing.edgeMin', '边缘侵入下限（可见比例）', G.frame, 0, 0.5, 0.01),
  num('framing.edgeMax', '边缘侵入上限（可见比例）', G.frame, 0.3, 1, 0.01),
  num('framing.moveZoom', '推拉倍率', G.frame, 1, 1.5, 0.01, '×'),
  num('framing.panShare', '横移幅度/画面宽', G.frame, 0, 0.3, 0.005),
  num('framing.shakeAmplitude', '抖动幅度/H', G.frame, 0, 0.05, 0.001),
  num('stage.actorTint', '人物环境乘色', G.stage, 0.3, 1, 0.01),
  num('stage.listenerDim', '听者压暗', G.stage, 0, 0.6, 0.01),
  num('rhythm.textSpeedCps', '逐字速度', G.rhythm, 2, 40, 0.5, '字/秒'),
  num('rhythm.readingCps', '阅读语速（无语音）', G.rhythm, 2, 30, 0.5, '字/秒'),
  num('rhythm.minLine', '最短句时长', G.rhythm, 0.2, 10, 0.1, 's'),
  num('rhythm.tail', '句尾停留', G.rhythm, 0, 5, 0.05, 's'),
  num('rhythm.lineGap', '句间隔', G.rhythm, 0, 3, 0.05, 's'),
  num('rhythm.minShotSeconds', '最短镜头时长', G.rhythm, 0, 20, 0.5, 's'),
  bool('rhythm.enforceMinShot', '强制最短镜头（短句沿用上一机位）', G.rhythm),
  num('rhythm.silentSeconds', '无声节拍默认时长', G.rhythm, 0.3, 10, 0.1, 's'),
  num('rhythm.emptySeconds', '空景节拍默认时长', G.rhythm, 0.3, 10, 0.1, 's'),
  { path: 'dialog.theme', label: '对话区主题', group: G.dialog, kind: 'enum', options: [['ournotes', '原作风格'], ['plate', '旧版面板']] },
  num('dialog.gradientY0', '渐变起点 y/H', G.dialog, 0, 1, 0.01),
  num('dialog.gradientY1', '渐变满强度 y/H', G.dialog, 0, 1, 0.01),
  color('dialog.color', '渐变颜色', G.dialog),
  num('dialog.maxAlpha', '最大不透明度', G.dialog, 0, 1, 0.01),
  num('dialog.nameSize', '名字字号/H', G.dialog, 0.01, 0.1, 0.0005),
  num('dialog.nameLeft', '名字左边距/H', G.dialog, 0, 1.5, 0.002),
  num('dialog.nameBaseline', '名字基线 y/H', G.dialog, 0.3, 1, 0.002),
  color('dialog.nameColor', '名字颜色', G.dialog),
  int('dialog.nameWeight', '名字字重', G.dialog, 100, 900),
  num('dialog.ruleY', '分隔线 y/H', G.dialog, 0.3, 1, 0.002),
  num('dialog.ruleLeft', '分隔线左边距/H', G.dialog, 0, 1.5, 0.002),
  num('dialog.ruleLength', '分隔线长度/H', G.dialog, 0, 2, 0.01),
  num('dialog.ruleThickness', '分隔线粗细/H', G.dialog, 0, 0.02, 0.0005),
  color('dialog.ruleColor', '分隔线颜色', G.dialog),
  num('dialog.textSize', '正文字号/H', G.dialog, 0.01, 0.1, 0.0005),
  num('dialog.textTop', '正文首行顶 y/H', G.dialog, 0.3, 1, 0.002),
  num('dialog.textLeft', '正文左边距/H', G.dialog, 0, 1.5, 0.002),
  num('dialog.textWidth', '正文宽度/H', G.dialog, 0.3, 2, 0.01),
  num('dialog.lineHeight', '行距/H', G.dialog, 0.01, 0.15, 0.0005),
  int('dialog.textWeight', '正文字重', G.dialog, 100, 900),
  int('dialog.maxLines', '最多行数', G.dialog, 1, 6),
  num('dialog.shadowAlpha', '文字阴影', G.dialog, 0, 1, 0.05),
  bool('dialog.monologueBrackets', '独白自动加括号', G.dialog),
  text('dialog.offscreenNameTemplate', '画外音名字模板', G.dialog),
  text('dialog.multiSeparator', '多人名字连接符', G.dialog),
  bool('hud.menuVisible', '显示菜单按钮', G.hud),
  num('hud.menuDiameter', '菜单按钮直径/H', G.hud, 0.03, 0.2, 0.002),
  num('hud.menuRight', '菜单按钮圆心距右/H', G.hud, 0, 0.5, 0.002),
  num('hud.menuTop', '菜单按钮圆心距上/H', G.hud, 0, 0.5, 0.002),
  color('hud.menuColorTop', '菜单按钮渐变上', G.hud),
  color('hud.menuColorBottom', '菜单按钮渐变下', G.hud),
  color('hud.menuRing', '菜单按钮描边', G.hud),
  bool('hud.autoVisible', '显示 Auto 图标', G.hud),
  num('hud.autoRight', 'Auto 距右/H', G.hud, 0, 0.6, 0.002),
  num('hud.autoTop', 'Auto 圆心 y/H', G.hud, 0, 1, 0.002),
  num('hud.autoDiameter', 'Auto 直径/H', G.hud, 0.02, 0.15, 0.002),
  num('hud.autoAlpha', 'Auto 不透明度', G.hud, 0, 1, 0.05),
  bool('hud.autoFollowsDialog', 'Auto 图标跟随对话区显隐', G.hud),
  num('hud.autoSpinDegPerSec', 'Auto 图标转速', G.hud, 0, 360, 1, '°/s'),
  bool('hud.menuHideOnBlack', '纯黑场时隐藏菜单按钮', G.hud),
  bool('hud.hideUi', '隐藏全部 UI（导出）', G.hud),
  num('location.centerY', '中心 y/H', G.loc, 0, 1, 0.002),
  num('location.height', '条高/H', G.loc, 0.01, 0.2, 0.002),
  color('location.color', '条带颜色', G.loc),
  num('location.alpha', '条带不透明度', G.loc, 0, 1, 0.05),
  num('location.solidHalf', '实色半宽/H', G.loc, 0, 1.5, 0.02),
  num('location.fadeHalf', '渐隐半宽/H', G.loc, 0, 2, 0.02),
  num('location.textSize', '字号/H', G.loc, 0.01, 0.1, 0.0005),
  color('location.textColor', '文字颜色', G.loc),
  color('location.strokeColor', '描边颜色', G.loc),
  num('location.delay', '渐亮后出现延迟', G.loc, 0, 5, 0.05, 's'),
  num('location.slideIn', '滑入时长', G.loc, 0, 2, 0.05, 's'),
  num('location.hold', '停留', G.loc, 0, 10, 0.1, 's'),
  num('location.slideOut', '滑出时长', G.loc, 0, 2, 0.05, 's'),
  num('location.slideDistance', '滑动距离/H', G.loc, 0, 0.3, 0.002),
  num('location.afterGap', '退出后到角色入场', G.loc, 0, 5, 0.05, 's'),
  num('transitions.dipOut', '黑场眨眼 渐黑', G.trans, 0, 2, 0.05, 's'),
  num('transitions.dipHold', '黑场眨眼 纯黑', G.trans, 0, 2, 0.05, 's'),
  num('transitions.dipIn', '黑场眨眼 渐亮', G.trans, 0, 2, 0.05, 's'),
  bool('transitions.sceneHideDialog', '换场先隐藏对话区', G.trans),
  num('transitions.scenePause', '换场 停顿', G.trans, 0, 5, 0.05, 's'),
  num('transitions.sceneOut', '换场 渐黑', G.trans, 0, 5, 0.05, 's'),
  num('transitions.sceneHold', '换场 纯黑', G.trans, 0, 5, 0.05, 's'),
  num('transitions.sceneIn', '换场 渐亮', G.trans, 0, 5, 0.05, 's'),
  num('transitions.endFade', '结尾渐黑', G.trans, 0, 5, 0.1, 's'),
  num('performance.enterSeconds', '入场淡入', G.perf, 0, 2, 0.05, 's'),
  num('performance.enterSlide', '入场滑入距离/H', G.perf, 0, 0.3, 0.005),
  num('performance.exitSeconds', '退场淡出', G.perf, 0, 2, 0.05, 's'),
  num('performance.reframeSeconds', '入场重构图时长', G.perf, 0, 3, 0.05, 's'),
  num('performance.glideSeconds', '镜头切换滑移时长（0 = 硬切）', G.perf, 0, 3, 0.05, 's'),
  bool('performance.ruleDirector', '规则导演', G.perf),
  int('performance.gestureEvery', '每 N 句换手势', G.perf, 1, 6),
  bool('performance.exprAtLineStart', '句首换表情', G.perf),
  num('performance.listenerTurnDelay', '听者转头延迟', G.perf, 0, 1, 0.05, 's'),
  bool('performance.listenerReact', '听者反应动作', G.perf),
  num('performance.listenerReactGap', '听者反应最小间隔', G.perf, 0, 30, 0.5, 's'),
  num('performance.mouthGain', '口型增益', G.perf, 0, 2, 0.05),
  num('fx.anxietyDesat', '不安暗角 去饱和', G.fx, 0, 1, 0.05),
  num('fx.anxietyInset', '不安暗角 边缘宽度/W', G.fx, 0, 0.5, 0.01),
  num('fx.anxietyDarkness', '不安暗角 边缘遮暗', G.fx, 0, 1, 0.05),
  num('fx.anxietyGlow', '不安暗角 人物外发光/H', G.fx, 0, 0.03, 0.0005),
  num('fx.anxietySmoke', '不安暗角 烟雾纹理强度', G.fx, 0, 1, 0.05),
  color('fx.anxietyTint', '不安暗角 雾色', G.fx),
  num('fx.anxietySmokeSpeed', '不安暗角 烟雾流速', G.fx, 0, 1, 0.01),
  num('fx.anxietyGlowScale', '不安暗角 外发光半径系数', G.fx, 0, 1, 0.05),
  num('fx.glowBlackLift', '泛光 黑位抬升', G.fx, 0, 0.5, 0.01),
  num('fx.glowChroma', '泛光 色差/H', G.fx, 0, 0.03, 0.0005),
  num('fx.glowBloom', '泛光 强度', G.fx, 0, 1, 0.05),
  num('fx.glowDialogAlpha', '泛光 对话区渐变保留比例', G.fx, 0, 1, 0.05),
  num('fx.dutchRoll', '荷兰角 倾斜°', G.fx, 0, 30, 0.5, '°'),
];

const FIELD_BY_PATH = new Map(STYLE_FIELDS.map((f) => [f.path, f]));
export const styleField = (path: string): StyleField | undefined => FIELD_BY_PATH.get(path);

/** Value coerced to what `field` accepts, or undefined when it is not valid (invalid overrides are ignored, never thrown). */
export function coerceStyleValue(field: StyleField, v: unknown): number | string | boolean | undefined {
  switch (field.kind) {
    case 'number':
    case 'int': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      const x = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, v));
      return field.kind === 'int' ? Math.round(x) : x;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
    case 'text':
      return typeof v === 'string' ? v : undefined;
    case 'enum':
      return typeof v === 'string' && field.options?.some(([o]) => o === v) ? v : undefined;
  }
}

export function getStylePath(values: StyleValues, path: string): number | string | boolean {
  let cur: unknown = values;
  for (const k of path.split('.')) cur = (cur as Record<string, unknown>)[k];
  return cur as number | string | boolean;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** A style layer as stored on Project / Scene / Beat (`StyleSchema` in schema/project.ts). */
export interface StyleLayerLike {
  preset?: string | undefined;
  overrides?: Record<string, unknown> | undefined;
}
export type StyleOrigin = 'preset' | 'project' | 'scene' | 'beat';
export interface ResolvedStyle {
  values: StyleValues;
  origin: Record<string, StyleOrigin>;
  /** Override keys that are not style fields or whose value is invalid (ignored). */
  issues: string[];
}

const LAYER_NAMES: StyleOrigin[] = ['project', 'scene', 'beat'];

export function resolveStyle(project?: StyleLayerLike | null, scene?: StyleLayerLike | null, beat?: StyleLayerLike | null): ResolvedStyle {
  const presetId = project?.preset && PRESETS[project.preset] ? project.preset : DEFAULT_PRESET;
  const values = structuredClone(PRESETS[presetId]!.values) as StyleValues;
  const origin: Record<string, StyleOrigin> = {};
  for (const f of STYLE_FIELDS) origin[f.path] = 'preset';
  const issues: string[] = [];
  [project, scene, beat].forEach((layer, i) => {
    for (const [path, raw] of Object.entries(layer?.overrides ?? {})) {
      const field = FIELD_BY_PATH.get(path);
      const v = field ? coerceStyleValue(field, raw) : undefined;
      if (!field || v === undefined) {
        issues.push(`${LAYER_NAMES[i]}: ${path}`);
        continue;
      }
      setPath(values as unknown as Record<string, unknown>, path, v);
      origin[path] = LAYER_NAMES[i]!;
    }
  });
  return { values, origin, issues };
}

/** Per-shot spec by (canonical) shot type key. */
export const shotSpec = (v: StyleValues, key: StyleShotKey) => v.shots[key];

/** Compact, token-cheap text views of the project for the agent: one line per scene, one line per beat, a full dump of one beat on demand. */
import { cameraSystemOf, type Beat, type Project, type Scene } from '../schema/project';
import { resolveStyle } from '../style/ournotes';
import { fxStates, keyValueText, CHANNEL_NAME } from './apply';
import { onStageIds } from './check';
import { beatLineInfo, lineFlag } from './lines';
import { HIDDEN_REASON_LABEL, scenePresence, type BeatPresence } from '../timeline/presence';

export const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);
export const nameOf = (p: Project, id: string | undefined) => (id ? p.cast.find((c) => c.id === id)?.displayName || id : '—');
export const KIND: Record<Beat['kind'], string> = { dialogue: '对', narration: '旁', action: '动', pause: '停', establishing: '空景', silent: '默', empty: '空' };

export interface AgentSelection {
  sceneId?: string | null | undefined;
  beatId?: string | null | undefined;
  castId?: string | null | undefined;
  /** A multi-selection of beats in script order ("这几句 / 这段 / 选中的 / these lines"). */
  beatIds?: string[] | undefined;
}

const SHORT_HIDDEN: Record<string, string> = { empty_beat: '空镜句', empty_shot_bg: '空镜背景', opacity_0: '透明' };
export const BG_PURPOSE_TEXT: Record<string, string> = { move: '换地点', time: '换时段', insert: '空镜(无人)' };
/** The 画面 column: who the viewer really sees during a beat (compiled presence, not the blocking). */
function screenCell(project: Project, pr: BeatPresence | undefined, total: number): string {
  if (!pr) return '—';
  const hidden = Object.values(pr.hidden).filter((r) => r in SHORT_HIDDEN).map((r) => SHORT_HIDDEN[r]!);
  const who = pr.visible.length === total && total > 0 ? '全员' : pr.visible.map((c) => nameOf(project, c)).join('+') || '无人';
  return hidden.length ? `${who}(隐藏:${[...new Set(hidden)].join(',')})` : who;
}

const MULTI_LISTED = 40;
/** The lines of a multi-selection with their text; empty when fewer than two of the ids exist. */
function multiLines(project: Project, ids: string[] | undefined): string {
  const want = new Set(ids ?? []);
  const rows: string[] = [];
  project.scenes.forEach((s, si) => s.beats.forEach((b, bi) => {
    if (want.has(b.id)) rows.push(`  #${si + 1}场 第${bi + 1}句 ${b.id} ${nameOf(project, b.speakerId)}:「${clip(b.text, 40)}」`);
  }));
  if (rows.length < 2) return '';
  const shown = rows.slice(0, MULTI_LISTED);
  return `\n用户多选了 ${rows.length} 句（「这几句 / 这段 / 选中的 / these lines」指这些句子，只改它们；顺序即剧本顺序）：\n${shown.join('\n')}${rows.length > shown.length ? `\n  …另有 ${rows.length - shown.length} 句` : ''}`;
}

export function projectSummary(project: Project, sel: AgentSelection = {}): string {
  const lines = project.scenes.map((s, i) => {
    const who = Object.keys(s.wardrobe).map((c) => `${nameOf(project, c)}(${c})`).join(',');
    return `#${i + 1} ${s.id}「${clip(s.title, 16)}」 bg=${s.background.assetId} ${s.beats.length}拍 人物:${who} 相机=${cameraSystemOf(project, s)}`;
  });
  const scene = project.scenes.find((s) => s.id === sel.sceneId);
  const beatIdx = scene ? scene.beats.findIndex((b) => b.id === sel.beatId) : -1;
  const beat = scene && beatIdx >= 0 ? scene.beats[beatIdx] : undefined;
  const seg = scene && beatIdx >= 0 ? passageOf(scene.beats, beatIdx) : null;
  const selection = scene
    ? `当前选区：场景=#${project.scenes.indexOf(scene) + 1} ${scene.id}${beat ? `；台词=第${beatIdx + 1}句 ${beat.id}（${nameOf(project, beat.speakerId)}:「${clip(beat.text, 14)}」）` : ''}${seg && seg[1] > seg[0] ? `；所在段落=第${seg[0] + 1}–${seg[1] + 1}句（「这段/这一段」指它）` : ''}${sel.castId ? `；角色=${nameOf(project, sel.castId)}(${sel.castId})` : ''}`
    : '当前选区：无';
  return `项目「${project.title}」 角色表：${project.cast.map((c) => `${c.id}=${c.displayName}`).join('，')}\n${lines.join('\n')}\n${selection}${multiLines(project, sel.beatIds)}`;
}

/**
 * The passage a beat belongs to (0-based inclusive range): a run of dialogue, with the silent reaction beats inside it, or a run of
 * narration / action. A pause, an establishing shot or a change between the two kinds ends it.
 */
export function passageOf(beats: Beat[], i: number): [number, number] {
  const talk = (b: Beat) => b.kind === 'dialogue' || b.kind === 'silent';
  const prose = (b: Beat) => b.kind === 'narration' || b.kind === 'action';
  const same = talk(beats[i]!) ? talk : prose(beats[i]!) ? prose : null;
  if (!same) return [i, i];
  let a = i;
  let z = i;
  while (a > 0 && same(beats[a - 1]!)) a--;
  while (z < beats.length - 1 && same(beats[z + 1]!)) z++;
  // a silent beat at either edge is a reaction to what is around it, not part of the talk
  while (same === talk && a < i && beats[a]!.kind === 'silent') a++;
  while (same === talk && z > i && beats[z]!.kind === 'silent') z--;
  return [a, z];
}

/** 景别 plus what changes the picture without changing the size: depth of field (背景虚化) and per-person offsets (画面偏移). */
function shotCell(project: Project, b: Beat): string {
  const off = Object.entries(b.shot.offsets ?? {}).filter(([, o]) => o && (o.x !== 0 || o.y !== 0)).map(([c, o]) => `${nameOf(project, c)}${o.x >= 0 ? '+' : ''}${o.x}${o.y ? `/${o.y >= 0 ? '+' : ''}${o.y}` : ''}`);
  return `${b.shot.type}${b.shot.dof ? `·景深${b.shot.dof}` : ''}${off.length ? `·偏移(${off.join(',')})` : ''}`;
}

function lockFlags(b: Beat): string {
  const f: string[] = [];
  if (b.meta.locked) f.push('锁:整句');
  else if (b.meta.lockedFields?.length) f.push(`锁:${b.meta.lockedFields.join('/')}`);
  if (b.shot.meta.locked) f.push('锁:镜头');
  else if (b.shot.meta.lockedFields?.length) f.push(`锁:镜头.${b.shot.meta.lockedFields.join('/')}`);
  if (b.style.meta.locked) f.push('锁:节奏');
  if (b.meta.source === 'user') f.push('手改:句');
  if (b.shot.meta.source === 'user') f.push('手改:镜头');
  if (b.style.meta.source === 'user') f.push('手改:节奏');
  return f.join(' ');
}

/** The table of one scene, optionally limited to a beat range (1-based, inclusive). */
export function sceneTable(project: Project, sceneId: string, range: { from?: number; to?: number } = {}): string {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return `场景 ${sceneId} 不存在`;
  const cam = cameraSystemOf(project, scene);
  const travel = cam === 'travel';
  const fx = fxStates(scene);
  const from = Math.max(1, range.from ?? 1);
  const to = Math.min(scene.beats.length, range.to ?? scene.beats.length);
  const head = `场景 ${scene.id}「${scene.title}」 相机=${cam} 开场背景=${scene.background.assetId}${scene.location ? ` 地点条=「${scene.location.text}」${scene.location.show ? '' : '(隐藏)'}` : ''} 转场=${scene.transitionIn.kind}${scene.brief?.isPerformance ? ' 【正式演出】' : ''}${scene.meta.locked ? ' 【场景已锁】' : ''}`;
  const stage = Object.entries(scene.blocking).map(([c, bl]) => `${nameOf(project, c)}(${c}) 站位${bl.slot.toFixed(2)}/${bl.depth.toFixed(2)} 服装${scene.wardrobe[c]?.modelId ?? '—'}${bl.enter ? ` 进场=第${scene.beats.findIndex((b) => b.id === bl.enter!.beatId) + 1}句` : ''}${bl.exit ? ` 离场=第${scene.beats.findIndex((b) => b.id === bl.exit!.beatId) + 1}句` : ''}${bl.meta.locked ? ' 锁' : ''}`);
  const bgKeys = scene.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys).map((k) => { const v = k.value as { assetId: string; purpose?: string }; return `第${scene.beats.findIndex((b) => b.id === k.at.beatId) + 1}句→${v.assetId}(${BG_PURPOSE_TEXT[v.purpose ?? 'move'] ?? v.purpose})`; });
  const presence = scenePresence(project, scene.id);
  const total = Object.keys(scene.wardrobe).length;
  const cols = `#|id|类|说话人|台词|景别|焦点|运镜${travel ? '/意图/flow' : ''}|特效|情绪|节奏|标记|画面上的人`;
  const rows: string[] = [];
  for (let i = from; i <= to; i++) {
    const b = scene.beats[i - 1]!;
    const rhythm = Object.entries(b.style.overrides).filter(([k]) => k.startsWith('rhythm.')).map(([k, v]) => `${k.slice(7)}=${String(v)}`).join(',') || (b.duration.mode === 'fixed' ? `固定${b.duration.seconds}s` : '—');
    const flow = b.shot.transition === 'cut' ? 'cut' : b.shot.transition === 'travel' ? 'move' : b.shot.transition ?? 'auto';
    rows.push([i, b.id, KIND[b.kind], nameOf(project, b.speakerId), `「${clip(b.text, 20)}」`, shotCell(project, b), b.shot.focus.map((f) => nameOf(project, f)).join('+') || '—', `${b.shot.move}${travel ? `/${b.shot.intent ?? '—'}/${flow}` : ''}`, fx[i - 1], b.emotion ?? '—', rhythm, [lockFlags(b), b.splitFrom !== undefined ? '续句' : '', lineFlag(beatLineInfo(project, scene, b))].filter(Boolean).join(' ') || '—', screenCell(project, presence[i - 1], total)].join('|'));
  }
  const absent = Object.keys(scene.blocking).filter((c) => !onStageIds(scene, 0).has(c)).map((c) => `${nameOf(project, c)}(第${scene.beats.findIndex((b) => b.id === scene.blocking[c]!.enter?.beatId) + 1}句进)`);
  return [head, `人物:\n${stage.join('\n')}`, absent.length ? `开场未在台上: ${absent.join('，')}` : '', bgKeys.length ? `场景内换背景: ${bgKeys.join('，')}` : '', '「画面上的人」= 这一句实际显示的人物（已扣除未进场/离场、空镜句、空镜背景、透明度 0；单人景别只拍焦点）；景别后的「景深N」= 背景虚化（0–6，越大背景越糊），「偏移」= 这一镜里人物的画面偏移（舞台高度为单位，绝对值大了会出画）', cols, ...rows].filter(Boolean).join('\n');
}

/** 「，3 行，超长（对话框 2 行）」 / 「，3 行，已展开」 for the read-back of one beat; '' when the line is fine. */
function lineText(project: Project, scene: Scene, b: Beat): string {
  const li = beatLineInfo(project, scene, b);
  if (!li || (!li.expanded && !li.over)) return '';
  return `，${li.lines} 行${li.expanded ? '，已展开' : `，超长（对话框 ${li.max} 行）`}`;
}

/** Everything about one beat (read-back for verification): fields, shot, rhythm, and its keys. */
export function beatDetail(project: Project, sceneId: string, beatId: string): string {
  const scene = project.scenes.find((s) => s.id === sceneId);
  const i = scene?.beats.findIndex((b) => b.id === beatId) ?? -1;
  if (!scene || i < 0) return `台词 ${beatId} 不在场景 ${sceneId}`;
  const b = scene.beats[i]!;
  const meta = (m: Beat['meta']) => `${m.source}${m.locked ? '/已锁' : ''}${m.lockedFields?.length ? `/锁${m.lockedFields.join(',')}` : ''}`;
  const style = resolveStyle(project.style, scene.style, b.style).values.rhythm;
  const keys = scene.tracks.flatMap((t) => t.keys.filter((k) => k.at.beatId === beatId).map((k) => ({ t, k })))
    .sort((a, c) => a.k.at.offset - c.k.at.offset)
    .map(({ t, k }) => `  ${k.id} ${CHANNEL_NAME[t.channel] ?? t.channel}${t.target.kind === 'actor' ? `(${nameOf(project, t.target.castId)})` : ''} +${k.at.offset}s ${keyValueText(t.channel, k.value, (x) => nameOf(project, x))} dur=${k.duration} ease=${k.ease} [${meta(k.meta)}${t.meta.locked ? '/轨道已锁' : ''}]`);
  const on = [...onStageIds(scene, i)].map((c) => nameOf(project, c)).join('、');
  const pr = scenePresence(project, scene.id)[i];
  const seen = pr ? pr.visible.map((c) => nameOf(project, c)).join('、') || '无人' : '—';
  const unseen = pr ? Object.entries(pr.hidden).map(([c, r]) => `${nameOf(project, c)}=${HIDDEN_REASON_LABEL[r]}`).join('；') : '';
  return [
    `第${i + 1}句 ${b.id} 所在场景 ${scene.id}「${scene.title}」 [${meta(b.meta)}]`,
    `类型=${b.kind} 形式=${b.variant} 说话人=${nameOf(project, b.speakerId)}${b.coSpeakers.length ? `+${b.coSpeakers.map((c) => nameOf(project, c)).join('、')}` : ''} 情绪=${b.emotion ?? '—'} 切入=${b.cutIn}${b.cutInKeepDialog ? '(保留对白)' : ''}`,
    `文字(${[...b.text].length}字${lineText(project, scene, b)})：${b.text}${b.splitFrom !== undefined ? `
这是拆开的长句的后续段（首段 ${b.splitFrom}），镜头跟着首段走` : ''}`,
    `镜头 [${meta(b.shot.meta)}]：${JSON.stringify({ type: b.shot.type, focus: b.shot.focus, move: b.shot.move, dof: b.shot.dof, transition: b.shot.transition, intent: b.shot.intent, insertBox: b.shot.insertBox, offsets: b.shot.offsets })}`,
    `节奏 [${meta(b.style.meta)}]：覆盖=${JSON.stringify(b.style.overrides)} 生效 readingCps=${style.readingCps} tail=${style.tail} lineGap=${style.lineGap} minLine=${style.minLine}；时长=${b.duration.mode === 'fixed' ? `固定${b.duration.seconds}s` : '自动'}`,
    `此时在台上（按进出场）：${on || '—'}`,
    `画面上实际看得见：${seen}${unseen ? `；看不见：${unseen}` : ''}`,
    keys.length ? `关键帧：\n${keys.join('\n')}` : '关键帧：无',
  ].join('\n');
}

export interface FoundBeat {
  sceneId: string;
  sceneNo: number;
  beatId: string;
  beatNo: number;
  speaker: string;
  text: string;
  /** Set when the text only matched approximately (0..1: share of the quoted characters found in order). */
  approx?: number;
}

export const PUNCT = /[「」『』“”"'\s…。，、！？!?,.~～—-]/g;
/** Longest common subsequence length of two short strings (the quote and a line), for the approximate text match. */
export function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!);
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/**
 * Search the whole project: by speaker (cast id or name), a text fragment, and/or scene. A quote the user remembered slightly wrong
 * («不知道怎么往下写» for «不知道该怎么往下写……») still finds its line: when nothing contains the fragment, lines that contain most of its
 * characters in order (≥ 70 %) are returned, best first, marked approximate.
 */
export function findBeats(project: Project, q: { sceneId?: string | undefined; speaker?: string | undefined; text?: string | undefined; limit?: number | undefined }): FoundBeat[] {
  const sp = q.speaker?.trim();
  const speakerIds = sp ? project.cast.filter((c) => c.id === sp || c.displayName === sp || c.displayName.includes(sp) || (sp.length >= 2 && sp.includes(c.displayName.slice(-2)))).map((c) => c.id) : null;
  const needle = q.text?.replace(PUNCT, '') ?? '';
  const pool: Array<FoundBeat & { plain: string }> = [];
  project.scenes.forEach((s, si) => {
    if (q.sceneId && s.id !== q.sceneId) return;
    s.beats.forEach((b, bi) => {
      if (speakerIds && !(b.speakerId && speakerIds.includes(b.speakerId))) return;
      pool.push({ sceneId: s.id, sceneNo: si + 1, beatId: b.id, beatNo: bi + 1, speaker: nameOf(project, b.speakerId), text: clip(b.text, 24), plain: b.text.replace(PUNCT, '') });
    });
  });
  const strip = (m: FoundBeat & { plain: string }): FoundBeat => { const { plain, ...x } = m; void plain; return x; };
  if (!needle) return pool.slice(0, q.limit ?? 12).map(strip);
  const exact = pool.filter((x) => x.plain.includes(needle));
  if (exact.length) return exact.slice(0, q.limit ?? 12).map(strip);
  const chars = [...needle];
  return pool
    .map((x) => ({ x, score: lcs(chars, [...x.plain]) / chars.length }))
    .filter((m) => m.score >= 0.7 && chars.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, q.limit ?? 12))
    .map((m) => ({ ...strip(m.x), approx: Math.round(m.score * 100) / 100 }));
}

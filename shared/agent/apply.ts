/**
 * Applies an AgentOp to a project (or an Immer draft of it). Pure and deterministic: absolute values come in with the op, ids come with the
 * op (`newId`, `newKeyId`) or from the monotonic id rule. Returns what changed (before -> after, for the change card) and which hand-made
 * (`source: user`) units were overwritten. It does NOT enforce locks: `checkOp` simulates the op and asks `findLockViolations`, and the
 * editor's `applyEdit` gate is the final barrier.
 */
import { absTime, anchorAt, clone, ensureTrack, findTrack, locateKey, newBeat, newKeyId, nextId, removeBeat, removeKey, repairSplitGroups, setActorInScene, storedBeatTimes, type AnyKey } from '../project/mutate';
import { bgSwitchValue } from '../director/bgKeys';
import { memoryThroughWhite } from '../director/expand';
import { EMOTION_LABEL, SHOT_LABEL, MOVE_LABEL, TRANSITION_LABEL, expressionLabel, motionLabel } from '../catalog/labels';
import { SHOT_INTENT_LABEL } from '../staging/shotIntent';
import { cameraSystemOf, type Beat, type MemoryTone, type Meta, type Project, type Scene } from '../schema/project';
import { resolveStyle } from '../style/ournotes';
import { FLASH_SECONDS } from '../timeline/fxParams';
import { ONE_SHOT_FX } from '../director/vocab';
import { TIGHTER } from '../director/splitPieces';
import { scopeOf, type AgentOp, type AgentScope } from './ops';

export interface ApplyCtx {
  genId: string;
  now: number;
}
export interface Change {
  scope: AgentScope;
  where: string;
  field: string;
  before: string;
  after: string;
  beatId?: string;
}
export interface ApplyResult {
  ok: boolean;
  error?: string;
  changes: Change[];
  /** Hand-made (`source: user`) units this op overwrote. */
  overwrote: string[];
  /** Things the op left alone on purpose (locked keys of a range ...). */
  skipped: string[];
}

type AnyTrack = { id: string; target: { kind: string; castId?: string }; channel: string; meta: Meta; keys: AnyKey[] };
const tracksOf = (scene: Scene) => scene.tracks as unknown as AnyTrack[];
const fail = (error: string): ApplyResult => ({ ok: false, error, changes: [], overwrote: [], skipped: [] });

const clip = (s: string, n = 18) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s);
const jsonShort = (v: unknown): string => {
  if (v === undefined || v === null) return '无';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? '是' : '否';
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x));
  return s.length > 50 ? `${s.slice(0, 47)}…` : s;
};

export const CHANNEL_NAME: Record<string, string> = { motion: '动作', expression: '表情', head: '头部朝向', body: '身体朝向', gaze: '视线', position: '走位', opacity: '出入场', costume: '换装', camera: '镜头', fade: '黑白场', fx: '特效', background: '背景切换', bgm: 'BGM', se: '音效' };
const GAZE: Record<string, string> = { camera: '看镜头', away: '移开视线', down: '低头' };

/** One key value in words. */
export function keyValueText(channel: string, v: unknown, castName: (id: string) => string = (x) => x): string {
  const o = (v ?? null) as Record<string, unknown> | null;
  if (v === null || v === undefined) return '无';
  if (channel === 'motion') return motionLabel(String(o?.name ?? ''));
  if (channel === 'expression') return o?.name ? expressionLabel(String(o.name)) : '默认表情';
  if (channel === 'gaze' && o && typeof o.target === 'string') return GAZE[o.target] ?? `看${castName(o.target)}`;
  if ((channel === 'head' || channel === 'body') && o) {
    const face = o.mode === 'target' ? (o.target === 'auto' ? '自动朝向' : (GAZE[String(o.target)] ?? `朝向${castName(String(o.target))}`)) : `角度 ${jsonShort(o.yaw)}`;
    return typeof o.pitch === 'number' && o.pitch !== 0 ? `${face}·${o.pitch < 0 ? '低头' : '抬头'}${Math.abs(o.pitch) === 0.6 || Math.abs(o.pitch) === 0.5 ? '' : ` ${jsonShort(o.pitch)}`}` : face;
  }
  if (channel === 'position' && o) return `站位 ${jsonShort(o.slot)} / 深度 ${jsonShort(o.depth)}`;
  if (channel === 'fx' && o) return `${String(o.fx)}${typeof o.strength === 'number' && o.strength !== 1 ? ` ×${jsonShort(o.strength)}` : ''}${o.tone ? `·${String(o.tone)}` : ''}${o.edge ? `·边${String(o.edge)}` : ''}${o.variant ? `·${String(o.variant)}` : ''}`;
  if (channel === 'fade' && o) return `${o.color === 'white' ? '白' : '黑'}场 α${jsonShort(o.alpha)}`;
  if (channel === 'camera' && o) return 'shot' in o ? `${SHOT_LABEL[String(o.shot)] ?? String(o.shot)}` : '手动镜头';
  if (channel === 'background' && o) return `背景 ${String(o.assetId)}（${String(o.transition ?? 'cut')}）`;
  if (channel === 'costume' && o) return String(o.modelId);
  return jsonShort(v);
}

const shotText = (s: Beat['shot']): string => `${SHOT_LABEL[s.type] ?? s.type}${s.focus.length ? `·${s.focus.length}人` : ''}${s.move !== 'static' ? `·${MOVE_LABEL[s.move] ?? s.move}` : ''}${s.dof !== undefined ? `·景深${s.dof}` : ''}${s.transition === 'travel' ? '·运镜' : s.transition === 'cut' ? '·硬切' : s.transition === 'glide' ? '·滑移' : ''}${s.intent ? `·${SHOT_INTENT_LABEL[s.intent]}` : ''}`;

/** The meta a unit gets when the agent changes it. A unit a person edited keeps `source: user` when they confirmed the overwrite. */
function stamp(meta: Meta, op: AgentOp, ctx: ApplyCtx, res: ApplyResult, label: string): void {
  const wasUser = meta.source === 'user';
  if (wasUser && !op.overrideUser) res.overwrote.push(label);
  meta.source = wasUser ? 'user' : 'ai';
  meta.genId = ctx.genId;
  if (op.reason) meta.reason = op.reason;
  meta.updatedAt = ctx.now;
}
const freshMeta = (op: AgentOp, ctx: ApplyCtx): Meta => ({ source: 'ai', locked: false, genId: ctx.genId, ...(op.reason ? { reason: op.reason } : {}), updatedAt: ctx.now });

export function applyOp(project: Project, op: AgentOp, ctx: ApplyCtx): ApplyResult {
  const scene = project.scenes.find((s) => s.id === op.sceneId);
  if (!scene) return fail(`场景 ${op.sceneId} 不存在`);
  const res: ApplyResult = { ok: true, changes: [], overwrote: [], skipped: [] };
  const sc = scopeOf(op);
  const castName = (id: string) => project.cast.find((c) => c.id === id)?.displayName || id;
  const where = (beatId: string) => `第${scene.beats.findIndex((b) => b.id === beatId) + 1}句`;
  const beatOf = (id: string) => scene.beats.find((b) => b.id === id);
  const need = (id: string): Beat | null => beatOf(id) ?? null;
  const push = (field: string, before: string, after: string, beatId?: string, scope: AgentScope = sc) => {
    if (before !== after) res.changes.push({ scope, where: beatId ? where(beatId) : '场景', field, before, after, ...(beatId ? { beatId } : {}) });
  };
  const beatLabel = (b: Beat) => `台词「${clip(b.text, 8)}」`;
  /** The continuations whose first piece changed because of a delete / move / merge, on the change card. */
  const noteGroups = (before: ReadonlyMap<string, string | undefined>) => {
    for (const b of scene.beats) {
      const was = before.get(b.id);
      if (before.has(b.id) && was !== b.splitFrom) push('续句关系', was ?? '无', b.splitFrom ?? '无（成为独立的一句）', b.id);
    }
  };

  switch (op.op) {
    case 'beat_set': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      const s = op.set;
      if (s.text !== undefined) { push('台词', clip(b.text, 24), clip(s.text, 24), b.id); b.text = s.text; }
      if (s.speakerId !== undefined) { push('说话人', b.speakerId ? castName(b.speakerId) : '无', s.speakerId ? castName(s.speakerId) : '无', b.id); if (s.speakerId) b.speakerId = s.speakerId; else delete b.speakerId; }
      if (s.kind !== undefined) { push('类型', b.kind, s.kind, b.id); b.kind = s.kind; }
      if (s.variant !== undefined) { push('台词形式', b.variant, s.variant, b.id); b.variant = s.variant; }
      if (s.emotion !== undefined) { push('情绪', b.emotion ? (EMOTION_LABEL[b.emotion] ?? b.emotion) : '无', s.emotion ? (EMOTION_LABEL[s.emotion] ?? s.emotion) : '无', b.id); if (s.emotion) b.emotion = s.emotion; else delete b.emotion; }
      if (s.cutIn !== undefined) { push('切入', TRANSITION_LABEL[b.cutIn] ?? b.cutIn, TRANSITION_LABEL[s.cutIn] ?? s.cutIn, b.id, 'camera'); b.cutIn = s.cutIn; }
      if (s.splitFrom !== undefined) { push('续句关系', b.splitFrom ?? '无', s.splitFrom ?? '无', b.id); if (s.splitFrom) b.splitFrom = s.splitFrom; else delete b.splitFrom; }
      if (s.cutInKeepDialog !== undefined) { push('切入时保留对白', jsonShort(b.cutInKeepDialog), jsonShort(s.cutInKeepDialog), b.id, 'camera'); b.cutInKeepDialog = s.cutInKeepDialog; }
      if (s.coSpeakers !== undefined) { push('同时说话', b.coSpeakers.map(castName).join('、') || '无', s.coSpeakers.map(castName).join('、') || '无', b.id); b.coSpeakers = s.coSpeakers; }
      if (s.duration !== undefined) {
        const t = (d: Beat['duration']) => (d.mode === 'fixed' ? `固定 ${jsonShort(d.seconds)} 秒` : '自动');
        push('时长', t(b.duration), t(s.duration), b.id, 'rhythm');
        b.duration = { mode: s.duration.mode, seconds: s.duration.seconds };
      }
      stamp(b.meta, op, ctx, res, beatLabel(b));
      return res;
    }
    case 'beat_insert': {
      if (op.afterBeatId !== null && !beatOf(op.afterBeatId)) return fail(`台词 ${op.afterBeatId} 不存在`);
      if (beatOf(op.newId)) return fail(`台词 id ${op.newId} 已被占用`);
      const nb = newBeat(scene, { kind: op.beat.kind, text: op.beat.text, ...(op.beat.speakerId ? { speakerId: op.beat.speakerId } : {}) });
      nb.id = op.newId;
      if (op.beat.kind !== 'dialogue' && !op.beat.speakerId) delete nb.speakerId;
      if (op.beat.emotion) nb.emotion = op.beat.emotion;
      if (op.beat.splitFrom) nb.splitFrom = op.beat.splitFrom;
      nb.meta = freshMeta(op, ctx);
      nb.shot.meta = freshMeta(op, ctx);
      nb.style.meta = freshMeta(op, ctx);
      const i = op.afterBeatId === null ? 0 : scene.beats.findIndex((b) => b.id === op.afterBeatId) + 1;
      scene.beats.splice(i, 0, nb);
      push('新增台词', '—', `${nb.speakerId ? `${castName(nb.speakerId)}：` : ''}${clip(nb.text, 24)}`, nb.id);
      return res;
    }
    case 'beat_delete': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      if (scene.beats.length <= 1) return fail('场景至少要保留一句台词');
      push('删除台词', `${b.speakerId ? `${castName(b.speakerId)}：` : ''}${clip(b.text, 24)}`, '—', b.id);
      if (b.meta.source === 'user') res.overwrote.push(beatLabel(b));
      const before = new Map(scene.beats.map((x) => [x.id, x.splitFrom]));
      removeBeat(scene, b.id);
      noteGroups(before);
      return res;
    }
    case 'beat_move': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      if (op.afterBeatId !== null && (!beatOf(op.afterBeatId) || op.afterBeatId === op.beatId)) return fail(`目标位置 ${op.afterBeatId} 无效`);
      const from = scene.beats.indexOf(b);
      const before = new Map(scene.beats.map((x) => [x.id, x.splitFrom]));
      scene.beats.splice(from, 1);
      const to = op.afterBeatId === null ? 0 : scene.beats.findIndex((x) => x.id === op.afterBeatId) + 1;
      scene.beats.splice(to, 0, b);
      repairSplitGroups(scene);
      noteGroups(before);
      push('顺序', `第${from + 1}句`, `第${to + 1}句`, b.id);
      stamp(b.meta, op, ctx, res, beatLabel(b));
      return res;
    }
    case 'beat_split': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      const chars = [...b.text];
      if (op.at >= chars.length) return fail('拆分位置超出文字长度');
      if (beatOf(op.newId)) return fail(`台词 id ${op.newId} 已被占用`);
      const copy: Beat = { ...clone(b), id: op.newId, text: chars.slice(op.at).join(''), meta: freshMeta(op, ctx) };
      delete copy.sourceOffset;
      push('拆分台词', clip(b.text, 24), `${chars.slice(0, op.at).join('')} ｜ ${copy.text}`, b.id);
      b.text = chars.slice(0, op.at).join('');
      stamp(b.meta, op, ctx, res, beatLabel(b));
      scene.beats.splice(scene.beats.indexOf(b) + 1, 0, copy);
      return res;
    }
    case 'beat_split_pieces': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      if (op.newIds.length !== op.pieces.length - 1) return fail('newIds 的数量要比 pieces 少一个');
      if (op.newIds.some((id) => beatOf(id))) return fail(`台词 id ${op.newIds.find((id) => beatOf(id))} 已被占用`);
      const texts = op.pieces.map((p) => p.text);
      const ids = [b.id, ...op.newIds];
      const lens = texts.map((t) => Math.max(1, [...t].length));
      const total = lens.reduce((x, y) => x + y, 0);
      const rhythm = resolveStyle(project.style, scene.style, b.style).values.rhythm;
      const fixed = b.duration.mode === 'fixed';
      // seconds the whole line takes now; the pieces share it by their length (the hand-set duration is shared out the same way)
      const span = fixed ? b.duration.seconds : Math.max(rhythm.minLine, total / rhythm.readingCps);
      const starts: number[] = [];
      let acc = 0;
      lens.forEach((n) => { starts.push(Math.round(span * (acc / total) * 100) / 100); acc += n; });
      const share = lens.map((n, k) => (k < lens.length - 1 ? Math.round(b.duration.seconds * (n / total) * 100) / 100 : 0));
      share[share.length - 1] = Math.round((b.duration.seconds - share.slice(0, -1).reduce((x, y) => x + y, 0)) * 100) / 100;
      // the person's keys inside the line follow the piece they fall in (a locked key stays where it is)
      for (const t of tracksOf(scene)) {
        if (t.target.kind !== 'actor') continue;
        for (const k of t.keys) {
          if (k.at.beatId !== b.id || k.at.offset <= 0) continue;
          let to = 0;
          for (let j = 1; j < starts.length; j++) if (k.at.offset >= starts[j]! - 1e-9) to = j;
          if (to === 0) continue;
          if (t.meta.locked || k.meta.locked) { res.skipped.push(`${where(b.id)}上锁定的关键帧 ${k.id}（留在第一段）`); continue; }
          k.at = { beatId: ids[to]!, offset: Math.round((k.at.offset - starts[to]!) * 100) / 100 };
        }
      }
      const travel = cameraSystemOf(project, scene) === 'travel';
      const head = b.splitFrom ?? b.id;
      const before = clip(b.text, 24);
      // a deliberate closer (one step tighter, the speaker alone) or reaction (the listener in a close-up) from the model; a hold after the
      // closer keeps the closer's framing, the same rule as the generation's split step (`continuation` in director/splitPieces.ts)
      const dialogue = b.kind === 'dialogue' && !!b.speakerId;
      let closerShot: Beat['shot'] | null = null;
      const conts: Beat[] = op.pieces.slice(1).map((p, k) => {
        const c: Beat = { ...clone(b), id: op.newIds[k]!, text: p.text, splitFrom: head, cutIn: 'cut', cutInKeepDialog: false, meta: freshMeta(op, ctx), style: { overrides: clone(b.style.overrides), meta: freshMeta(op, ctx) } };
        delete c.sourceOffset;
        delete c.overflow;
        if (p.emotion) c.emotion = p.emotion;
        if (p.why) c.meta.reason = p.why;
        // the same shot as the first piece, held (no move, no new framing)
        c.shot = { ...clone(p.camera === 'hold' || !p.camera ? closerShot ?? b.shot : b.shot), move: 'static', meta: freshMeta(op, ctx) };
        delete c.shot.transition;
        let intent: NonNullable<Beat['shot']['intent']> = 'continue';
        const tighter = (TIGHTER as Record<string, Beat['shot']['type'] | undefined>)[b.shot.type];
        if (p.camera === 'closer' && dialogue && b.shot.type !== 'insert' && tighter) {
          c.shot = { ...clone(b.shot), type: tighter, focus: [b.speakerId!], move: 'static', meta: freshMeta(op, ctx) };
          delete c.shot.transition;
          delete c.shot.dof;
          delete c.shot.insertBox;
          intent = 'emphasis';
          if (c.shot.type !== b.shot.type) closerShot = c.shot;
        } else if (p.camera === 'reaction' && dialogue && p.reactionOf) {
          c.shot = { ...clone(b.shot), type: 'cu', focus: [p.reactionOf], move: 'static', meta: freshMeta(op, ctx) };
          delete c.shot.dof;
          delete c.shot.insertBox;
          intent = 'reaction';
          if (travel) c.shot.transition = 'cut';
          closerShot = null;
        }
        if (travel) c.shot.intent = intent; else delete c.shot.intent;
        if (fixed) c.duration = { mode: 'fixed', seconds: share[k + 1]! };
        return c;
      });
      if (fixed) b.duration = { mode: 'fixed', seconds: share[0]! };
      if (b.overflow === 'expand') { res.overwrote.push(`已展开的${beatLabel(b)}`); delete b.overflow; }
      b.text = texts[0]!;
      if (op.pieces[0]!.emotion) b.emotion = op.pieces[0]!.emotion;
      push('拆成几句', before, texts.map((t) => clip(t, 14)).join(' ｜ '), b.id);
      stamp(b.meta, op, ctx, res, beatLabel(b));
      scene.beats.splice(scene.beats.indexOf(b) + 1, 0, ...conts);
      // the speaker's performance in a piece (the keys sit in the piece they belong to, like the generation's: motion shortly after the
      // start, expression at the start, a look at the addressee)
      if (b.speakerId) {
        const who = b.speakerId;
        const add = (channel: 'motion' | 'expression' | 'head' | 'gaze', beatId: string, offset: number, value: unknown, duration = 0, ease = 'inOutQuad') => {
          const tr = ensureTrack(scene, { kind: 'actor', castId: who }, channel as never) as unknown as AnyTrack;
          if (tr.keys.length === 0) tr.meta = freshMeta(op, ctx);
          tr.keys.push({ id: newKeyId(scene), at: { beatId, offset }, value, duration, ease, meta: freshMeta(op, ctx) } as AnyKey);
        };
        op.pieces.slice(1).forEach((p, k) => {
          const id = op.newIds[k]!;
          if (p.motion) add('motion', id, 0.05, { name: p.motion });
          if (p.expression) add('expression', id, 0, { name: p.expression });
          if (p.attention) {
            if (p.attention !== 'down') add('head', id, 0, { mode: 'target', target: p.attention }, 0.3, 'inOutSine');
            add('gaze', id, 0.1, { target: p.attention });
          }
          if (p.motion || p.expression || p.attention) push('表演', '无', [p.motion && motionLabel(p.motion), p.expression && expressionLabel(p.expression), p.attention && '视线'].filter(Boolean).join('·'), id);
        });
      }
      return res;
    }
    case 'dialog_expand': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      const was = b.overflow === 'expand';
      if (was === op.on) return res;
      push('对话框', was ? '展开显示全部' : '默认（限行）', op.on ? '展开显示全部' : '默认（限行）', b.id);
      if (op.on) b.overflow = 'expand'; else delete b.overflow;
      stamp(b.meta, op, ctx, res, beatLabel(b));
      return res;
    }
    case 'beat_merge': {
      const i = scene.beats.findIndex((b) => b.id === op.beatId);
      const b = scene.beats[i];
      const next = scene.beats[i + 1];
      if (!b || !next) return fail('没有可以合并的下一句');
      push('合并台词', `${clip(b.text, 10)} ｜ ${clip(next.text, 10)}`, clip(b.text + next.text, 24), b.id);
      if (next.meta.source === 'user') res.overwrote.push(beatLabel(next));
      b.text += next.text;
      // the pieces of the line that is merged in (it was a first piece) now belong to this one
      const before = new Map(scene.beats.map((x) => [x.id, x.splitFrom]));
      for (const x of scene.beats) if (x.splitFrom === next.id) x.splitFrom = b.splitFrom ?? b.id;
      for (const bl of Object.values(scene.blocking)) {
        if (bl.enter?.beatId === next.id) bl.enter.beatId = b.id;
        if (bl.exit?.beatId === next.id) bl.exit.beatId = b.id;
      }
      removeBeat(scene, next.id);
      noteGroups(before);
      stamp(b.meta, op, ctx, res, beatLabel(b));
      return res;
    }
    case 'shot_set': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      const before = shotText(b.shot);
      const s = op.set;
      if (s.type !== undefined) b.shot.type = s.type as Beat['shot']['type'];
      if (s.focus !== undefined) b.shot.focus = [...s.focus];
      if (s.move !== undefined) b.shot.move = s.move;
      if (s.dof !== undefined) { if (s.dof === null) delete b.shot.dof; else b.shot.dof = s.dof; }
      if (s.transition !== undefined) { if (s.transition === null) delete b.shot.transition; else b.shot.transition = s.transition; }
      if (s.intent !== undefined) { if (s.intent === null) delete b.shot.intent; else b.shot.intent = s.intent as NonNullable<Beat['shot']['intent']>; }
      if (s.insertBox !== undefined) { if (s.insertBox === null) delete b.shot.insertBox; else b.shot.insertBox = s.insertBox; }
      const after = shotText(b.shot);
      push('镜头', before, after, b.id);
      stamp(b.shot.meta, op, ctx, res, `${where(b.id)}的镜头`);
      return res;
    }
    case 'shot_offset': {
      const b = need(op.beatId);
      if (!b) return fail(`台词 ${op.beatId} 不存在`);
      const o = b.shot.offsets?.[op.castId];
      push(`画面偏移（${castName(op.castId)}）`, o ? `${jsonShort(o.x)}, ${jsonShort(o.y)}` : '无', op.offset ? `${jsonShort(op.offset.x)}, ${jsonShort(op.offset.y)}` : '无', b.id);
      if (op.offset) (b.shot.offsets ??= {})[op.castId] = { x: op.offset.x, y: op.offset.y };
      else if (b.shot.offsets) { delete b.shot.offsets[op.castId]; if (Object.keys(b.shot.offsets).length === 0) delete b.shot.offsets; }
      stamp(b.shot.meta, op, ctx, res, `${where(b.id)}的镜头`);
      return res;
    }
    case 'key_set': return applyKeySet(project, scene, op, ctx, res);
    case 'key_shift': {
      const hit = locateKey(scene, op.keyId);
      if (!hit) return fail(`关键帧 ${op.keyId} 不存在`);
      const idx = project.scenes.indexOf(scene);
      const times = storedBeatTimes(project, idx);
      const t = absTime(times, hit.key.at);
      if (t === null) return fail('关键帧所在台词不存在');
      const a = anchorAt(times, Math.max(0, t + op.seconds));
      if (!a) return fail('无法重新定位关键帧');
      const was = `${where(hit.key.at.beatId)} +${jsonShort(hit.key.at.offset)}s`;
      hit.key.at = a;
      push(`${CHANNEL_NAME[hit.track.channel] ?? hit.track.channel}时间`, was, `${where(a.beatId)} +${jsonShort(a.offset)}s`, a.beatId);
      stamp(hit.key.meta, op, ctx, res, '关键帧');
      return res;
    }
    case 'fx_range': return applyFxRange(scene, op, ctx, res, push, where);
    case 'actor_presence': {
      const has = !!scene.wardrobe[op.castId];
      if (op.present === has) return res;
      if (op.present) {
        if (!op.modelId) return fail('让角色入场景需要指定服装 modelId');
        setActorInScene(scene, op.castId, true, op.modelId, op.slot ?? 0);
        scene.wardrobe[op.castId]!.meta = freshMeta(op, ctx);
        scene.blocking[op.castId]!.meta = freshMeta(op, ctx);
      } else {
        const b = scene.blocking[op.castId];
        if (b?.meta.source === 'user') res.overwrote.push(`${castName(op.castId)}的站位`);
        setActorInScene(scene, op.castId, false, '');
      }
      push(`在场（${castName(op.castId)}）`, has ? '在场' : '不在场', op.present ? '在场' : '不在场', undefined, 'staging');
      return res;
    }
    case 'stage_set': {
      const bl = scene.blocking[op.castId];
      if (!bl) return fail(`${castName(op.castId)} 不在这个场景里`);
      const enterText = (e: typeof bl.enter) => (e ? `${where(e.beatId)}进场${e.side !== 'none' ? `（${e.side === 'left' ? '左' : '右'}侧）` : ''}` : '从开场就在');
      const exitText = (e: typeof bl.exit) => (e ? `${where(e.beatId)}离场` : '不离场');
      if (op.enter !== undefined) {
        if (op.enter && !beatOf(op.enter.beatId)) return fail(`台词 ${op.enter.beatId} 不存在`);
        push(`进场（${castName(op.castId)}）`, enterText(bl.enter), op.enter ? enterText(op.enter) : '从开场就在', op.enter?.beatId ?? bl.enter?.beatId);
        if (op.enter) bl.enter = { beatId: op.enter.beatId, side: op.enter.side }; else delete bl.enter;
      }
      if (op.exit !== undefined) {
        if (op.exit && !beatOf(op.exit.beatId)) return fail(`台词 ${op.exit.beatId} 不存在`);
        push(`离场（${castName(op.castId)}）`, exitText(bl.exit), op.exit ? exitText(op.exit) : '不离场', op.exit?.beatId ?? bl.exit?.beatId);
        if (op.exit) bl.exit = { beatId: op.exit.beatId }; else delete bl.exit;
      }
      if (op.slot !== undefined) { push(`开场站位（${castName(op.castId)}）`, jsonShort(bl.slot), jsonShort(op.slot)); bl.slot = op.slot; }
      if (op.depth !== undefined) { push(`开场深度（${castName(op.castId)}）`, jsonShort(bl.depth), jsonShort(op.depth)); bl.depth = op.depth; }
      stamp(bl.meta, op, ctx, res, `${castName(op.castId)}的站位`);
      return res;
    }
    case 'wardrobe_set': {
      const w = scene.wardrobe[op.castId];
      if (!w) return fail(`${castName(op.castId)} 不在这个场景里`);
      push(`服装（${castName(op.castId)}）`, w.modelId, op.modelId, undefined, 'costume');
      w.modelId = op.modelId;
      stamp(w.meta, op, ctx, res, `${castName(op.castId)}的服装`);
      return res;
    }
    case 'timing': {
      const beats = op.beatIds.map(need);
      if (beats.some((b) => !b)) return fail('有台词不存在');
      const keys = op.clear ? Object.keys(op.set).length > 0 ? Object.keys(op.set) : ['rhythm.readingCps', 'rhythm.tail', 'rhythm.lineGap', 'rhythm.minLine', 'rhythm.textSpeedCps'] : Object.keys(op.set);
      for (const path of keys) {
        const rows = (beats as Beat[]).map((b) => {
          const r = resolveStyle(project.style, scene.style, b.style).values.rhythm as unknown as Record<string, number>;
          const before = r[path.replace('rhythm.', '')] ?? 0;
          if (op.clear) delete b.style.overrides[path];
          else b.style.overrides[path] = op.set[path]!;
          return before;
        });
        const after = op.clear ? '恢复默认' : jsonShort(op.set[path]);
        const same = rows.every((x) => x === rows[0]);
        const bs = beats as Beat[];
        if (!op.clear && same && jsonShort(rows[0]) === after) continue;
        res.changes.push({ scope: 'rhythm', where: bs.length === 1 ? where(bs[0]!.id) : `${where(bs[0]!.id)}–${where(bs.at(-1)!.id)}（${bs.length}句）`, field: STYLE_RHYTHM_LABEL[path] ?? path, before: same ? jsonShort(rows[0]) : '各句不同', after, beatId: bs[0]!.id });
      }
      for (const b of beats as Beat[]) stamp(b.style.meta, op, ctx, res, `${where(b.id)}的节奏`);
      return res;
    }
    case 'bg_set': return applyBg(project, scene, op, ctx, res, push);
    case 'scene_set': {
      const s = op.set;
      if (s.title !== undefined) { push('场景标题', scene.title, s.title, undefined, 'structure'); scene.title = s.title; }
      if (s.cameraSystem !== undefined) { push('镜头系统', scene.cameraSystem ?? 'inherit', s.cameraSystem); if (s.cameraSystem === 'inherit') delete scene.cameraSystem; else scene.cameraSystem = s.cameraSystem; }
      if (s.mood !== undefined || s.timeOfDay !== undefined) {
        scene.brief ??= { timeOfDay: '', mood: '', isPerformance: false, band: null };
        if (s.mood !== undefined) { push('场景氛围', scene.brief.mood, s.mood); scene.brief.mood = s.mood; }
        if (s.timeOfDay !== undefined) { push('时间段', scene.brief.timeOfDay, s.timeOfDay); scene.brief.timeOfDay = s.timeOfDay; }
      }
      if (s.transitionIn) { push('场景转场', `${scene.transitionIn.kind} ${scene.transitionIn.duration}s`, `${s.transitionIn.kind} ${s.transitionIn.duration}s`); scene.transitionIn = { kind: s.transitionIn.kind, duration: s.transitionIn.duration, meta: scene.transitionIn.meta }; stamp(scene.transitionIn.meta, op, ctx, res, '转场'); }
      if (s.location) {
        push('地点标题条', scene.location ? `${scene.location.text}（${scene.location.show ? '显示' : '隐藏'}）` : '无', `${s.location.text ?? scene.location?.text ?? ''}（${(s.location.show ?? scene.location?.show ?? true) ? '显示' : '隐藏'}）`);
        if (scene.location) { if (s.location.text !== undefined) scene.location.text = s.location.text; if (s.location.show !== undefined) scene.location.show = s.location.show; stamp(scene.location.meta, op, ctx, res, '地点标题条'); }
        else scene.location = { text: s.location.text ?? scene.title, show: s.location.show ?? true, meta: freshMeta(op, ctx) };
      }
      if (s.title !== undefined || s.mood !== undefined || s.timeOfDay !== undefined || s.cameraSystem !== undefined) stamp(scene.meta, op, ctx, res, `场景「${scene.title}」`);
      return res;
    }
    case 'lock_set': {
      const unit = lockTarget(scene, op);
      if (!unit) return fail('找不到要锁定的对象');
      const before = lockText(unit);
      if (op.locked !== undefined) unit.locked = op.locked;
      if (op.lockedFields !== undefined) { if (op.lockedFields === null || op.lockedFields.length === 0) delete unit.lockedFields; else unit.lockedFields = op.lockedFields; }
      unit.updatedAt = ctx.now;
      push(`锁定（${op.unit}）`, before, lockText(unit), op.beatId, 'lock');
      return res;
    }
  }
}

const STYLE_RHYTHM_LABEL: Record<string, string> = { 'rhythm.readingCps': '阅读语速', 'rhythm.tail': '句尾停留', 'rhythm.lineGap': '句间隔', 'rhythm.minLine': '最短句时长', 'rhythm.textSpeedCps': '逐字速度' };
const lockText = (m: Meta) => (m.locked ? '已锁定' : m.lockedFields?.length ? `锁定字段：${m.lockedFields.join('、')}` : '未锁定');

function lockTarget(scene: Scene, op: Extract<AgentOp, { op: 'lock_set' }>): Meta | null {
  const beat = op.beatId ? scene.beats.find((b) => b.id === op.beatId) : undefined;
  switch (op.unit) {
    case 'scene': return scene.meta;
    case 'beat': return beat?.meta ?? null;
    case 'shot': return beat?.shot.meta ?? null;
    case 'rhythm': return beat?.style.meta ?? null;
    case 'wardrobe': return op.castId ? scene.wardrobe[op.castId]?.meta ?? null : null;
    case 'blocking': return op.castId ? scene.blocking[op.castId]?.meta ?? null : null;
    case 'track': return tracksOf(scene).find((t) => t.id === op.trackId)?.meta ?? null;
    case 'key': return locateKey(scene, op.keyId ?? '')?.key.meta ?? null;
  }
}

type Push = (field: string, before: string, after: string, beatId?: string, scope?: AgentScope) => void;

function applyKeySet(project: Project, scene: Scene, op: Extract<AgentOp, { op: 'key_set' }>, ctx: ApplyCtx, res: ApplyResult): ApplyResult {
  const castName = (id: string) => project.cast.find((c) => c.id === id)?.displayName || id;
  const where = (beatId: string) => `第${scene.beats.findIndex((b) => b.id === beatId) + 1}句`;
  const target = op.target as Parameters<typeof findTrack>[1];
  const who = target.kind === 'actor' ? `（${castName(target.castId)}）` : '';
  const field = `${CHANNEL_NAME[op.channel] ?? op.channel}${who}`;
  const scope = scopeOf(op);
  if (op.at && !scene.beats.some((b) => b.id === op.at!.beatId)) return fail(`台词 ${op.at.beatId} 不存在`);
  const track = findTrack(scene, target, op.channel as never) as unknown as AnyTrack | undefined;
  // which key
  let key: AnyKey | undefined = op.keyId ? track?.keys.find((k) => k.id === op.keyId) ?? locateKey(scene, op.keyId)?.key : undefined;
  if (op.keyId && !key) return fail(`关键帧 ${op.keyId} 不存在`);
  if (!key && op.at && track) key = track.keys.find((k) => k.at.beatId === op.at!.beatId && Math.abs(k.at.offset - op.at!.offset) < 0.05);
  if (op.remove) {
    if (!key) return fail('没有找到要删除的关键帧');
    const owner = track ?? locateKey(scene, key.id)!.track;
    res.changes.push({ scope, where: where(key.at.beatId), field, before: keyValueText(op.channel, key.value, castName), after: '无', beatId: key.at.beatId });
    if (key.meta.source === 'user') res.overwrote.push(`${field}关键帧`);
    removeKey(scene, key.id);
    if (owner.keys.length === 0 && owner.meta.source !== 'user' && !owner.meta.locked) scene.tracks = scene.tracks.filter((t) => t.id !== owner.id);
    return res;
  }
  if (key) {
    const before = keyValueText(op.channel, key.value, castName);
    if (op.value !== undefined) key.value = op.value;
    if (op.at) key.at = { beatId: op.at.beatId, offset: op.at.offset };
    if (op.duration !== undefined) key.duration = op.duration;
    if (op.ease !== undefined) key.ease = op.ease;
    const after = keyValueText(op.channel, key.value, castName);
    res.changes.push({ scope, where: where(key.at.beatId), field, before: before === after ? `${before}（时间/过渡）` : before, after, beatId: key.at.beatId });
    stamp(key.meta, op, ctx, res, `${field}关键帧`);
    return res;
  }
  if (!op.at || op.value === undefined) return fail('新建关键帧需要 at 与 value');
  const tr = ensureTrack(scene, target, op.channel as never) as unknown as AnyTrack;
  if (tr.keys.length === 0) tr.meta = freshMeta(op, ctx);
  const id = op.newKeyId && !scene.tracks.some((t) => t.keys.some((k) => k.id === op.newKeyId)) ? op.newKeyId : newKeyId(scene);
  const nk: AnyKey = { id, at: { beatId: op.at.beatId, offset: Math.round(op.at.offset * 1000) / 1000 }, value: op.value, duration: op.duration ?? 0, ease: op.ease ?? 'inOutQuad', meta: freshMeta(op, ctx) };
  tr.keys.push(nk);
  res.changes.push({ scope, where: where(nk.at.beatId), field, before: '无', after: keyValueText(op.channel, nk.value, castName), beatId: nk.at.beatId });
  return res;
}

/** The continuous effect that is running at the start of beat `index` (the last continuous key before it with strength > 0). */
export type FxValue = { fx: string; strength: number; tone?: string; edge?: string; variant?: string };
function runningFx(scene: Scene, index: number): FxValue | null {
  const order = new Map(scene.beats.map((b, i) => [b.id, i]));
  const keys = tracksOf(scene).filter((t) => t.channel === 'fx').flatMap((t) => t.keys).filter((k) => !(ONE_SHOT_FX as readonly string[]).includes((k.value as { fx: string }).fx) && (order.get(k.at.beatId) ?? 1e9) < index)
    .sort((a, b) => (order.get(a.at.beatId)! - order.get(b.at.beatId)!) || a.at.offset - b.at.offset);
  const last = keys.at(-1)?.value as FxValue | undefined;
  return last && last.strength > 0 ? last : null;
}

/** An effect with its parameters ("memory·sepia", "shake·0.7"), so that a tone or strength change shows on the card and in the read-back. */
function fxLabel(v: FxValue): string {
  const defaultStrength = v.fx === 'shake' ? 0.5 : 1;
  return [v.fx, v.fx === 'memory' ? v.tone : undefined, v.fx === 'memory' ? v.edge : undefined, v.fx === 'daze' ? v.variant : undefined, v.strength !== defaultStrength ? String(v.strength) : undefined].filter(Boolean).join('·');
}

/** Effect per beat (running continuous effect plus one-shots keyed on the beat) with its parameters, for the card text and the scene table. */
export function fxStates(scene: Scene): string[] {
  return fxValues(scene).map((cur) => (cur ? fxLabel(cur) : '无'));
}

/** The effect (with its parameters) in force at each beat, or null: the structured form of `fxStates` (used by the beat query). */
export function fxValues(scene: Scene): Array<FxValue | null> {
  const order = new Map(scene.beats.map((b, i) => [b.id, i]));
  const keys = tracksOf(scene).filter((t) => t.channel === 'fx').flatMap((t) => t.keys);
  return scene.beats.map((_b, i) => {
    const own = keys.filter((k) => order.get(k.at.beatId) === i).map((k) => k.value as FxValue).sort((x, y) => 0 - (x.strength - y.strength));
    let cur: FxValue | null = runningFx(scene, i);
    for (const v of own) cur = v.strength > 0 ? v : (cur?.fx === v.fx ? null : cur);
    return cur;
  });
}

function applyFxRange(scene: Scene, op: Extract<AgentOp, { op: 'fx_range' }>, ctx: ApplyCtx, res: ApplyResult, push: Push, where: (id: string) => string): ApplyResult {
  const a = scene.beats.findIndex((b) => b.id === op.fromBeatId);
  const z = scene.beats.findIndex((b) => b.id === op.toBeatId);
  if (a < 0 || z < 0) return fail('特效范围的台词不存在');
  if (z < a) return fail('特效范围的结束早于开始');
  const before = fxStates(scene);
  const oneShot = (ONE_SHOT_FX as readonly string[]).includes(op.fx);
  const inRange = (k: AnyKey) => { const i = scene.beats.findIndex((b) => b.id === k.at.beatId); return i >= a && i <= z + 1; };
  // includeProtected = the follow-up of a bulk edit that had to leave locked / hand-made keys alone: it takes them too (the lock check then asks the user)
  const protectedKey = (t: AnyTrack, k: AnyKey) => !op.includeProtected && (t.meta.locked || k.meta.locked || (k.meta.source === 'user' && !op.overrideUser));
  // 0. the same effect already runs here: a change to one parameter keeps the others (tone, edge, eyelid variant, strength, roll)
  const existing = ((): FxValue & { roll?: number } | null => {
    const order = new Map(scene.beats.map((b, i) => [b.id, i]));
    const own = tracksOf(scene).filter((t) => t.channel === 'fx').flatMap((t) => t.keys)
      .filter((k) => { const i = order.get(k.at.beatId) ?? -1; const v = k.value as FxValue; return i >= a && i <= z && v.fx === op.fx && v.strength > 0; })
      .sort((x, y) => (order.get(x.at.beatId)! - order.get(y.at.beatId)!) || x.at.offset - y.at.offset);
    const found = (own[0]?.value as (FxValue & { roll?: number }) | undefined) ?? (() => { const r = runningFx(scene, a); return r && r.fx === op.fx ? (r as FxValue & { roll?: number }) : undefined; })();
    return found ?? null;
  })();
  const eff = {
    tone: op.tone ?? (op.fx === 'memory' ? existing?.tone : undefined),
    edge: op.edge ?? existing?.edge,
    variant: op.variant ?? existing?.variant,
    strength: op.strength ?? (existing && op.fx !== 'shake' ? existing.strength : undefined),
    roll: op.roll ?? existing?.roll,
  };
  // 1. clear what is in the way: effect keys of the range plus the white fades a memory put at its edges (never a protected one)
  for (const t of tracksOf(scene)) {
    if (t.channel !== 'fx' && t.channel !== 'fade') continue;
    t.keys = t.keys.filter((k) => {
      if (!inRange(k)) return true;
      const v = k.value as { fx?: string; color?: string };
      if (t.channel === 'fade' && !(v.color === 'white' && k.meta.source !== 'user')) return true;
      // the "off" key at the beat after the range belongs to the range only when it switches something off
      if (t.channel === 'fx' && scene.beats.findIndex((b) => b.id === k.at.beatId) === z + 1 && (k.value as { strength: number }).strength > 0) return true;
      if (protectedKey(t, k)) { res.skipped.push(`${where(k.at.beatId)}的锁定/手改特效`); return true; }
      if (op.includeProtected && !t.meta.locked && !k.meta.locked && k.meta.source === 'user' && !op.overrideUser) res.overwrote.push(`${where(k.at.beatId)}的手改特效`);
      return false;
    });
  }
  scene.tracks = scene.tracks.filter((t) => t.keys.length > 0 || t.meta.locked || t.meta.source === 'user');
  if (res.skipped.length > 0 && res.skipped.length === new Set(res.skipped).size) { /* keep */ }
  // 2. write the new state
  const used = new Set(tracksOf(scene).flatMap((t) => t.keys.map((k) => k.id)));
  const key = (channel: 'fx' | 'fade', bi: number, offset: number, value: unknown, meta: Meta, duration = 0, ease = 'inOutQuad') => {
    const tr = ensureTrack(scene, { kind: 'screen' }, channel) as unknown as AnyTrack;
    if (tr.keys.length === 0) tr.meta = freshMeta(op, ctx);
    const id = nextId('k', used, scene);
    used.add(id);
    tr.keys.push({ id, at: { beatId: scene.beats[bi]!.id, offset: Math.round(offset * 1000) / 1000 }, value, duration, ease: ease as never, meta });
  };
  const meta = () => freshMeta(op, ctx);
  const kfn = ((_c: string | null, ch: 'fx' | 'fade', bi: number, off: number, val: unknown, m: Meta, dur?: number, ease?: string) => key(ch, bi, off, val, m, dur, ease)) as Parameters<typeof memoryThroughWhite>[0];
  const prev = runningFx(scene, a);
  if (op.fx === 'none') {
    if (prev && !oneShot) key('fx', a, 0, { fx: prev.fx, strength: 0, roll: 0 }, meta(), 0.4);
  } else if (oneShot) {
    key('fx', a, 0, { fx: op.fx, strength: op.fx === 'shake' ? op.strength ?? 0.5 : 1, roll: 0 }, meta(), op.fx === 'flash' ? FLASH_SECONDS : 0.5);
  } else {
    const strength = eff.strength ?? 1;
    if (prev && prev.fx !== op.fx) {
      if (prev.fx === 'memory' && a > 0) memoryThroughWhite(kfn, a, 0, meta(), meta());
      else key('fx', a, 0, { fx: prev.fx, strength: 0, roll: 0 }, meta(), 0.4);
    }
    const value = { fx: op.fx, strength, roll: eff.roll ?? (op.fx === 'dutch' ? 6 : 0), ...(op.fx === 'memory' && eff.tone ? { tone: eff.tone } : {}), ...(eff.edge ? { edge: eff.edge } : {}), ...(eff.variant ? { variant: eff.variant } : {}) };
    if (op.fx === 'memory' && a > 0) {
      memoryThroughWhite(kfn, a, 1, meta(), meta(), eff.tone as MemoryTone | undefined);
      if (eff.edge || eff.strength !== undefined) {
        // the helper writes a bare memory key: patch the edge / strength onto it
        const t = tracksOf(scene).find((x) => x.channel === 'fx');
        const last = t?.keys.filter((k) => k.at.beatId === scene.beats[a]!.id && (k.value as { fx: string; strength: number }).fx === 'memory' && (k.value as { strength: number }).strength === 1).at(-1);
        if (last) last.value = { ...(last.value as object), ...(eff.edge ? { edge: eff.edge } : {}), strength };
      }
    } else key('fx', a, 0, value, meta(), 0.5);
    // the end: the beat after the range switches it off (a memory through white); the last beat ends it a few seconds in
    if (z + 1 < scene.beats.length) {
      const next = tracksOf(scene).filter((t) => t.channel === 'fx').flatMap((t) => t.keys).find((k) => k.at.beatId === scene.beats[z + 1]!.id && (k.value as { fx: string }).fx === op.fx);
      if (!next) { if (op.fx === 'memory') memoryThroughWhite(kfn, z + 1, 0, meta(), meta()); else key('fx', z + 1, 0, { fx: op.fx, strength: 0, roll: 0 }, meta(), op.fx === 'dim' ? 0.5 : 0.4); }
    } else key('fx', z, 4, { fx: op.fx, strength: 0, roll: 0 }, meta(), 0.6);
  }
  const after = fxStates(scene);
  for (let i = a; i <= Math.min(z + 1, scene.beats.length - 1); i++) if (before[i] !== after[i]) push('特效', before[i]!, after[i]!, scene.beats[i]!.id);
  return res;
}

function applyBg(project: Project, scene: Scene, op: Extract<AgentOp, { op: 'bg_set' }>, ctx: ApplyCtx, res: ApplyResult, push: Push): ApplyResult {
  void project;
  if (op.at === 'start') {
    if (!op.assetId) return fail('场景开场背景不能清空');
    push('场景开场背景', scene.background.assetId, op.assetId);
    scene.background.assetId = op.assetId;
    stamp(scene.background.meta, op, ctx, res, '场景背景');
    if (op.location !== undefined) {
      push('地点标题条', scene.location?.text ?? '无', op.location);
      if (scene.location) { scene.location.text = op.location; stamp(scene.location.meta, op, ctx, res, '地点标题条'); } else scene.location = { text: op.location, show: true, meta: freshMeta(op, ctx) };
    }
    return res;
  }
  const beat = scene.beats.find((b) => b.id === op.at);
  if (!beat) return fail(`台词 ${op.at} 不存在`);
  const tr = findTrack(scene, { kind: 'stage' }, 'background') as unknown as AnyTrack | undefined;
  const existing = tr?.keys.find((k) => k.at.beatId === beat.id);
  if (!op.assetId) {
    if (!tr || !existing) return fail('这一句没有背景切换可以移除');
    push('背景切换', String((existing.value as { assetId: string }).assetId), '无', beat.id);
    if (existing.meta.source === 'user') res.overwrote.push('背景切换');
    removeKey(scene, existing.id);
    return res;
  }
  const value = { ...bgSwitchValue(op.assetId, op.transition ?? 'cut', op.purpose ?? 'move'), ...(op.transitionSeconds !== undefined ? { transitionSeconds: op.transitionSeconds } : {}) };
  if (existing) {
    push('背景切换', String((existing.value as { assetId: string }).assetId), op.assetId, beat.id);
    existing.value = value;
    stamp(existing.meta, op, ctx, res, '背景切换');
  } else {
    const t = ensureTrack(scene, { kind: 'stage' }, 'background') as unknown as AnyTrack;
    if (t.keys.length === 0) t.meta = freshMeta(op, ctx);
    t.keys.push({ id: newKeyId(scene), at: { beatId: beat.id, offset: 0 }, value, duration: 0, ease: 'inOutQuad', meta: freshMeta(op, ctx) });
    push('背景切换', '无', op.assetId, beat.id);
  }
  return res;
}

/**
 * A character line whose content is only punctuation ("……", "——", "！？") is a real line of dialogue (a meaningful text performance in a visual
 * novel), never a silent reaction. This is the deterministic safety net behind the prompt rule: when the model turned such a line into a
 * silent beat, put the dialogue back (conservatively: same paragraph, a silent beat that is still there, a speaker that can be resolved).
 */
import type { DirectedBeat, SceneDirection } from '../schema/ai';
import type { DirectorCatalog } from './resources';
import type { Paragraph } from './paragraphs';
import { mentions, nameIndex, segments } from './ruleDirector';

const PUNCT_ONLY = /^[\s\u3000…⋯·.。、，,!?！？—―─~～ー‥・:：;；-]+$/u;

/** True for non-empty text made only of punctuation and spaces. */
export function isPunctuationOnly(text: string): boolean {
  return text.trim().length > 0 && PUNCT_ONLY.test(text);
}

const unquote = (t: string) => t.trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '').trim();

interface Cast { castId: string; characterKey: string }

/** Mutates `d.beats`; returns the warnings. */
export function restorePunctuationDialogue(d: SceneDirection, cast: readonly Cast[], catalog: DirectorCatalog, paragraphs: readonly Paragraph[]): string[] {
  const warnings: string[] = [];
  const idx = nameIndex(catalog);
  const byKey = new Map(cast.map((c) => [c.characterKey, c.castId]));
  const castName = (name: string): string | null => {
    const k = idx.names.find((n) => n.text === name)?.key;
    return k && byKey.has(k) ? k : null;
  };
  const near = (s: string, last: boolean): string | null => {
    const m = mentions(idx, s).filter((x) => byKey.has(x.key));
    const k = (last ? m.at(-1) : m[0])?.key;
    return k ? byKey.get(k) ?? null : null;
  };
  const used = new Set<DirectedBeat>();
  const paraIds = [...new Set(d.beats.map((b) => b.paragraph))];
  for (const pi of paraIds) {
    const para = paragraphs.find((p) => p.index === pi);
    if (!para) continue;
    const segs = segments(para.text, castName);
    const utterances = segs.filter((s) => s.kind === 'dialogue' && isPunctuationOnly(s.text));
    for (const u of utterances) {
      const carried = d.beats.find((b) => b.paragraph === pi && b.kind === 'dialogue' && !used.has(b) && isPunctuationOnly(unquote(b.text)) && unquote(b.text) === u.text);
      if (carried) { used.add(carried); continue; }
      const silent = d.beats.find((b) => b.paragraph === pi && b.kind === 'silent' && b.keepId === null && !used.has(b));
      if (!silent) {
        // the model left the line out altogether (typically folded into a narration beat): put it back, but only when the text itself names the speaker
        const who = u.speakerKey ? byKey.get(u.speakerKey) ?? null : near(u.after.slice(0, 18), false) ?? near(u.before.slice(-18), true);
        const inPara = d.beats.filter((b) => b.paragraph === pi);
        if (!who || inPara.length === 0) continue;
        if (inPara.some((b) => b.kind === 'dialogue' && b.keepId === null && unquote(b.text) === u.text)) continue;
        const first = segs.indexOf(u) === 0;
        const ref = first ? inPara[0]! : inPara.at(-1)!;
        const at = d.beats.indexOf(ref) + (first ? 0 : 1);
        const type = ref.shot.type === 'group' || ref.shot.type === 'insert' || ref.shot.type === 'two_shot' ? 'mcu' : ref.shot.type;
        const nb = JSON.parse(JSON.stringify(ref)) as DirectedBeat;
        Object.assign(nb, { keepId: null, kind: 'dialogue', speaker: who, text: u.text, fx: 'none', cutIn: 'cut', actors: [], reason: '只有标点的台词，补回对白' });
        nb.shot = { ...nb.shot, type, focus: [who], move: 'static', dof: null } as DirectedBeat['shot'];
        delete (nb as { bg?: unknown }).bg;
        (nb.shot as { insertTarget?: unknown }).insertTarget = null;
        d.beats.splice(at, 0, nb);
        for (const c of d.costumeChanges) if (c.beatIndex >= at) c.beatIndex++;
        used.add(nb);
        warnings.push(`第 ${pi} 段只有标点的台词「${u.text}」没有对应的对白节拍，已补回 ${who} 的对白`);
        continue;
      }
      const named = u.speakerKey ? byKey.get(u.speakerKey) ?? null : near(u.after.slice(0, 18), false) ?? near(u.before.slice(-18), true);
      const focus = [...new Set(silent.shot.focus.filter((f) => cast.some((c) => c.castId === f)))];
      const speaker = named ?? (focus.length === 1 ? focus[0]! : null);
      const n = d.beats.indexOf(silent) + 1;
      if (!speaker) {
        warnings.push(`第 ${n} 句是无声节拍，但第 ${pi} 段有只有标点的台词「${u.text}」，找不到说话人，未改动`);
        continue;
      }
      silent.kind = 'dialogue';
      silent.speaker = speaker;
      silent.text = u.text;
      if (!silent.shot.focus.includes(speaker) && silent.shot.type !== 'group' && silent.shot.type !== 'two_shot') silent.shot.focus = [speaker];
      used.add(silent);
      warnings.push(`第 ${n} 句原为无声节拍，但第 ${pi} 段有只有标点的台词「${u.text}」，已改为 ${speaker} 的对白`);
    }
  }
  return warnings;
}

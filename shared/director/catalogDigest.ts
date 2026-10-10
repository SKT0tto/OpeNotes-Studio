/** Compact, deterministic text forms of the catalog for prompts (the stable, cacheable prefix of the AI calls). */
import type { ModelEntry } from '../schema/assets';
import { depthNameOf, slotNameOf } from './vocab';
import { lookup, modelLabel, rankBackgrounds, selectable, type DirectorCatalog } from './resources';
import { bandText, isUnknownLabel } from './bandFit';

const roleWord = (r: string | null) => r ?? '—';

export interface DigestOptions {
  /** Keep only this many backgrounds, ranked by overlap with `text` (small local models). */
  backgroundLimit?: number;
  text?: string;
}

/** Characters, band formations, outfits and backgrounds. Sorted and free of volatile data, so it is byte-stable per catalog. */
export function breakdownDigest(cat: DirectorCatalog, opts: DigestOptions = {}): string {
  const L = lookup(cat);
  const mains = cat.characters.filter((c) => !c.isSub).sort((a, b) => (a.key < b.key ? -1 : 1));
  const lines: string[] = ['## 角色（key｜姓名｜别名｜乐队｜职位）'];
  for (const c of mains) lines.push(`${c.key}｜${c.name}｜${[c.nickname, ...c.aliases].filter(Boolean).slice(0, 5).join('/')}｜${c.bandName}｜${roleWord(c.role)}`);

  lines.push('', '## 乐队正式演出编队（x：左负右正；depth：0 前排 … 1 后排）');
  for (const b of cat.bands) {
    const parts = b.formation.map((f) => {
      const c = L.characters.get(f.key);
      return `${c?.name ?? f.key}(${roleWord(c?.role ?? null)}) ${slotNameOf(f.x)}/${depthNameOf(f.depth)}`;
    });
    lines.push(`${b.name}：${parts.join('；')}`);
  }

  lines.push('', '## 服装（角色 key → modelId〔标签〕；live-mode 为正式演奏形态，仅用于演出）');
  for (const c of mains) {
    const adv = (L.modelsOf.get(c.key) ?? []).filter((m) => selectable(m)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const live = (L.modelsOf.get(c.key) ?? []).filter((m) => selectable(m, { live: true }));
    const fmt = (m: ModelEntry) => `${m.id}〔${modelLabel(m)}〕`;
    lines.push(`${c.key}：${[...adv, ...live].map(fmt).join(' ')}`);
  }

  // backgrounds of unknown ownership (and rarely-used ones) are never offered by default
  const offered = cat.backgrounds.filter((b) => !b.labels || (!(isUnknownLabel(b.labels) && (cat.labelRules?.unknownPolicy ?? 'avoid') !== 'allow') && !b.labels.usage));
  const bgs = opts.backgroundLimit && opts.text ? rankBackgrounds(offered, opts.text).slice(0, opts.backgroundLimit) : [...offered];
  const bandName = (k: string) => cat.bands.find((b) => b.key === k)?.name ?? k;
  lines.push('', '## 背景（id｜名称｜地点｜室内外｜时间｜乐队｜舞台｜简述）');
  for (const b of bgs.sort((a, c) => (a.id < c.id ? -1 : 1))) {
    lines.push(`${b.id}｜${b.name}｜${b.location ?? ''}｜${b.setting ?? ''}｜${b.time ?? ''}｜${bandText(b.labels, bandName)}｜${b.labels?.stage ? '是' : '否'}｜${(b.description ?? '').slice(0, 24)}`);
  }
  return lines.join('\n');
}

/** What one actor can do in its current outfit (offered to Pass 2; the model may only use these names). */
export interface ActorResources {
  castId: string;
  name: string;
  characterKey: string;
  role: string | null;
  modelId: string;
  mode: 'adv' | 'live';
  motions: string[];
  expressions: string[];
  /** Other outfits of the character the scene may switch to. */
  outfits: Array<{ modelId: string; label: string }>;
}

/** Motion families a prompt may offer (idle is automatic and never chosen by the model). */
export function motionFamilies(m: ModelEntry): string[] {
  return [...new Set(m.motions.map((x) => x.family))].filter((f) => !f.startsWith('idle')).sort();
}

export function actorResources(cat: DirectorCatalog, castId: string, characterKey: string, modelId: string): ActorResources | null {
  const L = lookup(cat);
  const m = L.models.get(modelId);
  if (!m) return null;
  const c = L.characters.get(characterKey);
  return {
    castId,
    name: c?.name ?? characterKey,
    characterKey,
    role: c?.role ?? null,
    modelId,
    mode: m.mode,
    motions: motionFamilies(m),
    expressions: m.mode === 'live' ? [] : m.expressions.map((e) => e.name),
    outfits: (L.modelsOf.get(characterKey) ?? []).filter((x) => selectable(x) && x.id !== modelId).map((x) => ({ modelId: x.id, label: modelLabel(x) })),
  };
}

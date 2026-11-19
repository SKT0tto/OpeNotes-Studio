import fs from 'node:fs';
import path from 'node:path';
import { cleanPath } from './paths';
import { EMOTIONS } from '../../../shared/director/vocab';
import { VoiceSettingsPatchSchema, VoiceSettingsSchema, type RefClip, type VoiceSettings, type VoiceSettingsPatch } from './schema';

/** A path as pasted (surrounding quotes and spaces removed); blank = absent. */
const clean = (x: string | undefined): string | undefined => cleanPath(x) || undefined;

/** Emotion references as stored: known emotions only, pasted quotes removed, blank paths dropped; nothing left = absent. */
export function cleanEmotionRefs(refs: Record<string, RefClip> | undefined): Record<string, RefClip> | undefined {
  const out: Record<string, RefClip> = {};
  for (const [emotion, r] of Object.entries(refs ?? {})) {
    const path = clean(r.path);
    if (!(EMOTIONS as readonly string[]).includes(emotion) || !path) continue;
    out[emotion] = { path, text: r.text.trim(), lang: r.lang.trim() || 'ja' };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * GPT-SoVITS plugin settings: `data/plugins/gpt-sovits/settings.json` (gitignored with the rest of `data/`). Plain paths and an address; no secrets.
 * An invalid / missing file = the defaults (plugin off). Before the plugin existed the same settings lived in `data/voice.local.json`:
 * that file is read when the new one is missing (its fields are all still valid; `volume` moved to the studio).
 */
export class VoiceSettingsStore {
  constructor(private readonly file: string, private readonly legacyFile?: string) {}

  read(): VoiceSettings {
    for (const f of [this.file, this.legacyFile]) {
      if (!f) continue;
      try {
        return VoiceSettingsSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
      } catch {
        /* missing or invalid: next */
      }
    }
    return VoiceSettingsSchema.parse({});
  }

  private write(s: VoiceSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Applies a patch (a profile set to `null` is removed; empty strings clear optional paths). Throws ZodError on a bad patch. */
  patch(input: unknown): VoiceSettings {
    const p: VoiceSettingsPatch = VoiceSettingsPatchSchema.parse(input);
    const cur = this.read();
    const profiles = { ...cur.profiles };
    for (const [key, v] of Object.entries(p.profiles ?? {})) {
      if (v === null) delete profiles[key];
      else {
        const gpt = clean(v.gptWeights);
        const sov = clean(v.sovitsWeights);
        const ref = clean(v.refAudioPath);
        const emotionRefs = cleanEmotionRefs(v.emotionRefs);
        profiles[key] = { ...(gpt ? { gptWeights: gpt } : {}), ...(sov ? { sovitsWeights: sov } : {}), ...(ref ? { refAudioPath: ref } : {}), promptText: v.promptText.trim(), promptLang: v.promptLang.trim() || 'ja', speed: v.speed, ...(emotionRefs ? { emotionRefs } : {}) };
      }
    }
    const next: VoiceSettings = {
      enabled: p.enabled ?? cur.enabled,
      endpoint: (p.endpoint ?? cur.endpoint).trim().replace(/\/+$/, '') || cur.endpoint,
      textLang: p.textLang?.trim() || cur.textLang,
      refDirs: (p.refDirs ?? cur.refDirs).map(cleanPath).filter(Boolean),
      profiles,
    };
    for (const k of ['defaultGptWeights', 'defaultSovitsWeights', 'sovitsRoot'] as const) {
      const v = k in p ? clean(p[k]) : cur[k];
      if (v) next[k] = v;
    }
    this.write(next);
    return next;
  }
}

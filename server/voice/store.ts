import fs from 'node:fs';
import path from 'node:path';
import { VoiceSettingsPatchSchema, VoiceSettingsSchema, type VoiceSettings, type VoiceSettingsPatch } from '../../shared/schema/voice';

/**
 * GPT-SoVITS plugin settings: `data/voice.local.json` (gitignored with the rest of `data/`). Plain paths and an address; no secrets.
 * Invalid / missing file = the defaults (plugin off).
 */
export class VoiceSettingsStore {
  constructor(private readonly file: string) {}

  read(): VoiceSettings {
    try {
      return VoiceSettingsSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return VoiceSettingsSchema.parse({});
    }
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
        const clean = (x: string | undefined) => (x && x.trim() !== '' ? x.trim() : undefined);
        const gpt = clean(v.gptWeights);
        const sov = clean(v.sovitsWeights);
        const ref = clean(v.refAudioPath);
        profiles[key] = { ...(gpt ? { gptWeights: gpt } : {}), ...(sov ? { sovitsWeights: sov } : {}), ...(ref ? { refAudioPath: ref } : {}), promptText: v.promptText.trim(), promptLang: v.promptLang.trim() || 'ja', speed: v.speed };
      }
    }
    const next: VoiceSettings = {
      enabled: p.enabled ?? cur.enabled,
      endpoint: (p.endpoint ?? cur.endpoint).trim().replace(/\/+$/, '') || cur.endpoint,
      volume: p.volume ?? cur.volume,
      textLang: p.textLang?.trim() || cur.textLang,
      profiles,
    };
    for (const k of ['defaultGptWeights', 'defaultSovitsWeights'] as const) {
      const v = k in p ? p[k]?.trim() : cur[k];
      if (v) next[k] = v;
    }
    this.write(next);
    return next;
  }
}

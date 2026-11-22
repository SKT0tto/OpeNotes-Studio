import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PluginServerContext } from '../../../../shared/plugins/api';
import { cleanPath } from '../paths';
import type { VoiceSettings } from '../schema';
import { VoiceError } from '../service';
import type { VoiceSettingsStore } from '../store';
import { autoMatch } from './match';

const AUDIO_TYPES: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };

/** Is `file` an audio file inside one of `dirs` (symlinks and `..` resolved)? Returns its real path, else null. */
export function insideScanned(file: string, dirs: readonly string[]): string | null {
  const ext = path.extname(file).toLowerCase();
  if (!AUDIO_TYPES[ext] || !path.isAbsolute(file)) return null;
  try {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) return null;
    for (const d of dirs) {
      const root = fs.realpathSync(d);
      const rel = path.relative(root, real);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
    }
  } catch { /* missing */ }
  return null;
}

/** An audio file that is saved as a reference clip (a character's main one or an emotion's): real path, else null. */
export function configuredRef(file: string, s: VoiceSettings): string | null {
  const ext = path.extname(file).toLowerCase();
  if (!AUDIO_TYPES[ext] || !path.isAbsolute(file)) return null;
  const saved = Object.values(s.profiles).flatMap((p) => [p.refAudioPath, ...Object.values(p.emotionRefs ?? {}).map((r) => r.path)]);
  if (!saved.includes(file)) return null;
  try {
    const real = fs.realpathSync(file);
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * `POST /match` { characters:[{key,name}], sovitsRoot?, refDirs? } -> the proposal (nothing is saved; the dialog applies what the person ticks).
 * `GET /ref-audio?path=` streams one reference clip so the person can listen before choosing: only audio files inside the folders of the
 * latest scan or saved as a reference clip, never any other file.
 */
export function matchRoutes(ctx: PluginServerContext, settings: VoiceSettingsStore): void {
  let scanned: string[] = [];
  ctx.router.post('/match', async (req, res) => {
    const body = z.object({ characters: z.array(z.object({ key: z.string().min(1), name: z.string() })).max(200), sovitsRoot: z.string().optional(), refDirs: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) throw new VoiceError(400, '需要 characters');
    const cur = settings.read();
    const root = cleanPath(body.data.sovitsRoot) || cur.sovitsRoot;
    const refDirs = (body.data.refDirs ?? cur.refDirs).map(cleanPath).filter(Boolean);
    const ctl = new AbortController();
    res.on('close', () => !res.writableEnded && ctl.abort());
    try {
      const result = await autoMatch(ctx, { sovitsRoot: root, refDirs }, body.data.characters, ctl.signal);
      scanned = result.dirs;
      res.json(result);
    } catch (e) {
      if (ctl.signal.aborted) return;
      throw new VoiceError(400, (e as Error).message);
    }
  });
  /** `POST /scan-refs`: the same scan as `/match`, without the AI step or any proposal: just the reference clips found for each character. */
  ctx.router.post('/scan-refs', async (req, res) => {
    const body = z.object({ characters: z.array(z.object({ key: z.string().min(1), name: z.string() })).max(200), sovitsRoot: z.string().optional(), refDirs: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) throw new VoiceError(400, '需要 characters');
    const cur = settings.read();
    const root = cleanPath(body.data.sovitsRoot) || cur.sovitsRoot;
    const refDirs = (body.data.refDirs ?? cur.refDirs).map(cleanPath).filter(Boolean);
    const ctl = new AbortController();
    res.on('close', () => !res.writableEnded && ctl.abort());
    try {
      const noAi: Pick<PluginServerContext, 'llm'> = { llm: { ...ctx.llm, available: () => ({ ok: false, message: '' }) } };
      const result = await autoMatch(noAi, { sovitsRoot: root, refDirs }, body.data.characters, ctl.signal);
      scanned = result.dirs;
      res.json({ candidates: Object.fromEntries(result.rows.map((r) => [r.characterKey, r.candidates])), dirs: result.dirs });
    } catch (e) {
      if (ctl.signal.aborted) return;
      throw new VoiceError(400, (e as Error).message);
    }
  });
  ctx.router.get('/ref-audio', (req, res) => {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const real = insideScanned(p, scanned) ?? configuredRef(p, settings.read());
    if (!real) throw new VoiceError(404, '只能试听最近一次扫描的文件夹里的音频，或已保存为参考音频的文件（请先点「自动匹配」或保存设置）');
    res.setHeader('cache-control', 'no-store');
    res.type(AUDIO_TYPES[path.extname(real).toLowerCase()]!).sendFile(real, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: '读不到这个音频' });
    });
  });
}

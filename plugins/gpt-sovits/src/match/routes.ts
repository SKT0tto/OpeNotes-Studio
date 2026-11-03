import { z } from 'zod';
import type { PluginServerContext } from '../../../../shared/plugins/api';
import { VoiceError } from '../service';
import type { VoiceSettingsStore } from '../store';
import { autoMatch } from './match';

/** `POST /match` { characters:[{key,name}] } -> the proposal (nothing is saved; the dialog applies what the person ticks). */
export function matchRoutes(ctx: PluginServerContext, settings: VoiceSettingsStore): void {
  ctx.router.post('/match', async (req, res) => {
    const body = z.object({ characters: z.array(z.object({ key: z.string().min(1), name: z.string() })).max(200), sovitsRoot: z.string().optional(), refDirs: z.array(z.string()).optional() }).safeParse(req.body);
    if (!body.success) throw new VoiceError(400, '需要 characters');
    const cur = settings.read();
    const root = body.data.sovitsRoot?.trim() || cur.sovitsRoot;
    const ctl = new AbortController();
    res.on('close', () => !res.writableEnded && ctl.abort());
    try {
      res.json(await autoMatch(ctx, { sovitsRoot: root, refDirs: body.data.refDirs ?? cur.refDirs }, body.data.characters, ctl.signal));
    } catch (e) {
      if (ctl.signal.aborted) return;
      throw new VoiceError(400, (e as Error).message);
    }
  });
}

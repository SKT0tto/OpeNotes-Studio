/** Node side of the GPT-SoVITS plugin: `register(ctx)` is called by the studio's plugin loader. */
import path from 'node:path';
import type { PluginServerContext } from '../../../shared/plugins/api';
import { matchRoutes } from './match/routes';
import { voiceRoutes } from './routes';
import { VoiceService } from './service';
import { VoiceSettingsStore } from './store';

export default function register(ctx: PluginServerContext): void {
  // settings moved here from data/voice.local.json: the old file is read until the new one exists
  const settings = new VoiceSettingsStore(path.join(ctx.dataDir, 'settings.json'), path.join(ctx.rootDataDir, 'voice.local.json'));
  const service = new VoiceService({ settings, voice: ctx.voice, llm: ctx.llm });
  voiceRoutes(ctx.router, settings, service);
  matchRoutes(ctx, settings);
}

import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { loadDotEnv } from './settings/store';

// The LLM settings re-read `.env` on every request (see LlmSettings), so editing it needs no restart. `realEnv` is the
// process environment before `.env` is merged in: real variables win over `.env`, a removed `.env` line really goes away.
const realEnv = { ...process.env };
loadDotEnv('.env'); // never printed; keys stay in process.env
const config = loadConfig();
const { app } = createApp(config, (m) => console.log(`[studio] ${m}`), { dotEnv: { file: path.resolve('.env'), base: realEnv } });

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[studio] server http://127.0.0.1:${config.port}  ASSET_ROOT=${config.assetRoot}`);
});

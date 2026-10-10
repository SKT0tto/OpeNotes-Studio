import { createApp } from './app';
import { loadConfig } from './config';
import { loadDotEnv } from './settings/store';

loadDotEnv('.env'); // never printed; keys stay in process.env
const config = loadConfig();
const { app } = createApp(config, (m) => console.log(`[studio] ${m}`));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[studio] server http://127.0.0.1:${config.port}  ASSET_ROOT=${config.assetRoot}`);
});

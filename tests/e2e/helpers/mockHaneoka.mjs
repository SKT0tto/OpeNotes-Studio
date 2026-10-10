// Tiny local stand-in for the three Haneoka index endpoints (serves the synthetic fixtures; no real network).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const dir = path.resolve('tests/fixtures/sources/haneoka');
const routes = { '/api/v1/live2d': 'live2d.json', '/api/v1/story-assets/views/backgrounds': 'story.json', '/api/v1/backgrounds': 'cards.json' };
http
  .createServer((req, res) => {
    const file = routes[(req.url ?? '').split('?')[0]];
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-haneoka-release-id': 'r-mock' });
    res.end(fs.readFileSync(path.join(dir, file)));
  })
  .listen(Number(process.env.MOCK_PORT ?? 5377), '127.0.0.1', () => console.log('mock haneoka up'));

import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerAskRoute } from './routes/ask.js';
import { startRateLimitSweeper } from './lib/ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const cfg = loadConfig();
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cors, { origin: true });

  app.get('/healthz', async () => ({ ok: true }));

  registerShareRoutes(app, cfg);
  registerAskRoute(app, cfg);

  // Web 分享页：/s/{shareId} → web/s/[shareId].html
  // 本地：api/dist → ../../web = 仓库根/web；容器：WEB_DIR=/app/web 由 compose 设置
  const webDir = process.env.WEB_DIR ?? path.resolve(__dirname, '../../web');
  const sharePage = fs.readFileSync(path.join(webDir, 's', '[shareId].html'), 'utf8');
  app.get('/s/:shareId', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(sharePage);
  });

  return app;
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  buildServer()
    .then((app) => {
      startRateLimitSweeper();
      return app.listen({ host: '0.0.0.0', port: 3000 });
    })
    .catch((err) => {
      console.error('server failed to start:', err);
      process.exit(1);
    });
}

import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes';
import { assertAuthConfiguration } from './server/auth';
import { startSyncWorker, syncWorker } from './server/sync/worker';
import { getSyncConfig } from './server/sync/config';
import { startEmailWorker, emailWorker } from './server/email/service';
import { startBackupScheduler } from './server/ops/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  // Refuse to start without a real JWT secret (there is no built-in fallback).
  assertAuthConfiguration();

  const app = express();
  const httpServer = http.createServer(app);
  // Server port defaults to 3000
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // CORS. POS terminals load the UI from this same server (same origin: no CORS needed).
  // ALLOWED_ORIGINS (comma-separated) restricts cross-origin callers, e.g. an online frontend;
  // when it is not set the previous permissive behaviour ("*") is kept for compatibility.
  // Auth uses Bearer tokens (not cookies), so a foreign page cannot ride a logged-in session.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Mount API router
  app.use('/api', apiRouter);

  // Errors raised before/inside the API router (e.g. malformed JSON body, oversized payload) are
  // answered as JSON, never as Express's default HTML error page.
  app.use('/api', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[API] Unhandled error:', err?.message || err);
    res.status(status).json({
      error: err?.type === 'entity.parse.failed' ? 'Request body is not valid JSON.' : status >= 500 ? 'Internal server error.' : err?.message || 'Bad request.',
    });
  });

  // Serve or mount Vite middlewares
  const distPath = path.resolve(__dirname, 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isProduction = process.env.NODE_ENV === 'production' || hasDist;

  if (isProduction && hasDist) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {

    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        cors: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Fallback to index.html for client-side navigation in dev mode
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  }

  // API_HOST: 0.0.0.0 = reachable by LAN terminals (protect with Windows Firewall, Private profile,
  // LAN subnet only); 127.0.0.1 = this PC only. Never port-forward this to the internet.
  const HOST = (process.env.API_HOST || '0.0.0.0').trim();
  httpServer.listen(PORT, HOST, () => {
    console.log(`[GIGA CHEMIST] Server listening on http://${HOST}:${PORT}`);
    const sync = getSyncConfig();
    console.log(`[GIGA CHEMIST] Mode: ${sync.mode.toUpperCase()} | outbox ${sync.outboxEnabled ? 'on' : 'off'} | cloud sync worker ${sync.workerEnabled ? 'on' : 'off'}`);
    // The cloud is never required for startup: the worker logs and retries on its own.
    startSyncWorker();
    startEmailWorker();
    startBackupScheduler();
  });

  const shutdown = async (signal: string) => {
    console.log(`[GIGA CHEMIST] ${signal} received, stopping...`);
    await syncWorker.stop().catch(() => {});
    await emailWorker.stop().catch(() => {});
    httpServer.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { applyCommonMiddleware, apiErrorHandler } from './server/http/common';
import { getAppMode } from './server/db/client';
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

  const mode = getAppMode();
  if (mode === 'online') {
    // ONLINE (Vercel-style): cloud data, read-only API, no local PostgreSQL, no background workers.
    const { mountOnlineApi } = await import('./server/online/app');
    mountOnlineApi(app);
  } else {
    // LOCAL / HYBRID pharmacy server: local PostgreSQL is authoritative.
    applyCommonMiddleware(app);
    const { apiRouter } = await import('./server/routes');
    app.use('/api', apiRouter);
    // Errors raised before/inside the API router are answered as JSON, never as an HTML page.
    app.use('/api', apiErrorHandler);
  }

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
    if (mode === 'online') {
      console.log('[GIGA CHEMIST] Mode: ONLINE | cloud data source, read-only API, no local workers');
      return;
    }
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

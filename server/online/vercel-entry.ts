import express from 'express';
import { mountOnlineApi } from './app';

/**
 * Vercel serverless entry (bundled to api/index.js by `npm run build:api`).
 * vercel.json rewrites /api/* to this function; Vercel owns the runtime, so there is no listen().
 * This entry is ALWAYS the online (cloud, read-only) API — it never touches a local PostgreSQL.
 */
const app = express();
app.use((req, _res, next) => {
  if (!req.url.startsWith('/api')) req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  next();
});
mountOnlineApi(app);

export default app;

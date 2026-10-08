import express from 'express';

/**
 * HTTP behaviour shared by the local POS server (server.ts) and the online/Vercel app.
 *
 * CORS: the POS UI is served by the same origin as /api (local: http://<pos>:3000, online:
 * https://gigachem.vercel.app), so no CORS header is needed. Cross-origin callers are allowed only
 * when listed in ALLOWED_ORIGINS (comma-separated). "*" is never sent.
 */
export function applyCommonMiddleware(app: express.Express) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');
    }
    if (origin) res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // HSTS only when the request really arrived over HTTPS (Vercel); the LAN POS stays plain http.
    if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

/** Errors raised before/inside an /api router (bad JSON, oversized body...) are answered as JSON. */
export function apiErrorHandler(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[API] Unhandled error:', err?.message || err);
  res.status(status).json({
    error: err?.type === 'entity.parse.failed' ? 'Request body is not valid JSON.' : status >= 500 ? 'Internal server error.' : err?.message || 'Bad request.',
  });
}

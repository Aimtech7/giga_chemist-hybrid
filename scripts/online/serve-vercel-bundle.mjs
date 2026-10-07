// Serves the Vercel function bundle (api/index.js) on a local port, exactly as deployed, for
// automated tests and manual checks. Usage: PORT=3198 node scripts/online/serve-vercel-bundle.mjs
import http from 'http';
import { pathToFileURL } from 'url';
import path from 'path';

const { default: app } = await import(pathToFileURL(path.resolve('api/index.js')).href);
const port = Number(process.env.PORT || 3198);
http.createServer(app).listen(port, '127.0.0.1', () => console.log(`[vercel-bundle] http://127.0.0.1:${port}`));

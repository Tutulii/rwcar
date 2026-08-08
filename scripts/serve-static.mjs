import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve(process.env.WEB_ROOT?.trim() || join(process.cwd(), 'dist'));
const host = process.env.WEB_HOST?.trim() || '0.0.0.0';
const port = Number(process.env.WEB_PORT?.trim() || process.env.PORT?.trim() || 5173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('WEB_PORT or PORT must be a valid TCP port');
if (!existsSync(join(root, 'index.html'))) throw new Error(`Built frontend is missing at ${root}; run npm run build:v2:local`);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  if ((request.url || '').split('?', 1)[0] === '/health') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    }).end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    return;
  }
  let pathname;
  try {
    const rawPath = (request.url || '/').split('?', 1)[0];
    const decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.includes('\0') || decodedPath.split(/[\\/]/).includes('..')) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }
  const requested = resolve(root, `.${pathname}`);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  let file = requested;
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    file = join(root, 'index.html');
  }
  const metadata = statSync(file);
  const isHtml = extname(file).toLowerCase() === '.html';
  response.writeHead(200, {
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    'content-length': metadata.size,
    'content-type': contentTypes.get(extname(file).toLowerCase()) || 'application/octet-stream',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).on('error', () => response.destroy()).pipe(response);
});

server.listen(port, host, () => console.log(`RWCAR frontend listening at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

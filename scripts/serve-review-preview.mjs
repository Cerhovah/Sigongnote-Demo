import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const ui = path.join(repo, 'scripts/review-preview');
const web = path.join(repo, '.work/review-preview/web');
const lan = process.argv.includes('--lan');
const port = 5188;
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
await readJson(path.join(web, 'preview-build.json'));
const ipv4 = Object.values(networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address);
const allowedHosts = new Set(['localhost', '127.0.0.1', ...(lan ? ipv4 : [])]);
const files = new Map([['/', ['index.html', 'text/html']], ['/review.css', ['review.css', 'text/css']], ['/review.js', ['review.js', 'text/javascript']], ['/content.json', ['content.json', 'application/json']]]);
for (const name of ['pilot.js', 'pilot-model.mjs']) files.set(`/${name}`, [name, 'text/javascript']);
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const url = new URL(req.url, 'http://127.0.0.1'); const host = new URL(`http://${req.headers.host}`).hostname;
    if (!allowedHosts.has(host)) { res.writeHead(403).end(); return; }
    let file; let type;
    if (url.pathname === '/version.json') {
      const metadata = await readJson(path.join(web, 'preview-build.json'));
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ...metadata, lan, urls: (lan ? ipv4 : ['127.0.0.1']).map(ip => `http://${ip}:${port}/`) })); return;
    }
    if (url.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"service":"sigongnote-review-preview","data":"real-service-links"}'); return; }
    if (files.has(url.pathname)) { const entry = files.get(url.pathname); file = path.join(ui, entry[0]); type = entry[1]; }
    else if (['/app', '/app/'].includes(url.pathname)) {
      res.writeHead(302, { Location: 'https://sigongnote-api.onrender.com/' }).end(); return;
    } else if (/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg|woff2?)$/.test(url.pathname)) {
      file = await realpath(path.join(web, url.pathname)); const base = await realpath(web);
      if (!file.startsWith(base + path.sep)) { res.writeHead(404).end(); return; }
      type = ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' })[path.extname(file)];
    } else { res.writeHead(404).end(); return; }
    const body = await readFile(file); res.setHeader('Content-Type', `${type}; charset=utf-8`); res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end(); }
});
server.on('error', () => { console.error('Preview unavailable: check whether port 5188 is already in use.'); process.exitCode = 1; });
server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => console.log(`READY http://127.0.0.1:${port}/ ${lan ? 'LAN feedback-only' : 'PC only'}`));

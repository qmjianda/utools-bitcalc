// dev/shot-demo.mjs - screenshot the layout demo variants (headless Chrome + CDP, zero deps)
// usage: node dev/shot-demo.mjs [--scale=2]
//
// The demo is static, but screenshotting it through CDP is the only reliable way here:
// plain `chrome --screenshot` keeps handing off to an already running browser and exits 0
// without writing a file, so we drive one page per variant through the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9351);
const WEB_PORT = Number(process.env.WEB_PORT || 9352);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url.replace(/^[\\/]+/, '');
  const file = resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));

const VIEWS = [
  ['v0', 'v=v0', 760, 420],
  ['v1', 'v=v1', 760, 420],
  ['v2', 'v=v2', 760, 420],
  ['v3', 'v=v3', 760, 420],
  ['v3dark', 'v=v3&theme=dark', 760, 420],
  ['v4', 'v=v4', 760, 420],
  ['v5', 'v=v5&sel=15-12', 760, 420],
  ['v5dark', 'v=v5&theme=dark&sel=15-12', 760, 420],
  ['v5hist', 'v=v5&open=history', 760, 420],
  ['v5spec', 'v=v5&open=defs', 760, 420],
  ['v5wide', 'v=v5', 1000, 600],
  ['gallery', '', 1280, 1200],
];

const PROFILE = join(ROOT, 'dev', '.shot-profile-' + Date.now());
mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* still booting */ }
    await sleep(150);
  }
  throw new Error('cannot reach Chrome on port ' + PORT);
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');

for (const [name, query, w, h] of VIEWS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 2, mobile: false, screenWidth: w, screenHeight: h,
  });
  const base = 'http://127.0.0.1:' + WEB_PORT + '/dev/layout-demo.html';
  const url = base + '?' + (query ? query + '&' : '') + 't=' + Date.now();
  await send('Page.navigate', { url });
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(ROOT, 'dev', 'demo-' + name + '.png');
  (await import('node:fs')).writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('shot -> ' + file);
}

chrome.kill();
server.close();
process.exit(0);

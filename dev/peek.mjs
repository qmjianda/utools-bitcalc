// dev/peek.mjs - dump one DOM slice + its computed style (headless Chrome + CDP, zero deps)
// usage: node dev/peek.mjs "<css selector>" [width] [height]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9357);
const WEB_PORT = Number(process.env.WEB_PORT || 9358);
const SEL = process.argv[2] || '.value';
const W = Number(process.argv[3] || 760);
const H = Number(process.argv[4] || 420);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^[\\/]+/, '');
  const file = resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
const PAGE = 'http://127.0.0.1:' + WEB_PORT + '/index.html#utools';
const PROFILE = join(ROOT, 'dev', '.chrome-profile-peek');
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
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false, screenWidth: W, screenHeight: 1080 });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  window.utools = {
    onPluginEnter() {}, onPluginOut() {}, setSubInput() {}, setExpandHeight() {},
    copyText() {}, isDarkColors() { return false; },
    dbStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
})();` });
await send('Page.navigate', { url: PAGE });
await sleep(900);

const out = await evaluate(`(() => {
  const root = document.querySelector(${JSON.stringify(SEL)});
  if (!root) return 'no match';
  const walk = (el, depth) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).filter(Boolean);
    const lines = [ '  '.repeat(depth) + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') +
      ' [' + Math.round(b.x) + ',' + Math.round(b.y) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) + ']' +
      ' display=' + cs.display + ' font=' + cs.fontSize + '/' + cs.lineHeight + ' color=' + cs.color +
      (own.length ? ' text=' + JSON.stringify(own.join('|')) : '') ];
    for (const c of el.children) lines.push(...walk(c, depth + 1));
    return lines;
  };
  return walk(root, 0).join('\\n');
})()`);
console.log(out);
ws.close();
chrome.kill();
server.close();
process.exit(0);

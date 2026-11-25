// dev/check-demo.mjs - smoke test the layout demo interactions (headless Chrome + CDP, zero deps)
// usage: node dev/check-demo.mjs [v0|v1|v2|v3]
//
// The demo only ships clicks/drags, so the fastest proof that a variant is usable is
// driving it like a user: real mouse events (synthetic PointerEvents cannot own pointer
// capture) and then reading the rendered DOM back. Everything is scoped to the active
// frame because the gallery keeps the other variants mounted.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const V = process.argv[2] || 'v3';
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9353);
const WEB_PORT = Number(process.env.WEB_PORT || 9354);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = resolve(ROOT, url.replace(/^[\\/]+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try { const body = readFileSync(file); res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));

const PROFILE = join(ROOT, 'dev', '.chrome-profile-check');
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
    } catch { /* boot */ }
    await sleep(150);
  }
  throw new Error('cannot reach Chrome on port ' + PORT);
}
const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 420, deviceScaleFactor: 1, mobile: false, screenWidth: 760, screenHeight: 900 });
await send('Page.navigate', { url: 'http://127.0.0.1:' + WEB_PORT + '/dev/layout-demo.html?v=' + V });
await sleep(900);

// page-side helpers, scoped to the active frame (gallery keeps the other variants mounted)
await evaluate(`(() => {
  window.__f = () => document.querySelector('#demo .item.active .frame');
  window.__q = (sel) => window.__f().querySelector(sel);
  window.__qa = (sel) => Array.from(window.__f().querySelectorAll(sel));
  window.__rect = (sel) => { const e = window.__q(sel); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  window.__hit = (sel) => { const r = window.__rect(sel); if (!r) return false;
    const e = document.elementFromPoint(r.x, r.y); return e ? !!e.closest(sel) : false; };
})()`);

const pass = [];
const fail = [];
const ok = (name, cond, extra) => (cond ? pass : fail).push(name + (extra ? ' — ' + extra : ''));

async function click(sel) {
  const p = await evaluate('window.__rect(' + JSON.stringify(sel) + ')');
  if (!p) throw new Error('missing ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(90);
}
async function drag(a, b) {
  const p1 = await evaluate('window.__rect(' + JSON.stringify(a) + ')');
  const p2 = await evaluate('window.__rect(' + JSON.stringify(b) + ')');
  if (!p1 || !p2) throw new Error('missing drag target');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p1.x, y: p1.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p1.x + (p2.x - p1.x) * i / 4, y: p1.y + (p2.y - p1.y) * i / 4, button: 'left', buttons: 1 });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p2.x, y: p2.y, button: 'left', clickCount: 1 });
  await sleep(140);
}

// 1. 点一位 → 该位点亮 + 大数变化
const before = await evaluate('window.__q("[data-role=big]").textContent.trim()');
await click('.bit[data-pos="1"]');
const onCount = await evaluate('window.__qa(".bit.on").length');
const after = await evaluate('window.__q("[data-role=big]").textContent.trim()');
ok('clickBit', onCount >= 1 && before !== after, before + ' -> ' + after);

// 2. 拖选一段 → 选区框 + 状态行报位段（不同方案的行列不同，用第 1 行两格）
await drag('.bit[data-pos="14"]', '.bit[data-pos="12"]');
const segRect = await evaluate('window.__qa(".seg-rect").length');
const status = await evaluate('window.__q("[data-role=status]").textContent.trim()');
ok('dragSelect', segRect >= 1, 'rects=' + segRect + ' status=' + status);

// 3. 切位宽 8 → 网格 8 格
await click('[data-act=width][data-w="8"]');
const cells8 = await evaluate('window.__qa(".bit").length');
ok('width8', cells8 === 8, 'cells=' + cells8);

// 4. 切回 64 → 网格 64 格
await click('[data-act=width][data-w="64"]');
const cells64 = await evaluate('window.__qa(".bit").length');
ok('width64', cells64 === 64, 'cells=' + cells64);

// 5. 历史浮层（协议模式下才有定义入口，先保持 proto）
await click('[data-act=history]');
const histOpen = await evaluate('!window.__q("[data-role=history]").hidden');
const histRows = await evaluate('window.__qa(".hitem").length');
ok('historyPanel', histOpen && histRows >= 3, 'open=' + histOpen + ' rows=' + histRows);
await click('[data-act=close-history]');

// 6. 字段定义浮层（常驻语法 + 方案文本）
await click('[data-act=defs]');
const defsOpen = await evaluate('!window.__q("[data-role=defs]").hidden');
const defsText = await evaluate('window.__q("[data-role=defs-input]").value');
ok('specPanel', defsOpen && /opcode/.test(defsText), 'open=' + defsOpen);
await click('[data-act=close-defs]');

if (process.env.PROBE) {
  const info = await evaluate(`(() => {
    const list = window.__q('[data-role=fieldlist]');
    const cs = getComputedStyle(list);
    const rows = Array.from(list.children).map((r) => { const b = r.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; });
    const fields = window.__q('[data-role=fields]');
    const fc = getComputedStyle(fields);
    const frameCs = getComputedStyle(window.__f());
    return { display: cs.display, cols: cs.gridTemplateColumns, autoRows: cs.gridAutoRows, align: cs.alignContent,
      gap: cs.rowGap + '/' + cs.columnGap, h: Math.round(list.getBoundingClientRect().height),
      fieldsH: Math.round(fields.getBoundingClientRect().height), fieldsFlex: fc.flex, fieldsJustify: fc.justifyContent,
      frameJustify: frameCs.justifyContent, frameHeight: Math.round(window.__f().getBoundingClientRect().height),
      rows: rows.slice(0, 7) };
  })()`);
  console.log(JSON.stringify(info));
}


// 7. 切位计算模式 → 按钮态与面板同步
await click('[data-act=mode][data-mode=bits]');
const pressed = await evaluate('window.__q("[data-act=mode][data-mode=bits]").getAttribute("aria-pressed")');
ok('modeBits', pressed === 'true', 'aria-pressed=' + pressed);

if (process.env.PROBE) {
  const info = await evaluate(`(() => {
    const list = window.__q('[data-role=fieldlist]');
    const cs = getComputedStyle(list);
    const rows = Array.from(list.children).map((r) => { const b = r.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; });
    return { display: cs.display, cols: cs.gridTemplateColumns, autoRows: cs.gridAutoRows, align: cs.alignContent, h: Math.round(list.getBoundingClientRect().height), rows: rows.slice(0, 6) };
  })()`);
  console.log(JSON.stringify(info));
}

console.log('layout demo ' + V + ': ' + pass.length + '/' + (pass.length + fail.length) + ' pass');
pass.forEach((p) => console.log('  ok   ' + p));
fail.forEach((p) => console.log('  FAIL ' + p));

chrome.kill();
server.close();
process.exit(fail.length ? 1 : 0);

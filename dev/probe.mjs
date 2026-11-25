// 一次性探针：读页面里关键元素的计算样式，用来核对"眼睛看到的"和"CSS 实际算出来的"是否一致。
// 用法：node dev/probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///' + resolve(process.cwd(), 'index.html').replace(/\\/g, '/') + '#utools';
const profile = mkdtempSync(join(tmpdir(), 'bc-probe-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=9334',
  '--user-data-dir=' + profile,
  '--no-first-run',
  '--disable-extensions',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9334/json/list');
      const list = await r.json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('连不上 Chrome');
}

const wsUrl = await target();
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description || ''));
  return r.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: PAGE });
await sleep(900);

const pts = await evalJs(`(() => {
  const cells = [...document.querySelectorAll('.cell')];
  const a = cells[4].getBoundingClientRect();
  const b = cells[8].getBoundingClientRect();
  return {
    ax: a.x + a.width/2, ay: a.y + a.height/2,
    bx: b.x + b.width/2, by: b.y + b.height/2,
  };
})()`);

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.ax, y: pts.ay, button: 'left', buttons: 1, clickCount: 1 });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts.bx, y: pts.by, button: 'left', buttons: 1 });
await sleep(60);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.bx, y: pts.by, button: 'left', buttons: 0, clickCount: 1 });
await sleep(300);

const out = await evalJs(`(() => {
  const sel = [...document.querySelectorAll('.cell.sel')];
  const one = sel.find(c => !c.classList.contains('on')) || sel[0];
  if (!one) return { selCount: 0, hint: document.getElementById('hint').textContent };
  const g = getComputedStyle(one);
  return {
    selCount: sel.length,
    classes: one.className,
    bg: g.backgroundColor,
    border: g.borderTopColor,
    color: g.color,
    opacity: g.opacity,
    selBgVar: getComputedStyle(document.documentElement).getPropertyValue('--sel-bg').trim(),
    hint: document.getElementById('hint').textContent,
    h: Math.round(one.getBoundingClientRect().height),
    w: Math.round(one.getBoundingClientRect().width),
  };
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();

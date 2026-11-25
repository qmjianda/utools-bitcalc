// 交互态截图器：node dev/shot2.mjs [宽] [高]
// 走真实 DOM 事件（点 tab / 拖选位域 / 填字段定义），产出 4 张评审图：
//   01 位计算-选中位域、02 深色、03 协议解析-字段表、04 协议解析-悬停字段
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [w = '760', h = '420'] = process.argv.slice(2);
const PAGE = 'file:///' + resolve(process.cwd(), 'index.html').replace(/\\/g, '/') + '#utools';
const outDir = resolve(process.cwd(), 'dev');
const profile = mkdtempSync(join(tmpdir(), 'bc-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9337', '--user-data-dir=' + profile,
  '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9337/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('连不上 Chrome');
}

const ws = new WebSocket(await wsUrl());
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
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params }));
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

const shot = async (name) => {
  await sleep(220);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const p = join(outDir, name);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(p);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false,
});
await send('Page.navigate', { url: PAGE });
await sleep(900);

// ---- 1. 位计算：输入表达式 + 拖选一段位域 ----
await evaluate(`(() => {
  const i = document.querySelector('#fallback-expr');
  i.value = 'pow(2,17)|0xFF00|0xAC';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);

const rect = async (pos) => evaluate(`(() => {
  const el = document.querySelector('.cell[data-pos="${pos}"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);

const a = await rect(11);
const b = await rect(8);
if (!a || !b) throw new Error('找不到格子');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(200);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
await shot('v4-01-scoped.png');

// ---- 2. 深色 ----
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await shot('v4-02-dark.png');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// ---- 3. 协议解析：写字段定义 → 应用 → 点第一行 ----
await evaluate(`document.querySelector('#mode-tabs button[data-mode="proto"]').click()`);
await sleep(200);
await evaluate(`(() => {
  // 先清掉上一幕留下的位域选择，否则新值会被写进那 4 位里
  document.querySelector('#clear-btn').click();
  const t = document.querySelector('#spec-text');
  t.value = 'opcode 15:12\\nrd 11:8\\nrs 7:4\\nfunc 3:0';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#spec-save').click();
  return true;
})()`);
await sleep(250);
await evaluate(`(() => {
  const i = document.querySelector('#fallback-expr');
  i.value = '0x8D3A';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await evaluate(`document.querySelectorAll('.field-row')[0].click()`);
await sleep(250);
await shot('v4-03-proto.png');

// ---- 4. 悬停第二行（网格 ↔ 表联动） ----
const row = await evaluate(`(() => {
  const r = document.querySelectorAll('.field-row')[1].getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y, buttons: 0 });
await shot('v4-04-proto-hover.png');

// ---- 断言 ----
const report = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const txt = (s) => (q(s) ? q(s).textContent.trim() : null);
  return {
    cells: document.querySelectorAll('.cell').length,
    noFatal: !document.querySelector('.fatal'),
    dec: txt('#val-dec'),
    hex: txt('#val-hex'),
    chip: q('#field-chip').hidden ? null : txt('#field-chip'),
    hint: txt('#hint'),
    fieldRows: document.querySelectorAll('.field-row').length,
    fieldVals: [].map.call(document.querySelectorAll('.field-row-val'), (e) => e.textContent),
    selCells: document.querySelectorAll('.cell.sel').length,
    onCells: document.querySelectorAll('.cell.on').length,
    bodyH: document.body.style.height,
    panelHidden: q('#field-panel').hidden,
  };
})()`);
console.log(JSON.stringify(report, null, 2));

// ---- 5. 位宽 8 / 32（窗口高度跟着位宽变，所以截图前同步视口高度）----
await evaluate(`document.querySelector('#mode-tabs button[data-mode="bits"]').click()`);
await sleep(150);

for (const spec of [
  { width: 8, expr: '0xFF', name: 'v4-05-w8.png' },
  { width: 32, expr: '0x3FC00000', name: 'v4-06-w32.png' },
]) {
  await evaluate(`(() => {
    document.querySelector('#width-seg button[data-w="${spec.width}"]').click();
    const i = document.querySelector('#fallback-expr');
    i.value = '${spec.expr}';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const m = await evaluate(`(() => ({
    inline: document.body.style.height,
    scroll: document.body.scrollHeight,
    wrap: document.querySelector('.wrap').offsetHeight,
  }))()`);
  console.log(spec.width + ' 位：', JSON.stringify(m));
  const px = Number(String(m.inline).replace('px', '')) || m.wrap;
  if (px > 0) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(w), height: px, deviceScaleFactor: 2, mobile: false,
    });
  }
  await sleep(300);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 });
  await shot(spec.name);
}

// ---- 6. 选中位域后输入 = 写回该位域（BitCalc 的核心手感）----
await evaluate(`(() => {
  document.querySelector('#mode-tabs button[data-mode="bits"]').click();
  document.querySelector('#width-seg button[data-w="64"]').click();
  document.querySelector('#clear-btn').click();
  const i = document.querySelector('#fallback-expr');
  i.value = '0';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
const c11 = await rect(11);
const c8 = await rect(8);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c11.x, y: c11.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c8.x, y: c8.y, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c8.x, y: c8.y, button: 'left', clickCount: 1, buttons: 0 });
await sleep(200);
const writeBack = await evaluate(`(() => {
  const i = document.querySelector('#fallback-expr');
  i.value = '0xF';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return new Promise((r) => setTimeout(() => r({
    dec: document.querySelector('#val-dec').textContent,
    hex: document.querySelector('#val-hex').textContent,
    bin: document.querySelector('#val-bin').textContent,
    hint: document.querySelector('#hint').textContent,
  }), 120));
})()`);
console.log('写回位域：', JSON.stringify(writeBack));

ws.close();
chrome.kill();

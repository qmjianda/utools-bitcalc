// 通用截图器：node dev/shot.mjs <相对路径> <输出名> [宽] [高] [缩放倍数] [hash]
// 用 Chrome DevTools Protocol 截任意页面，供视觉评审用。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const [rel, outName, w = '760', h = '540', dsf = '2', hash = ''] = process.argv.slice(2);
const PAGE = 'file:///' + resolve(process.cwd(), rel).replace(/\\/g, '/') + (hash ? '#' + hash : '');
const outPath = resolve(process.cwd(), 'dev', outName);
const profile = mkdtempSync(join(tmpdir(), 'bc-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9335', '--user-data-dir=' + profile,
  '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
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

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(w), height: Number(h), deviceScaleFactor: Number(dsf), mobile: false,
});
await send('Page.navigate', { url: PAGE });
await sleep(700);
const { data } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outPath, Buffer.from(data, 'base64'));
console.log(outPath);
ws.close();
chrome.kill();

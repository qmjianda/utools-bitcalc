'use strict';

/*
 * Headless-Chrome screenshot pipeline for bitcalc marketing shots.
 * No dependencies: static server + Chrome DevTools Protocol over the
 * built-in WebSocket client (Node 22+).
 *
 * Usage: node scripts/shots/capture.js
 * Output: .shots/raw/*.png + .shots/raw/rects.json
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.shots', 'raw');
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 47821;
const DEBUG_PORT = 47822;
const CSS_W = 1440;
const CSS_H = 900;
const DPR = 2;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function startServer() {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      fs.readFile(file, function (err, buf) {
        if (err) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    server.listen(PORT, '127.0.0.1', function () { resolve(server); });
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function cdpConnect() {
  return fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then(function (r) { return r.json(); }).then(function (list) {
    const page = list.find(function (t) { return t.type === 'page'; });
    if (!page) throw new Error('no page target');
    return page.webSocketDebuggerUrl;
  });
}

function makeClient(wsUrl) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;

    ws.addEventListener('open', function () {
      resolve({
        send: function (method, params) {
          const id = nextId++;
          return new Promise(function (res, rej) {
            pending.set(id, { res: res, rej: rej });
            ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
          });
        },
        on: function (event, fn) {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(fn);
        },
        close: function () { ws.close(); },
      });
    });

    ws.addEventListener('message', function (ev) {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.method + ': ' + JSON.stringify(msg.error)));
        else p.res(msg.result);
        return;
      }
      if (msg.method && listeners.has(msg.method)) {
        listeners.get(msg.method).forEach(function (fn) { fn(msg.params); });
      }
    });

    ws.addEventListener('error', function (e) { reject(new Error('ws error ' + (e.message || ''))); });
  });
}

function waitLoad(client) {
  return new Promise(function (resolve) {
    const timer = setTimeout(resolve, 8000);
    client.on('Page.loadEventFired', function () {
      clearTimeout(timer);
      resolve();
    });
  });
}

const FIELDS_64 = [
  '# 64 位寄存器示例',
  'opcode 63:60',
  'dst 59:56',
  'src 55:52',
  'mode 51:48',
  'imm 19:0',
].join('\n');

const FIELDS_16 = [
  '# 16 位指令示例',
  'opcode 15:12',
  'dst 11:8',
  'src 7:4',
  'mode:3',
  'flag 0:0',
].join('\n');

function settings(extra) {
  return Object.assign({
    width: 64,
    signed: false,
    endian: 'BE',
    base: 'HEX',
    theme: 'dark',
    showFloat: true,
  }, extra || {});
}

function historyEntry(i, type, label, before, after, extra) {
  return Object.assign({
    id: 'h' + i,
    ts: Date.now() - i * 42000,
    type: type,
    label: label,
    expression: '',
    fieldName: '',
    hi: null,
    lo: null,
    before: before,
    after: after,
    width: 64,
  }, extra || {});
}

const SCENARIOS = [
  {
    name: '01-hero',
    caption: '一屏看全：数值、位图与字段',
    seed: {
      settings: settings({}),
      value: '0xA1B2C3D4E5F60718',
      fields: FIELDS_64,
      schemes: [],
      history: [],
      theme: 'dark',
    },
    rects: ['#exprForm', '#baseList', '#bitGrid', '#fieldStrip', '#mainHeader'],
  },
  {
    name: '02-enable',
    caption: '拖选一段位，就是字段',
    seed: {
      settings: settings({}),
      value: '0xA1B2C3D4E5F60718',
      fields: FIELDS_64,
      schemes: [],
      history: [],
      theme: 'dark',
    },
    actions: 'select-63-60',
    rects: ['#enableControls', '#exprForm', '#baseList', '#bitGrid'],
  },
  {
    name: '03-fields',
    caption: '定义一次，按名字改值',
    seed: {
      settings: settings({ width: 16 }),
      value: '0xABCD',
      fields: FIELDS_16,
      schemes: [
        {
          id: 's1',
          name: 'STM32 指令帧',
          text: FIELDS_16,
          createdAt: Date.now() - 86400000,
          updatedAt: Date.now() - 3600000,
          width: 16,
          fieldCount: 5,
        },
      ],
      history: [],
      theme: 'dark',
    },
    actions: 'open-fields',
    rects: ['#fieldsDialog'],
  },
  {
    name: '04-history',
    caption: '算过的、改过的，都能找回来',
    seed: {
      settings: settings({ width: 32 }),
      value: '0x00C0FFEE',
      fields: FIELDS_16,
      schemes: [],
      history: [
        historyEntry(1, 'expr', '计算 0xA1B2C3D4 ^ 0x00FF00FF', '0x00C0FFEE', '0xA14DC32B', { expression: '0xA1B2C3D4 ^ 0x00FF00FF', width: 32 }),
        historyEntry(2, 'field', '字段 dst 写入 0x7', '0x00000000', '0x00000700', { fieldName: 'dst', hi: 11, lo: 8, before: '0x00000000', after: '0x00000700', width: 32 }),
        historyEntry(3, 'bit', '翻转 bit 7', '0x00000700', '0x00000780', { hi: 7, lo: 7, width: 32 }),
        historyEntry(4, 'range', '位段 15:12 置 1', '0x00000780', '0x0000F780', { hi: 15, lo: 12, width: 32 }),
        historyEntry(5, 'expr', '计算 1 << 16', '0x0000F780', '0x00010000', { expression: '1 << 16', width: 32 }),
        historyEntry(6, 'bit', '翻转 bit 0', '0x00010000', '0x00010001', { hi: 0, lo: 0, width: 32 }),
      ],
      theme: 'dark',
    },
    actions: 'open-history',
    rects: ['#historyDialog'],
  },
  {
    name: '05-help',
    caption: '内置使用指南，按 ? 随时打开',
    seed: {
      settings: settings({}),
      value: '0xA1B2C3D4E5F60718',
      fields: FIELDS_64,
      schemes: [],
      history: [],
      theme: 'dark',
    },
    actions: 'open-help',
    rects: ['#helpDialog'],
  },
];

const SEED_JS = function (s) {
  return [
    'localStorage.clear();',
    'localStorage.setItem("bitcalc.settings", ' + JSON.stringify(JSON.stringify(s.settings)) + ');',
    'localStorage.setItem("bitcalc.value", ' + JSON.stringify(JSON.stringify(s.value)) + ');',
    'localStorage.setItem("bitcalc.fields", ' + JSON.stringify(JSON.stringify(s.fields)) + ');',
    'localStorage.setItem("bitcalc.schemes", ' + JSON.stringify(JSON.stringify(s.schemes)) + ');',
    'localStorage.setItem("bitcalc.history", ' + JSON.stringify(JSON.stringify(s.history)) + ');',
    'localStorage.setItem("bitcalc.theme", ' + JSON.stringify(s.theme) + ');',
    '"seeded";',
  ].join('\n');
};

const ACTIONS_JS = {
  'select-63-60': [
    '(async function(){',
    '  const sleep = (ms) => new Promise(r => setTimeout(r, ms));',
    '  const cell = (b) => document.querySelector(".bit[data-bit=\\"" + b + "\\"]");',
    '  const fire = (el, type, opts) => el.dispatchEvent(new PointerEvent(type, Object.assign({bubbles:true, cancelable:true, pointerId:1, pointerType:"mouse", isPrimary:true}, opts)));',
    '  const start = cell(63);',
    '  if (!start) return "no cell";',
    '  fire(start, "pointerdown", {buttons:1});',
    '  await sleep(30);',
    '  for (const b of [62, 61, 60]) { const c = cell(b); if (c) { fire(c, "pointerover", {buttons:1}); await sleep(30); } }',
    '  document.dispatchEvent(new PointerEvent("pointerup", {bubbles:true, pointerId:1, pointerType:"mouse"}));',
    '  await sleep(100);',
    '  const input = document.getElementById("exprInput");',
    '  if (input) { input.value = "0x5"; input.dispatchEvent(new Event("input", {bubbles:true})); }',
    '  await sleep(60);',
    '  const form = document.getElementById("exprForm");',
    '  if (form) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", {bubbles:true, cancelable:true}));',
    '  await sleep(200);',
    '  return "ok";',
    '})()',
  ].join('\n'),
  'open-fields': 'document.getElementById("fieldsBtn").click(); "ok"',
  'open-history': 'document.getElementById("menuHistory").click(); "ok"',
  'open-help': 'document.getElementById("menuHelp").click(); "ok"',
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = path.join(ROOT, '.shots', 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const logPath = path.join(ROOT, '.shots', 'chrome.log');
  const logFd = fs.openSync(logPath, 'w');

  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-extensions',
    '--force-device-scale-factor=' + DPR,
    '--window-size=' + CSS_W + ',' + CSS_H,
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + DEBUG_PORT,
    'about:blank',
  ], { stdio: ['ignore', logFd, logFd] });

  let client;
  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        const list = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list').then(function (r) { return r.json(); });
        const page = list.find(function (t) { return t.type === 'page'; });
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch (e) { /* retry */ }
    }
    if (!wsUrl) throw new Error('Chrome did not expose a page target');

    client = await makeClient(wsUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: CSS_W, height: CSS_H, deviceScaleFactor: DPR, mobile: false,
    });

    const url = 'http://127.0.0.1:' + PORT + '/index.html';
    let loadPromise = waitLoad(client);
    await client.send('Page.navigate', { url: url });
    await loadPromise;
    await sleep(500);

    const rects = {};
    let seedScriptId = null;
    let navIndex = 0;
    for (const sc of SCENARIOS) {
      if (seedScriptId) {
        await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScriptId });
      }
      const added = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: SEED_JS(sc.seed) });
      seedScriptId = added.identifier;

      loadPromise = waitLoad(client);
      await client.send('Page.navigate', { url: url + '?shot=' + (++navIndex), cacheBust: true });
      await loadPromise;
      await sleep(700);

      if (sc.actions) {
        const act = await client.send('Runtime.evaluate', { expression: ACTIONS_JS[sc.actions], awaitPromise: true, returnByValue: true });
        if (act && act.exceptionDetails) throw new Error('action failed: ' + JSON.stringify(act.exceptionDetails));
        await sleep(500);
      }

      const info = await client.send('Runtime.evaluate', {
        returnByValue: true,
        expression: '(function(){ var o={}; var sels=' + JSON.stringify(['#main', '#app'].concat(sc.rects || [])) + ';' +
          'sels.forEach(function(s){ var e=document.querySelector(s); if(!e) return; var r=e.getBoundingClientRect(); o[s]={x:r.x,y:r.y,w:r.width,h:r.height,text:(e.innerText||"").slice(0,40)}; });' +
          'return {title: document.title, rects: o, scrollH: document.documentElement.scrollHeight}; })()',
      });
      rects[sc.name] = info.result ? info.result.value : null;

      const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(OUT, sc.name + '.png'), Buffer.from(shot.data, 'base64'));
      console.log('captured', sc.name);
    }

    fs.writeFileSync(path.join(OUT, 'rects.json'), JSON.stringify(rects, null, 2));
  } finally {
    if (client) client.close();
    child.kill();
    server.close();
    fs.closeSync(logFd);
  }
}

main().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});

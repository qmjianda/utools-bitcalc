/**
 * dev/cdp.mjs — 用 Chrome DevTools Protocol 驱动插件页面做视觉/交互调试。
 *
 * 为什么需要它：插件页面就是普通前端，但"看起来对"必须靠真实渲染判断。
 * 这个脚本能做的事，正是 uTools 里做不到的那部分：强制深浅色、精确点击、拖拽、
 * 截图，从而在没有 uTools 的环境下核对视觉与交互。
 *
 * 用法（需要浏览器权限）：
 *   node dev/cdp.mjs <输出目录>
 *
 * 输出：01-light.png / 02-dark.png / 03-error.png / 04-hover.png
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const HERE = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PAGE = 'file:///' + (resolve(HERE, '..', 'index.html').replace(/\\/g, '/'));
const OUT = resolve(process.argv[2] || join(tmpdir(), 'bc-shots'));
const PROFILE = join(tmpdir(), 'cdp-profile-' + Date.now());

const W = 760;
const H = 342; // 与 main.js 的 heightFor(64) 一致

/** 与 main.js heightFor() 保持同一套算式：窗口高度跟着位宽走 */
const heightFor = (w) => {
  const rows = w >= 32 ? (w === 32 ? 2 : 4) : 1;
  const gridH = rows * 30 + (rows - 1) * 2;
  const readoutRows = w >= 32 ? 5 : 4;
  return 22 + 22 + 8 + gridH + 12 + (readoutRows * 26 + 2) + 20;
};

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-breakpad',
    '--no-first-run',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    PAGE + '#utools',
  ],
  { stdio: 'ignore' }
);

let ws;
let nextId = 1;
const pending = new Map();
const events = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rej(new Error('CDP 超时: ' + method));
      }
    }, 15000);
  });
}

function once(event) {
  return new Promise((res) => {
    const list = events.get(event) || [];
    list.push(res);
    events.set(event, list);
  });
}

async function main() {
  // 等 Chrome 起来并拿到 page target
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('没能连上 Chrome 调试端口');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      const list = events.get(msg.method);
      if (list && list.length) list.shift()(msg.params);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('  ' + name);
  };

  // 换位宽就等于换窗口高度：这里跟着改视口，才能验证「uTools 里不会被裁」
  const setViewport = async (h) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: h,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(150);
  };

  const go = async (hash) => {
    // 先跳 about:blank 再回来：只改 hash 属于同文档导航，不会触发 load 事件（会卡死等待），
    // 而且重新加载能保证每个场景的状态干净。
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(120);
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url: PAGE + hash });
    await Promise.race([loaded, sleep(2500)]);
    await sleep(320);
  };

  const centerOf = async (selector) => {
    const { result } = await send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      returnByValue: true,
    });
    return result.value;
  };

  const cellCenter = async (pos) => centerOf(`.cell[data-pos="${pos}"]`);

  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    });

  const clickCell = async (pos) => {
    const p = await cellCenter(pos);
    await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
    await mouse('mousePressed', p.x, p.y);
    await mouse('mouseReleased', p.x, p.y);
    await sleep(60);
  };

  const dragCells = async (from, to) => {
    const a = await cellCenter(from);
    const b = await cellCenter(to);
    await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
    await mouse('mousePressed', a.x, a.y);
    await sleep(40);
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      await mouse('mouseMoved', a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      await sleep(25);
    }
    await mouse('mouseReleased', b.x, b.y);
    await sleep(80);
  };

  const evalJs = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  };

  console.log('截图输出到 ' + OUT);

  // ---- 场景 0：静止态（值全 0、鼠标不在网格上）→ 位号应完全隐去 ----
  await go('#utools');
  await mouse('mouseMoved', 6, 6, { buttons: 0 });
  await sleep(220);
  await shot('00-idle.png');
  const noVisible = await evalJs(
    `getComputedStyle(document.querySelector('.cell-no')).opacity`
  );
  console.log('  静止态位号 opacity = ' + noVisible);

  // ---- 场景 1：浅色 + 若干位置 1 + 一段已提交的位域选择 ----
  await go('#utools');
  await clickCell(63);
  await clickCell(60);
  await clickCell(48);
  await clickCell(13);
  await clickCell(9);
  await clickCell(0);
  await dragCells(13, 9);
  await sleep(200);
  await shot('01-light.png');
  console.log('  hint = ' + (await evalJs(`document.getElementById('hint').textContent`)));

  // ---- 场景 2：同一状态下的深色主题 ----
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await sleep(200);
  await shot('02-dark.png');

  // ---- 场景 3：非法表达式 → 工具栏原地报错（不改变布局） ----
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await go('#utools');
  await evalJs(`(() => {
    const i = document.getElementById('expr-input');
    i.focus();
    i.value = '0xFF << ';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await shot('03-error.png');
  console.log('  hint = ' + (await evalJs(`document.getElementById('hint').textContent`)));

  // ---- 场景 4：合法表达式 + 悬停某一位 ----
  await evalJs(`(() => {
    const i = document.getElementById('expr-input');
    i.value = 'pow(2,17) | 0xFF00';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // 输入框有 200ms 防抖，等它算完再取坐标：否则求值引起的重建会发生在光标移动之后，
  // :hover 状态被新节点丢掉，悬停断言偶发失败
  await sleep(320);
  const hp = await cellCenter(37);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: hp.x,
    y: hp.y,
    buttons: 0,
  });
  await sleep(200);
  await shot('04-hover.png');
  console.log('  hint = ' + (await evalJs(`document.getElementById('hint').textContent`)));

  // ---- 交互断言（不靠肉眼） ----
  const checks = [];
  const assert = async (name, expression, expected) => {
    const got = await evalJs(expression);
    checks.push({
      name,
      ok: JSON.stringify(got) === JSON.stringify(expected),
      got,
      expected,
    });
  };
  await assert('格子总数 = 64', `document.querySelectorAll('.cell').length`, 64);
  await assert('位号标签数 = 64', `document.querySelectorAll('.cell-no').length`, 64);
  await assert(
    '右下角格位号 = 0',
    `document.querySelector('.cell[data-pos="0"] .cell-no').textContent`,
    '0'
  );
  await assert('无致命错误条', `document.querySelectorAll('.fatal').length`, 0);
  // BIN 行已删：64 位二进制由位网格表达，主进制切换只留 DEC/HEX/OCT
  await assert(
    '主进制切换 = 三档',
    `document.querySelectorAll('#base-switch button').length`,
    3
  );
  await assert('BIN 读数行已移除', `!!document.getElementById('val-bin')`, false);
  await assert(
    'pow(2,17)|0xFF00 的 DEC',
    `document.getElementById('val-dec').textContent`,
    '196,352'
  );

  // 悬停组：被指的格与同组其它格的底色必须不同（否则读不出「组」这件事）
  const nibStyles = await evalJs(`(() => {
    const g = (p) => getComputedStyle(document.querySelector('.cell[data-pos="' + p + '"]')).backgroundColor;
    const cls = (p) => document.querySelector('.cell[data-pos="' + p + '"]').className;
    return { hovered: g(37), sibling: g(36), cls37: cls(37), cls36: cls(36) };
  })()`);
  console.log('  悬停组样式 = ' + JSON.stringify(nibStyles));
  checks.push({
    name: '悬停格与同组底色不同',
    ok: nibStyles.hovered !== nibStyles.sibling,
    got: nibStyles.hovered,
    expected: '≠ ' + nibStyles.sibling,
  });

  // ---- 场景 5：位宽 8 ----
  await evalJs(`document.querySelector('#width-seg button[data-w="8"]').click()`);
  await setViewport(heightFor(8));
  await mouse('mouseMoved', 6, 6, { buttons: 0 }); // 移出网格，让工具栏回到默认/提醒态
  await sleep(150);
  await shot('05-width8.png');
  await assert('位宽 8：格子只剩 8 个', `document.querySelectorAll('.cell').length`, 8);
  await assert('位宽 8：HEX 只留 2 位', `document.getElementById('val-hex').textContent`, '0x00');
  await assert('位宽 8：浮点行隐藏', `document.getElementById('row-float').hidden`, true);
  await assert(
    '位宽 8：截断提醒',
    `document.getElementById('hint').textContent`,
    '超出 8 位的高位已忽略'
  );

  // ---- 场景 6：64 位 + 小端 HEX ----
  await evalJs(`document.querySelector('#width-seg button[data-w="64"]').click()`);
  await setViewport(heightFor(64));
  await evalJs(`document.getElementById('endian-btn').click()`);
  await sleep(120);
  await shot('06-little-endian.png');
  await assert(
    '小端 HEX = 字节反转',
    `document.getElementById('val-hex').textContent`,
    '0x00FF020000000000'
  );
  await evalJs(`document.getElementById('endian-btn').click()`); // 还原
  await sleep(100);

  // ---- 场景 7：32 位下把位模式读成 f32 ----
  await evalJs(`(() => {
    const i = document.getElementById('expr-input');
    i.value = '0x3FC00000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evalJs(`document.querySelector('#width-seg button[data-w="32"]').click()`);
  await setViewport(heightFor(32));
  await mouse('mouseMoved', 6, 6, { buttons: 0 });
  await sleep(150);
  await shot('07-f32.png');
  await assert('32 位 f32 读数 = 1.5', `document.getElementById('val-float').textContent`, '1.5');
  await assert('32 位：浮点行标签 F32', `document.getElementById('float-name').textContent`, 'F32');
  await assert(
    '32 位：HEX 读数 8 位',
    `document.getElementById('val-hex').textContent`,
    '0x3FC00000'
  );
  await assert('32 位：格子 32 个', `document.querySelectorAll('.cell').length`, 32);
  // 布局自检：内容不得超出 uTools 会给的窗口高度（超出就会被裁）
  await assert(
    '32 位：内容不溢出',
    `document.documentElement.scrollHeight <= ${heightFor(32)}`,
    true
  );

  console.log('\n交互断言：');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}` + (c.ok ? '' : `  期望 ${JSON.stringify(c.expected)} 实际 ${JSON.stringify(c.got)}`));
  }
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('失败：' + e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { ws && ws.close(); } catch {}
    chrome.kill();
    await sleep(300);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  });

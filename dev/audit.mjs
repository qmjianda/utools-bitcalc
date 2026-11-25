// dev/audit.mjs - layout & interaction regression probe (headless Chrome + CDP, zero deps)
// usage: node dev/audit.mjs [width] [height] [--shots]
//
// Covers the two bugs that started this branch:
//   A. entering through the plain-text command (type="text") must not evaluate the payload
//      as an expression (used to throw: 未知函数或标识符 "bitcalc")
//   B. in protocol mode the field panel must never be squeezed (32-bit used to leave 1.5 rows)
// plus the added features: persistent syntax help, live validation, named schemes, history.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9347);
const WEB_PORT = Number(process.env.WEB_PORT || 9348);
// 起一个静态服务再测：file:// 下的 localStorage 行为随 Chromium 版本变，
// 换成 http 源能稳定验证「设置/字段跨刷新保留」。uTools 里走的是 dbStorage，两条都测到。
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
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // 不缓存：否则改完 CSS/JS 重跑脚本，Chrome 仍用旧字节，截图与实测都是上一版
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', r));
const PAGE = 'http://127.0.0.1:' + WEB_PORT + '/index.html';
const W = Number(process.argv[2] || 760);
const H = Number(process.argv[3] || 420);
const SHOTS = process.argv.includes('--shots');
const PROFILE = join(ROOT, 'dev', '.chrome-profile');
mkdirSync(PROFILE, { recursive: true });

const SPEC32 = ['opcode 31:28', 'rd 27:24', 'rs 23:20', 'func 19:16', 'flag 15:15', 'cnt 14:12', 'rsvd 11:0'].join('\n');

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
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 2, mobile: false, screenWidth: W, screenHeight: 1080,
});

// uTools stub: records enter/subInput/expand so we can assert the plugin contract
const stub = `(() => {
  const rec = { enter: null, subInput: null, expand: 0, copied: [] };
  window.__utRec = rec;
  window.utools = {
    onPluginEnter(fn) { rec.enter = fn; },
    onPluginOut(fn) { rec.out = fn; },
    setSubInput(fn, ph) { rec.subInput = fn; rec.subPh = ph; },
    setExpandHeight(h) { rec.expand = h; },
    copyText(t) { rec.copied.push(t); },
    isDarkColors() { return false; }
  };
  // 默认每个新文档都清空存储；URL 带 ?keep 时保留（用于验证设置/字段跨刷新恢复）
  try { if (location.search.indexOf('keep') < 0) { localStorage.clear(); } } catch (e) {}
  // uTools 的持久层：插件真实环境里 store.js 优先用它，这里用 localStorage 兜底实现
  window.utools.dbStorage = {
    getItem(k) { try { return localStorage.getItem('db:' + k); } catch (e) { return null; } },
    setItem(k, v) { try { localStorage.setItem('db:' + k, String(v)); } catch (e) {} },
    removeItem(k) { try { localStorage.removeItem('db:' + k); } catch (e) {} }
  };
})();`;

await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
await send('Page.navigate', { url: PAGE });
await sleep(900);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
// helper injected into every page-side snippet
const BOX = 'const box=(el)=>{if(!el)return null;const b=el.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),bottom:Math.round(b.bottom),right:Math.round(b.right)};};';
const FRAME = 'const frame=()=>new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(r)));';

// ---------- 1) entry payload regression ----------
const enterText = await evaluate(`(() => {
  window.__utRec.enter({ code: 'bitcalc', type: 'text', payload: 'bitcalc', option: { code: 'bitcalc' } });
  const h = document.querySelector('#hint');
  return { hint: h.textContent.trim(), cls: h.className, val: document.querySelector('#val-dec').textContent.trim() };
})()`);
check('enterByTextCmd', enterText.cls.indexOf('error') < 0 && enterText.hint.indexOf('未知') < 0,
  'text command must not error; hint=' + JSON.stringify(enterText.hint));

const enterRegex = await evaluate(`(() => {
  window.__utRec.enter({ code: 'x', type: 'regex', payload: '0xFF' });
  return { val: document.querySelector('#val-dec').textContent.trim(),
           cls: document.querySelector('#hint').className };
})()`);
check('enterByRegexPayload', enterRegex.val === '255' && enterRegex.cls.indexOf('error') < 0,
  'regex payload should be evaluated; val=' + enterRegex.val + ' cls=' + enterRegex.cls);

// ---------- 2) geometry ----------
const measure = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  ${BOX}
  ${FRAME}
  const out = { cases: {} };
  function snap(name) {
    const cells = [...document.querySelectorAll('.cell')];
    const rows = [...document.querySelectorAll('.field-row')];
    const stage = box(q('#stage'));
    const body = q('#field-body');
    const bodyBox = box(body);
    const visibleRows = bodyBox ? rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= bodyBox.y - 1 && b.bottom <= bodyBox.bottom + 1;
    }).length : 0;
    out.cases[name] = {
      viewport: { w: innerWidth, h: innerHeight },
      pageH: Math.round(document.body.getBoundingClientRect().height),
      expand: window.__utRec.expand,
      stage, grid: box(q('.grid')), fields: box(q('#field-panel')),
      fieldsHead: box(q('.fields-head')),
      fieldsBody: body ? { clientH: body.clientHeight, scrollH: body.scrollHeight, box: bodyBox } : null,
      rows: rows.length, visibleRows,
      readouts: box(q('#readouts')),
      cellCount: cells.length,
      cellsBelowStage: cells.filter((c) => box(c).bottom > stage.bottom + 1).length,
      readoutsCoverGrid: (() => {
        const g = box(q('.grid')), ro = box(q('#readouts'));
        if (!g || !ro) { return 0; }
        // 新版布局里读数在网格右侧，两者本来就可能同一水平带；要判的是矩形是否真的相交
        const dx = Math.max(0, Math.min(g.right, ro.right) - Math.max(g.x, ro.x));
        const dy = Math.max(0, Math.min(g.bottom, ro.bottom) - Math.max(g.y, ro.y));
        return Math.round(dx * dy);
      })(),
      pageOverflow: Math.round(document.body.getBoundingClientRect().height - innerHeight)
    };
  }
  snap('bits64');
  q('#width-seg button[data-w="8"]').click();
  await frame();
  snap('bits8');
  q('#width-seg button[data-w="64"]').click();
  q('#mode-tabs button[data-mode="proto"]').click();
  const setSpec = (txt) => {
    if (q('#spec-panel').hidden) { q('#field-edit-btn').click(); }
    const t = q('#spec-text');
    t.value = txt; t.dispatchEvent(new Event('input', { bubbles: true }));
    q('#spec-save').click();
  };
  setSpec('opcode 15:12\\nrd 11:8\\nrs 7:4\\nfunc 3:0');
  await frame();
  snap('proto64');
  q('#width-seg button[data-w="32"]').click();
  setSpec(${JSON.stringify(SPEC32)});
  await frame();
  snap('proto32many');
  return out;
})()`);

const c = measure.cases;
check('bits64_noCover', c.bits64.readoutsCoverGrid === 0 && c.bits64.cellsBelowStage === 0,
  'grid/readouts overlap ' + c.bits64.readoutsCoverGrid + 'px2, cells past stage ' + c.bits64.cellsBelowStage);
check('bits64_expandFits', Math.abs(c.bits64.expand - c.bits64.pageH) <= 2,
  'expand=' + c.bits64.expand + ' pageH=' + c.bits64.pageH);
check('proto32_allRowsVisible', c.proto32many.visibleRows === c.proto32many.rows && c.proto32many.rows === 7,
  'field rows ' + c.proto32many.rows + ', fully visible ' + c.proto32many.visibleRows +
  ', panel ' + (c.proto32many.fields ? c.proto32many.fields.h : '?') + 'px (stage=' + c.proto32many.stage.h + ')');
check('proto32_gridIntact', c.proto32many.readoutsCoverGrid === 0 && c.proto32many.cellsBelowStage === 0,
  'overlap ' + c.proto32many.readoutsCoverGrid + 'px2, cells past stage ' + c.proto32many.cellsBelowStage);
check('proto64_noCover', c.proto64.readoutsCoverGrid === 0 && c.proto64.cellsBelowStage === 0,
  'proto64 overlap ' + c.proto64.readoutsCoverGrid + 'px2, cells past stage ' + c.proto64.cellsBelowStage);
check('protoPageFitsWindow', Math.abs(c.proto32many.expand - c.proto32many.pageH) <= 2 && c.proto32many.pageOverflow <= 2,
  'expand=' + c.proto32many.expand + ' pageH=' + c.proto32many.pageH);

// ---------- 3) spec editor: persistent help + live validation ----------
const specUi = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  q('#field-edit-btn').click();
  const help = q('#spec-help');
  const panelOpen = !q('#spec-panel').hidden;
  const helpText = help.textContent.trim();
  const helpVisible = !help.hidden && help.getBoundingClientRect().height > 20;

  const t = q('#spec-text');
  t.value = '这不是字段'; t.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  const badMsg = q('#spec-msg').textContent.trim();
  const badCls = q('#spec-msg').className;
  const invalid = t.getAttribute('aria-invalid');

  t.value = 'a 15:12\\nb 11:8'; t.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  const okMsg = q('#spec-msg').textContent.trim();
  const okCls = q('#spec-msg').className;
  const invalidAfter = t.getAttribute('aria-invalid');

  // dirty: edited but not applied yet
  t.value = 'a 15:12\\nb 11:8\\nc 7:4'; t.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  const dirtyMsg = q('#spec-msg').textContent.trim();

  return { panelOpen, helpVisible, helpText, badMsg, badCls, invalid, okMsg, okCls, invalidAfter, dirtyMsg };
})()`);
check('specHelpPersistent', specUi.panelOpen && specUi.helpVisible && specUi.helpText.indexOf('名称') >= 0,
  'help visible=' + specUi.helpVisible + ' text=' + JSON.stringify(specUi.helpText.slice(0, 40)));
check('specLiveError', /^第 1 行：/.test(specUi.badMsg) && /error/.test(specUi.badCls) && specUi.invalid === 'true',
  'msg=' + JSON.stringify(specUi.badMsg) + ' cls=' + specUi.badCls);
check('specLiveOk', specUi.invalidAfter === null && !/error/.test(specUi.okCls) && specUi.okMsg.indexOf('2 个字段') >= 0,
  'msg=' + JSON.stringify(specUi.okMsg) + ' cls=' + specUi.okCls);
check('specDirtyHint', specUi.dirtyMsg.indexOf('未应用') >= 0,
  'dirty msg=' + JSON.stringify(specUi.dirtyMsg));

// 「示例」按钮：只填编辑框，不影响已应用字段；关掉再打开回到原文。
const sample = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const countBefore = q('#field-count').textContent.trim();
  q('#spec-sample').click();
  await new Promise((r) => setTimeout(r, 300));
  const text = q('#spec-text').value;
  const msg = q('#spec-msg').textContent.trim();
  q('#spec-cancel').click();
  const closed = q('#spec-panel').hidden;
  const countAfter = q('#field-count').textContent.trim();
  // 还原成方案段要用的脏文本并重新打开面板
  q('#field-edit-btn').click();
  const t = q('#spec-text');
  t.value = 'a 15:12\\nb 11:8\\nc 7:4';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  return { text, msg, countBefore, countAfter, closed, reopened: q('#spec-text').value };
})()`);
check('specSampleButton', /opcode 7:4/.test(sample.text) && /2 个字段/.test(sample.msg) &&
  sample.countBefore === sample.countAfter && sample.closed === true && sample.reopened === 'a 15:12\nb 11:8\nc 7:4',
  'sample=' + JSON.stringify(sample.text.split('\n').slice(1)) + ' msg=' + JSON.stringify(sample.msg) +
  ' fields ' + sample.countBefore + '->' + sample.countAfter);

// ---------- 4) named schemes: save -> other spec -> load restores ----------
const scheme = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  q('#spec-save').click();                       // apply the 3-field draft
  const afterApply = q('#field-count').textContent.trim();
  const applyHint = q('#hint').textContent.trim();   // feedback now lives in the status line

  q('#field-edit-btn').click();
  q('#scheme-save').click();
  q('#scheme-name').value = '测试方案';
  q('#scheme-name-ok').click();
  const options = [...q('#scheme-select').options].map((o) => o.value);
  const savedCount = window.BitCalcStore.schemeList().length;
  const savedSpec = window.BitCalcStore.schemeGet('测试方案');

  const t = q('#spec-text');
  t.value = 'mode:3'; t.dispatchEvent(new Event('input', { bubbles: true }));
  q('#spec-save').click();
  const afterOther = q('#field-count').textContent.trim();

  q('#field-edit-btn').click();
  q('#scheme-select').value = '测试方案';
  q('#scheme-select').dispatchEvent(new Event('change', { bubbles: true }));
  q('#scheme-load').click();
  await new Promise((r) => setTimeout(r, 60));
  const afterLoad = q('#field-count').textContent.trim();
  const loadedText = q('#spec-text').value;
  const loadMsg = q('#hint').textContent.trim();
  return { afterApply, applyHint, savedCount, savedSpec: savedSpec && savedSpec.spec, afterOther, afterLoad,
           loadedText, loadMsg, options, loadDisabled: q('#scheme-load').disabled };
})()`);
check('schemeSave', scheme.savedCount === 1 && scheme.options.indexOf('测试方案') >= 0,
  'schemes ' + JSON.stringify(scheme.options) + ' count=' + scheme.savedCount);
check('schemeSavedSpec', scheme.savedSpec === 'a 15:12\nb 11:8\nc 7:4',
  'saved spec=' + JSON.stringify(scheme.savedSpec));
check('schemeLoadRestores', scheme.afterOther === '1' && scheme.afterLoad === '3' && scheme.loadedText === scheme.savedSpec,
  scheme.afterOther + ' fields -> loaded ' + scheme.afterLoad);
check('feedbackInStatusLine', scheme.applyHint.indexOf('已应用') >= 0 && scheme.loadMsg.indexOf('已载入') >= 0,
  'apply hint=' + JSON.stringify(scheme.applyHint) + ' load hint=' + JSON.stringify(scheme.loadMsg));

// ---------- 5) history: record -> popover -> restore ----------
const hist = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  q('#spec-cancel').click();
  window.__utRec.subInput({ text: '0xFF & 0x0F' });
  await new Promise((r) => setTimeout(r, 1250));
  const list = window.BitCalcStore.historyList();
  q('#history-btn').click();
  await new Promise((r) => setTimeout(r, 30));
  const panelOpen = !q('#history-panel').hidden;
  const items = [...document.querySelectorAll('.history-item')];
  const firstExpr = items[0] ? items[0].querySelector('.h-expr').textContent : '';
  const firstVal = items[0] ? items[0].querySelector('.h-val').textContent : '';

  // popover must paint above the grid: probe a point where they overlap
  const pop = q('#history-panel').getBoundingClientRect();
  const cell = [...document.querySelectorAll('.cell')].map((c) => c.getBoundingClientRect())
    .find((r) => r.right > pop.left + 6 && r.left < pop.right - 6 && r.top < pop.bottom - 6 && r.bottom > pop.top + 6);
  let topmost = 'no-overlap';
  if (cell) {
    const x = Math.max(cell.left, pop.left) + 4;
    const y = Math.max(cell.top, pop.top) + 4;
    const hit = document.elementFromPoint(x, y);
    topmost = hit && hit.closest('#history-panel') ? 'panel'
      : (hit ? (hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') + ' @' + Math.round(x) + ',' + Math.round(y)) : 'null');
  }

  window.__utRec.subInput({ text: '1' });
  items[0].click();
  await new Promise((r) => setTimeout(r, 30));
  return { count: list.length, expr: list[0] && list[0].expr, panelOpen, itemCount: items.length,
           firstExpr, firstVal, topmost,
           panelClosedAfter: q('#history-panel').hidden, val: q('#val-dec').textContent.trim(),
           expanded: q('#history-btn').getAttribute('aria-expanded') };
})()`);
check('historyRecorded', hist.count >= 1 && hist.expr === '0xFF & 0x0F',
  'entries ' + hist.count + ', first=' + JSON.stringify(hist.expr));
check('historyPanel', hist.panelOpen === true && hist.itemCount === hist.count,
  'panelOpen=' + hist.panelOpen + ' items=' + hist.itemCount + '/' + hist.count);
check('historyPanelAboveGrid', hist.topmost === 'panel',
  'point over both hits ' + JSON.stringify(hist.topmost) + ' (want panel)');
check('historyRestore', hist.val === '15' && hist.panelClosedAfter === true,
  'value after restore=' + hist.val + ' panel closed=' + hist.panelClosedAfter);

// ---------- 6) undo & shortcuts ----------
const keys = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  window.__utRec.subInput({ text: '0x40' });
  const before = q('#val-dec').textContent.trim();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  const after = q('#val-dec').textContent.trim();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }));
  const opened = !q('#history-panel').hidden;
  // 关浮层不能靠 Esc（uTools 拿它退出插件），点浮层外面即可
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const closed = q('#history-panel').hidden;
  return { before, after, opened, closed };
})()`);
check('undoShortcut', keys.before === '64' && keys.after === '15', 'before=' + keys.before + ' after=' + keys.after);
check('historyShortcut', keys.opened === true && keys.closed === true, 'ctrl+H opened=' + keys.opened + ' outside-click closed=' + keys.closed);

// 历史里的值必须是「当时」的值：0x40 有利于抓「setTimeout 里才读 store.value」这类回退。
const histSnap = await evaluate(`(async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const list = window.BitCalcStore.historyList();
  const hit = list.filter((e) => e.expr === '0x40')[0];
  return { value: hit ? String(hit.value) : null, exprs: list.map((e) => e.expr) };
})()`);
check('historyValueSnapshot', histSnap.value === '64',
  '0x40 记成 ' + histSnap.value + '（应是 64），列表=' + JSON.stringify(histSnap.exprs));

// ---------- 7) field rows: select, write into selection, keys, copy ----------
const interact = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  q('#width-seg button[data-w="64"]').click();
  q('#mode-tabs button[data-mode="proto"]').click();
  if (q('#spec-panel').hidden) { q('#field-edit-btn').click(); }
  const t = q('#spec-text');
  t.value = 'opcode 15:12\\nrd 11:8\\nrs 7:4\\nfunc 3:0';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  q('#spec-save').click();
  window.__utRec.subInput({ text: '0xABCD' });
  await frame();

  const rows = () => [...document.querySelectorAll('.field-row')];
  rows()[1].click();
  await frame();
  const chipText = q('#field-chip').textContent.trim();
  const chipHidden = q('#field-chip').hidden;
  const scopedDec = q('#val-dec').textContent.trim();
  const activeIdx = rows().findIndex((r) => r.getAttribute('aria-selected') === 'true');

  window.__utRec.subInput({ text: '0x5' });
  await frame();
  const rdVal = rows()[1].querySelector('.field-row-val').textContent;

  const body = q('#field-body');
  body.focus();
  body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await frame();
  const afterArrow = rows().findIndex((r) => r.getAttribute('aria-selected') === 'true');

  window.__utRec.copied.length = 0;
  rows()[1].querySelector('.field-row-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  q('#clear-btn').click();
  await frame();
  const full = q('#val-dec').textContent.trim();

  return { chipText, chipHidden, scopedDec, activeIdx, rdVal, afterArrow, full,
           copied: window.__utRec.copied.slice(0, 1), rowCount: rows().length };
})()`);
check('fieldRowSelect', interact.chipHidden === false && /rd/.test(interact.chipText) && interact.activeIdx === 1 && interact.scopedDec === '11',
  'chip=' + JSON.stringify(interact.chipText) + ' scoped=' + interact.scopedDec + ' active=' + interact.activeIdx);
check('selectionWriteBack', interact.rdVal === '0x5' && interact.full.replace(/,/g, '') === '42445',
  'rd=' + interact.rdVal + ' full=' + interact.full + ' (want 42,445 = 0xA5CD)');
check('fieldRowKeyboard', interact.afterArrow === 2, 'active after ArrowDown=' + interact.afterArrow);
check('fieldRowCopy', interact.copied[0] === '0x5', 'copied=' + JSON.stringify(interact.copied[0]));

// 位宽调小后：超出位宽的字段要标「超界」，状态行提示一下，切回去标记消失。
const oor = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  q('#width-seg button[data-w="8"]').click();
  await frame();
  const rows = [...document.querySelectorAll('.field-row')];
  const out = rows.filter((r) => r.classList.contains('out-of-range')).length;
  const hint = q('#hint').textContent.trim();
  q('#width-seg button[data-w="64"]').click();
  await frame();
  return { rows: rows.length, out, hint, afterBack: document.querySelectorAll('.field-row.out-of-range').length };
})()`);
check('outOfRangeMarked', oor.out === 2 && /超出范围/.test(oor.hint) && oor.afterBack === 0,
  '8 位时超界行=' + oor.out + '/' + oor.rows + '，提示=' + JSON.stringify(oor.hint) + '，切回 64 位后=' + oor.afterBack);

// ---------- 8) settings & fields survive a reload (stub keeps storage on ?keep) ----------
await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  q('#width-seg button[data-w="16"]').click();
  const c = q('#signed-chk');
  if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
  if (q('#endian-btn').textContent.trim() !== 'LE') { q('#endian-btn').click(); }
  q('#mode-tabs button[data-mode="proto"]').click();
  return true;
})()`);
await send('Page.navigate', { url: PAGE + '?keep=1' });
await sleep(800);
const persisted = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wBtn = q('#width-seg button[aria-pressed="true"]');
  const mBtn = q('#mode-tabs button[aria-pressed="true"]');
  return { width: wBtn && wBtn.dataset.w, signed: q('#signed-chk').checked,
           endian: q('#endian-btn').textContent.trim(), mode: mBtn && mBtn.dataset.mode,
           rows: document.querySelectorAll('.field-row').length,
           fieldsShown: !q('#field-panel').hidden };
})()`);
check('settingsRestored', persisted.width === '16' && persisted.signed === true && persisted.endian === 'LE',
  'width=' + persisted.width + ' signed=' + persisted.signed + ' endian=' + persisted.endian);
check('modeAndFieldsRestored', persisted.mode === 'proto' && persisted.fieldsShown === true && persisted.rows === 4,
  'mode=' + persisted.mode + ' rows=' + persisted.rows + ' panel=' + persisted.fieldsShown);

// ---------- 9) 窗口内表达式输入 ----------
const entry = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // 有选区时表达式写的是「选中段」，这里要测整值计算，先清掉选区；顺带切到 64 位
  q('#width-seg button[data-w="64"]').click();
  q('#clear-btn').click();
  await frame();
  const inp = q('#expr-input');
  inp.value = '0xFF & 0x0F';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 320));
  const typed = q('#val-dec').textContent.trim();
  // Enter 立刻求值，不再等防抖；顺带验证求值后文本被全选，方便直接改写
  inp.value = '1 << 20';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await frame();
  const entered = q('#val-dec').textContent.trim();
  return { typed, entered, selAll: inp.selectionStart === 0 && inp.selectionEnd === inp.value.length };
})()`);
check('exprInputComputes', entry.typed === '15' && entry.entered.replace(/,/g, '') === '1048576',
  'typed=' + entry.typed + ' enter=' + entry.entered + ' selected=' + entry.selAll);

// ---------- 10) 定义写超当前位宽必须拦住 ----------
const wide = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const before = document.querySelectorAll('.field-row').length;
  // 用 16 位来制造「写超」：39:36 在 64 位下是合法的，必须切到更小位宽才测得出拦截
  q('#width-seg button[data-w="16"]').click();
  await frame();
  q('#field-edit-btn').click();
  const t = q('#spec-text');
  t.value = 'wide 39:36';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 260));
  const msg = q('#spec-msg').textContent.trim();
  const invalid = t.getAttribute('aria-invalid') === 'true';
  q('#spec-save').click();
  await frame();
  const stillOpen = !q('#spec-panel').hidden;
  const after = document.querySelectorAll('.field-row').length;
  q('#spec-cancel').click();
  await frame();
  q('#width-seg button[data-w="64"]').click();
  await frame();
  return { msg, invalid, stillOpen, before, after, closed: q('#spec-panel').hidden };
})()`);
check('specTooWideBlocked',
  /超出当前位宽/.test(wide.msg) && wide.invalid === true && wide.stillOpen === true &&
  wide.before === wide.after && wide.closed === true,
  'msg=' + JSON.stringify(wide.msg) + ' invalid=' + wide.invalid + ' 应用后仍打开=' + wide.stillOpen +
  ' 字段数 ' + wide.before + '→' + wide.after);

// ---------- 11) 点字段值就地改值 ----------
const inlineEdit = await evaluate(`(async () => {
  const q = (s) => document.querySelector(s);
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__utRec.subInput({ text: '0xA5CD' });
  await frame();
  // subInput 会 render() 重建字段行，旧引用已脱离文档，必须重新取
  const row = document.querySelectorAll('.field-row')[0];
  row.querySelector('.field-row-val').click();
  await frame();
  const inp = document.querySelector('.field-edit');
  const opened = !!inp;
  if (inp) {
    inp.value = '3';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await frame();
  const val = document.querySelectorAll('.field-row')[0].querySelector('.field-row-val').textContent.trim();
  const hint = q('#hint').textContent.trim();
  return { opened, val, hint, leftover: !!document.querySelector('.field-edit') };
})()`);
check('fieldInlineEdit',
  inlineEdit.opened === true && inlineEdit.val === '0x3' && /已写入/.test(inlineEdit.hint) && inlineEdit.leftover === false,
  '打开=' + inlineEdit.opened + ' 值=' + inlineEdit.val + ' 提示=' + JSON.stringify(inlineEdit.hint));

// ---------- output ----------
console.log(JSON.stringify({ cases: c, specUi, scheme, hist, keys, interact, persisted }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log('\n=== ' + (failed.length ? 'FAIL' : 'PASS') + ' · ' + (results.length - failed.length) + '/' + results.length + ' ===');
for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + ' - ' + r.detail);

if (SHOTS) {
  const shoot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(ROOT, 'dev', 'audit-' + name + '.png'), Buffer.from(data, 'base64'));
  };
  const frames = () => evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  // 用真实鼠标事件拖选位域：合成的 PointerEvent 过不了 setPointerCapture，CDP 的 mouse 事件会被 Chrome 补成 pointer 事件
  const dragSelect = async (fromPos, toPos) => {
    const pts = await evaluate(`(() => {
      const mid = (p) => { const r = document.querySelector('.cell[data-pos="' + p + '"]').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      return { a: mid('${fromPos}'), b: mid('${toPos}') };
    })()`);
    const base = { button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.a.x, y: pts.a.y, buttons: 1, ...base });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (pts.a.x + pts.b.x) / 2, y: pts.b.y, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pts.b.x, y: pts.b.y, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.b.x, y: pts.b.y, buttons: 0, ...base });
    await frames();
  };
  const applySpec = async (spec) => {
    await evaluate(`(async () => {
      const q = (s) => document.querySelector(s);
      q('#mode-tabs button[data-mode="proto"]').click();
      if (q('#spec-panel').hidden) { q('#field-edit-btn').click(); }
      const t = q('#spec-text');
      t.value = ${JSON.stringify(spec)};
      t.dispatchEvent(new Event('input', { bubbles: true }));
      q('#spec-save').click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
  };

  // --dump：打印网格与容器的实际矩形，排查"格子压过分栏线"这类几何问题
  if (process.argv.includes('--dump')) {
    const dump = await evaluate(`(() => {
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const b = e.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), w: +b.width.toFixed(1) }; };
      const cs = document.querySelector('.cell');
      const cb = cs && cs.getBoundingClientRect();
      return { stage: r('#stage'), wrapGrid: r('#grid'), grid: r('.grid'), cell: cb ? { l: +cb.left.toFixed(1), r: +cb.right.toFixed(1), w: +cb.width.toFixed(1) } : null,
        value: r('.value'), lastCell: r('.cell[data-pos="48"]'), tpl: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns };
    })()`);
    console.log(JSON.stringify(dump, null, 2));
  }

  // 干净的展示态：64 位、一个像样的值、选中 11:8
  await send('Page.navigate', { url: PAGE + '?shot=1#utools' });
  await sleep(700);
  await evaluate(`window.__utRec.subInput({ text: '0xA5C3F0D2' })`);
  await frames();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 300, buttons: 0 });
  await dragSelect('15', '12');
  await shoot('bits');

  // 悬停态：指在 bit 40 上，同组 4 格淡蓝、被指的那格深一档
  const hoverPt = await evaluate(`(() => {
    const r = document.querySelector('.cell[data-pos="40"]').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPt.x, y: hoverPt.y, buttons: 0 });
  await frames();
  await shoot('hover');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 300, buttons: 0 });

  await evaluate(`document.querySelector('#width-seg button[data-w="32"]').click()`);
  await frames();
  await applySpec(SPEC32);
  await evaluate(`document.querySelector('#clear-btn').click()`);
  if (process.argv.includes('--dump')) {
    const rows = await evaluate(`(() => [...document.querySelectorAll('.field-row')].map((r) => {
      const cs = getComputedStyle(r);
      return { cls: r.className, sel: r.getAttribute('aria-selected'), w: +r.getBoundingClientRect().width.toFixed(1),
               border: cs.borderTopStyle + ' ' + cs.borderTopColor, bg: cs.backgroundColor };
    }))()`);
    console.log(JSON.stringify(rows, null, 2));
  }
  await sleep(1500); // 等状态行闪示淡出，截图里别留「已应用」
  await shoot('proto32');

  await evaluate(`window.BitCalcStore.schemeSave('32 位 RISC 指令', ${JSON.stringify(SPEC32)}, 32)`);
  await evaluate(`document.querySelector('#field-edit-btn').click()`);
  await evaluate(`(function () {
    const sel = document.querySelector('#scheme-select');
    sel.value = '32 位 RISC 指令';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(150);
  await shoot('spec');
  await evaluate(`document.querySelector('#spec-cancel').click()`);

  await evaluate(`(async () => {
    const t = (v) => window.__utRec.subInput({ text: v });
    t('0x0F'); t('bits 3:0'); t('1 << 20'); t('popcount(0xFF)');
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#history-btn').click();
  })()`);
  await sleep(300);
  await shoot('history');
  await evaluate(`document.querySelector('#history-btn').click()`);

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url: PAGE + '?keep=1#utools' });
  await sleep(750);
  await applySpec(SPEC32);
  await evaluate(`window.__utRec.subInput({ text: '0xA5C3F0D2' })`);
  await evaluate(`document.querySelector('#clear-btn').click()`); // 顺手收掉「已应用」闪示
  await sleep(400);
  await shoot('dark');
  await send('Emulation.setEmulatedMedia', { features: [] });
  console.log('shots -> dev/audit-bits.png dev/audit-hover.png dev/audit-proto32.png dev/audit-spec.png dev/audit-history.png dev/audit-dark.png');
}

ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);


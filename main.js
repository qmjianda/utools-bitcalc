/**
 * main.js — 状态、显示、交互装配
 *
 * 分工：
 *   parser.js  表达式 → BigInt（纯函数，可单测）
 *   grid.js    位网格渲染 + 拖动选位域（纯几何函数可单测）
 *   proto.js   字段定义文本 → 字段表 + 解码（纯函数，可单测）
 *   store.js   本地持久化：字段定义 / 历史记录 / 命名方案 / 界面设置
 *   main.js    以上四者的粘合层：状态机、格式化、DOM 事件、窗口高度
 *
 * 交互主轴：
 *   拖选一段 bit → 值条变成这一段的值（右移到 bit0），输入表达式就写回这一段；
 *   点字段行 → 选中该字段；点字段值 → 就地改值；字段面板可折叠。
 *   表达式只由插件内自定义输入框承载，不使用 uTools 子输入框。
 */
(function () {
  'use strict';

  var P = window.BitCalcParser;
  var G = window.BitCalcGrid;
  var PB = window.BitCalcProto || null;
  var S = window.BitCalcStore || null;
  var ut = window.utools || null;

  var $ = function (sel) { return document.querySelector(sel); };

  var HISTORY_DEBOUNCE = 900;
  var UNDO_MAX = 30;
  var WIDTHS = [8, 16, 32, 64];
  var BASES = ['dec', 'hex', 'oct'];
  var FIELD_COLORS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];

  // ---------- 元素 ----------
  var el = {
    app: $('#app'),
    hint: $('#hint'),
    saveState: $('#save-state'),

    exprInput: $('#expr-input'),

    widthSelect: $('#width-select'),
    widthLabel: $('#width-label'),
    fieldsBtn: $('#fields-btn'),
    fieldsCount: $('#fields-count'),
    displayBtn: $('#display-btn'),
    displayMenu: $('#display-menu'),
    signedChk: $('#signed-chk'),
    endianBtn: $('#endian-btn'),
    historyBtn: $('#history-btn'),
    moreBtn: $('#more-btn'),
    moreMenu: $('#more-menu'),
    undoBtn: $('#undo-btn'),
    clearSelBtn: $('#clear-sel-btn'),
    copyAllBtn: $('#copy-all-btn'),

    valuebar: $('.valuebar'),
    valBig: $('#val-big'),
    eyebrow: $('#eyebrow'),
    baseSwitch: $('#base-switch'),
    ctxActions: $('#ctx-actions'),
    ctxEdit: $('#ctx-edit'),
    ctxClear: $('#ctx-clear'),
    copyMain: $('#copy-main'),
    selMeta: $('#sel-meta'),

    gridRoot: $('#grid'),

    content: $('#content'),
    workbench: $('#workbench'),
    inspector: $('#inspector'),
    inspTabs: $('#insp-tabs'),
    inspFields: $('#insp-fields'),
    inspValues: $('#insp-values'),
    inspHistory: $('#insp-history'),
    tabFieldsCount: $('#tab-fields-count'),
    fieldSummary: $('#field-summary'),
    fieldList: $('#field-list'),
    coverageBar: $('#coverage-bar'),
    coverageText: $('#coverage-text'),
    overlapText: $('#overlap-text'),
    defineFields: $('#define-fields'),
    addField: $('#add-field'),
    valueTable: $('#value-table'),

    historyList: $('#history-list'),
    historyEmpty: $('#history-empty'),
    historyClear: $('#history-clear'),

    specPanel: $('#spec-panel'),
    specText: $('#spec-text'),
    specMsg: $('#spec-msg'),
    specHelp: $('#spec-help'),
    specHelpToggle: $('#spec-help-toggle'),
    specSample: $('#spec-sample'),
    specClose: $('#spec-close'),
    specCancel: $('#spec-cancel'),
    specSave: $('#spec-save'),
    schemeSelect: $('#scheme-select'),
    schemeLoad: $('#scheme-load'),
    schemeSave: $('#scheme-save'),
    schemeDel: $('#scheme-del'),
    schemeForm: $('#scheme-form'),
    schemeName: $('#scheme-name'),
    schemeNameOk: $('#scheme-name-ok'),
    schemeNameCancel: $('#scheme-name-cancel')
  };

  // ---------- 状态 ----------
  var store = {
    value: 0n,        // 恒按 64 位无符号存放
    sel: null,        // { start, end } 闭区间，start <= end
    signed: false,
    width: 64,
    le: false,
    base: 'hex'       // 主数字的进制：dec | hex | oct
  };
  var fields = [];
  var activeIdx = -1;
  var lastActiveIdx = -1;
  var hoverField = null;
  var hoverIdx = -1;
  var specText = '';
  var rowEls = [];
  var lastError = '';
  var grid = null;

  var inspOpen = false;
  var inspTab = 'fields';

  var histActive = -1;
  var histEls = [];
  var histTimer = 0;
  var histPending = null;
  var undoStack = [];

  var specTimer = 0;
  var delTimer = 0;
  var exprTimer = 0;
  var exprText = '';

  // ---------- 数值工具 ----------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function groupThousands(s) {
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function maskOf(width) {
    return (1n << BigInt(width)) - 1n;
  }

  function clampU(v) {
    return BigInt.asUintN(store.width, v);
  }

  function extractRange(u, start, width) {
    return (u >> BigInt(start)) & maskOf(width);
  }

  function fieldWidth(f) { return f.end - f.start + 1; }

  function hexDigits(u, width) {
    var digits = Math.max(1, Math.ceil(width / 4));
    var s = u.toString(16).toUpperCase();
    while (s.length < digits) { s = '0' + s; }
    return s;
  }

  function bswapWidth(u, width) {
    var out = 0n;
    var bytes = Math.ceil(width / 8);
    for (var i = 0; i < bytes; i++) {
      out = (out << 8n) | ((u >> BigInt(8 * i)) & 0xFFn);
    }
    return BigInt.asUintN(width, out);
  }

  /** HEX：补足位宽的十六进制串，不加空格——这些字符串会被原样复制。 */
  function formatHex(u, width) {
    var v = store.le ? bswapWidth(u, width) : u;
    return '0x' + hexDigits(v, width);
  }

  /** 大字 HEX：每 4 位插一个空格，只用于显示。 */
  function formatHexBig(u, width) {
    var s = hexDigits(store.le ? bswapWidth(u, width) : u, width);
    s = s.replace(/\B(?=(?:.{4})+$)/g, ' ');
    return '0x' + s;
  }

  function decPlain(u, width) {
    return (store.signed ? BigInt.asIntN(width, u) : u).toString();
  }

  function formatDec(u, width) {
    return groupThousands(decPlain(u, width));
  }

  /** 八进制不补前导零：64 位补满要 22 位，全 0 时是一面零墙。 */
  function formatOct(u) {
    return '0o' + u.toString(8);
  }

  function formatOctBig(u) {
    return '0o' + u.toString(8);
  }

  function formatBin(u, width) {
    var s = u.toString(2);
    while (s.length < width) { s = '0' + s; }
    var out = [];
    for (var i = 0; i < s.length; i += 4) { out.push(s.slice(i, i + 4)); }
    return out.join(' ');
  }

  function formatBinBig(u, width) {
    return '0b' + formatBin(u, width).replace(/ /g, '');
  }

  function formatBinMeta(u, width) {
    var s = u.toString(2);
    while (s.length < width) { s = '0' + s; }
    return '0b' + s.replace(/(.{4})(?=.)/g, '$1 ');
  }

  var fbuf = new ArrayBuffer(8);
  var fview = new DataView(fbuf);

  function readFloat(u, width) {
    if (width === 32) {
      fview.setUint32(0, Number(BigInt.asUintN(32, u)), true);
      return { label: 'F32', value: fview.getFloat32(0, true) };
    }
    if (width === 64) {
      var lo = Number(BigInt.asUintN(32, u));
      var hi = Number(BigInt.asUintN(32, u >> 32n));
      fview.setUint32(0, lo, true);
      fview.setUint32(4, hi, true);
      return { label: 'F64', value: fview.getFloat64(0, true) };
    }
    return null;
  }

  function prettyFloat(x) {
    if (Number.isNaN(x)) { return 'NaN'; }
    if (x === Infinity) { return '∞'; }
    if (x === -Infinity) { return '-∞'; }
    if (x === 0) { return Object.is(x, -0) ? '-0' : '0'; }
    var abs = Math.abs(x);
    if (abs >= 1e-4 && abs < 1e16) { return String(Number(x.toPrecision(9))); }
    return x.toExponential(6);
  }

  function fieldColor(i) {
    return 'var(--' + FIELD_COLORS[i % FIELD_COLORS.length] + ')';
  }

  // ---------- 提示行 ----------
  function defaultHint() {
    return '点按翻转 · 拖动选择 · 输入即写回';
  }

  function findField(start, end) {
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].start === start && fields[i].end === end) { return fields[i]; }
    }
    return null;
  }

  function fieldAt(pos) {
    for (var i = 0; i < fields.length; i++) {
      if (pos >= fields[i].start && pos <= fields[i].end) { return i; }
    }
    return -1;
  }

  function clearError() {
    if (!lastError) { return; }
    lastError = '';
    el.hint.title = '';
    if (el.exprInput) { el.exprInput.removeAttribute('aria-invalid'); }
  }

  var flashUntil = 0;

  function updateHint(hoverPos) {
    if (flashUntil && Date.now() < flashUntil) {
      if (!lastError) { return; }
      flashUntil = 0;
    }
    var text = '';
    var cls = 'hint';
    if (lastError) {
      text = lastError;
      cls = 'hint error';
    } else if (store.sel !== null) {
      var w = store.sel.end - store.sel.start + 1;
      var v = extractRange(clampU(store.value), store.sel.start, w);
      var f = findField(store.sel.start, store.sel.end);
      text = '位 ' + store.sel.start + '–' + store.sel.end +
        (f ? ' · ' + f.name : '') + ' · ' + w + ' 位 · 0x' + hexDigits(v, w) + ' · Ctrl+K 输入即写回';
    } else if (hoverPos !== null && hoverPos !== undefined) {
      var nib = extractRange(clampU(store.value), Math.floor(hoverPos / 4) * 4, 4);
      text = '位 ' + hoverPos + ' · 该组 0x' + nib.toString(16).toUpperCase() + ' · 点击翻转';
    } else if (store.value !== clampU(store.value)) {
      text = '超出 ' + store.width + ' 位的高位已忽略';
      cls = 'hint warn';
    }
    if (!text) { text = defaultHint(); }
    el.hint.textContent = text;
    el.hint.className = cls;
    el.hint.title = text.length > 56 ? text : '';
  }

  // ---------- 表达式输入 ----------
  // 只使用插件内自定义输入框；不注册、也不读写 uTools 子输入框。
  function syncExprInput(text) {
    exprText = text == null ? '' : String(text);
    if (el.exprInput && document.activeElement !== el.exprInput) {
      el.exprInput.value = exprText;
    }
  }

  function wireExprInput() {
    function runExpr() {
      clearTimeout(exprTimer);
      return applyExpression(el.exprInput.value);
    }
    el.exprInput.addEventListener('input', function () {
      exprText = el.exprInput.value;
      clearTimeout(exprTimer);
      exprTimer = setTimeout(runExpr, 200);
    });
    el.exprInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runExpr();
        el.exprInput.select();
      }
    });
  }

  function focusExpr() {
    if (!el.exprInput) { return; }
    el.exprInput.focus();
    try { el.exprInput.select(); } catch (err) { /* ignore */ }
  }

  // ---------- 渲染 ----------
  function fitBig() {
    var big = el.valBig;
    if (!big) { return; }
    big.style.fontSize = '';
    big.style.letterSpacing = '';
    var avail = big.clientWidth;
    var need = big.scrollWidth;
    if (!avail || need <= avail) { return; }
    var base = big.classList.contains('short') ? 34 : 28;
    var size = Math.max(13, Math.floor(base * avail / need));
    big.style.fontSize = size + 'px';
    big.style.letterSpacing = (size / base * -1.2).toFixed(2) + 'px';
  }

  function formatBig(u, width) {
    if (store.base === 'hex') { return formatHexBig(u, width); }
    if (store.base === 'oct') { return formatOctBig(u); }
    return formatDec(u, width);
  }

  function render() {
    var u = clampU(store.value);
    var scoped = store.sel !== null;
    var fw = scoped ? (store.sel.end - store.sel.start + 1) : store.width;
    var fv = scoped ? extractRange(u, store.sel.start, fw) : u;
    var f = scoped ? findField(store.sel.start, store.sel.end) : null;

    el.valBig.textContent = formatBig(fv, fw);
    el.valBig.className = 'big' + (scoped && fw <= 8 ? ' short' : '');

    if (scoped) {
      el.eyebrow.innerHTML = '位 ' + store.sel.start + '–' + store.sel.end +
        (f ? ' · <em>' + esc(f.name) + '</em>' : '') + ' · ' + fw + ' 位';
    } else {
      el.eyebrow.textContent = '整值 · ' + store.width + ' 位';
    }
    el.ctxActions.hidden = !scoped;

    if (scoped) {
      el.selMeta.hidden = false;
      var dec = decPlain(fv, fw);
      el.selMeta.textContent = (fw <= 16 ? formatBinMeta(fv, fw) + ' · DEC ' + dec : 'DEC ' + dec);
    } else {
      el.selMeta.hidden = true;
      el.selMeta.textContent = '';
    }

    [].forEach.call(el.baseSwitch.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.base === store.base));
    });

    el.endianBtn.querySelector('b').textContent = store.le ? 'LE' : 'BE';
    el.endianBtn.dataset.on = store.le ? 'true' : 'false';
    el.widthSelect.value = String(store.width);
    el.widthLabel.textContent = String(store.width);
    el.signedChk.checked = store.signed;
    el.fieldsCount.textContent = String(fields.length);

    if (grid) {
      grid.setState({
        value: u,
        sel: store.sel,
        width: store.width,
        field: hoverField,
        fieldColor: hoverIdx >= 0 ? fieldColor(hoverIdx) : ''
      });
    }

    renderFields(u);
    renderValues(u);
    updateHint(null);
    fitBig();
    fitWorkbenchHeight();
    scheduleFit();
  }

  function renderFields(u) {
    rowEls = [];
    el.fieldList.textContent = '';
    el.tabFieldsCount.textContent = String(fields.length);
    el.fieldsCount.textContent = String(fields.length);

    if (!fields.length) {
      el.fieldSummary.textContent = '没有字段';
      el.coverageText.textContent = '0 / ' + store.width;
      el.coverageBar.style.width = '0%';
      el.overlapText.textContent = '未覆盖';
      el.overlapText.className = '';
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<b>还没有字段</b>定义一段位域，网格就能按字段读值。';
      el.fieldList.appendChild(empty);
      lastActiveIdx = -1;
      syncActiveDescendant();
      return;
    }

    var covered = 0n;
    fields.forEach(function (f, i) {
      covered |= maskOf(fieldWidth(f)) << BigInt(f.start);

      var row = document.createElement('div');
      row.className = 'frow k' + (i % FIELD_COLORS.length + 1) + (i === activeIdx ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.dataset.idx = String(i);
      row.id = 'field-row-' + i;

      var dot = document.createElement('i');
      dot.className = 'dot k' + (i % FIELD_COLORS.length + 1);

      var name = document.createElement('span');
      name.className = 'fn';
      name.textContent = f.name;
      name.title = f.name + ' · 位 ' + f.end + ':' + f.start;

      var range = document.createElement('span');
      range.className = 'fr';
      range.textContent = f.end + ':' + f.start;

      var val = document.createElement('span');
      val.className = 'fv';
      var w = fieldWidth(f);
      var fv = extractRange(u, f.start, w);
      val.textContent = '0x' + hexDigits(fv, w);
      val.title = '点击改值 · ' + (store.signed ? BigInt.asIntN(w, fv) : fv).toString() + ' · ' + w + ' 位';

      var copy = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      copy.setAttribute('class', 'icon f-copy');
      copy.setAttribute('aria-hidden', 'true');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-copy');
      copy.appendChild(use);

      if (f.end >= store.width) {
        row.classList.add('out-of-range');
        row.title = f.name + ' · 位 ' + f.end + ':' + f.start + ' · 超出当前 ' + store.width + ' 位宽';
        val.title = (store.signed ? BigInt.asIntN(w, fv) : fv).toString() + ' · 超出当前位宽';
      }

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(range);
      row.appendChild(val);
      row.appendChild(copy);
      el.fieldList.appendChild(row);
      rowEls.push(row);
    });

    covered &= maskOf(store.width);
    var coveredCount = covered.toString(2).replace(/0/g, '').length;
    var ov = PB && PB.overlaps ? PB.overlaps(fields) : [];
    el.fieldSummary.textContent = fields.length + ' 个字段 · 覆盖 ' + coveredCount + ' 位';
    el.coverageText.textContent = coveredCount + ' / ' + store.width;
    el.coverageBar.style.width = Math.min(100, coveredCount / store.width * 100).toFixed(1) + '%';
    if (ov.length) {
      el.overlapText.textContent = ov.length + ' 处重叠';
      el.overlapText.className = 'warn';
    } else {
      el.overlapText.textContent = '无重叠';
      el.overlapText.className = 'ok';
    }

    syncActiveDescendant();
    scrollActiveRowIntoView();
  }

  function scrollActiveRowIntoView() {
    if (activeIdx < 0 || activeIdx === lastActiveIdx) { lastActiveIdx = activeIdx; return; }
    lastActiveIdx = activeIdx;
    var row = rowEls[activeIdx];
    if (!row || !row.getBoundingClientRect) { return; }
    var rb = row.getBoundingClientRect();
    var bb = el.fieldList.getBoundingClientRect();
    if (rb.top < bb.top) { el.fieldList.scrollTop -= (bb.top - rb.top); }
    else if (rb.bottom > bb.bottom) { el.fieldList.scrollTop += (rb.bottom - bb.bottom); }
  }

  function paintRows() {
    rowEls.forEach(function (row, i) {
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.classList.toggle('active', i === activeIdx);
      row.classList.toggle('hovered', i === hoverIdx && i !== activeIdx);
    });
    syncActiveDescendant();
  }

  function syncActiveDescendant() {
    if (activeIdx >= 0 && rowEls[activeIdx]) {
      el.fieldList.setAttribute('aria-activedescendant', 'field-row-' + activeIdx);
    } else {
      el.fieldList.removeAttribute('aria-activedescendant');
    }
  }

  function pushGridState() {
    if (!grid) { return; }
    grid.setState({
      value: clampU(store.value),
      sel: store.sel,
      width: store.width,
      field: hoverField,
      fieldColor: hoverIdx >= 0 ? fieldColor(hoverIdx) : ''
    });
  }

  function renderValues(u) {
    if (!el.valueTable) { return; }
    var rows = [
      ['DEC', formatDec(u, store.width), decPlain(u, store.width)],
      ['HEX', formatHex(u, store.width), formatHex(u, store.width)],
      ['OCT', formatOct(u), formatOct(u)],
      ['BIN', formatBin(u, store.width), formatBinBig(u, store.width)]
    ];
    var fl = readFloat(u, store.width);
    if (fl) {
      rows.push([fl.label, prettyFloat(fl.value), String(fl.value)]);
    }

    el.valueTable.textContent = '';
    rows.forEach(function (r) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'vrow';
      row.dataset.copy = r[2];
      row.dataset.label = r[0];
      row.title = '点击复制 ' + r[0];
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = r[0];
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = r[1];
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon');
      var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-copy');
      icon.appendChild(use);
      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(icon);
      el.valueTable.appendChild(row);
    });
  }

  // ---------- 窗口高度 ----------
  var fitRaf = 0;
  var lastFit = -1;

  function fitWorkbenchHeight() {
    if (!el.workbench) { return; }
    var rows = Math.ceil(store.width / 16);
    var gridHeight = rows * 32 + Math.max(0, rows - 1) * 8;
    var height = gridHeight + 28;
    if (inspOpen) { height = Math.max(146, height); }
    height = Math.min(220, height);
    // 工作区高度只跟位宽和检查器开合有关；历史/字段再多也在面板内部滚动。
    el.workbench.style.height = height + 'px';
    var valuebarHeight = el.valuebar ? el.valuebar.getBoundingClientRect().height : 84;
    el.content.style.height = (valuebarHeight + height) + 'px';
  }

  function scheduleFit() {
    if (fitRaf) { return; }
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitHeight();
    });
  }

  function fitHeight() {
    var app = el.app;
    if (!app) { return 0; }
    app.style.height = 'auto';
    document.body.style.height = 'auto';
    document.documentElement.style.height = '';

    var h = Math.ceil(app.getBoundingClientRect().height);
    if (!h) { return 0; }
    h = Math.max(h, 220);

    document.body.style.height = h + 'px';
    app.style.height = h + 'px';

    fitBig();
    if (h !== lastFit && ut && ut.setExpandHeight) {
      lastFit = h;
      try { ut.setExpandHeight(h); } catch (err) { /* 浏览器预览时忽略 */ }
    }
    return h;
  }

  // ---------- 选择 / 位宽 ----------
  function clampSel(sel) {
    if (!sel) { return null; }
    var end = Math.min(sel.end, store.width - 1);
    var start = Math.min(sel.start, end);
    if (end < 0) { return null; }
    return { start: start, end: end };
  }

  function setSelection(sel) {
    clearError();
    store.sel = clampSel(sel);
    activeIdx = -1;
    if (store.sel) {
      var f = findField(store.sel.start, store.sel.end);
      if (f) { activeIdx = fields.indexOf(f); }
    }
    render();
  }

  function clearSelection() {
    clearError();
    cancelFlash();
    store.sel = null;
    activeIdx = -1;
    render();
  }

  function selectField(i) {
    var f = fields[i];
    if (!f) { return; }
    setSelection({ start: f.start, end: f.end });
  }

  /** 字段值就地编辑：只写这个字段的位段，其余位保持不变。
      不能用 Esc 放弃——Esc 是 uTools 退出插件的快捷键。 */
  function startFieldEdit(idx) {
    var f = fields[idx];
    if (!f) { return; }
    openInspector('fields');
    selectField(idx);
    var row = rowEls[idx];
    if (!row) { return; }
    var val = row.querySelector('.fv');
    if (!val || val.querySelector('input')) { return; }
    var w = fieldWidth(f);
    var cur = extractRange(clampU(store.value), f.start, w);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'f-edit';
    inp.value = cur.toString();
    inp.setAttribute('aria-label', f.name + ' 的值');
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    val.textContent = '';
    val.appendChild(inp);
    inp.focus();
    inp.select();

    var done = false;
    function finish(commit, quietFail) {
      if (done) { return; }
      done = true;
      if (!commit) { render(); return; }
      var src = inp.value.trim();
      var v;
      try { v = src ? P.parse(src) : 0n; }
      catch (err) {
        var why = (err && err.message) || '表达式有误';
        if (quietFail) {
          render();
          toast('没写成：' + why, 'warn');
          return;
        }
        done = false;
        inp.setAttribute('aria-invalid', 'true');
        toast(why, 'warn');
        inp.focus();
        return;
      }
      var next = writeRange(store.value, f.start, w, v);
      if (next === store.value && v === cur) { render(); return; }
      if (next !== store.value) { pushUndo(); }
      store.value = next;
      clearError();
      render();
      var now = extractRange(store.value, f.start, w);
      toast('已写入 ' + f.name + ' = 0x' + hexDigits(now, w) + '（' + now.toString() + '）');
      queueHistory(f.name + ' = ' + (src || '0'));
    }

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    });
    inp.addEventListener('blur', function () { finish(true, true); });
  }

  function setWidth(w) {
    if (WIDTHS.indexOf(w) < 0 || w === store.width) { return; }
    clearError();
    store.width = w;
    if (store.sel && store.sel.end >= w) { store.sel = null; } else { store.sel = clampSel(store.sel); }
    hoverField = null;
    hoverIdx = -1;
    if (activeIdx >= 0 && fields[activeIdx].end >= w) { activeIdx = -1; }
    if (specText && PB) { parseAndApply(specText, true); }
    var out = 0;
    for (var i = 0; i < fields.length; i++) { if (fields[i].end >= store.width) { out++; } }
    saveSettings();
    render();
    if (out) { toast('已切到 ' + store.width + ' 位 · ' + out + ' 个字段超出范围', 'warn'); }
  }

  function saveSettings() {
    if (!S) { return; }
    S.patchSettings({ width: store.width, signed: store.signed, le: store.le, base: store.base });
  }

  // ---------- 撤销 ----------
  function pushUndo() {
    undoStack.push({
      value: store.value,
      sel: store.sel ? { start: store.sel.start, end: store.sel.end } : null
    });
    if (undoStack.length > UNDO_MAX) { undoStack.shift(); }
  }

  function undo() {
    if (!undoStack.length) { toast('没有可撤销的操作', 'warn'); return; }
    var prev = undoStack.pop();
    store.value = clampU(prev.value);
    store.sel = prev.sel ? clampSel(prev.sel) : null;
    lastError = '';
    render();
    toast('已撤销');
  }

  // ---------- 反馈 ----------
  var flashTimer = 0;

  function toast(msg, tone) {
    var warn = tone === 'warn';
    el.hint.textContent = (warn ? '' : '✓ ') + msg;
    el.hint.className = warn ? 'hint warn flash' : 'hint flash';
    el.hint.title = msg;
    flashUntil = Date.now() + 1600;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashUntil = 0;
      updateHint(null);
    }, 1600);
  }

  function cancelFlash() {
    flashUntil = 0;
    clearTimeout(flashTimer);
    flashTimer = 0;
  }

  function copy(text, label) {
    if (ut && ut.copyText) {
      ut.copyText(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
    toast('已复制 ' + label);
  }

  // ---------- 表达式 ----------
  function writeRange(cur, start, width, v) {
    var u = clampU(cur);
    var span = (1n << BigInt(width)) - 1n;
    var mask = span << BigInt(start);
    var bits = (P.toUint64(v) & span) << BigInt(start);
    return BigInt.asUintN(64, (u & ~mask) | bits);
  }

  function applyExpression(text, opts) {
    var silent = !!(opts && opts.silent);
    var src = String(text == null ? '' : text).trim();
    exprText = src;
    if (!src) {
      clearError();
      if (store.value !== 0n) { pushUndo(); }
      store.value = 0n;
      store.sel = clampSel(store.sel);
      render();
      return true;
    }
    var v;
    try {
      v = P.parse(src);
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (el.exprInput) { el.exprInput.setAttribute('aria-invalid', 'true'); }
      updateHint(null);
      scheduleFit();
      return false;
    }
    clearError();
    if (el.exprInput) { el.exprInput.removeAttribute('aria-invalid'); }
    var next;
    if (store.sel) {
      var w = store.sel.end - store.sel.start + 1;
      next = writeRange(store.value, store.sel.start, w, v);
    } else {
      next = P.toUint64(v);
    }
    if (next !== store.value) { pushUndo(); }
    store.value = next;
    store.sel = clampSel(store.sel);
    render();
    if (!silent) { queueHistory(src); }
    return true;
  }

  // ---------- 历史记录 ----------
  function queueHistory(expr) {
    if (!S || !expr) { return; }
    histPending = {
      expr: expr,
      value: clampU(store.value).toString(),
      width: store.width,
      signed: store.signed
    };
    clearTimeout(histTimer);
    histTimer = setTimeout(flushHistory, HISTORY_DEBOUNCE);
  }

  function flushHistory() {
    clearTimeout(histTimer);
    histTimer = 0;
    if (!histPending || !S) { return; }
    S.historyPush(histPending);
    histPending = null;
    if (inspOpen && inspTab === 'history') { renderHistory(); }
  }

  function histValueLabel(entry) {
    var w = Number(entry.width) || store.width;
    var raw = BigInt(entry.value || '0');
    var v = BigInt.asUintN(w, raw);
    var dec = (entry.signed ? BigInt.asIntN(w, v) : v).toString();
    var s = '= ' + groupThousands(dec);
    if (w <= 16) { s += ' · 0x' + hexDigits(v, w); }
    return s;
  }

  function renderHistory() {
    var list = S ? S.historyList() : [];
    el.historyList.textContent = '';
    histEls = [];
    el.historyEmpty.hidden = list.length > 0;
    list.forEach(function (entry, i) {
      var li = document.createElement('li');
      li.className = 'history-item';
      li.id = 'hist-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.idx = String(i);

      var ex = document.createElement('span');
      ex.className = 'h-expr';
      ex.textContent = entry.expr;

      var val = document.createElement('span');
      val.className = 'h-val';
      val.textContent = histValueLabel(entry);

      li.title = entry.expr + ' · ' + new Date(entry.ts || Date.now()).toLocaleString();
      li.appendChild(ex);
      li.appendChild(val);
      el.historyList.appendChild(li);
      histEls.push(li);
    });
    histActive = list.length ? 0 : -1;
    paintHistory();
  }

  function paintHistory() {
    histEls.forEach(function (li, i) {
      li.setAttribute('aria-selected', String(i === histActive));
    });
    var cur = histEls[histActive];
    if (cur) {
      el.historyList.setAttribute('aria-activedescendant', cur.id);
      if (cur.scrollIntoView) { cur.scrollIntoView({ block: 'nearest' }); }
    } else {
      el.historyList.removeAttribute('aria-activedescendant');
    }
  }

  function applyHistory(idx) {
    var entry = (S ? S.historyList() : [])[idx];
    if (!entry) { return; }
    histActive = idx;
    paintHistory();
    syncExprInput(entry.expr);
    var ok = applyExpression(entry.expr, { silent: true });
    if (!ok) {
      lastError = '';
      if (store.value !== clampU(BigInt(entry.value || '0'))) { pushUndo(); }
      store.value = clampU(BigInt(entry.value || '0'));
      store.sel = clampSel(store.sel);
      render();
    }
    toast('已恢复 ' + entry.expr);
  }

  // ---------- 检查器 ----------
  function setInspector(open) {
    inspOpen = !!open;
    el.inspector.hidden = !inspOpen;
    el.fieldsBtn.classList.toggle('on', inspOpen && inspTab === 'fields');
    el.historyBtn.setAttribute('aria-expanded', String(inspOpen && inspTab === 'history'));
    fitWorkbenchHeight();
    scheduleFit();
    if (inspOpen) {
      requestAnimationFrame(function () { pushGridState(); });
    }
  }

  function setInspTab(tab) {
    if (['fields', 'values', 'history'].indexOf(tab) < 0) { return; }
    inspTab = tab;
    [].forEach.call(el.inspTabs.children, function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    el.inspFields.hidden = tab !== 'fields';
    el.inspValues.hidden = tab !== 'values';
    el.inspHistory.hidden = tab !== 'history';
    el.fieldsBtn.classList.toggle('on', inspOpen && tab === 'fields');
    el.historyBtn.setAttribute('aria-expanded', String(inspOpen && tab === 'history'));
    if (tab === 'history') { renderHistory(); }
    if (tab === 'values') { renderValues(clampU(store.value)); }
    scheduleFit();
  }

  function openInspector(tab) {
    setInspector(true);
    setInspTab(tab || 'fields');
  }

  function openHistory() {
    if (!el.specPanel.hidden) { closeSpec(); }
    flushHistory();
    openInspector('history');
    el.historyList.focus();
  }

  function toggleHistory() {
    if (inspOpen && inspTab === 'history') { setInspector(false); return; }
    openHistory();
  }

  // ---------- 字段定义 ----------
  function setSpecMsg(text, kind) {
    el.specMsg.textContent = text;
    el.specMsg.className = 'spec-msg' + (kind ? ' ' + kind : '');
  }

  function validateSpec(text) {
    if (!PB) {
      el.specText.setAttribute('aria-invalid', 'true');
      setSpecMsg('proto.js 未加载', 'error');
      return false;
    }
    var res = PB.parseSpec(text, store.width);
    var errs = (res && res.errors) || [];
    if (errs.length) {
      var e = errs[0];
      var more = errs.length > 1 ? '（共 ' + errs.length + ' 处）' : '';
      el.specText.setAttribute('aria-invalid', 'true');
      setSpecMsg('第 ' + e.line + ' 行：' + e.message + more, 'error');
      return false;
    }
    el.specText.removeAttribute('aria-invalid');
    var list = res.fields || [];
    if (!list.length) {
      setSpecMsg('还没有字段：每行一个，例如 opcode 15:12', 'ok');
      return true;
    }
    var wide = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].end >= store.width) { wide = list[i]; break; }
    }
    if (wide) {
      var need = WIDTHS.filter(function (w) { return w > wide.end; })[0] || 64;
      el.specText.setAttribute('aria-invalid', 'true');
      setSpecMsg('字段 ' + wide.name + ' 占 ' + wide.end + ':' + wide.start + '，超出当前位宽 ' + store.width +
        '——切到 ' + need + ' 位，或把位段改小', 'error');
      return false;
    }
    var span = 0;
    list.forEach(function (f) { span = Math.max(span, f.end + 1); });
    var ov = PB.overlaps ? PB.overlaps(list) : [];
    var msg = list.length + ' 个字段 · 占 ' + span + ' 位';
    if (ov.length) {
      setSpecMsg(msg + ' · ' + ov.length + ' 处位域重叠', 'warn');
    } else if (String(text).trim() !== String(specText).trim()) {
      setSpecMsg(msg + ' · 未应用', 'ok');
    } else {
      setSpecMsg(msg, 'ok');
    }
    return true;
  }

  function parseAndApply(text, quiet) {
    if (!PB) {
      setSpecMsg('proto.js 未加载', 'error');
      return false;
    }
    var res = PB.parseSpec(text, store.width);
    if (res.errors && res.errors.length) {
      var e = res.errors[0];
      var more = res.errors.length > 1 ? '（共 ' + res.errors.length + ' 处）' : '';
      setSpecMsg('第 ' + e.line + ' 行：' + e.message + more, 'error');
      return false;
    }
    if (!quiet) {
      var wide = null;
      (res.fields || []).forEach(function (f) {
        if (!wide && f.end >= store.width) { wide = f; }
      });
      if (wide) {
        var need = WIDTHS.filter(function (w) { return w > wide.end; })[0] || 64;
        setSpecMsg('字段 ' + wide.name + ' 占 ' + wide.end + ':' + wide.start + '，超出当前位宽 ' + store.width +
          '——切到 ' + need + ' 位，或把位段改小', 'error');
        return false;
      }
    }
    fields = res.fields || [];
    hoverField = null;
    hoverIdx = -1;
    activeIdx = store.sel ? fields.indexOf(findField(store.sel.start, store.sel.end)) : -1;
    specText = text;
    if (S) { S.setSpec(text); }
    if (!quiet) {
      validateSpec(text);
      render();
    }
    return true;
  }

  // ---------- 方案 ----------
  function syncSchemeButtons() {
    var has = !!el.schemeSelect.value;
    el.schemeLoad.disabled = !has;
    el.schemeDel.disabled = !has;
  }

  function renderSchemes(selectedName) {
    if (!S) { return; }
    var list = S.schemeList();
    var want = selectedName != null ? selectedName : el.schemeSelect.value;
    el.schemeSelect.textContent = '';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = list.length ? '未保存的方案…' : '还没有保存的方案';
    el.schemeSelect.appendChild(none);

    list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name + (s.width && s.width !== store.width ? ' · ' + s.width + '位' : '');
      el.schemeSelect.appendChild(opt);
    });

    var keep = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === want) { keep = want; break; }
    }
    el.schemeSelect.value = keep;
    syncSchemeButtons();
  }

  function showSchemeForm() {
    el.schemeForm.hidden = false;
    el.schemeName.value = el.schemeSelect.value || '';
    el.schemeName.focus();
    el.schemeName.select();
  }

  function hideSchemeForm() {
    el.schemeForm.hidden = true;
    el.schemeName.value = '';
  }

  function commitScheme() {
    if (!S) { return; }
    var name = S.clipName(el.schemeName.value);
    if (!name) { toast('先给方案起个名字', 'warn'); el.schemeName.focus(); return; }
    var text = el.specText.value;
    if (!validateSpec(text)) { toast('字段定义还有错误，先改好再保存', 'warn'); return; }
    var r = S.schemeSave(name, text, store.width);
    if (!r.ok) { toast('保存失败', 'warn'); return; }
    hideSchemeForm();
    renderSchemes(name);
    toast('已保存方案「' + name + '」');
  }

  function loadScheme() {
    var name = el.schemeSelect.value;
    if (!name || !S) { return; }
    var s = S.schemeGet(name);
    if (!s) { return; }
    el.specText.value = s.spec;
    validateSpec(s.spec);
    if (parseAndApply(s.spec, true)) {
      render();
      openInspector('fields');
      toast('已载入方案「' + name + '」');
    } else {
      toast('方案有错误，未应用', 'warn');
    }
  }

  function deleteScheme() {
    var name = el.schemeSelect.value;
    if (!name || !S) { return; }
    if (!delTimer) {
      el.schemeDel.textContent = '确认删除';
      delTimer = setTimeout(function () {
        delTimer = 0;
        el.schemeDel.textContent = '删除';
      }, 3000);
      return;
    }
    clearTimeout(delTimer);
    delTimer = 0;
    el.schemeDel.textContent = '删除';
    S.schemeDelete(name);
    renderSchemes('');
    toast('已删除方案「' + name + '」');
  }

  // ---------- 字段编辑器开合 ----------
  function openSpec() {
    closeMenus();
    el.specPanel.hidden = false;
    el.specText.value = specText || (S ? S.getSpec() : '') || '';
    renderSchemes();
    hideSchemeForm();
    validateSpec(el.specText.value);
    el.specText.focus();
    var n = el.specText.value.length;
    try { el.specText.setSelectionRange(n, n); } catch (err) { /* 忽略 */ }
  }

  function closeSpec(refocus) {
    el.specPanel.hidden = true;
    el.specText.removeAttribute('aria-invalid');
    hideSchemeForm();
    if (refocus !== false) { focusExpr(); }
  }

  // ---------- 菜单 ----------
  function closeMenus() {
    el.displayMenu.hidden = true;
    el.moreMenu.hidden = true;
    el.displayBtn.setAttribute('aria-expanded', 'false');
    el.moreBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(btn, menu) {
    var open = menu.hidden;
    closeMenus();
    if (open) {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  // ---------- 事件 ----------
  function wire() {
    el.widthSelect.addEventListener('change', function () {
      setWidth(Number(el.widthSelect.value));
    });

    el.fieldsBtn.addEventListener('click', function () {
      closeMenus();
      if (inspOpen && inspTab === 'fields') { setInspector(false); }
      else { openInspector('fields'); }
    });

    el.displayBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu(el.displayBtn, el.displayMenu);
    });
    el.moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMenu(el.moreBtn, el.moreMenu);
    });

    el.signedChk.addEventListener('change', function () {
      clearError();
      store.signed = el.signedChk.checked;
      saveSettings();
      render();
    });

    el.endianBtn.addEventListener('click', function () {
      clearError();
      store.le = !store.le;
      saveSettings();
      render();
      el.endianBtn.querySelector('b').textContent = store.le ? 'LE' : 'BE';
      closeMenus();
    });

    el.historyBtn.addEventListener('click', function () {
      closeMenus();
      toggleHistory();
    });

    el.undoBtn.addEventListener('click', function () { closeMenus(); undo(); });
    el.clearSelBtn.addEventListener('click', function () { closeMenus(); clearSelection(); });
    el.copyAllBtn.addEventListener('click', function () {
      closeMenus();
      copy(formatHex(clampU(store.value), store.width), 'HEX 整值');
    });

    document.addEventListener('pointerdown', function (e) {
      if (!e.target.closest || !e.target.closest('.menu-wrap')) { closeMenus(); }
    });

    if (el.exprInput) { wireExprInput(); }

    el.ctxEdit.addEventListener('click', function () {
      if (activeIdx >= 0) { startFieldEdit(activeIdx); }
      else { focusExpr(); toast('在输入框输入表达式，写回选中段'); }
    });
    el.ctxClear.addEventListener('click', clearSelection);
    el.copyMain.addEventListener('click', function () { copyMainValue(); });
    el.valBig.addEventListener('click', function () { copyMainValue(); });

    el.baseSwitch.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-base]');
      if (!b || BASES.indexOf(b.dataset.base) < 0) { return; }
      store.base = b.dataset.base;
      saveSettings();
      render();
    });

    el.inspTabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (b) { openInspector(b.dataset.tab); }
    });

    el.valueTable.addEventListener('click', function (e) {
      var row = e.target.closest('.vrow');
      if (row) { copy(row.dataset.copy, row.dataset.label); }
    });

    el.defineFields.addEventListener('click', openSpec);
    el.addField.addEventListener('click', openSpec);

    el.fieldList.addEventListener('click', function (e) {
      var row = e.target.closest('.frow');
      if (!row) { return; }
      var idx = Number(row.dataset.idx);
      var f = fields[idx];
      if (!f) { return; }
      if (e.target.closest('.f-copy')) {
        var w = fieldWidth(f);
        var v = extractRange(clampU(store.value), f.start, w);
        copy('0x' + hexDigits(v, w), f.name);
        return;
      }
      if (e.target.closest('.fv')) {
        startFieldEdit(idx);
        return;
      }
      if (store.sel && store.sel.start === f.start && store.sel.end === f.end) {
        clearSelection();
      } else {
        selectField(idx);
      }
    });

    el.fieldList.addEventListener('dblclick', function (e) {
      if (e.target.closest('.fv') || e.target.closest('.f-copy')) { return; }
      var row = e.target.closest('.frow');
      if (!row) { return; }
      var f = fields[Number(row.dataset.idx)];
      if (!f) { return; }
      var w = fieldWidth(f);
      var v = extractRange(clampU(store.value), f.start, w);
      copy('0x' + hexDigits(v, w), f.name);
    });

    el.fieldList.addEventListener('pointerover', function (e) {
      var row = e.target.closest('.frow');
      if (!row) { return; }
      var idx = Number(row.dataset.idx);
      var f = fields[idx];
      if (!f || hoverField === f) { return; }
      hoverField = f;
      hoverIdx = idx;
      paintRows();
      pushGridState();
    });

    el.fieldList.addEventListener('pointerleave', function () {
      hoverField = null;
      hoverIdx = -1;
      paintRows();
      pushGridState();
    });

    el.fieldList.addEventListener('keydown', function (e) {
      if (!fields.length) { return; }
      var k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        e.preventDefault();
        var cur = activeIdx;
        if (k === 'ArrowDown') { cur = Math.min(fields.length - 1, cur + 1); }
        else if (k === 'ArrowUp') { cur = Math.max(0, cur - 1); }
        else if (k === 'Home') { cur = 0; }
        else { cur = fields.length - 1; }
        selectField(cur);
      } else if (k === 'F2') {
        e.preventDefault();
        if (activeIdx >= 0) { startFieldEdit(activeIdx); }
      } else if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        selectField(activeIdx >= 0 ? activeIdx : 0);
      }
    });

    el.historyClear.addEventListener('click', function () {
      if (!S) { return; }
      S.historyClear();
      renderHistory();
      toast('历史已清空');
    });

    el.historyList.addEventListener('click', function (e) {
      var li = e.target.closest('.history-item');
      if (li) { applyHistory(Number(li.dataset.idx)); }
    });

    el.historyList.addEventListener('pointerover', function (e) {
      var li = e.target.closest('.history-item');
      if (!li) { return; }
      var idx = Number(li.dataset.idx);
      if (idx !== histActive) { histActive = idx; paintHistory(); }
    });

    el.historyList.addEventListener('keydown', function (e) {
      var n = histEls.length;
      if (!n) { return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); histActive = Math.min(n - 1, histActive + 1); paintHistory(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); histActive = Math.max(0, histActive - 1); paintHistory(); }
      else if (e.key === 'Enter') { e.preventDefault(); applyHistory(histActive); }
    });

    el.specCancel.addEventListener('click', closeSpec);
    el.specClose.addEventListener('click', closeSpec);
    el.specSave.addEventListener('click', function () {
      if (parseAndApply(el.specText.value, false)) {
        closeSpec();
        openInspector('fields');
        if (!fields.length) { toast('已清空字段'); return; }
        var ov = PB && PB.overlaps ? PB.overlaps(fields).length : 0;
        if (ov) { toast('已应用 ' + fields.length + ' 个字段 · ' + ov + ' 处重叠', 'warn'); }
        else { toast('已应用 ' + fields.length + ' 个字段'); }
      }
    });

    el.specHelpToggle.addEventListener('click', function () {
      var open = el.specHelp.hidden;
      el.specHelp.hidden = !open;
      el.specHelpToggle.setAttribute('aria-expanded', String(open));
    });

    el.specSample.addEventListener('click', function () {
      el.specText.value = [
        '# 示例：一条 8 位指令，可随意改位段后点「应用」',
        'opcode 7:4',
        'operand 3:0'
      ].join('\n');
      el.specText.dispatchEvent(new Event('input', { bubbles: true }));
      el.specText.focus();
      el.specText.setSelectionRange(0, 0);
    });

    el.specText.addEventListener('input', function () {
      clearTimeout(specTimer);
      specTimer = setTimeout(function () { validateSpec(el.specText.value); }, 180);
    });

    el.schemeSelect.addEventListener('change', syncSchemeButtons);
    el.schemeLoad.addEventListener('click', loadScheme);
    el.schemeSave.addEventListener('click', showSchemeForm);
    el.schemeDel.addEventListener('click', deleteScheme);
    el.schemeNameOk.addEventListener('click', commitScheme);
    el.schemeNameCancel.addEventListener('click', hideSchemeForm);
    el.schemeName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitScheme(); }
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var tag = t && t.tagName ? t.tagName : '';
      var inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        var k = String(e.key || '').toLowerCase();
        if (k === 'h') { e.preventDefault(); toggleHistory(); return; }
        if (k === 'z' && !inField) { e.preventDefault(); undo(); return; }
        if (k === 'k') { e.preventDefault(); focusExpr(); return; }
        if (k === 'enter' && t === el.specText) { e.preventDefault(); el.specSave.click(); return; }
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField && store.sel) {
        e.preventDefault();
        clearSelection();
      }
    });

    window.addEventListener('resize', function () {
      scheduleFit();
      pushGridState();
    });
  }

  function copyMainValue() {
    var u = clampU(store.value);
    var scoped = store.sel !== null;
    var w = scoped ? (store.sel.end - store.sel.start + 1) : store.width;
    var v = scoped ? extractRange(u, store.sel.start, w) : u;
    if (store.base === 'hex') { copy(formatHex(v, w), 'HEX'); return; }
    if (store.base === 'oct') { copy(formatOct(v), 'OCT'); return; }
    copy(decPlain(v, w), 'DEC');
  }

  // ---------- 进入插件 ----------
  function handleEnter(action) {
    if (!action) { return; }
    if (action.type === 'text') { return; }
    if (action.type === 'img' || action.type === 'files') { return; }
    var payload = action.payload == null ? '' : String(action.payload).trim();
    if (!payload) { return; }
    syncExprInput(payload);
    applyExpression(payload);
    focusExpr();
  }

  // ---------- 启动 ----------
  function boot() {
    if (!P) { throw new Error('parser.js 未加载'); }
    if (!G) { throw new Error('grid.js 未加载'); }

    var settings = S ? S.getSettings() : {};
    if (WIDTHS.indexOf(settings.width) >= 0) { store.width = settings.width; }
    store.signed = !!settings.signed;
    store.le = !!settings.le;
    if (BASES.indexOf(settings.base) >= 0) { store.base = settings.base; }

    specText = S ? S.getSpec() : '';
    if (specText && PB) { parseAndApply(specText, true); }

    wire();

    grid = G.init({
      root: '#grid',
      onToggleBit: function (pos) {
        clearError();
        pushUndo();
        store.value = clampU(store.value ^ (1n << BigInt(pos)));
        render();
      },
      onSetBit: function (pos, bit) {
        var mask = 1n << BigInt(pos);
        var cur = clampU(store.value);
        var on = (cur & mask) !== 0n;
        if (on === !!bit) { return; }
        clearError();
        pushUndo();
        store.value = bit ? (cur | mask) : (cur & ~mask);
        render();
      },
      onCommitRange: function (start, end) {
        setSelection({ start: start, end: end });
      },
      onClearSelection: clearSelection,
      onHoverBit: function (pos) {
        if (pos === null) {
          if (hoverField) {
            hoverField = null;
            hoverIdx = -1;
            paintRows();
            pushGridState();
          }
          updateHint(null);
          return;
        }
        var idx = fieldAt(pos);
        var f = idx >= 0 ? fields[idx] : null;
        if (f !== hoverField) {
          hoverField = f;
          hoverIdx = idx;
          paintRows();
          pushGridState();
        }
        updateHint(pos);
      }
    });

    if (ut) {
      if (ut.onPluginEnter) {
        ut.onPluginEnter(function (action) {
          handleEnter(action);
          scheduleFit();
        });
      }
      if (ut.onPluginOut) {
        ut.onPluginOut(function () {
          flushHistory();
          if (!el.specPanel.hidden) { closeSpec(false); }
        });
      }
    }

    setInspector(fields.length > 0);
    setInspTab('fields');
    render();
    scheduleFit();

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        scheduleFit();
        pushGridState();
      });
    }
  }

  function fatal(err) {
    var box = document.createElement('div');
    box.className = 'fatal';
    box.textContent = '插件初始化失败：' + (err && err.message ? err.message : String(err));
    document.body.appendChild(box);
    if (window.console) { console.error(err); }
  }

  function start() {
    try {
      boot();
    } catch (err) {
      fatal(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

/**
 * main.js — 状态、显示、交互装配
 *
 * 分工：
 *   parser.js  表达式 → BigInt（纯函数，可单测）
 *   grid.js    位网格渲染 + 拖动选位域（纯几何函数可单测）
 *   proto.js   协议字段定义文本 → 字段表 + 解码（纯函数，可单测）
 *   store.js   本地持久化：字段定义 / 历史记录 / 命名方案 / 界面设置
 *   main.js    以上四者的粘合层：状态机、格式化、DOM 事件、窗口高度
 *
 * 交互主轴（对应参考项目 BitCalc 的「选择部分 bit 显示值」）：
 *   拖选一段 bit → 主数值区立刻变成这一段的值（右移到 bit0），
 *   点字段表某行 → 等价于选中那段 bit；右键 / Delete / 点 chip 取消。
 *
 * 高度策略（曾经的 bug 就在这）：
 *   uTools 插件窗口高度由 setExpandHeight 决定。早先按"网格行数 + 固定面板高"自己推算，
 *   32 位时网格只有 2 行（59px），旁边/下面的字段表就被压成 59px，字段行被裁、滚不动。
 *   现在布局是自然高度（顶栏 + 左右分栏 + 字段区 + 状态行），fitHeight() 直接量内容，
 *   再把窗口设成一样高——CSS 改样式，高度自动跟上，不用同步改一份公式。
 */
(function () {
  'use strict';

  var P = window.BitCalcParser;
  var G = window.BitCalcGrid;
  var PB = window.BitCalcProto || null;
  var S = window.BitCalcStore || null;
  var ut = window.utools || null;

  var $ = function (sel) { return document.querySelector(sel); };

  var HISTORY_DEBOUNCE = 900;  // 停止输入这么久才记一条历史，避免逐键记录
  var UNDO_MAX = 30;
  var WIDTHS = [8, 16, 32, 64];
  var BASES = ['dec', 'hex', 'oct'];

  // ---------- 元素 ----------
  var el = {
    hint: $('#hint'),
    exprInput: $('#expr-input'),
    exprGo: $('#expr-go'),
    modeTabs: $('#mode-tabs'),
    widthSeg: $('#width-seg'),
    signedChk: $('#signed-chk'),
    endianBtn: $('#endian-btn'),
    clearBtn: $('#clear-btn'),
    historyBtn: $('#history-btn'),
    historyPanel: $('#history-panel'),
    historyList: $('#history-list'),
    historyEmpty: $('#history-empty'),
    historyClear: $('#history-clear'),
    valDec: $('#val-dec'),
    valHex: $('#val-hex'),
    baseSwitch: $('#base-switch'),
    fieldChip: $('#field-chip'),
    stage: $('#stage'),
    gridRoot: $('#grid'),
    fieldPanel: $('#field-panel'),
    fieldBody: $('#field-body'),
    fieldCount: $('#field-count'),
    fieldEditBtn: $('#field-edit-btn'),
    specPanel: $('#spec-panel'),
    specText: $('#spec-text'),
    specMsg: $('#spec-msg'),
    specHelp: $('#spec-help'),
    specHelpToggle: $('#spec-help-toggle'),
    specSample: $('#spec-sample'),
    specCancel: $('#spec-cancel'),
    specSave: $('#spec-save'),
    schemeSelect: $('#scheme-select'),
    schemeLoad: $('#scheme-load'),
    schemeSave: $('#scheme-save'),
    schemeDel: $('#scheme-del'),
    schemeForm: $('#scheme-form'),
    schemeName: $('#scheme-name'),
    schemeNameOk: $('#scheme-name-ok'),
    schemeNameCancel: $('#scheme-name-cancel'),
    readouts: $('#readouts'),
    valOct: $('#val-oct'),
    valBin: $('#val-bin'),
    valFloat: $('#val-float'),
    floatName: $('#float-name'),
    rowFloat: $('#row-float')
  };

  // ---------- 状态 ----------
  var store = {
    value: 0n,        // 恒按 64 位无符号存放
    sel: null,        // { start, end } 闭区间，start <= end
    signed: false,
    width: 64,
    le: false,
    base: 'dec'       // 主数字的进制：dec | hex | oct
  };
  var mode = 'bits';            // 'bits' | 'proto'
  var fields = [];              // [{ name, start, end }]
  var activeIdx = -1;           // 字段表里选中的行
  var lastActiveIdx = -1;       // 上一次渲染时的选中行（用于"滚到可见"）
  var hoverField = null;        // 悬停中的字段（网格 ↔ 表联动）
  var specText = '';            // 已应用的字段定义原文
  var rowEls = [];              // 字段表行元素
  var lastError = '';
  var grid = null;

  var histOpen = false;
  var histActive = -1;
  var histEls = [];
  var histTimer = 0;
  var histPending = null;
  var undoStack = [];

  var specTimer = 0;
  var delTimer = 0;

  // ---------- 数值工具 ----------
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

  /** HEX：补足位宽的十六进制串，不加空格分组——这些字符串会被原样复制，
      夹空格粘贴到代码里就废了；太长的话大数字那边有 fitBig() 自动缩字号。 */
  function formatHex(u, width) {
    var v = store.le ? bswapWidth(u, width) : u;
    return '0x' + hexDigits(v, width);
  }

  function formatDec(u, width) {
    var v = store.signed ? BigInt.asIntN(width, u) : u;
    return groupThousands(v.toString());
  }

  /** 八进制不补前导零：64 位补满要 22 位，全 0 时是一面零墙，读不出信息量 */
  function formatOct(u) {
    return '0' + u.toString(8);
  }

  function formatBin(u, width) {
    var s = u.toString(2);
    while (s.length < width) { s = '0' + s; }
    var out = [];
    for (var i = 0; i < s.length; i += 4) { out.push(s.slice(i, i + 4)); }
    return out.join(' ');
  }

  var fbuf = new ArrayBuffer(8);
  var fview = new DataView(fbuf);

  /** 按位宽把整数值解释成 IEEE754（32 位看 f32，64 位看 f64） */
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

  // ---------- 提示行 ----------
  function defaultHint() {
    return mode === 'proto' ? '点字段行选中位域 · 双击复制字段值' : '点击翻转位 · 拖动选位域';
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

  /** 清掉上一条表达式错误。点格子、改位宽这些"手动操作"都该让错误退场。 */
  function clearError() {
    if (!lastError) { return; }
    lastError = '';
    el.hint.title = '';
    if (el.exprInput) { el.exprInput.removeAttribute('aria-invalid'); }
  }

  function updateHint(hoverPos) {
    // 反馈闪烁期间先别抢状态行；但错误优先级更高，直接接管
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
      text = '位 ' + store.sel.start + '–' + store.sel.end + ' · ' + w + ' 位 · 0x' + hexDigits(v, w);
      if (store.signed) { text += ' · ' + BigInt.asIntN(w, v).toString(); }
      text += ' · 输入即写回';
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

  // ---------- 渲染 ----------
  /** 主数字可能是一整串 64 位十进制/十六进制，字号得跟着长度缩，宁小勿裁 */
  function fitBig() {
    var big = el.valDec;
    if (!big) { return; }
    big.style.fontSize = '';
    big.style.letterSpacing = '';
    var avail = big.clientWidth;
    var need = big.scrollWidth;
    if (!avail || need <= avail) { return; }
    var size = Math.max(15, Math.floor(34 * avail / need));
    big.style.fontSize = size + 'px';
    big.style.letterSpacing = (size / 34 * -1.2).toFixed(2) + 'px';
  }

  function formatBase(u, width) {
    if (store.base === 'hex') { return formatHex(u, width); }
    if (store.base === 'oct') { return formatOct(u); }
    return formatDec(u, width);
  }

  function render() {
    var u = clampU(store.value);
    var scoped = store.sel !== null;
    var fw = scoped ? (store.sel.end - store.sel.start + 1) : store.width;
    var fv = scoped ? extractRange(u, store.sel.start, fw) : u;

    el.valDec.textContent = formatBase(fv, fw);
    el.valDec.className = 'disp-val' + (scoped ? ' scoped' : '');
    // 右侧三行读数永远给整值（选中一段时也一样）：主数字已经是选中段了，
    // 这里再重复一遍选中段没有意义，对照整值反而更有用。
    el.valHex.textContent = formatHex(u, store.width);

    if (el.baseSwitch) {
      [].forEach.call(el.baseSwitch.children, function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.base === store.base));
      });
    }

    if (scoped) {
      var f = findField(store.sel.start, store.sel.end);
      el.fieldChip.hidden = false;
      el.fieldChip.textContent = (f ? f.name + ' ' : '') + store.sel.end + ':' + store.sel.start;
    } else {
      el.fieldChip.hidden = true;
    }

    el.valOct.textContent = formatOct(u);
    if (el.valBin) { el.valBin.textContent = formatBin(u, store.width); }

    var fl = readFloat(u, store.width);
    if (fl) {
      el.rowFloat.hidden = false;
      el.floatName.textContent = fl.label;
      el.valFloat.textContent = prettyFloat(fl.value);
    } else {
      el.rowFloat.hidden = true;
    }

    el.endianBtn.textContent = store.le ? 'LE' : 'BE';
    el.endianBtn.dataset.on = store.le ? 'true' : 'false';

    [].forEach.call(el.widthSeg.children, function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.w) === store.width));
    });
    el.signedChk.checked = store.signed;

    if (grid) {
      grid.setState({
        value: u,
        sel: store.sel,
        width: store.width,
        field: hoverField || (activeIdx >= 0 ? fields[activeIdx] : null)
      });
    }

    renderFields(u);
    updateHint(null);
    fitBig();
    scheduleFit();
  }

  function renderFields(u) {
    rowEls = [];
    el.fieldBody.textContent = '';
    el.fieldCount.textContent = fields.length ? String(fields.length) : '';
    if (!fields.length) {
      var empty = document.createElement('div');
      empty.className = 'fields-empty';
      empty.textContent = '还没有字段定义。点右上「定义…」按行写字段，例如 opcode 15:12。';
      el.fieldBody.appendChild(empty);
      lastActiveIdx = -1;
      return;
    }
    fields.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'field-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.dataset.idx = String(i);
      row.id = 'field-row-' + i;

      var name = document.createElement('span');
      name.className = 'field-row-name';
      name.textContent = f.name;
      name.title = f.name + ' · 位 ' + f.end + ':' + f.start;

      var range = document.createElement('span');
      range.className = 'field-row-range';
      range.textContent = f.end + ':' + f.start;

      var val = document.createElement('span');
      val.className = 'field-row-val';
      var w = fieldWidth(f);
      var fv = extractRange(u, f.start, w);
      val.textContent = '0x' + hexDigits(fv, w);
      var decv = store.signed ? BigInt.asIntN(w, fv) : fv;
      val.title = '点击改值 · ' + decv.toString() + ' · ' + w + ' 位';
      // 位宽调小后，旧定义里超界的字段值恒为 0：标出来，别让人以为数据丢了
      if (f.end >= store.width) {
        row.classList.add('out-of-range');
        row.title = f.name + ' · 位 ' + f.end + ':' + f.start + ' · 超出当前 ' + store.width + ' 位宽';
        val.title = decv.toString() + ' · 超出当前位宽';
      }

      row.appendChild(name);
      row.appendChild(range);
      row.appendChild(val);
      el.fieldBody.appendChild(row);
      rowEls.push(row);
    });
    syncActiveDescendant();
    scrollActiveRowIntoView();
  }

  /** 选中行滚进视野：用矩形比较而不是 scrollIntoView，避免连带滚动整个页面 */  function scrollActiveRowIntoView() {
    if (activeIdx < 0 || activeIdx === lastActiveIdx) { lastActiveIdx = activeIdx; return; }
    lastActiveIdx = activeIdx;
    var row = rowEls[activeIdx];
    if (!row || !row.getBoundingClientRect) { return; }
    var rb = row.getBoundingClientRect();
    var bb = el.fieldBody.getBoundingClientRect();
    if (rb.top < bb.top) { el.fieldBody.scrollTop -= (bb.top - rb.top); }
    else if (rb.bottom > bb.bottom) { el.fieldBody.scrollTop += (rb.bottom - bb.bottom); }
  }

  /** 只切换行的选中/悬停态，不重建行（重建会打断 hover） */
  function paintRows() {
    var hi = hoverField ? fields.indexOf(hoverField) : -1;
    rowEls.forEach(function (row, i) {
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.style.background = (i === hi && i !== activeIdx) ? 'var(--hover)' : '';
    });
    syncActiveDescendant();
  }

  /** listbox 用 aria-activedescendant 指当前行，读屏才知道焦点在哪个字段上 */
  function syncActiveDescendant() {
    if (activeIdx >= 0 && rowEls[activeIdx]) {
      el.fieldBody.setAttribute('aria-activedescendant', 'field-row-' + activeIdx);
    } else {
      el.fieldBody.removeAttribute('aria-activedescendant');
    }
  }

  function pushGridState() {
    if (!grid) { return; }
    grid.setState({
      value: clampU(store.value),
      sel: store.sel,
      width: store.width,
      field: hoverField || (activeIdx >= 0 ? fields[activeIdx] : null)
    });
  }

  // ---------- 窗口高度 ----------
  // 不再用常量推算内容高度：布局是「顶栏 + 左右分栏 + 字段区 + 状态行」的自然高度，
  // 用公式推算等于把 CSS 抄一遍，改一次样式就会偏。直接量 .wrap，再把窗口设成一样高。
  var fitRaf = 0;
  var lastFit = -1;

  function scheduleFit() {
    if (fitRaf) { return; }
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitHeight();
    });
  }

  function overlayBottom(node, base) {
    if (!node || node.hidden) { return base; }
    var r = node.getBoundingClientRect();
    var wrap = $('.wrap');
    var top = wrap ? wrap.getBoundingClientRect().top : 0;
    // 浮层贴着 .wrap 顶部绝对定位，换算成相对文档内容的高度
    return Math.max(base, Math.ceil(r.bottom - top + 10));
  }

  function fitHeight() {
    var wrap = $('.wrap');
    if (!wrap) { return 0; }
    // 先回到内容高度再量：上一轮写下的固定高度会把测量值钉死在旧值上
    wrap.style.height = 'auto';
    document.body.style.height = 'auto';
    document.documentElement.style.height = '';

    var h = Math.ceil(wrap.getBoundingClientRect().height);
    if (!h) { return 0; }

    // 浮层是绝对定位的，不进 .wrap 的高度，但它同样要占屏：开着浮层时按浮层底边算窗口高，
    // 否则 body 的 overflow:hidden 会把「取消/应用」那排按钮切掉。
    h = Math.max(h, overlayBottom(el.specPanel, h), overlayBottom(el.historyPanel, h));

    document.body.style.height = h + 'px';
    wrap.style.height = h + 'px';
    // html 高度保持 auto：万一 uTools 把窗口压得比内容矮，交给页面滚动兜底，而不是把底部切掉

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
    // 用户已经手动清除选区，上一句「已应用 N 个字段」的闪示也就过时了
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

  /** 字段值就地编辑：点值那一格变输入框，Enter 或点别处提交。
      不能用 Esc 放弃——Esc 是 uTools 退出插件的快捷键，按下去窗口就没了。
      写入只动这个字段的位段（writeRange），其余位保持不变。 */
  function startFieldEdit(idx) {
    var f = fields[idx];
    var row = rowEls[idx];
    if (!f || !row) { return; }
    selectField(idx);
    // selectField 会 render() 重建字段行，必须换用新行，否则输入框挂到已脱离文档的旧节点上
    row = rowEls[idx] || row;
    var val = row.querySelector('.field-row-val');
    if (!val || val.querySelector('input')) { return; }
    var w = fieldWidth(f);
    var cur = extractRange(clampU(store.value), f.start, w);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'field-edit';
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
          // 点别处走了就别抢焦点回来，按原值重画一遍，把错误说清楚即可
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
      if (next === store.value && v === cur) { render(); return; } // 没改动，静默收场
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
    // 位宽变小时，越界的选区直接清掉，而不是夹到最高位——
    // 夹出来的「位 7–7」是用户没选过的，比没有选区更误导。
    if (store.sel && store.sel.end >= w) { store.sel = null; } else { store.sel = clampSel(store.sel); }
    if (activeIdx >= 0 && fields[activeIdx].end >= w) { activeIdx = -1; }
    // 按位宽写法的字段要从新的最高位重新铺开，所以位宽变化后要重新解析
    if (specText && PB) { parseAndApply(specText, true); }
    var out = 0;
    for (var i = 0; i < fields.length; i++) { if (fields[i].end >= store.width) { out++; } }
    saveSettings();
    render();
    if (out) { toast('已切到 ' + store.width + ' 位 · ' + out + ' 个字段超出范围', 'warn'); }
  }

  function saveSettings() {
    if (!S) { return; }
    S.patchSettings({ width: store.width, signed: store.signed, le: store.le, mode: mode, base: store.base });
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
  // 反馈写在状态行（#hint）里，而不是浮在窗口底部的 toast：
  // uTools 的窗口高度等于内容高度，任何 fixed 定位的浮层最终都会压住网格或读数行。
  // 状态行本来就有 role=status/aria-live，读屏用户也能听到，算是顺手修好可达性。
  var flashTimer = 0;
  var flashUntil = 0;
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

  // 切模式时上一模式的提示（「已应用 N 个字段 · 3 个超出当前 32 位」之类）
  // 已经不再适用于新画面，立刻收掉，别让状态行说谎
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
  // 把 v 写进 [start, start+width) 这一段，位域以外的位保持不动。
  // 这是 BitCalc 的核心手感：选区不只是"看"，也是"改"的目标——
  // 选中 11:8 之后输入 0xF，改的是这 4 位，其余 60 位不受影响。
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
      v = P.parse(src);          // parser.js 出错直接 throw，中文消息可原样展示
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (el.exprInput) { el.exprInput.setAttribute('aria-invalid', 'true'); }
      updateHint(null);
      scheduleFit();
      return false;
    }
    clearError();
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
  /** 把外部来源（uTools 子输入框、历史恢复、指令带入）的文字同步进窗口里的输入框 */
  function syncExprInput(text) {
    if (!el.exprInput) { return; }
    if (document.activeElement === el.exprInput) { return; }
    el.exprInput.value = text == null ? '' : String(text);
  }

  // 关键：值/位宽必须在此刻快照。早先在 flush 时才读 store.value，
  // 于是「输入 0x40 → 900ms 内按 Ctrl+Z」会把历史里的 0x40 记成撤销后的值。
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
    if (histOpen) { renderHistory(); }
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

  function openHistory() {
    if (!el.specPanel.hidden) { closeSpec(); }
    flushHistory();
    histOpen = true;
    el.historyPanel.hidden = false;
    el.historyBtn.setAttribute('aria-expanded', 'true');
    renderHistory();
    el.historyList.focus();
    scheduleFit();
  }

  function closeHistory() {
    histOpen = false;
    el.historyPanel.hidden = true;
    el.historyBtn.setAttribute('aria-expanded', 'false');
    scheduleFit();
  }

  function toggleHistory() {
    if (histOpen) { closeHistory(); } else { openHistory(); }
  }

  function applyHistory(idx) {
    var entry = (S ? S.historyList() : [])[idx];
    if (!entry) { return; }
    syncExprInput(entry.expr);
    var ok = applyExpression(entry.expr, { silent: true });
    if (!ok) {
      // 表达式现在解析不了了（比如输入法残留），退回记录时的值，至少不丢数据
      lastError = '';
      if (store.value !== clampU(BigInt(entry.value || '0'))) { pushUndo(); }
      store.value = clampU(BigInt(entry.value || '0'));
      store.sel = clampSel(store.sel);
      render();
    }
    toast('已恢复 ' + entry.expr);
    closeHistory();
  }

  // ---------- 字段定义 ----------
  function setSpecMsg(text, kind) {
    el.specMsg.textContent = text;
    el.specMsg.className = 'spec-msg' + (kind ? ' ' + kind : '');
  }

  /** 边写边校验：错误一句话讲清（行号 + 原因），能应用时顺带报字段数与占位 */
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
    // 写超了就是错误：位段超出当前位宽时不肯应用，并直接告诉用户该切到多少位。
    // 不这么做的话，定义能"成功"存下来，字段却永远读 0，看起来像数据丢了。
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
    // 用户手点「应用」时再兜一层：边写边校验只是提示，真正落库前必须拦住
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
    if (histOpen) { closeHistory(); }
    el.specPanel.hidden = false;
    el.specText.value = specText || (S ? S.getSpec() : '') || '';
    renderSchemes();
    hideSchemeForm();
    validateSpec(el.specText.value);
    el.specText.focus();
    var n = el.specText.value.length;
    try { el.specText.setSelectionRange(n, n); } catch (err) { /* 忽略 */ }
    scheduleFit();
  }

  function closeSpec() {
    el.specPanel.hidden = true;
    el.specText.removeAttribute('aria-invalid');
    hideSchemeForm();
    scheduleFit();
  }

  function setMode(next) {
    if (next !== 'bits' && next !== 'proto') { return; }
    mode = next;
    cancelFlash();
    [].forEach.call(el.modeTabs.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    el.fieldPanel.hidden = mode !== 'proto';
    if (mode === 'proto') {
      if (!specText && S) { specText = S.getSpec(); }
      if (specText && PB) { parseAndApply(specText, true); }
      render();
      if (!fields.length && PB) { openSpec(); }
    } else {
      closeSpec();
      render();
    }
    saveSettings();
  }

  // ---------- 事件 ----------
  function wire() {
    el.modeTabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (b) { setMode(b.dataset.mode); }
    });

    el.widthSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-w]');
      if (b) { setWidth(Number(b.dataset.w)); }
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
    });

    el.clearBtn.addEventListener('click', clearSelection);
    el.fieldChip.addEventListener('click', clearSelection);

    el.valDec.addEventListener('click', function () {
      var u = clampU(store.value);
      var scoped = store.sel !== null;
      var w = scoped ? store.sel.end - store.sel.start + 1 : store.width;
      var v = scoped ? extractRange(u, store.sel.start, w) : u;
      // 复制的是眼前这串字符：切到 HEX 时还复制十进制会让人以为复制错了
      if (store.base === 'hex') { copy(formatHex(v, w), 'HEX'); return; }
      if (store.base === 'oct') { copy(formatOct(v), 'OCT'); return; }
      copy((store.signed ? BigInt.asIntN(w, v) : v).toString(), 'DEC');
    });

    if (el.baseSwitch) {
      el.baseSwitch.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-base]');
        if (!b || BASES.indexOf(b.dataset.base) < 0) { return; }
        store.base = b.dataset.base;
        saveSettings();
        render();
      });
    }

    el.valHex.addEventListener('click', function () {
      var u = clampU(store.value);
      var scoped = store.sel !== null;
      var w = scoped ? store.sel.end - store.sel.start + 1 : store.width;
      var v = scoped ? extractRange(u, store.sel.start, w) : u;
      copy(formatHex(v, w), 'HEX');
    });

    el.readouts.addEventListener('click', function (e) {
      var row = e.target.closest('.row');
      if (!row || row.hidden) { return; }
      var u = clampU(store.value);
      if (row.dataset.base === 'oct') { copy(formatOct(u), 'OCT'); }
      if (row.dataset.base === 'bin') { copy(formatBin(u, store.width).replace(/ /g, ''), 'BIN'); }
      if (row.dataset.base === 'float') {
        var fl = readFloat(u, store.width);
        if (fl) { copy(String(fl.value), fl.label); }
      }
    });

    // ---------- 历史记录 ----------
    el.historyBtn.addEventListener('click', toggleHistory);
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

    // 点浮层以外的地方关掉它（uTools 里点子输入框也算"外面"）
    document.addEventListener('pointerdown', function (e) {
      if (!histOpen) { return; }
      if (el.historyPanel.contains(e.target) || el.historyBtn.contains(e.target)) { return; }
      closeHistory();
    });

    // ---------- 字段定义 ----------
    el.fieldEditBtn.addEventListener('click', openSpec);
    el.fieldPanel.querySelector('.fields-head').addEventListener('click', function (e) {
      if (e.target.closest('button')) { return; }
      openSpec();
    });

    el.specCancel.addEventListener('click', closeSpec);
    el.specSave.addEventListener('click', function () {
      if (parseAndApply(el.specText.value, false)) {
        closeSpec();
        if (!fields.length) { toast('已清空字段'); return; }
        var ov = PB && PB.overlaps ? PB.overlaps(fields).length : 0;
        // 重叠不阻止应用（有人故意用重叠字段看多个视图），但必须说一句，否则重叠的位会悄悄算两遍
        if (ov) { toast('已应用 ' + fields.length + ' 个字段 · ' + ov + ' 处重叠', 'warn'); }
        else { toast('已应用 ' + fields.length + ' 个字段'); }
      }
    });

    el.specHelpToggle.addEventListener('click', function () {
      var open = el.specHelp.hidden;
      el.specHelp.hidden = !open;
      el.specHelpToggle.setAttribute('aria-expanded', String(open));
    });

    // 示例：只填编辑框，不直接生效。用户要按「应用」才替换现有字段，
    // 按「取消」则原文与被应用的字段都不受影响（textarea 每次打开都从 specText 重填）。
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

    // ---------- 方案 ----------
    el.schemeSelect.addEventListener('change', syncSchemeButtons);
    el.schemeLoad.addEventListener('click', loadScheme);
    el.schemeSave.addEventListener('click', showSchemeForm);
    el.schemeDel.addEventListener('click', deleteScheme);
    el.schemeNameOk.addEventListener('click', commitScheme);
    el.schemeNameCancel.addEventListener('click', hideSchemeForm);
    el.schemeName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitScheme(); }
    });

    // ---------- 字段表 ----------
    el.fieldBody.addEventListener('click', function (e) {
      var row = e.target.closest('.field-row');
      if (!row) { return; }
      var idx = Number(row.dataset.idx);
      var f = fields[idx];
      if (!f) { return; }
      // 点「值」那一格 = 就地改值；点名字/位段 = 选中（两件事在同一行上，位置区分最省认知）
      if (e.target.closest('.field-row-val')) {
        startFieldEdit(idx);
        return;
      }
      if (store.sel && store.sel.start === f.start && store.sel.end === f.end) {
        clearSelection();
      } else {
        selectField(idx);
      }
    });

    el.fieldBody.addEventListener('dblclick', function (e) {
      if (e.target.closest('.field-row-val')) { return; } // 值那一格归「改值」用
      var row = e.target.closest('.field-row');
      if (!row) { return; }
      var f = fields[Number(row.dataset.idx)];
      if (!f) { return; }
      var w = fieldWidth(f);
      var v = extractRange(clampU(store.value), f.start, w);
      copy('0x' + hexDigits(v, w), f.name);
    });

    el.fieldBody.addEventListener('pointerover', function (e) {
      var row = e.target.closest('.field-row');
      if (!row) { return; }
      var f = fields[Number(row.dataset.idx)];
      if (!f || hoverField === f) { return; }
      hoverField = f;
      paintRows();
      pushGridState();
    });

    el.fieldBody.addEventListener('pointerleave', function () {
      hoverField = null;
      paintRows();
      pushGridState();
    });

    el.fieldBody.addEventListener('keydown', function (e) {
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

    // ---------- 全局快捷键 ----------
    // 注意：Esc 归 uTools（它是退出插件），窗口里一律不接 Esc。
    // 早先用 Esc 清选区/关浮层，结果用户一按插件就退了，看起来像"按 Esc 崩溃"。
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var tag = t && t.tagName ? t.tagName : '';
      var inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        var k = String(e.key || '').toLowerCase();
        if (k === 'h') { e.preventDefault(); toggleHistory(); return; }
        if (k === 'z' && !inField) { e.preventDefault(); undo(); return; }
        if (k === 'enter' && t === el.specText) { e.preventDefault(); el.specSave.click(); return; }
      }

      // Delete / Backspace 取消选区：替掉原来的 Esc，且这两个键在 uTools 里没有别的含义
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField && store.sel) {
        e.preventDefault();
        clearSelection();
      }
    });

    // 点历史浮层外面收起它（浮层上没有关闭按钮，Esc 又不能用）
    document.addEventListener('pointerdown', function (e) {
      if (!histOpen) { return; }
      if (el.historyPanel.contains(e.target) || el.historyBtn.contains(e.target)) { return; }
      closeHistory();
    });

    // 表达式输入常驻在窗口里：Enter / 「计算」立刻求值；打字时 200ms 防抖跟随。
    // 早先只靠 uTools 子输入框（搜索栏），换到新布局后用户找不到在哪算。
    var exprTimer = 0;
    function runExpr() {
      clearTimeout(exprTimer);
      return applyExpression(el.exprInput.value);
    }
    el.exprInput.addEventListener('input', function () {
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
    el.exprGo.addEventListener('click', function () {
      runExpr();
      el.exprInput.focus();
    });

    window.addEventListener('resize', function () { scheduleFit(); });
  }

  // ---------- 进入插件 ----------
  function handleEnter(action) {
    if (!action) { return; }
    // 功能指令（type = "text"）的 payload 是命令名本身（就是 "bitcalc"）。
    // 早先这里不分类型，一律把 payload 当表达式求值，于是从关键字进入会报
    // 「未知函数或标识符 "bitcalc"（位置 0）」——这是本次修的第一个 bug。
    if (action.type === 'text') { return; }
    // 图片 / 多文件拖入拿不到能算的东西，直接忽略，别在状态行里留下一句莫名其妙的报错
    if (action.type === 'img' || action.type === 'files') { return; }
    var payload = action.payload == null ? '' : String(action.payload).trim();
    if (!payload) { return; }
    syncExprInput(payload);
    applyExpression(payload);
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
      onCommitRange: function (start, end) {
        setSelection({ start: start, end: end });
      },
      onClearSelection: clearSelection,
      onHoverBit: function (pos) {
        if (pos === null) {
          if (hoverField) { hoverField = null; paintRows(); pushGridState(); }
          updateHint(null);
          return;
        }
        var idx = fieldAt(pos);
        var f = idx >= 0 ? fields[idx] : null;
        if (f !== hoverField) {
          hoverField = f;
          paintRows();
          pushGridState();
        }
        updateHint(pos);
      }
    });

    // 浏览器预览：#utools 假装自己在 uTools 里（隐藏调试输入框、按内容高度定窗口）
    var preview = location.hash.indexOf('utools') >= 0;
    if (ut || preview) {
      document.body.classList.remove('no-utools');
    } else {
      document.body.classList.add('no-utools');
    }

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
          if (histOpen) { closeHistory(); }
          if (!el.specPanel.hidden) { closeSpec(); }
        });
      }
      if (ut.setSubInput) {
        ut.setSubInput(function (action) {
          var text = action && action.text;
          syncExprInput(text);
          applyExpression(text);
        }, '表达式与数值：0xFF、1<<8 | 3、pow(2,16)', true);
      }
    }

    var startMode = settings.mode === 'proto' || location.hash.indexOf('proto') >= 0 ? 'proto' : 'bits';
    setMode(startMode);
    render();
    scheduleFit();

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { scheduleFit(); });
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

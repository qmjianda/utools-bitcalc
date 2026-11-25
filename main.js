/**
 * main.js — 状态、显示、交互装配
 *
 * 分工：
 *   parser.js  表达式 → BigInt（纯函数，可单测）
 *   grid.js    位网格渲染 + 拖动选位域（纯几何函数可单测）
 *   proto.js   协议字段定义文本 → 字段表 + 解码（纯函数，可单测）
 *   main.js    以上三者的粘合层：状态机、格式化、DOM 事件、窗口高度
 *
 * 交互主轴（对应参考项目 BitCalc 的「选择部分 bit 显示值」）：
 *   拖选一段 bit → 主数值区立刻变成这一段的值（右移到 bit0），
 *   点字段表某行 → 等价于选中那段 bit；右键 / Esc / 点 chip 取消。
 */
(function () {
  'use strict';

  var P = window.BitCalcParser;
  var G = window.BitCalcGrid;
  var PB = window.BitCalcProto || null;
  var ut = window.utools || null;

  var $ = function (sel) { return document.querySelector(sel); };

  // 网格几何常量，必须与 style.css 的 grid-auto-rows / gap 保持一致
  var ROW_H = 28;
  var CELL_GAP = 3;

  var STACK_GAP = 8;      // .wrap 的纵向 gap，与 style.css 一致
  var PAD_TOP = 8;
  var PAD_BOTTOM = 10;

  var SPEC_KEY = 'bitcalc.fields.v1';

  // ---------- 元素 ----------
  var el = {
    hint: $('#hint'),
    modeTabs: $('#mode-tabs'),
    widthSeg: $('#width-seg'),
    signedChk: $('#signed-chk'),
    endianBtn: $('#endian-btn'),
    clearBtn: $('#clear-btn'),
    valDec: $('#val-dec'),
    valHex: $('#val-hex'),
    fieldChip: $('#field-chip'),
    stage: $('#stage'),
    gridRoot: $('#grid'),
    fieldPanel: $('#field-panel'),
    fieldBody: $('#field-body'),
    fieldEditBtn: $('#field-edit-btn'),
    specPanel: $('#spec-panel'),
    specText: $('#spec-text'),
    specMsg: $('#spec-msg'),
    specCancel: $('#spec-cancel'),
    specSave: $('#spec-save'),
    readouts: $('#readouts'),
    valOct: $('#val-oct'),
    valBin: $('#val-bin'),
    valFloat: $('#val-float'),
    floatName: $('#float-name'),
    rowFloat: $('#row-float'),
    toast: $('#toast'),
    fallback: $('.fallback'),
    fallbackInput: $('#fallback-expr')
  };

  // ---------- 状态 ----------
  var store = {
    value: 0n,        // 恒按 64 位无符号存放
    sel: null,        // { start, end } 闭区间，start <= end
    signed: false,
    width: 64,
    le: false
  };
  var mode = 'bits';            // 'bits' | 'proto'
  var fields = [];              // [{ name, start, end }]
  var activeIdx = -1;           // 字段表里选中的行
  var hoverField = null;        // 悬停中的字段（网格 ↔ 表联动）
  var specText = '';            // 字段定义原文
  var rowEls = [];              // 字段表行元素
  var lastError = '';
  var grid = null;

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

  /** HEX：<=16 位连着写；更宽按 4 位十六进制（16 bit）空格分组；小端时先按字节反序 */
  function formatHex(u, width) {
    var v = store.le ? bswapWidth(u, width) : u;
    var s = hexDigits(v, width);
    if (width <= 16) { return '0x' + s; }
    var out = [];
    for (var i = 0; i < s.length; i += 4) { out.push(s.slice(i, i + 4)); }
    return '0x' + out.join(' ');
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
    return mode === 'proto' ? '点字段行选中位域 · 拖动可选任意位段' : '点击翻转位 · 拖动选位域';
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

  function updateHint(hoverPos) {
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
  }

  // ---------- 渲染 ----------
  function render() {
    var u = clampU(store.value);
    var scoped = store.sel !== null;
    var fw = scoped ? (store.sel.end - store.sel.start + 1) : store.width;
    var fv = scoped ? extractRange(u, store.sel.start, fw) : u;

    el.valDec.textContent = formatDec(fv, fw);
    el.valDec.className = 'disp-val' + (scoped ? ' scoped' : '');
    el.valHex.textContent = formatHex(fv, fw);

    if (scoped) {
      var f = findField(store.sel.start, store.sel.end);
      el.fieldChip.hidden = false;
      el.fieldChip.textContent = (f ? f.name + ' ' : '') + store.sel.end + ':' + store.sel.start;
    } else {
      el.fieldChip.hidden = true;
    }

    el.valOct.textContent = formatOct(u);
    el.valBin.textContent = formatBin(u, store.width);

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
    scheduleFit();
  }

  function renderFields(u) {
    rowEls = [];
    el.fieldBody.textContent = '';
    if (!fields.length) {
      var empty = document.createElement('div');
      empty.className = 'fields-empty';
      empty.textContent = '还没有字段定义。点右上「定义…」按行写字段，例如 mode:3。';
      el.fieldBody.appendChild(empty);
      return;
    }
    fields.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'field-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.dataset.idx = String(i);

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
      val.title = decv.toString() + ' · ' + w + ' 位';

      row.appendChild(name);
      row.appendChild(range);
      row.appendChild(val);
      el.fieldBody.appendChild(row);
      rowEls.push(row);
    });
  }

  /** 只切换行的选中/悬停态，不重建行（重建会打断 hover） */
  function paintRows() {
    var hi = hoverField ? fields.indexOf(hoverField) : -1;
    rowEls.forEach(function (row, i) {
      row.setAttribute('aria-selected', String(i === activeIdx));
      row.style.background = (i === hi && i !== activeIdx) ? 'var(--hover)' : '';
    });
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
  var fitRaf = 0;
  function scheduleFit() {
    if (fitRaf) { return; }
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      fitHeight();
    });
  }

  function measureHeight() {
    var shape = G.gridShape(store.width);
    var gridH = shape.rows * ROW_H + (shape.rows - 1) * CELL_GAP;
    var h = PAD_TOP +
      $('.bar').offsetHeight + STACK_GAP +
      $('.display').offsetHeight + STACK_GAP +
      gridH + STACK_GAP +
      el.readouts.offsetHeight + PAD_BOTTOM;
    if (document.body.classList.contains('no-utools')) {
      h += STACK_GAP + el.fallback.offsetHeight;
    }
    return Math.ceil(h);
  }

  function fitHeight() {
    var h = measureHeight();
    document.documentElement.style.height = h + 'px';
    document.body.style.height = h + 'px';
    $('.wrap').style.height = h + 'px';
    if (ut && ut.setExpandHeight) {
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
    store.sel = clampSel(sel);
    activeIdx = -1;
    if (store.sel) {
      var f = findField(store.sel.start, store.sel.end);
      if (f) { activeIdx = fields.indexOf(f); }
    }
    render();
  }

  function clearSelection() {
    store.sel = null;
    activeIdx = -1;
    render();
  }

  function setWidth(w) {
    store.width = w;
    // 位宽变小时，越界的选区直接清掉，而不是夹到最高位——
    // 夹出来的「位 7–7」是用户没选过的，比没有选区更误导。
    if (store.sel && store.sel.end >= w) { store.sel = null; } else { store.sel = clampSel(store.sel); }
    if (activeIdx >= 0 && fields[activeIdx].end >= w) { activeIdx = -1; }
    // 按位宽写法的字段要从新的最高位重新铺开，所以位宽变化后要重新解析
    if (specText && PB) { parseAndApply(specText, true); }
    render();
  }

  // ---------- 反馈 ----------
  var toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 1200);
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

  function applyExpression(text) {
    var src = String(text || '').trim();
    if (!src) {
      lastError = '';
      store.value = 0n;
      store.sel = clampSel(store.sel);
      render();
      return;
    }
    var v;
    try {
      v = P.parse(src);          // parser.js 出错直接 throw，中文消息可原样展示
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      updateHint(null);
      return;
    }
    lastError = '';
    if (store.sel) {
      var w = store.sel.end - store.sel.start + 1;
      store.value = writeRange(store.value, store.sel.start, w, v);
    } else {
      store.value = P.toUint64(v);
    }
    store.sel = clampSel(store.sel);
    render();
  }

  // ---------- 字段定义 ----------
  function loadSpec() {
    try { return localStorage.getItem(SPEC_KEY) || ''; } catch (err) { return ''; }
  }

  function saveSpec(text) {
    try { localStorage.setItem(SPEC_KEY, text); } catch (err) { /* 忽略配额错误 */ }
  }

  function parseAndApply(text, quiet) {
    if (!PB) {
      el.specMsg.textContent = 'proto.js 未加载';
      el.specMsg.className = 'spec-msg';
      return false;
    }
    var res = PB.parseSpec(text, store.width);
    if (res.errors && res.errors.length) {
      var e = res.errors[0];
      var more = res.errors.length > 1 ? '（共 ' + res.errors.length + ' 处）' : '';
      el.specMsg.textContent = '第 ' + e.line + ' 行：' + e.message + more;
      el.specMsg.className = 'spec-msg';
      return false;
    }
    fields = res.fields || [];
    activeIdx = store.sel ? fields.indexOf(findField(store.sel.start, store.sel.end)) : -1;
    specText = text;
    saveSpec(text);
    if (!quiet) {
      el.specMsg.textContent = fields.length ? fields.length + ' 个字段' : '';
      el.specMsg.className = 'spec-msg ok';
      render();
    }
    return true;
  }

  function openSpec() {
    el.specPanel.hidden = false;
    el.specText.value = specText || loadSpec();
    el.specMsg.textContent = '';
    el.specMsg.className = 'spec-msg';
    el.specText.focus();
  }

  function closeSpec() {
    el.specPanel.hidden = true;
  }

  function setMode(next) {
    mode = next;
    [].forEach.call(el.modeTabs.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    el.fieldPanel.hidden = mode !== 'proto';
    if (mode === 'proto') {
      if (!specText) { specText = loadSpec(); }
      if (specText && PB) { parseAndApply(specText, true); }
      if (!fields.length && PB) { openSpec(); }
    }
    render();
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
      store.signed = el.signedChk.checked;
      render();
    });

    el.endianBtn.addEventListener('click', function () {
      store.le = !store.le;
      render();
    });

    el.clearBtn.addEventListener('click', clearSelection);
    el.fieldChip.addEventListener('click', clearSelection);

    el.valDec.addEventListener('click', function () {
      var u = clampU(store.value);
      var scoped = store.sel !== null;
      var w = scoped ? store.sel.end - store.sel.start + 1 : store.width;
      var v = scoped ? extractRange(u, store.sel.start, w) : u;
      copy((store.signed ? BigInt.asIntN(w, v) : v).toString(), 'DEC');
    });

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

    el.fieldEditBtn.addEventListener('click', openSpec);
    el.specCancel.addEventListener('click', closeSpec);
    el.specSave.addEventListener('click', function () {
      if (parseAndApply(el.specText.value, false)) { closeSpec(); }
    });
    el.specText.addEventListener('input', function () {
      el.specMsg.textContent = '';
    });

    el.fieldBody.addEventListener('click', function (e) {
      var row = e.target.closest('.field-row');
      if (!row) { return; }
      var f = fields[Number(row.dataset.idx)];
      if (!f) { return; }
      if (store.sel && store.sel.start === f.start && store.sel.end === f.end) {
        clearSelection();
      } else {
        setSelection({ start: f.start, end: f.end });
      }
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

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') { return; }
      if (!el.specPanel.hidden) { closeSpec(); return; }
      if (store.sel) { clearSelection(); }
    });

    // 调试/浏览器预览用：uTools 里该输入框 display:none，输入由子输入框驱动
    var exprTimer = 0;
    el.fallbackInput.addEventListener('input', function () {
      clearTimeout(exprTimer);
      var v = el.fallbackInput.value;
      exprTimer = setTimeout(function () { applyExpression(v); }, 60);
    });
  }

  // ---------- 启动 ----------
  function boot() {
    if (!P) { throw new Error('parser.js 未加载'); }
    if (!G) { throw new Error('grid.js 未加载'); }

    specText = loadSpec();
    if (specText && PB) { parseAndApply(specText, true); }

    wire();

    grid = G.init({
      root: '#grid',
      onToggleBit: function (pos) {
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
          if (action && action.payload) {
            var p = String(action.payload).trim();
            if (/^0x[0-9a-f]+$/i.test(p) || /^\d+$/.test(p)) {
              lastError = '';
              store.value = clampU(BigInt(p));
              render();
            } else {
              applyExpression(p);
            }
          }
          fitHeight();
        });
      }
      if (ut.setSubInput) {
        ut.setSubInput(function (action) {
          applyExpression(action && action.text);
        }, '输入表达式，如 1<<8 | 0xFF、pow(2,16)、~0', true);
      }
    }

    setMode(location.hash.indexOf('proto') >= 0 ? 'proto' : 'bits');
    render();
    scheduleFit();
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

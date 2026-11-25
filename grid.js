/**
 * grid.js — bit 网格渲染与拖动位域选择
 *
 * 数值逻辑 1:1 移植自参考项目 BitCalc（Python/PyQt5，只读参考）：
 *   - 使能 mask 计算（bh_grid.py:73-76 set_enabled）：
 *       mask = 0xFFFFFFFFFFFFFFFF
 *       mask &= ~((1 << start) - 1)
 *       mask &= (1 << (end + 1)) - 1
 *   - 位域组合值提取（bh_grid.py:44-45 val()）：(value & mask) >> start
 *   - 拖动状态机（bh_grid.py:109-140）：左键按下开始 → 移动实时预览 → 松开锁定范围
 *   - 右键清除位域选择（bh_grid.py:110-112）；ESC 清除由 main.js 监听（对应 bh_window.py:46-48）
 *   - 布局（bh_grid.py:19-25）：每行 16 位、4 位一组，bit 0 在右下、最高位在左上，组内高位在左
 *
 * 渲染/事件层用 DOM 重写：CSS Grid + Pointer Events + setPointerCapture。
 *
 * 位宽（8/16/32/64）决定网格实际画多少格：只画当前位宽需要的位，不画"灰掉的其余位"。
 * 理由：64 位时自觉是画布，8 位时那 56 个灰零就是纯噪音；宁可让窗口跟着变矮。
 *
 * 纯函数（bitPosAt / computeMask / extractField / normalizeRange / rangeSegments）不依赖 DOM，
 * 可在 Node 中 require 后单测；init() 只在浏览器中挂载 DOM 与事件。
 */
(function (root, factory) {
  var api = factory();
  // 无条件挂到全局：uTools 页面可能存在 module 对象，不能靠 if/else 二选一，
  // 否则全局变量缺失会让 main.js 静默抛错、整页只剩静态 HTML（已踩过一次）。
  if (root) {
    root.BitCalcGrid = api;
  }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var NBITS = 64;              // 值本身恒按 64 位存放
  var MAX_COLS = 16;           // 每行最多 16 位（4 nibble）
  var CLICK_THRESHOLD_PX = 3;  // 移动距离 < 3px 视为单击（规格：单击翻转 bit）

  // ---------- 纯函数（与 DOM 无关，可在 Node 单测） ----------

  /**
   * 网格坐标 (row, col) → bit 位号。大端视觉：左上 = 最高位，右下 = bit 0。
   * @param {number} row 行
   * @param {number} col 列
   * @param {number} [width] 位宽，默认 64；cols = min(16, width)
   */
  function bitPosAt(row, col, width) {
    var w = width || NBITS;
    var cols = Math.min(MAX_COLS, w);
    return w - 1 - (row * cols + col);
  }

  /** 位域使能 mask（bh_grid.py:73-76 的 1:1 移植，BigInt 版） */
  function computeMask(start, end) {
    var mask = 0xFFFFFFFFFFFFFFFFn;
    mask &= ~((1n << BigInt(start)) - 1n);
    mask &= (1n << (BigInt(end) + 1n)) - 1n;
    return mask;
  }

  /** 提取位域组合值：(value & mask) >> start（bh_grid.py:44-45 的 val() 语义） */
  function extractField(value, start, end) {
    return (BigInt.asUintN(64, value) & computeMask(start, end)) >> BigInt(start);
  }

  /** 拖动起止归一化：保证 start <= end（bh_grid.py:135-136 的 min/max） */
  function normalizeRange(a, b) {
    return { start: a < b ? a : b, end: a < b ? b : a };
  }

  /** 位宽对应的网格列数 / 行数：8→1×8，16→1×16，32→2×16，64→4×16 */
  function gridShape(width) {
    var cols = Math.min(MAX_COLS, width);
    return { cols: cols, rows: Math.ceil(width / cols) };
  }

  /**
   * 把连续位段拆成「每行一段」的视觉区间。
   * 位号是跨行连续的，但几何不是：0–16 在 32/64 位下跨越两行，
   * 必须分别框住「16」和「15–0」，不能用两个端点画一个又高又窄的矩形。
   * @returns {Array<{row:number,start:number,end:number}>} 按位号从低到高
   */
  function rangeSegments(start, end, width) {
    var w = width || NBITS;
    var lo = Math.max(0, Math.min(start, end));
    var hi = Math.min(w - 1, Math.max(start, end));
    if (hi < lo) { return []; }
    var cols = Math.min(MAX_COLS, w);
    var out = [];
    for (var pos = lo; pos <= hi;) {
      var row = Math.floor((w - 1 - pos) / cols);
      var rowHigh = w - 1 - row * cols;
      var segHigh = Math.min(hi, rowHigh);
      out.push({ row: row, start: pos, end: segHigh });
      pos = segHigh + 1;
    }
    return out;
  }

  // ---------- DOM 渲染与交互（仅浏览器） ----------

  /**
   * 初始化网格。
   * @param {string|Element|object} opts.root 网格容器（如 '#grid'）
   * @param {Function} opts.onToggleBit      单击翻转回调 (pos: number) => void
   * @param {Function} opts.onCommitRange    拖动落定回调 (start: number, end: number) => void
   * @param {Function} opts.onClearSelection 清除位域选择回调 () => void
   * @param {Function} opts.onHoverBit       悬停位号回调 (pos|null) => void
   * @returns {{ setState: Function }} setState({ value, sel, width }) 重渲染
   */
  function init(opts, extra) {
    if (typeof document === 'undefined') {
      throw new Error('grid.init 只能在浏览器环境调用');
    }
    // 兼容两种调用形态：init({root, ...}) 与 init('#grid', {...})，
    // 避免调用方传错形态时静默抛错（已踩过一次，见 main.js 注释）。
    if (typeof opts === 'string' || (opts && typeof opts.nodeType === 'number')) {
      opts = Object.assign({ root: opts }, extra || {});
    }
    opts = opts || {};
    var rootEl = typeof opts.root === 'string' ? document.querySelector(opts.root) : opts.root;
    if (!rootEl) { throw new Error('网格容器不存在: ' + opts.root); }

    var onToggleBit = opts.onToggleBit || function () {};
    var onCommitRange = opts.onCommitRange || function () {};
    var onClearSelection = opts.onClearSelection || function () {};
    var onHoverBit = opts.onHoverBit || function () {};
    var onSetBit = opts.onSetBit || function (pos, bit) { if (bit) { onToggleBit(pos); } };

    // field：协议字段悬停时的高亮范围 {start,end}|null；字段颜色由 fieldColor 传入
    // （不把字段色常驻在格子上，避免 4bit 区域变花）
    var state = { value: 0n, sel: null, width: NBITS, field: null, fieldColor: '' };
    var drag = null;       // { pointerId, startPos, currentPos, startX, startY, moved }
    var hoverNib = -1;     // 当前悬停的 nibble 序号，-1 表示无
    var builtWidth = 0;    // 已建好的网格位宽，0 表示尚未构建
    var cursor = -1;       // 键盘光标位号，-1 表示网格未聚焦
    var anchor = -1;       // Shift+方向键的锚点

    var gridEl = document.createElement('div');
    gridEl.className = 'grid';
    rootEl.appendChild(gridEl);

    var cells = [];    // cells[pos] = 格子元素
    var valSpans = []; // valSpans[pos] = 位值元素
    var selFrames = [];    // 选中位域：每行一个实线外框
    var dragFrames = [];   // 拖动预览：每行一个虚线外框
    var frameRaf = 0;

    // ---- 按位宽重建格子 ----
    // 每个 nibble 是 4 格，nibble 内 2px、nibble 间 8px，字节边界再多 5px。
    // 这些间距全在 CSS 里；这里只负责行/组/格的 DOM 结构。
    function build(width) {
      var shape = gridShape(width);
      builtWidth = width;
      cells = new Array(width);
      valSpans = new Array(width);
      hoverNib = -1;
      if (cursor >= width) { cursor = width - 1; }
      if (anchor >= width) { anchor = -1; }

      var nibbles = Math.ceil(shape.cols / 4);
      // 8 位时不要被 1fr 拉成一排巨格；64 位时上限大于容器，自然让位于容器实宽。
      // 与 CSS 的 2px 组内 / 8px 组间 / 5px 字节间距对应。
      var maxW = shape.cols * 38 + nibbles * 3 * 2 + Math.max(0, nibbles - 1) * 8 + (nibbles >= 3 ? 5 : 0);
      gridEl.style.maxWidth = maxW + 'px';
      // 与 style.css 的 32px 格高 / 8px 行距对应：让画布随位宽收紧，不再固定留一大块空白。
      // 变量要设在画布（网格的祖先）上，设在 #grid 上不会被 .canvas 的 min-height 继承。
      var canvasEl = rootEl.closest ? rootEl.closest('.canvas') : null;
      (canvasEl || rootEl).style.setProperty('--grid-height', (shape.rows * 32 + Math.max(0, shape.rows - 1) * 8) + 'px');

      gridEl.textContent = '';
      selFrames = [];
      dragFrames = [];
      var frag = document.createDocumentFragment();
      for (var r = 0; r < shape.rows; r++) {
        var rowEl = document.createElement('div');
        rowEl.className = 'bitrow';
        for (var n = 0; n < nibbles; n++) {
          var nibEl = document.createElement('div');
          nibEl.className = 'nibble';
          for (var j = 0; j < 4; j++) {
            var c = n * 4 + j;
            if (c >= shape.cols) { break; }
            var pos = bitPosAt(r, c, width);
            var cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.pos = String(pos);

            var valSpan = document.createElement('span');
            valSpan.className = 'val';
            valSpan.textContent = '0';
            cell.appendChild(valSpan);

            var numSpan = document.createElement('span');
            numSpan.className = 'bit';
            numSpan.textContent = String(pos);
            cell.appendChild(numSpan);

            nibEl.appendChild(cell);
            cells[pos] = cell;
            valSpans[pos] = valSpan;
          }
          rowEl.appendChild(nibEl);
        }
        frag.appendChild(rowEl);
      }
      gridEl.appendChild(frag);
    }

    // ---- 选中位域外框 ----
    // 一段位域里既有 1 又有 0 时，实心深色（1）和浅色（0）读起来是两种东西；
    // 按行分别套框，「这些位是一个整体」就是一条几何事实；跨行也不会画成端点矩形。
    function makeFrame(cls) {
      var el = document.createElement('div');
      el.className = cls;
      el.hidden = true;
      gridEl.appendChild(el);
      return el;
    }

    function placeOn(el, range) {
      if (!el) { return; }
      if (!range) { el.hidden = true; return; }
      var a = cells[range.start];
      var b = cells[range.end];
      if (!a || !b) { el.hidden = true; return; }
      var gr = gridEl.getBoundingClientRect();
      var ra = a.getBoundingClientRect();
      var rb = b.getBoundingClientRect();
      var left = Math.min(ra.left, rb.left) - gr.left;
      var top = Math.min(ra.top, rb.top) - gr.top;
      var right = Math.max(ra.right, rb.right) - gr.left;
      var bottom = Math.max(ra.bottom, rb.bottom) - gr.top;
      el.style.left = (left - 2) + 'px';
      el.style.top = (top - 2) + 'px';
      el.style.width = (right - left + 4) + 'px';
      el.style.height = (bottom - top + 4) + 'px';
      el.hidden = false;
    }

    function syncFrames(frames, cls, ranges) {
      while (frames.length < ranges.length) {
        frames.push(makeFrame(cls));
      }
      for (var i = 0; i < frames.length; i++) {
        placeOn(frames[i], i < ranges.length ? ranges[i] : null);
      }
    }

    function placeFrame() {
      var sel = state.sel ? rangeSegments(state.sel.start, state.sel.end, state.width) : [];
      var preview = drag ? rangeSegments(drag.startPos, drag.currentPos, state.width) : [];
      syncFrames(selFrames, 'sel-frame', sel);
      syncFrames(dragFrames, 'drag-frame', preview);
    }

    function scheduleFrame() {
      if (frameRaf) { return; }
      frameRaf = requestAnimationFrame(function () {
        frameRaf = 0;
        placeFrame();
      });
    }

    // ---- 命中检测：优先取指针下的格子；落在 3/4、字节或行间隙时按方向吸附 ----
    // 只按 elementFromPoint 会在 bit3↔bit4 的组间隙、以及跨行拖动松手时漏掉，
    // 用户看到的就是“选择失败”。间隙兜底把空隙也纳入拖选手势。
    function cellAtPoint(x, y, bias) {
      var hit = document.elementFromPoint(x, y);
      var cell = hit && hit.closest ? hit.closest('.cell') : null;
      if (cell && gridEl.contains(cell)) { return parseInt(cell.dataset.pos, 10); }

      var gr = gridEl.getBoundingClientRect();
      var slack = 12;
      if (x < gr.left - slack || x > gr.right + slack || y < gr.top - slack || y > gr.bottom + slack) {
        return null;
      }

      var best = null;
      var bestDist = Infinity;
      var bestProjection = -Infinity;
      var directional = !!bias && bias.dx * bias.dx + bias.dy * bias.dy >= 4;
      for (var pos = 0; pos < state.width; pos++) {
        var r = cells[pos].getBoundingClientRect();
        var dx = Math.max(r.left - x, 0, x - r.right);
        var dy = Math.max(r.top - y, 0, y - r.bottom);
        var dist = dx * dx + dy * dy;
        if (dist > slack * slack) { continue; }
        var projection = bias ? ((r.left + r.right) / 2 - bias.x) * bias.dx +
          ((r.top + r.bottom) / 2 - bias.y) * bias.dy : 0;
        // 有明确移动方向时，间隙归前方那一格：从 bit4 向右拖，刚进入 3/4 间隙
        // 就应选 bit3，而不是因为离 bit4 近 1px 又粘回起点。静止释放才按最近格。
        var better = best === null;
        if (!better && directional) {
          better = projection > bestProjection + 0.5 ||
            (Math.abs(projection - bestProjection) < 0.5 && dist < bestDist);
        } else if (!better) {
          better = dist < bestDist || (Math.abs(dist - bestDist) < 0.5 && projection > bestProjection);
        }
        if (better) {
          best = pos;
          bestDist = dist;
          bestProjection = projection;
        }
      }
      return best;
    }

    // ---- 渲染：值高亮 / 位域选中 / 拖动预览 ----
    function renderCells() {
      if (builtWidth !== state.width) { build(state.width); }
      var value = state.value;
      var sel = state.sel;
      var fld = state.field;
      var preview = drag ? normalizeRange(drag.startPos, drag.currentPos) : null;
      for (var pos = 0; pos < state.width; pos++) {
        var on = ((value >> BigInt(pos)) & 1n) === 1n;
        var inSel = sel !== null && pos >= sel.start && pos <= sel.end;
        var inDrag = preview !== null && pos >= preview.start && pos <= preview.end;
        var inNib = hoverNib >= 0 && Math.floor(pos / 4) === hoverNib;
        var inField = fld !== null && pos >= fld.start && pos <= fld.end;
        valSpans[pos].textContent = on ? '1' : '0';
        cells[pos].classList.toggle('on', on);
        cells[pos].classList.toggle('one', on);
        cells[pos].classList.toggle('sel', inSel);
        cells[pos].classList.toggle('drag', inDrag);
        cells[pos].classList.toggle('nib', inNib);
        cells[pos].classList.toggle('field', inField);
        cells[pos].classList.toggle('cursor', pos === cursor);
        if (inField && state.fieldColor) {
          cells[pos].style.setProperty('--fc', state.fieldColor);
        } else {
          cells[pos].style.removeProperty('--fc');
        }
      }
      scheduleFrame();
    }

    // 悬停在一位上时，把它所在的 4 位一组（一个十六进制位）整体点亮：
    // 让「这 4 个 bit 就是 HEX 的某一位」变成看得见的事实，不用讲。
    function setHoverNibble(pos) {
      var n = pos === null ? -1 : Math.floor(pos / 4);
      if (n === hoverNib) { return; }
      hoverNib = n;
      renderCells();
    }

    // ---- Pointer Events 拖动状态机（bh_grid.py:109-140 的 DOM 移植） ----
    gridEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; } // 只处理左键；右键走 contextmenu
      var cell = e.target && e.target.closest ? e.target.closest('.cell') : null;
      if (!cell || !gridEl.contains(cell)) { return; }
      e.preventDefault(); // 阻止文本选择/默认拖动
      var pos = parseInt(cell.dataset.pos, 10);
      cursor = pos;
      anchor = -1;
      try { rootEl.focus({ preventScroll: true }); } catch (err) { rootEl.focus(); }
      drag = {
        pointerId: e.pointerId,
        startPos: pos,
        currentPos: pos,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false
      };
      // Pointer Capture 让事件持续派发到起始格；window 上的 move/up 监听则兼容
      // 某些 Electron 版本捕获失败的情况。命中检测仍按真实指针坐标走。
      try {
        cell.setPointerCapture(e.pointerId);
      } catch (err) {
        // 捕获失败不阻塞
      }
      renderCells(); // 立即显示单格预览
    });

    window.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.pointerId) { return; }
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.moved && dx * dx + dy * dy >= CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX) {
        drag.moved = true;
      }
      var bias = { x: drag.lastX, y: drag.lastY, dx: e.clientX - drag.lastX, dy: e.clientY - drag.lastY };
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      var cellPos = cellAtPoint(e.clientX, e.clientY, bias);
      if (cellPos !== null && cellPos !== drag.currentPos) {
        drag.currentPos = cellPos;
        renderCells(); // 实时预览
      }
    });

    window.addEventListener('pointerup', function (e) {
      if (!drag || e.pointerId !== drag.pointerId) { return; }
      var d = drag;
      drag = null;
      // 松手时用整个手势的方向，而不是最后一帧方向：最后一帧可能已经停在间隙里。
      var bias = { x: d.startX, y: d.startY, dx: e.clientX - d.startX, dy: e.clientY - d.startY };
      var endPos = cellAtPoint(e.clientX, e.clientY, bias);
      var target = endPos !== null ? endPos : d.currentPos;
      if (!d.moved) {
        onToggleBit(d.startPos);   // 单击（移动 < 3px）→ 翻转 bit
      } else if (target !== null && (endPos !== null || target !== d.startPos)) {
        var rng = normalizeRange(d.startPos, target);
        onCommitRange(rng.start, rng.end); // 松手在间隙上也按拖动方向落定
      }
      renderCells(); // 清除预览高亮
    });

    window.addEventListener('pointercancel', function (e) {
      if (drag && e.pointerId === drag.pointerId) {
        drag = null;
        renderCells();
      }
    });

    // 右键清除位域选择（bh_grid.py:110-112）
    gridEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      onClearSelection();
    });

    gridEl.addEventListener('pointerover', function (e) {
      var cell = e.target && e.target.closest ? e.target.closest('.cell') : null;
      var pos = cell && gridEl.contains(cell) ? parseInt(cell.dataset.pos, 10) : null;
      setHoverNibble(pos);
      onHoverBit(pos);
    });
    gridEl.addEventListener('pointerleave', function () {
      setHoverNibble(null);
      onHoverBit(null);
    });

    // ---- 键盘：方向键移动光标，Shift+方向键扩选，空格翻转，Enter 选中一位 ----
    // 焦点在宿主 #grid 上（gridEl 本身不参与 tab 顺序），所以监听 rootEl。
    rootEl.addEventListener('focus', function () {
      if (cursor < 0) { cursor = state.sel ? state.sel.start : 0; }
      renderCells();
    });
    rootEl.addEventListener('blur', function () {
      cursor = -1;
      anchor = -1;
      renderCells();
    });
    rootEl.addEventListener('keydown', function (e) {
      var k = e.key;
      var cols = Math.min(MAX_COLS, state.width);
      var step = 0;
      // 视觉方向：bit0 在右下、最高位在左上
      if (k === 'ArrowLeft') { step = 1; }
      else if (k === 'ArrowRight') { step = -1; }
      else if (k === 'ArrowUp') { step = cols; }
      else if (k === 'ArrowDown') { step = -cols; }
      else if (k === 'Home') { cursor = state.width - 1; e.preventDefault(); renderCells(); return; }
      else if (k === 'End') { cursor = 0; e.preventDefault(); renderCells(); return; }
      else if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        if (cursor < 0) { cursor = state.sel ? state.sel.start : 0; }
        if (k === 'Enter') { onCommitRange(cursor, cursor); }
        else { onToggleBit(cursor); }
        return;
      } else if (k === '0' || k === '1') {
        e.preventDefault();
        if (cursor < 0) { cursor = state.sel ? state.sel.start : 0; }
        if (cursor >= 0 && cursor < state.width) { onSetBit(cursor, k === '1'); }
        return;
      } else {
        return;
      }
      e.preventDefault();
      if (cursor < 0) { cursor = state.sel ? state.sel.start : 0; }
      var next = cursor + step;
      if (next < 0) { next = 0; }
      if (next >= state.width) { next = state.width - 1; }
      if (e.shiftKey) {
        if (anchor < 0) { anchor = cursor; }
        cursor = next;
        onCommitRange(Math.min(anchor, cursor), Math.max(anchor, cursor));
      } else {
        anchor = -1;
        cursor = next;
        if (state.sel) { onClearSelection(); }
        renderCells();
      }
    });

    return {
      /** 外部状态同步：value 为 BigInt，sel 为 {start,end}|null，width 为 8/16/32/64，
       *  field 为协议模式下要高亮的字段范围 {start,end}|null */
      setState: function (next) {
        state.value = next.value;
        state.sel = next.sel || null;
        state.width = next.width || NBITS;
        state.field = next.field || null;
        state.fieldColor = next.fieldColor || '';
        renderCells();
      }
    };
  }

  return {
    init: init,
    bitPosAt: bitPosAt,
    computeMask: computeMask,
    extractField: extractField,
    normalizeRange: normalizeRange,
    gridShape: gridShape,
    rangeSegments: rangeSegments
  };
});

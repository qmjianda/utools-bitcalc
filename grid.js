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
 * 纯函数（bitPosAt / computeMask / extractField / normalizeRange）不依赖 DOM，
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

    // field：协议解析模式下当前高亮的字段范围 {start,end}|null（与 sel 独立，
    // 用于「悬停字段表某行 → 网格里对应 bit 段亮起」的双向联动）
    var state = { value: 0n, sel: null, width: NBITS, field: null };
    var drag = null;       // { pointerId, startPos, currentPos, startX, startY, moved }
    var hoverNib = -1;     // 当前悬停的 nibble 序号，-1 表示无
    var builtWidth = 0;    // 已建好的网格位宽，0 表示尚未构建

    var gridEl = document.createElement('div');
    gridEl.className = 'grid';
    rootEl.appendChild(gridEl);

    var cells = [];    // cells[pos] = 格子元素
    var valSpans = []; // valSpans[pos] = 位值元素
    var selFrame = null;   // 选中位域的实线外框
    var fieldFrame = null;  // 协议模式字段的虚线外框
    var frameRaf = 0;

    // ---- 按位宽重建格子 ----
    // 轨道编号（1 基）：每 4 格一组，组间由 10px 的 spacer 轨道分隔。
    // 列 c 的轨道 = c + 1 + floor(c / 4)；行 r 的轨道 = r + 1。
    function build(width) {
      var shape = gridShape(width);
      builtWidth = width;
      cells = new Array(width);
      valSpans = new Array(width);
      hoverNib = -1;

      var tracks = [];
      for (var g = 0; g < shape.cols / 4; g++) {
        if (g > 0) { tracks.push('10px'); }
        tracks.push('repeat(4, 1fr)');
      }
      gridEl.style.gridTemplateColumns = tracks.join(' ');
      // 每位给一个宽度上限（约 36px），整片网格的 max-width 按列数算：
      // 8 位时只有 8 列，若不封顶会被 1fr 拉成一排宽条；64 位时又可能撑破窗口。
      var groups = Math.ceil(shape.cols / 4);
      gridEl.style.maxWidth =
        (shape.cols * 36 + Math.max(0, groups - 1) * 10 + (shape.cols - 1) * 3) + 'px';

      gridEl.textContent = '';
      // 清空把两个外框一起删了，置空后下一帧 placeFrame 会重建
      selFrame = null;
      fieldFrame = null;
      var frag = document.createDocumentFragment();
      for (var r = 0; r < shape.rows; r++) {
        for (var c = 0; c < shape.cols; c++) {
          var pos = bitPosAt(r, c, width);
          var cell = document.createElement('div');
          cell.className = 'cell';
          cell.dataset.pos = String(pos);
          cell.style.gridRow = String(r + 1);
          cell.style.gridColumn = String(c + 1 + Math.floor(c / 4));

          var valSpan = document.createElement('span');
          valSpan.className = 'cell-val';
          valSpan.textContent = '0';
          cell.appendChild(valSpan);

          var numSpan = document.createElement('span');
          numSpan.className = 'cell-no';
          numSpan.textContent = String(pos);
          cell.appendChild(numSpan);

          frag.appendChild(cell);
          cells[pos] = cell;
          valSpans[pos] = valSpan;
        }
      }
      gridEl.appendChild(frag);
    }

    // ---- 位域外框 ----
    // 一段位域里既有 1 又有 0 时，实心蓝（1）和淡蓝（0）读起来是两种东西；
    // 外面套一个框，「这几位是一个整体」就变成一条几何事实，不用解释。
    // 两个框：选中的位域（实线）、协议模式里悬停/激活的字段（虚线）。
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

    function placeFrame() {
      if (!selFrame) { selFrame = makeFrame('sel-frame'); }
      if (!fieldFrame) { fieldFrame = makeFrame('field-frame'); }
      var fld = state.field;
      // 字段和选区是同一位域时，只画实线框，别叠两层
      if (fld && state.sel && fld.start === state.sel.start && fld.end === state.sel.end) {
        fld = null;
      }
      placeOn(selFrame, state.sel);
      placeOn(fieldFrame, fld);
    }

    function scheduleFrame() {
      if (frameRaf) { return; }
      frameRaf = requestAnimationFrame(function () {
        frameRaf = 0;
        placeFrame();
      });
    }

    // ---- 命中检测：读指针所在格子的 data-pos ----
    function cellAtPoint(x, y) {
      // elementFromPoint 可能返回格子内部子元素（如位号 label），closest 回退到格子
      var el = document.elementFromPoint(x, y);
      var cell = el && el.closest ? el.closest('.cell') : null;
      if (!cell || !gridEl.contains(cell)) { return null; }
      return parseInt(cell.dataset.pos, 10);
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
        cells[pos].classList.toggle('sel', inSel);
        cells[pos].classList.toggle('drag', inDrag);
        cells[pos].classList.toggle('nib', inNib);
        cells[pos].classList.toggle('field', inField);
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
      drag = {
        pointerId: e.pointerId,
        startPos: pos,
        currentPos: pos,
        startX: e.clientX,
        startY: e.clientY,
        moved: false
      };
      // 【待实测】Pointer Capture：捕获后 pointer 事件持续派发到起始格（并经冒泡到 gridEl）。
      // move 时的命中检测用 document.elementFromPoint，不受捕获影响。
      try {
        cell.setPointerCapture(e.pointerId);
      } catch (err) {
        // 捕获失败不阻塞：事件仍冒泡到 gridEl
      }
      renderCells(); // 立即显示单格预览
    });

    gridEl.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.pointerId) { return; }
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.moved && dx * dx + dy * dy >= CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX) {
        drag.moved = true;
      }
      var cellPos = cellAtPoint(e.clientX, e.clientY);
      if (cellPos !== null && cellPos !== drag.currentPos) {
        drag.currentPos = cellPos;
        renderCells(); // 实时预览
      }
    });

    gridEl.addEventListener('pointerup', function (e) {
      if (!drag || e.pointerId !== drag.pointerId) { return; }
      var d = drag;
      drag = null;
      var endPos = cellAtPoint(e.clientX, e.clientY);
      if (endPos !== null) {
        if (!d.moved || endPos === d.startPos) {
          onToggleBit(d.startPos);   // 单击（移动 < 3px）→ 翻转 bit
        } else {
          var rng = normalizeRange(d.startPos, endPos);
          onCommitRange(rng.start, rng.end); // 拖动落定 → 锁定位域范围（bh_grid.py:135-138）
        }
      }
      renderCells(); // 清除预览高亮
    });

    gridEl.addEventListener('pointercancel', function (e) {
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

    return {
      /** 外部状态同步：value 为 BigInt，sel 为 {start,end}|null，width 为 8/16/32/64，
       *  field 为协议模式下要高亮的字段范围 {start,end}|null */
      setState: function (next) {
        state.value = next.value;
        state.sel = next.sel || null;
        state.width = next.width || NBITS;
        state.field = next.field || null;
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
    gridShape: gridShape
  };
});

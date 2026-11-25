/**
 * proto.js — 协议解析模式的纯逻辑层（位域定义解析 / 解码 / 重叠检测 / 回写）
 *
 * 模块职责（只做逻辑，不碰 DOM，UI 集成由 main.js 负责）
 *   1. parseSpec(text[, totalWidth]) 文本定义 → 字段列表 + 逐行错误（容错优先，一行写错不整份作废）
 *   2. decode(value, fields)         64 位值 → 每个字段的 value/signed/mask/hex/dec/bin 读数
 *   3. overlaps(fields)              字段位范围两两比对，返回重叠冲突对
 *   4. specToText(fields)            字段列表 → 可回写文本框的定义文本
 *
 * 支持的语法（每行一个字段，容错优先）
 *   —— 显式位范围（高:低）——
 *   # 注释行            以 # 开头的整行直接跳过
 *   opcode 15:12        名称 + 空格 + 起始:结束
 *   rd[11:8]            名称 + [起始:结束]
 *   rs1 [ 7 : 4 ]       方括号内、冒号两侧都允许空格
 *   —— 按位宽声明（从最高位向下自动分配）——
 *   mode:3              名称:宽
 *   mode 3              名称 宽（与 mode:3 同义）
 *
 *   三种写法互斥，判定顺序固定：方括号 → 「空格 + 冒号 + 两个数」的位范围
 *   → 「单个冒号 + 单个数字」的位宽 → 「纯空格 + 单个数字」的位宽。
 *   因为冒号优先于空格，`flag 5:5` 恒为位范围而不是位宽 5。
 *   因为「名称:宽」优先于任何无空格的紧贴写法，`f1:3` 读作名称 f1 + 位宽 3，
 *   `rd11:8` 读作名称 rd11 + 位宽 8 —— 想表达位范围请加空格或方括号（rd 11:8 / rd[11:8]）。
 *
 *   名称字符集：中文 / 字母 / 数字 / 下划线 / 连字符 / 点（如 f.exp），不含空格、不含方括号、不含冒号。
 *   空行、纯空白行、# 开头行跳过，不产生字段也不产生错误。
 *   start > end 自动交换（视为同一段位域只是写反了），不报错。
 *
 * 按位宽声明的分配规则
 *   所有「按位宽」字段按书写顺序从高到低紧挨着摆放，基准最高位由 totalWidth 决定：
 *   - 传了 totalWidth（当前位宽 8/16/32/64）→ 从 totalWidth-1 向下分配；
 *   - 没传 → 用这些字段的宽度之和自适配（所以 `a:3 b:4 c:1` 恰好占满 bit 7..0）。
 *   例：`a:3 + b:4 + c:1`（总宽 8）→ a{7,5} b{4,1} c{0,0}；同样文本传 totalWidth=16 → a{15,13} b{12,9} c{8,8}。
 *   累计宽度超出上限（默认 64）时报 `字段总宽度超出 64 位`：该字段与其后所有行都标错，
 *   前面已分配好的字段保留（后段布局已经不可信，继续解析只会给出错误的位号）。
 *   显式位范围与按位宽声明可以混用，但两套基准互不影响；混用是否重叠由 overlaps() 负责检出。
 *
 * 为什么全程用 BigInt
 *   64 位值一旦落进 Number 就只有 53 位有效位，而 Number 的位运算（<< >> & |）干脆只有
 *   32 位——位域提取 (value >> start) & mask 在 start 较大或 width > 32 时必然算错。
 *   所以本模块所有移位/掩码一律 BigInt，值统一按无符号 64 位视角处理（BigInt.asUintN(64, v)），
 *   这也是 main.js / grid.js 已有的约定（与 bh_grid.py:44-45 val() 的语义一致）。
 */
(function (root, factory) {
  var api = factory();
  // 无条件挂到全局：uTools 页面可能存在 module 对象，不能靠 if/else 二选一，
  // 否则全局变量缺失会让调用方静默抛错、整页只剩静态 HTML（同 grid.js，已踩过一次）。
  if (root) {
    root.BitCalcProto = api;
  }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var NBITS = 64;      // 值恒按 64 位存放
  var MAX_BIT = NBITS - 1;
  var OVERFLOW_MSG = '字段总宽度超出 64 位';

  // 合法名称：中文（CJK 常用区）/ 字母 / 数字 / 下划线 / 连字符 / 点
  var NAME_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fff]+$/;

  // 四种写法，按固定优先级依次尝试（互斥，避免互相误判）
  var RE_BRACKET = /^([^\s\[\]]+)\s*\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/;  // rd[11:8]
  var RE_RANGE = /^([^\s\[\]]+)\s+(-?\d+)\s*:\s*(-?\d+)$/;              // opcode 15:12
  var RE_W_COLON = /^([^\s\[\]:]+)\s*:\s*(-?\d+)$/;                     // mode:3
  var RE_W_SPACE = /^([^\s\[\]:]+)\s+(-?\d+)$/;                         // mode 3

  // ---------- 内部工具 ----------

  /** 从左往右每 size 个字符插一个分隔符（与 main.js 的 groupLeft 同语义） */
  function groupLeft(s, size, sep) {
    var out = [];
    for (var i = 0; i < s.length; i += size) {
      out.push(s.slice(i, i + size));
    }
    return out.join(sep);
  }

  /** 十进制千分位：10376 → '10,376'（字段值恒非负，不必处理符号） */
  function formatDec(v) {
    return v.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 定宽二进制，每 4 位一组：宽度 8、值 0x12 → '0001 0010' */
  function formatBin(v, width) {
    return groupLeft(v.toString(2).padStart(width, '0'), 4, ' ');
  }

  /** 位范围归一化：恒返回 { start, end } 且 start <= end */
  function normalize(start, end) {
    return start < end ? { start: start, end: end } : { start: end, end: start };
  }

  // ---------- 1. 解析 ----------

  /**
   * 解析协议定义文本。
   *
   * 容错策略：单行出错只记录一条错误（带 1 起始的行号），其余行照常解析；
   * 返回的 fields 只含合法行，并保持书写顺序。
   *
   * @param {string} text 多行定义文本，\n / \r\n / \r 均可
   * @param {number} [totalWidth] 当前位宽（8/16/32/64）。仅影响「按位宽声明」的分配基准；
   *        不传时按这些字段的宽度之和自适配
   * @returns {{ fields: Array<{name: string, start: number, end: number}>,
   *             errors: Array<{line: number, message: string}> }}
   *          start 恒 <= end（写反时自动交换）；位宽 = end - start + 1，由 decode 计算
   */
  function parseSpec(text, totalWidth) {
    var entries = [];
    var seen = Object.create(null);

    if (typeof text !== 'string') {
      // null/undefined 视为空定义；其余类型兜底转字符串
      if (text === null || text === undefined) {
        text = '';
      } else {
        text = String(text);
      }
    }

    // ---- 第一遍：逐行分类 + 单行校验（重名、越界、无法识别） ----
    var lines = text.split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var lineNo = i + 1;
      var line = lines[i].trim();
      if (line === '' || line.charAt(0) === '#') { continue; }

      var entry = { lineNo: lineNo, kind: '', name: '', start: 0, end: 0, width: 0, err: null };
      var m = RE_BRACKET.exec(line) || RE_RANGE.exec(line);
      var kind = m ? 'explicit' : '';
      if (!m) {
        m = RE_W_COLON.exec(line) || RE_W_SPACE.exec(line);
        kind = m ? 'width' : '';
      }
      if (!m || !NAME_RE.test(m[1])) {
        entry.err = '无法识别的行: ' + line;
        entries.push(entry);
        continue;
      }

      var name = m[1];
      if (seen[name]) {
        entry.err = '字段名重复: ' + name;
        entries.push(entry);
        continue;
      }

      if (kind === 'explicit') {
        var a = parseInt(m[2], 10);
        var b = parseInt(m[3], 10);
        // 越界检查：把越界的那个数字原样报出来，方便用户按行定位
        var bad = [];
        if (a < 0 || a > MAX_BIT) { bad.push(a); }
        if (b < 0 || b > MAX_BIT) { bad.push(b); }
        if (bad.length) {
          entry.err = '位编号超出 0-63: ' + bad.join(', ');
          entries.push(entry);
          continue;
        }
        var r = normalize(a, b);
        entry.kind = 'explicit';
        entry.name = name;
        entry.start = r.start;
        entry.end = r.end;
      } else {
        var w = parseInt(m[2], 10);
        if (w < 1) {
          // 宽度 0 / 负数无法摆位；宽度 > 64 不单独报错，统一走下面的总量溢出
          entry.err = '字段宽度非法: ' + w;
          entries.push(entry);
          continue;
        }
        entry.kind = 'width';
        entry.name = name;
        entry.width = w;
      }

      seen[name] = true;
      entries.push(entry);
    }

    // ---- 第二遍：按位宽声明从高位向下分配 ----
    var widthEntries = [];
    var sum = 0;
    for (i = 0; i < entries.length; i++) {
      if (entries[i].kind === 'width' && !entries[i].err) {
        widthEntries.push(entries[i]);
        sum += entries[i].width;
      }
    }
    if (widthEntries.length) {
      var hasTotal = typeof totalWidth === 'number' && totalWidth > 0 && totalWidth <= NBITS;
      var limit = hasTotal ? Math.floor(totalWidth) : NBITS;
      var base = hasTotal ? limit : Math.min(sum, limit);
      var cursor = base - 1;
      var cutLine = -1;   // 第一个放不下的行号；其后的行一律标错
      for (i = 0; i < widthEntries.length; i++) {
        var e = widthEntries[i];
        if (cutLine !== -1) {
          e.err = OVERFLOW_MSG;
          continue;
        }
        var lo = cursor - e.width + 1;
        if (lo < 0) {
          cutLine = e.lineNo;
          e.err = OVERFLOW_MSG;
          continue;
        }
        e.start = lo;
        e.end = cursor;
        cursor = lo - 1;
      }
      // 级联：溢出字段之后的每一行都标错（布局已不可信，继续给位号只会误导）
      if (cutLine !== -1) {
        for (i = 0; i < entries.length; i++) {
          if (entries[i].lineNo > cutLine && !entries[i].err) {
            entries[i].err = OVERFLOW_MSG;
          }
        }
      }
    }

    // ---- 第三遍：按行序产出字段与错误 ----
    var fields = [];
    var errors = [];
    for (i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (en.err) {
        errors.push({ line: en.lineNo, message: en.err });
      } else {
        fields.push({ name: en.name, start: en.start, end: en.end });
      }
    }

    return { fields: fields, errors: errors };
  }

  // ---------- 2. 解码 ----------

  /**
   * 把 64 位值按字段拆开。
   *
   * 字段值 = (u >> start) & ((1 << width) - 1)，其中 u = BigInt.asUintN(64, value)，
   * 即「右移到 bit0 的最小表示」——这是参考项目 BitCalc（bh_grid.py:44-45）的
   * 「选区即字段值」语义：用户选中 15:12 看到的就是一个 4 位整数，不是原位对齐的蒙版。
   * signed 再按字段宽度符号扩展（BigInt.asIntN(width, value)），mask 是该字段在 64 位整数中的掩码，
   * 供 UI 做高亮/复制；(u & mask) >> start 恒等于 value。
   *
   * @param {BigInt} value 当前 64 位值（可为负，按无符号 64 位视角处理）
   * @param {Array<{name: string, start: number, end: number}>} fields parseSpec 产出的字段列表
   * @returns {Array<{name: string, start: number, end: number, width: number,
   *                  value: BigInt, signed: BigInt, mask: BigInt,
   *                  hex: string, dec: string, bin: string}>}
   *          hex 形如 '0x11'（大写、不补零）；dec 带千分位；bin 定宽且每 4 位一组
   */
  function decode(value, fields) {
    var u = BigInt.asUintN(NBITS, typeof value === 'bigint' ? value : BigInt(value));
    var list = fields || [];
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var r = normalize(f.start, f.end);  // 防御：外部传进来的字段没归一化也照算
      var start = r.start;
      var end = r.end;
      var width = end - start + 1;
      var span = (1n << BigInt(width)) - 1n;
      var fv = (u >> BigInt(start)) & span;
      out.push({
        name: f.name,
        start: start,
        end: end,
        width: width,
        value: fv,
        signed: BigInt.asIntN(width, fv),
        mask: span << BigInt(start),
        hex: '0x' + fv.toString(16).toUpperCase(),
        dec: formatDec(fv),
        bin: formatBin(fv, width)
      });
    }

    return out;
  }

  // ---------- 3. 重叠检测 ----------

  /**
   * 检测字段位范围重叠（闭区间相交，含完全包含与同一位）。
   * 按 fields 顺序两两比较（i < j），a 恒为靠前的字段名，便于按书写顺序展示冲突。
   *
   * @param {Array<{name: string, start: number, end: number}>} fields
   * @returns {Array<{a: string, b: string}>} 所有冲突对；无冲突返回空数组
   */
  function overlaps(fields) {
    var list = fields || [];
    var pairs = [];

    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = normalize(list[i].start, list[i].end);
        var b = normalize(list[j].start, list[j].end);
        if (a.start <= b.end && b.start <= a.end) {
          pairs.push({ a: list[i].name, b: list[j].name });
        }
      }
    }

    return pairs;
  }

  // ---------- 4. 回写 ----------

  /**
   * 字段列表 → 定义文本（每行「名称 高:低」，按 start 降序，与 UI 上高→低的视觉顺序一致）。
   * parseSpec(specToText(fields)) 得到与 fields 等价的定义，可用于「编辑位域后回写文本框」。
   *
   * @param {Array<{name: string, start: number, end: number}>} fields
   * @returns {string} 多行文本，行间以 \n 分隔，末尾不带换行；空输入返回 ''
   */
  function specToText(fields) {
    var list = fields || [];
    var rows = [];

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var r = normalize(f.start, f.end);
      rows.push({ name: f.name, start: r.start, end: r.end, idx: i });
    }
    // start 降序；同起点时保持原有书写顺序（idx 作为稳定 tiebreaker）
    rows.sort(function (x, y) { return y.start - x.start || x.idx - y.idx; });

    var lines = [];
    for (i = 0; i < rows.length; i++) {
      lines.push(rows[i].name + ' ' + rows[i].end + ':' + rows[i].start);
    }
    return lines.join('\n');
  }

  return {
    parseSpec: parseSpec,
    decode: decode,
    overlaps: overlaps,
    specToText: specToText
  };
});

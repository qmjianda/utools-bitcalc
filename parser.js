/**
 * parser.js — bitcalc 表达式解析器（自研 tokenizer + 递归下降，全程 BigInt）
 *
 * 语义基线：参考项目 BitCalc（bh_calc.py 用 Python eval）的运算符集合与优先级。
 * 与 BitCalc/Python 的已知语义差异（有意为之，由 test-parser.js 单测锁死）：
 *   1. `/` 为 BigInt 截断整除（向 0 截断）；BitCalc 经 Python eval 得浮点真除。
 *      本插件全程整数位域语义，故采用截断。
 *   2. `%` 为 BigInt 语义：结果符号随被除数；Python `%` 符号随除数。
 *   3. 十进制字面量不允许前导零（与 Python 3 一致；BitCalc 的 eval 同样会报错）。
 *   4. 不支持 `**`、`//`、下划线数字分隔符（不在需求范围内）。
 *   5. `>>` 为算术右移（BigInt 默认行为），负数移位量报错（与 Python 一致）。
 *   6. 函数调用仅支持白名单 FUNCS（pow/abs/min/max/log2 + 位级 popcount/clz/ctz/bswap/bitrev/rol/ror），不开放任意函数；
 *      仅支持 `名字(...)` 形式，参数之间用逗号分隔，函数名大小写不敏感。
 *
 * 错误约定：任何词法/语法错误、除零、负移位量都抛出带中文信息的 Error，
 * 由 main.js 捕获后在页面内标红显示（参考 bh_calc.py:21 的红边框错误样式）。
 *
 * 运行环境：浏览器（<script> 加载后暴露 window.BitCalcParser）与 Node（require）双用，零依赖、免构建。
 */
(function (root, factory) {
  var api = factory();
  // 无条件挂全局 + 同时导出 CommonJS：uTools 页面可能存在 module 对象，
  // 若用 if/else 二选一，页面里 window.BitCalcParser 会缺失（已踩过一次，见 main.js）。
  if (root) {
    root.BitCalcParser = api;
  }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ---------- Tokenizer ----------

  var WS = /^\s+/;
  var NUM_HEX = /^0[xX][0-9a-fA-F]+/;
  var NUM_BIN = /^0[bB][01]+/;
  var NUM_OCT = /^0[oO][0-7]+/;
  var NUM_DEC = /^[0-9]+/;
  var IDENT = /^[A-Za-z][A-Za-z0-9_]*/;
  var OP_CHARS = '+-*/%&|^~(),';

  /**
   * 词法分析。返回 token 数组，末尾固定一个 eof token。
   * token: { type: 'num'|'op'|'ident'|'eof', value: string, pos: number }
   */
  function tokenize(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    while (i < n) {
      var rest = src.slice(i);
      var m = rest.match(WS);
      if (m) { i += m[0].length; continue; }

      if (rest.slice(0, 2) === '<<') {
        tokens.push({ type: 'op', value: '<<', pos: i });
        i += 2;
        continue;
      }
      if (rest.slice(0, 2) === '>>') {
        tokens.push({ type: 'op', value: '>>', pos: i });
        i += 2;
        continue;
      }

      m = rest.match(NUM_HEX) || rest.match(NUM_BIN) || rest.match(NUM_OCT);
      // 前缀残缺（如 "0x"、单独的 "0b"）给出明确错误，而不是把 "0" 当十进制再报"多余输入"
      if (!m) {
        var badPrefix = rest.match(/^0[xX]/) ? '0x' : (rest.match(/^0[bB]/) ? '0b' : (rest.match(/^0[oO]/) ? '0o' : null));
        if (badPrefix) {
          throw new Error('残缺的' + ({ '0x': '十六进制', '0b': '二进制', '0o': '八进制' })[badPrefix] +
            '字面量 "' + badPrefix + '" 后缺少有效数字（位置 ' + i + '）');
        }
      }
      if (!m) { m = rest.match(NUM_DEC); }
      if (m) {
        var lit = m[0];
        // 十进制字面量前导零检查（Python 3 行为："0123" 报错；"0" 本身合法）
        if (/^0[0-9]+$/.test(lit)) {
          throw new Error('十进制字面量不允许前导零: "' + lit + '"（位置 ' + i + '）');
        }
        tokens.push({ type: 'num', value: lit, pos: i });
        i += lit.length;
        continue;
      }

      var ch = rest[0];
      if (OP_CHARS.indexOf(ch) >= 0) {
        tokens.push({ type: 'op', value: ch, pos: i });
        i += 1;
        continue;
      }
      m = rest.match(IDENT);
      if (m) {
        tokens.push({ type: 'ident', value: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      throw new Error('意外的字符 "' + ch + '"（位置 ' + i + '）');
    }
    tokens.push({ type: 'eof', value: '', pos: n });
    return tokens;
  }

  // ---------- 函数白名单（全程 BigInt 语义，未列出的名字一律报错） ----------

  /** 向下取整的 log2（x 为 BigInt 且 > 0）：用于求位宽，如 log2(1024) = 10 */
  function ilog2(x) {
    var n = 0n;
    while (x > 1n) { x >>= 1n; n += 1n; }
    return n;
  }

  function expectArgs(name, args, n, pos, allowMore) {
    if (allowMore ? args.length < n : args.length !== n) {
      throw new Error('函数 "' + name + '" 需要 ' + (allowMore ? '至少 ' : '') + n +
        ' 个参数，实际 ' + args.length + ' 个（位置 ' + pos + '）');
    }
  }

  var FUNCS = {
    pow: function (args, pos) {
      expectArgs('pow', args, 2, pos, false);
      if (args[1] < 0n) {
        throw new Error('pow 的指数不能为负数（位置 ' + pos + '）');
      }
      return args[0] ** args[1];
    },
    abs: function (args, pos) {
      expectArgs('abs', args, 1, pos, false);
      return args[0] < 0n ? -args[0] : args[0];
    },
    min: function (args, pos) {
      expectArgs('min', args, 1, pos, true);
      var m = args[0];
      for (var i = 1; i < args.length; i++) { if (args[i] < m) { m = args[i]; } }
      return m;
    },
    max: function (args, pos) {
      expectArgs('max', args, 1, pos, true);
      var m = args[0];
      for (var i = 1; i < args.length; i++) { if (args[i] > m) { m = args[i]; } }
      return m;
    },
    log2: function (args, pos) {
      expectArgs('log2', args, 1, pos, false);
      if (args[0] <= 0n) {
        throw new Error('log2 的参数必须为正整数（位置 ' + pos + '）');
      }
      return ilog2(args[0]);
    },

    // ---- 位级函数：统一按「无符号 64 位」视角计算，与网格显示保持一致 ----
    // 负数先按补码转成 64 位无符号，因此 popcount(-1) = 64、clz(0) = 64。

    popcount: function (args, pos) {
      expectArgs('popcount', args, 1, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      var n = 0n;
      while (x > 0n) { x &= x - 1n; n += 1n; }
      return n;
    },

    clz: function (args, pos) {
      expectArgs('clz', args, 1, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      if (x === 0n) { return 64n; }
      var n = 0n;
      for (var m = 1n << 63n; (x & m) === 0n; m >>= 1n) { n += 1n; }
      return n;
    },

    ctz: function (args, pos) {
      expectArgs('ctz', args, 1, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      if (x === 0n) { return 64n; }
      var n = 0n;
      while ((x & 1n) === 0n) { x >>= 1n; n += 1n; }
      return n;
    },

    /** 字节序反转：0x1122334455667788 → 0x8877665544332211 */
    bswap: function (args, pos) {
      expectArgs('bswap', args, 1, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      var r = 0n;
      for (var i = 0n; i < 8n; i += 1n) {
        r = (r << 8n) | ((x >> (i * 8n)) & 0xffn);
      }
      return r;
    },

    /** 64 位整体位反转：bit 0 与 bit 63 互换 */
    bitrev: function (args, pos) {
      expectArgs('bitrev', args, 1, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      var r = 0n;
      for (var i = 0n; i < 64n; i += 1n) {
        r = (r << 1n) | ((x >> i) & 1n);
      }
      return r;
    },

    /** 循环左移，移位量对 64 取模，负数等价于循环右移 */
    rol: function (args, pos) {
      expectArgs('rol', args, 2, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      var k = ((args[1] % 64n) + 64n) % 64n;
      if (k === 0n) { return x; }
      return BigInt.asUintN(64, (x << k) | (x >> (64n - k)));
    },

    /** 循环右移，移位量对 64 取模，负数等价于循环左移 */
    ror: function (args, pos) {
      expectArgs('ror', args, 2, pos, false);
      var x = BigInt.asUintN(64, args[0]);
      var k = ((args[1] % 64n) + 64n) % 64n;
      if (k === 0n) { return x; }
      return BigInt.asUintN(64, (x >> k) | (x << (64n - k)));
    }
  };

  // ---------- Parser（递归下降 + 优先级爬升，优先级与 C/Python 一致） ----------

  // 二进制运算符优先级从低到高：| < ^ < & < 移位 < 加减 < 乘除模
  var LEVELS = [
    ['|'],
    ['^'],
    ['&'],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%']
  ];

  function parse(src) {
    if (typeof src !== 'string') {
      throw new Error('表达式必须是字符串');
    }
    var tokens = tokenize(src);
    var idx = 0;

    function peek() { return tokens[idx]; }

    function describeToken(t) {
      if (t.type === 'eof') { return '，但表达式已结束'; }
      return '，但遇到 "' + t.value + '"（位置 ' + t.pos + '）';
    }

    function parsePrimary() {
      var t = peek();
      if (t.type === 'num') {
        idx++;
        // tokenizer 已保证字面量形态合法，BigInt() 不会在此失败
        return BigInt(t.value);
      }
      if (t.type === 'op' && t.value === '(') {
        idx++;
        var v = parseBinary(0);
        var close = peek();
        if (close.type !== 'op' || close.value !== ')') {
          throw new Error('期望 ")"' + describeToken(close));
        }
        idx++;
        return v;
      }
      if (t.type === 'ident') {
        idx++;
        var fn = FUNCS[t.value.toLowerCase()];
        if (!fn) {
          throw new Error('未知函数或标识符 "' + t.value + '"（位置 ' + t.pos + '）');
        }
        var open = peek();
        if (open.type !== 'op' || open.value !== '(') {
          throw new Error('函数 "' + t.value + '" 后缺少 "("' + describeToken(open));
        }
        idx++;
        var args = [];
        var next = peek();
        if (!(next.type === 'op' && next.value === ')')) {
          for (;;) {
            args.push(parseBinary(0));
            var sep = peek();
            if (sep.type === 'op' && sep.value === ',') { idx++; continue; }
            break;
          }
        }
        var closeParen = peek();
        if (closeParen.type !== 'op' || closeParen.value !== ')') {
          throw new Error('函数 "' + t.value + '" 缺少 ")"' + describeToken(closeParen));
        }
        idx++;
        return fn(args, t.pos);
      }
      throw new Error('期望数字、"(" 或函数名' + describeToken(t));
    }

    function parseUnary() {
      var t = peek();
      if (t.type === 'op' && (t.value === '-' || t.value === '+' || t.value === '~')) {
        idx++;
        var v = parseUnary();
        if (t.value === '-') { return -v; }
        if (t.value === '~') { return ~v; }
        return v; // 一元 +
      }
      return parsePrimary();
    }

    function applyBin(op, l, r, pos) {
      switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0n) { throw new Error('除零错误（"/"，位置 ' + pos + '）'); }
          return l / r; // BigInt 除法：向 0 截断
        case '%':
          if (r === 0n) { throw new Error('除零错误（"%"，位置 ' + pos + '）'); }
          return l % r; // BigInt 取模：结果符号随被除数
        case '<<':
          if (r < 0n) { throw new Error('移位量不能为负数（"<<"，位置 ' + pos + '）'); }
          return l << r;
        case '>>':
          if (r < 0n) { throw new Error('移位量不能为负数（">>"，位置 ' + pos + '）'); }
          return l >> r; // BigInt 默认算术右移
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        default:
          throw new Error('未知运算符 "' + op + '"（位置 ' + pos + '）');
      }
    }

    function parseBinary(minLevel) {
      if (minLevel >= LEVELS.length) { return parseUnary(); }
      var left = parseBinary(minLevel + 1);
      for (;;) {
        var t = peek();
        if (t.type !== 'op') { break; }
        if (LEVELS[minLevel].indexOf(t.value) < 0) { break; }
        idx++;
        var right = parseBinary(minLevel + 1);
        left = applyBin(t.value, left, right, t.pos);
      }
      return left;
    }

    var result = parseBinary(0);
    var tail = peek();
    if (tail.type !== 'eof') {
      throw new Error('多余的输入 "' + tail.value + '"（位置 ' + tail.pos + '）');
    }
    return result;
  }

  // ---------- 64 位规范化（渲染前使用） ----------

  /** 无符号 64 位规范化：网格只显示低 64 位，超出部分截断不报错 */
  function toUint64(v) { return BigInt.asUintN(64, v); }

  /** 有符号 64 位解释：供 DEC 行"有符号"显示切换使用（默认无符号） */
  function toInt64(v) { return BigInt.asIntN(64, v); }

  return {
    parse: parse,
    parseExpr: parse,
    tokenize: tokenize,
    toUint64: toUint64,
    toInt64: toInt64
  };
});

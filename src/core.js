/* bitcalc core — 64-bit integer / bitfield engine.
 * Runs as a classic browser script (window.BitcalcCore) and as a CommonJS module for tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BitcalcCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const U64 = 0xffffffffffffffffn;
  const WIDTHS = [8, 16, 32, 64];
  const BASES = ['HEX', 'DEC', 'OCT', 'BIN'];
  const BASE_TO_RADIX = { HEX: 16, DEC: 10, OCT: 8, BIN: 2 };
  const MAX_EXPONENT = 1000000n;

  class ExprError extends Error {
    constructor(message, position) {
      super(message);
      this.name = 'ExprError';
      this.position = position;
    }
  }

  function clampWidth(width) {
    const n = Number(width);
    if (!Number.isInteger(n) || n < 1 || n > 64) return 64;
    return n;
  }

  function normalizeWidth(width) {
    const n = Number(width);
    return WIDTHS.indexOf(n) >= 0 ? n : 64;
  }

  function maskFor(width) {
    return (1n << BigInt(clampWidth(width))) - 1n;
  }

  function u64(value) {
    let v = BigInt(value);
    v %= 1n << 64n;
    if (v < 0n) v += 1n << 64n;
    return v;
  }

  function toWidth(value, width) {
    return u64(value) & maskFor(width);
  }

  function toSigned(value, width) {
    const w = clampWidth(width);
    const v = toWidth(value, w);
    const sign = 1n << BigInt(w - 1);
    return v >= sign ? v - (1n << BigInt(w)) : v;
  }

  function isNegative(value, width) {
    const w = clampWidth(width);
    return ((toWidth(value, w) >> BigInt(w - 1)) & 1n) === 1n;
  }

  function hexBody(value, width) {
    const w = clampWidth(width);
    const digits = Math.ceil(w / 4);
    return toWidth(value, w).toString(16).toUpperCase().padStart(digits, '0');
  }

  function formatHex(value, width, endian) {
    const w = clampWidth(width);
    let body = hexBody(value, w);
    if (endian === 'LE' && w % 8 === 0) {
      body = (body.match(/.{2}/g) || []).reverse().join('');
    }
    return '0x' + body;
  }

  function formatBin(value, width, options) {
    const opts = options || {};
    const w = clampWidth(width);
    const body = toWidth(value, w).toString(2).padStart(w, '0');
    const displayed = opts.group === false ? body : body.replace(/(.{4})(?=.)/g, '$1 ');
    return (opts.prefix === false ? '' : '0b') + displayed;
  }

  function formatOct(value, width) {
    const w = clampWidth(width);
    const digits = Math.ceil(w / 3);
    return '0o' + toWidth(value, w).toString(8).padStart(digits, '0');
  }

  function formatDec(value, width, signed) {
    return signed ? toSigned(value, width).toString() : toWidth(value, width).toString();
  }

  function formatByBase(value, width, base, options) {
    const opts = options || {};
    switch (base) {
      case 'HEX':
        return formatHex(value, width, opts.endian || 'BE');
      case 'OCT':
        return formatOct(value, width);
      case 'BIN':
        return formatBin(value, width, { group: opts.group !== false, prefix: opts.prefix !== false });
      case 'DEC':
      default:
        return formatDec(value, width, !!opts.signed);
    }
  }

  function formatPrimary(value, settings) {
    const width = normalizeWidth(settings.width);
    return formatByBase(value, width, settings.base, {
      signed: settings.signed,
      endian: settings.endian,
      group: true,
    });
  }

  function formatFloat(value, width, kind) {
    const w = clampWidth(width);
    if (kind === 'F32') {
      if (w < 32) return null;
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setUint32(0, Number(toWidth(value, 32)), true);
      const f = view.getFloat32(0, true);
      return formatFloatNumber(f, 7);
    }
    if (kind === 'F64') {
      if (w < 64) return null;
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigUint64(0, toWidth(value, 64), true);
      const f = view.getFloat64(0, true);
      return formatFloatNumber(f, 17);
    }
    return null;
  }

  function formatFloatNumber(f, precision) {
    if (Number.isNaN(f)) return 'NaN';
    if (f === Infinity) return 'Infinity';
    if (f === -Infinity) return '-Infinity';
    if (Object.is(f, -0)) return '-0';
    if (Number.isInteger(f) && Math.abs(f) < 1e15) return String(f);
    const precise = Number(f.toPrecision(precision));
    return String(precise);
  }

  function getBytes(value, width) {
    const w = clampWidth(width);
    if (w % 8 !== 0) return [];
    const count = w / 8;
    const v = toWidth(value, w);
    const bytes = [];
    for (let i = 0; i < count; i += 1) {
      const byte = Number((v >> BigInt(i * 8)) & 0xffn);
      bytes.push({
        index: i,
        value: byte,
        hex: byte.toString(16).toUpperCase().padStart(2, '0'),
      });
    }
    return bytes;
  }

  /* ------------------------------------------------------------------ */
  /* Expression tokenizer                                                */
  /* ------------------------------------------------------------------ */

  const NUMBER_DEC = /^[0-9](?:_?[0-9])*$/;
  const NUMBER_HEX = /^0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*$/;
  const NUMBER_BIN = /^0[bB][01](?:_?[01])*$/;
  const NUMBER_OCT = /^0[oO][0-7](?:_?[0-7])*$/;

  function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        const start = i;
        while (i < source.length && /[0-9A-Za-z_]/.test(source[i])) i += 1;
        tokens.push({ type: 'number', raw: source.slice(start, i), pos: start });
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i += 1;
        tokens.push({ type: 'ident', raw: source.slice(start, i), pos: start });
        continue;
      }
      const two = source.slice(i, i + 2);
      if (two === '<<' || two === '>>' || two === '**') {
        tokens.push({ type: 'op', op: two, pos: i });
        i += 2;
        continue;
      }
      if ('+-*/%&|^~(),'.indexOf(ch) >= 0) {
        tokens.push({ type: 'op', op: ch, pos: i });
        i += 1;
        continue;
      }
      throw new ExprError('无法识别的字符 “' + ch + '”', i);
    }
    tokens.push({ type: 'eof', pos: source.length });
    return tokens;
  }

  function parseNumberToken(token) {
    const raw = token.raw;
    const compact = raw.replace(/_/g, '');
    let value;
    if (NUMBER_HEX.test(raw)) value = BigInt(compact);
    else if (NUMBER_BIN.test(raw)) value = BigInt(compact);
    else if (NUMBER_OCT.test(raw)) value = BigInt(compact);
    else if (NUMBER_DEC.test(raw)) value = BigInt(compact);
    else throw new ExprError('无效的数字字面量 “' + raw + '”', token.pos);
    if (value > U64) throw new ExprError('字面量超过 64 位', token.pos);
    return value;
  }

  /* ------------------------------------------------------------------ */
  /* Expression parser                                                   */
  /* ------------------------------------------------------------------ */

  const FUNCTION_DEFS = {
    abs: { arity: 1, description: '按当前位宽的有符号值取绝对值' },
    min: { arity: 2, description: '按无符号值取较小者' },
    max: { arity: 2, description: '按无符号值取较大者' },
    pow: { arity: 2, description: '幂运算，结果按 64 位回绕' },
    log2: { arity: 1, description: '向下取以 2 为底的对数' },
    popcount: { arity: 1, description: '当前位宽内 1 的个数' },
    clz: { arity: 1, description: '前导零个数（按当前位宽）' },
    ctz: { arity: 1, description: '尾随零个数（按当前位宽）' },
    bswap: { arity: 1, description: '字节反转（位宽须为 8 的倍数）' },
    bitrev: { arity: 1, description: '翻转当前位宽内的所有位' },
    rotl: { arity: 2, description: '循环左移，第二位为移位数' },
    rotr: { arity: 2, description: '循环右移，第二位为移位数' },
    asr: { arity: 2, description: '算术右移，按当前位宽符号位扩展' },
  };

  class Parser {
    constructor(tokens, width) {
      this.tokens = tokens;
      this.index = 0;
      this.width = clampWidth(width);
    }

    peek() {
      return this.tokens[this.index];
    }

    next() {
      const token = this.tokens[this.index];
      this.index += 1;
      return token;
    }

    matchOp(op) {
      const token = this.peek();
      if (token.type === 'op' && token.op === op) {
        this.index += 1;
        return true;
      }
      return false;
    }

    expectOp(op) {
      const token = this.peek();
      if (token.type !== 'op' || token.op !== op) {
        throw new ExprError('此处应为 “' + op + '”', token.pos);
      }
      this.index += 1;
      return token;
    }

    parse() {
      if (this.peek().type === 'eof') throw new ExprError('请输入表达式', 0);
      const value = this.parseBitOr();
      const token = this.peek();
      if (token.type !== 'eof') throw new ExprError('表达式末尾存在多余内容', token.pos);
      return value;
    }

    parseBitOr() {
      let value = this.parseBitXor();
      while (this.matchOp('|')) {
        value = u64(value | this.parseBitXor());
      }
      return value;
    }

    parseBitXor() {
      let value = this.parseBitAnd();
      while (this.matchOp('^')) {
        value = u64(value ^ this.parseBitAnd());
      }
      return value;
    }

    parseBitAnd() {
      let value = this.parseShift();
      while (this.matchOp('&')) {
        value = u64(value & this.parseShift());
      }
      return value;
    }

    parseShift() {
      let value = this.parseAdditive();
      for (;;) {
        const token = this.peek();
        if (token.type === 'op' && (token.op === '<<' || token.op === '>>')) {
          this.index += 1;
          const count = this.parseAdditive();
          if (count > 64n) {
            value = 0n;
          } else if (token.op === '<<') {
            value = u64(value << count);
          } else {
            value = u64(toWidth(value, 64) >> count);
          }
        } else {
          break;
        }
      }
      return value;
    }

    parseAdditive() {
      let value = this.parseMultiplicative();
      for (;;) {
        const token = this.peek();
        if (token.type === 'op' && (token.op === '+' || token.op === '-')) {
          this.index += 1;
          const right = this.parseMultiplicative();
          value = token.op === '+' ? u64(value + right) : u64(value - right);
        } else {
          break;
        }
      }
      return value;
    }

    parseMultiplicative() {
      let value = this.parseUnary();
      for (;;) {
        const token = this.peek();
        if (token.type === 'op' && (token.op === '*' || token.op === '/' || token.op === '%')) {
          this.index += 1;
          const right = this.parseUnary();
          if ((token.op === '/' || token.op === '%') && right === 0n) {
            throw new ExprError('不能除以 0', token.pos);
          }
          if (token.op === '*') value = u64(value * right);
          else if (token.op === '/') value = u64(value / right);
          else value = u64(value % right);
        } else {
          break;
        }
      }
      return value;
    }

    parseUnary() {
      const token = this.peek();
      if (token.type === 'op' && token.op === '+') {
        this.index += 1;
        return this.parseUnary();
      }
      if (token.type === 'op' && token.op === '-') {
        this.index += 1;
        return u64(-this.parseUnary());
      }
      if (token.type === 'op' && token.op === '~') {
        this.index += 1;
        return u64(~this.parseUnary());
      }
      return this.parsePower();
    }

    parsePower() {
      const left = this.parsePrimary();
      if (this.matchOp('**')) {
        const right = this.parseUnary();
        if (right > MAX_EXPONENT) {
          throw new ExprError('指数不能为负或过大', this.peek().pos);
        }
        return pow64(left, right);
      }
      return left;
    }

    parsePrimary() {
      const token = this.next();
      if (token.type === 'number') return parseNumberToken(token);
      if (token.type === 'ident') {
        const name = token.raw.toLowerCase();
        const definition = FUNCTION_DEFS[name];
        if (!definition) throw new ExprError('未知函数 “' + token.raw + '”', token.pos);
        this.expectOp('(');
        const args = [];
        if (!this.matchOp(')')) {
          args.push(this.parseBitOr());
          while (this.matchOp(',')) args.push(this.parseBitOr());
          this.expectOp(')');
        }
        if (args.length !== definition.arity) {
          throw new ExprError(
            name + ' 需要 ' + definition.arity + ' 个参数，实际收到 ' + args.length + ' 个',
            token.pos
          );
        }
        return this.callFunction(name, args, token.pos);
      }
      if (token.type === 'op' && token.op === '(') {
        const value = this.parseBitOr();
        this.expectOp(')');
        return value;
      }
      if (token.type === 'eof') throw new ExprError('表达式不完整', token.pos);
      throw new ExprError('此处应为数字、函数或括号', token.pos);
    }

    callFunction(name, args, position) {
      const width = this.width;
      switch (name) {
        case 'abs': {
          const signed = toSigned(args[0], width);
          return u64(signed < 0n ? -signed : signed);
        }
        case 'min':
          return args[0] < args[1] ? args[0] : args[1];
        case 'max':
          return args[0] > args[1] ? args[0] : args[1];
        case 'pow': {
          if (args[1] > MAX_EXPONENT) throw new ExprError('指数不能为负或过大', position);
          return pow64(args[0], args[1]);
        }
        case 'log2': {
          const value = u64(args[0]);
          if (value === 0n) throw new ExprError('log2(0) 未定义', position);
          return BigInt(value.toString(2).length - 1);
        }
        case 'popcount': {
          const value = toWidth(args[0], width);
          let count = 0;
          let v = value;
          while (v) {
            count += Number(v & 1n);
            v >>= 1n;
          }
          return BigInt(count);
        }
        case 'clz': {
          const value = toWidth(args[0], width);
          return BigInt(value === 0n ? width : width - value.toString(2).length);
        }
        case 'ctz': {
          const value = toWidth(args[0], width);
          if (value === 0n) return BigInt(width);
          let count = 0;
          let v = value;
          while ((v & 1n) === 0n) {
            count += 1;
            v >>= 1n;
          }
          return BigInt(count);
        }
        case 'bswap': {
          if (width % 8 !== 0) throw new ExprError('bswap 需要位宽为 8 的倍数', position);
          if (width === 8) return toWidth(args[0], 8);
          let value = toWidth(args[0], width);
          let result = 0n;
          for (let i = 0; i < width / 8; i += 1) {
            result = (result << 8n) | (value & 0xffn);
            value >>= 8n;
          }
          return result;
        }
        case 'bitrev': {
          let value = toWidth(args[0], width);
          let result = 0n;
          for (let i = 0; i < width; i += 1) {
            result = (result << 1n) | (value & 1n);
            value >>= 1n;
          }
          return result;
        }
        case 'rotl':
        case 'rotr': {
          const value = toWidth(args[0], width);
          const shift = args[1] % BigInt(width);
          if (shift === 0n) return value;
          if (name === 'rotl') {
            return toWidth((value << shift) | (value >> (BigInt(width) - shift)), width);
          }
          return toWidth((value >> shift) | (value << (BigInt(width) - shift)), width);
        }
        case 'asr': {
          const shift = args[1] > BigInt(width) ? BigInt(width) : args[1];
          return toWidth(toSigned(args[0], width) >> shift, width);
        }
        default:
          throw new ExprError('未知函数 “' + name + '”', position);
      }
    }
  }

  function pow64(base, exponent) {
    let result = 1n;
    let b = u64(base);
    let e = exponent;
    while (e > 0n) {
      if (e & 1n) result = u64(result * b);
      b = u64(b * b);
      e >>= 1n;
    }
    return result;
  }

  function evaluate(expression, options) {
    const opts = options || {};
    const width = clampWidth(opts.width || 64);
    const source = String(expression == null ? '' : expression).trim();
    if (!source) {
      return { ok: false, error: { message: '请输入表达式', position: 0 } };
    }
    try {
      const parser = new Parser(tokenize(source), width);
      const raw = parser.parse();
      const mask = maskFor(width);
      const value = raw & mask;
      const high = raw & (U64 ^ mask);
      const signHigh = U64 ^ mask;
      const negativeFit = high === signHigh && ((value >> BigInt(width - 1)) & 1n) === 1n;
      const truncated = high !== 0n && !negativeFit;
      return {
        ok: true,
        value,
        raw,
        width,
        truncated,
      };
    } catch (error) {
      if (error instanceof ExprError) {
        return { ok: false, error: { message: error.message, position: error.position } };
      }
      return { ok: false, error: { message: error && error.message ? error.message : '表达式错误', position: 0 } };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Field definitions                                                   */
  /* ------------------------------------------------------------------ */

  const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';
  const RE_EXPLICIT = new RegExp('^(' + NAME + ')\\s+(\\d+)\\s*:\\s*(\\d+)$');
  const RE_SEQUENTIAL = new RegExp('^(' + NAME + ')\\s*:\\s*(\\d+)$');
  const RE_SINGLE = new RegExp('^(' + NAME + ')\\s+(\\d+)$');

  function stripFieldComment(line) {
    let cut = line.length;
    const hash = line.indexOf('#');
    if (hash >= 0) cut = Math.min(cut, hash);
    const slash = line.indexOf('//');
    if (slash >= 0) cut = Math.min(cut, slash);
    return line.slice(0, cut);
  }

  function parseFields(text, width) {
    const w = normalizeWidth(width);
    const fields = [];
    const errors = [];
    const warnings = [];
    const occupied = new Set();
    let cursor = w - 1;
    const lines = String(text == null ? '' : text).split(/\r?\n/);

    function markOccupied(hi, lo) {
      for (let bit = lo; bit <= hi; bit += 1) occupied.add(bit);
    }

    function findFreeRun(start, runWidth) {
      let top = start >= 0 ? Math.min(start, w - 1) : w - 1;
      while (top >= 0) {
        if (occupied.has(top)) {
          top -= 1;
          continue;
        }
        let bottom = top;
        while (bottom >= 0 && !occupied.has(bottom)) bottom -= 1;
        if (top - bottom >= runWidth) {
          return { hi: top, lo: top - runWidth + 1 };
        }
        top = bottom;
      }
      return null;
    }

    lines.forEach(function (rawLine, index) {
      const lineNumber = index + 1;
      const line = stripFieldComment(rawLine).trim();
      if (!line) return;

      let name;
      let hi;
      let lo;
      const explicit = line.match(RE_EXPLICIT);
      const sequential = line.match(RE_SEQUENTIAL);
      const single = line.match(RE_SINGLE);

      if (explicit) {
        name = explicit[1];
        hi = Number(explicit[2]);
        lo = Number(explicit[3]);
        if (hi > 63 || lo > 63) {
          errors.push({ line: lineNumber, message: '位号不能超过 63' });
          return;
        }
        if (hi < lo) {
          errors.push({ line: lineNumber, message: '高位必须大于或等于低位（' + hi + ':' + lo + '）' });
          return;
        }
        if (hi >= w) {
          errors.push({ line: lineNumber, message: '位号 ' + hi + ' 超出当前 ' + w + ' 位宽度' });
          return;
        }
        markOccupied(hi, lo);
        if (cursor < 0 || hi <= cursor) cursor = lo - 1;
      } else if (sequential) {
        name = sequential[1];
        const fieldWidth = Number(sequential[2]);
        if (fieldWidth < 1) {
          errors.push({ line: lineNumber, message: '字段宽度必须大于 0' });
          return;
        }
        if (fieldWidth > 64) {
          errors.push({ line: lineNumber, message: '字段宽度不能超过 64' });
          return;
        }
        const run = findFreeRun(cursor, fieldWidth);
        if (!run) {
          errors.push({
            line: lineNumber,
            message: '字段总宽度超出当前 ' + w + ' 位，没有连续的 ' + fieldWidth + ' 位可用',
          });
          return;
        }
        hi = run.hi;
        lo = run.lo;
        markOccupied(hi, lo);
        cursor = lo - 1;
      } else if (single) {
        name = single[1];
        hi = Number(single[2]);
        lo = hi;
        if (hi > 63) {
          errors.push({ line: lineNumber, message: '位号不能超过 63' });
          return;
        }
        if (hi >= w) {
          errors.push({ line: lineNumber, message: '位号 ' + hi + ' 超出当前 ' + w + ' 位宽度' });
          return;
        }
        markOccupied(hi, lo);
        if (cursor < 0 || hi <= cursor) cursor = lo - 1;
      } else {
        errors.push({
          line: lineNumber,
          message: '无法解析字段定义。示例：opcode 15:12、mode:3、flag 7',
        });
        return;
      }

      fields.push({
        name: name,
        hi: hi,
        lo: lo,
        width: hi - lo + 1,
        line: lineNumber,
      });
    });

    const byName = new Map();
    fields.forEach(function (field) {
      if (!byName.has(field.name)) byName.set(field.name, []);
      byName.get(field.name).push(field);
    });
    byName.forEach(function (group, name) {
      if (group.length > 1) {
        group.forEach(function (field) {
          errors.push({ line: field.line, message: '字段名重复：' + name });
        });
      }
    });
    const duplicateLines = new Set(
      errors.filter(function (e) { return e.message.indexOf('字段名重复：') === 0; }).map(function (e) { return e.line; })
    );
    const unique = fields.filter(function (field) { return !duplicateLines.has(field.line); });

    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const a = unique[i];
        const b = unique[j];
        if (a.hi >= b.lo && b.hi >= a.lo) {
          a.overlap = true;
          b.overlap = true;
          const overlapLo = Math.max(a.lo, b.lo);
          const overlapHi = Math.min(a.hi, b.hi);
          warnings.push({
            line: b.line,
            message:
              '字段 ' + a.name + ' (' + a.hi + ':' + a.lo + ') 与 ' +
              b.name + ' (' + b.hi + ':' + b.lo + ') 重叠 ' +
              (overlapHi - overlapLo + 1) + ' 位',
          });
        }
      }
    }

    let cover = 0n;
    unique.forEach(function (field) {
      cover |= maskFor(field.width) << BigInt(field.lo);
    });
    let usedBits = 0;
    let coverValue = cover;
    while (coverValue) {
      usedBits += Number(coverValue & 1n);
      coverValue >>= 1n;
    }

    unique.forEach(function (field, index) {
      field.colorIndex = index % 8;
    });

    errors.sort(function (a, b) { return a.line - b.line; });
    warnings.sort(function (a, b) { return a.line - b.line; });

    return {
      fields: unique,
      errors: errors,
      warnings: warnings,
      stats: {
        width: w,
        fieldCount: unique.length,
        errorCount: errors.length,
        warningCount: warnings.length,
        usedBits: usedBits,
      },
    };
  }

  function fieldValue(value, field) {
    const raw = readRange(value, field.hi, field.lo);
    return {
      unsigned: raw,
      signed: toSigned(raw, field.width),
      hex: formatHex(raw, field.width, 'BE'),
      binary: formatBin(raw, field.width, { group: false }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Range helpers                                                       */
  /* ------------------------------------------------------------------ */

  function validRange(hi, lo, width) {
    const w = clampWidth(width);
    const a = Number(hi);
    const b = Number(lo);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < 0 || b < 0 || a >= w || b >= w) return null;
    return a >= b ? { hi: a, lo: b } : { hi: b, lo: a };
  }

  function rangeMask(hi, lo) {
    const a = Number(hi);
    const b = Number(lo);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < b || b < 0 || a > 63) return 0n;
    return maskFor(a - b + 1) << BigInt(b);
  }

  function readRange(value, hi, lo) {
    const mask = rangeMask(hi, lo);
    return (u64(value) & mask) >> BigInt(Number(lo));
  }

  function writeRange(value, hi, lo, newValue, width) {
    const w = width == null ? 64 : clampWidth(width);
    const mask = rangeMask(hi, lo);
    const base = toWidth(value, w);
    const shifted = (u64(newValue) & (mask >> BigInt(Number(lo)))) << BigInt(Number(lo));
    return toWidth((base & (maskFor(w) ^ mask)) | shifted, w);
  }

  function flipRange(value, hi, lo, width) {
    const w = width == null ? 64 : clampWidth(width);
    return toWidth(toWidth(value, w) ^ rangeMask(hi, lo), w);
  }

  function setRange(value, hi, lo, bit, width) {
    const w = width == null ? 64 : clampWidth(width);
    const base = toWidth(value, w);
    const mask = rangeMask(hi, lo);
    return toWidth(bit ? base | mask : base & (maskFor(w) ^ mask), w);
  }

  /* ------------------------------------------------------------------ */
  /* Direct value parsing                                                */
  /* ------------------------------------------------------------------ */

  function parseDirectValue(text, base, width) {
    const w = clampWidth(width);
    const original = String(text == null ? '' : text).trim();
    const compact = original.replace(/_/g, '');
    if (!compact) return { ok: false, message: '请输入数值' };

    let sign = 1n;
    let body = compact;
    if (body[0] === '+' || body[0] === '-') {
      if (body[0] === '-') sign = -1n;
      body = body.slice(1);
    }
    if (!body) return { ok: false, message: '请输入数值' };

    let radix = BASE_TO_RADIX[base] || 10;
    let mode = 'DEC';
    if (/^0[xX]/.test(body)) {
      radix = 16;
      mode = 'HEX';
      body = body.slice(2);
    } else if (/^0[bB]/.test(body)) {
      radix = 2;
      mode = 'BIN';
      body = body.slice(2);
    } else if (/^0[oO]/.test(body)) {
      radix = 8;
      mode = 'OCT';
      body = body.slice(2);
    }

    if (!body) return { ok: false, message: '缺少数字部分' };
    let valid = false;
    if (radix === 16) valid = /^[0-9a-fA-F]+$/.test(body);
    else if (radix === 10) valid = /^[0-9]+$/.test(body);
    else if (radix === 8) valid = /^[0-7]+$/.test(body);
    else if (radix === 2) valid = /^[01]+$/.test(body);
    if (!valid) {
      const label = { 16: '十六进制', 10: '十进制', 8: '八进制', 2: '二进制' }[radix] || '数值';
      return { ok: false, message: '包含无效的' + label + '数字' };
    }

    let value;
    if (radix === 16) value = BigInt('0x' + body);
    else if (radix === 8) value = BigInt('0o' + body);
    else if (radix === 2) value = BigInt('0b' + body);
    else value = BigInt(body);
    value *= sign;

    const maxUnsigned = maskFor(w);
    const minSigned = -(1n << BigInt(w - 1));
    const maxSigned = (1n << BigInt(w - 1)) - 1n;

    if (value < 0n) {
      if (value < minSigned) {
        return {
          ok: false,
          message: '超出 ' + w + ' 位范围（有符号 ' + minSigned + ' … ' + maxSigned + '，无符号 0 … ' + maxUnsigned + '）',
        };
      }
      return { ok: true, value: toWidth(value, w) };
    }
    if (value > maxUnsigned) {
      return {
        ok: false,
        message: '超出 ' + w + ' 位范围（有符号 ' + minSigned + ' … ' + maxSigned + '，无符号 0 … ' + maxUnsigned + '）',
      };
    }
    return { ok: true, value: value, mode: mode };
  }

  return {
    U64: U64,
    WIDTHS: WIDTHS,
    BASES: BASES,
    FUNCTION_DEFS: FUNCTION_DEFS,
    clampWidth: clampWidth,
    normalizeWidth: normalizeWidth,
    maskFor: maskFor,
    u64: u64,
    toWidth: toWidth,
    toSigned: toSigned,
    isNegative: isNegative,
    formatHex: formatHex,
    formatBin: formatBin,
    formatOct: formatOct,
    formatDec: formatDec,
    formatByBase: formatByBase,
    formatPrimary: formatPrimary,
    formatFloat: formatFloat,
    getBytes: getBytes,
    evaluate: evaluate,
    parseFields: parseFields,
    fieldValue: fieldValue,
    validRange: validRange,
    rangeMask: rangeMask,
    readRange: readRange,
    writeRange: writeRange,
    flipRange: flipRange,
    setRange: setRange,
    parseDirectValue: parseDirectValue,
  };
});

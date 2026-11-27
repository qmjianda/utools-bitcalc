'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core.js');

test('formatting respects width, sign and endianness', () => {
  assert.equal(core.formatHex(0xdeadbeefn, 32, 'BE'), '0xDEADBEEF');
  assert.equal(core.formatHex(0xdeadbeefn, 32, 'LE'), '0xEFBEADDE');
  assert.equal(core.formatHex(0x12n, 8, 'BE'), '0x12');
  assert.equal(core.formatHex(0x1234n, 16, 'LE'), '0x3412');
  assert.equal(core.formatBin(0b1010n, 8), '0b0000 1010');
  assert.equal(core.formatBin(0b1010n, 8, { group: false }), '0b00001010');
  assert.equal(core.formatOct(511n, 16), '0o000777');
  assert.equal(core.formatDec(0xffn, 8, false), '255');
  assert.equal(core.formatDec(0xffn, 8, true), '-1');
  assert.equal(core.toSigned(0x80n, 8), -128n);
  assert.equal(core.toWidth(0x1ffn, 8), 0xffn);
});

test('float interpretation', () => {
  assert.equal(core.formatFloat(0x3f800000n, 32, 'F32'), '1');
  assert.equal(core.formatFloat(0x3ff0000000000000n, 64, 'F64'), '1');
  assert.equal(core.formatFloat(0x00000000n, 32, 'F32'), '0');
  assert.equal(core.formatFloat(0x80000000n, 32, 'F32'), '-0');
  assert.equal(core.formatFloat(0x7fc00000n, 32, 'F32'), 'NaN');
  assert.equal(core.formatFloat(0x7f800000n, 32, 'F32'), 'Infinity');
  assert.equal(core.formatFloat(0x1n, 8, 'F32'), null);
  assert.equal(core.formatFloat(0x1n, 32, 'F64'), null);
});

test('expression arithmetic and precedence', () => {
  assert.equal(core.evaluate('1 + 2 * 3').value, 7n);
  assert.equal(core.evaluate('(1 << 12) - 1').value, 4095n);
  assert.equal(core.evaluate('1 | 2 ^ 3 & 4').value, 3n);
  assert.equal(core.evaluate('2 ** 3 ** 2').value, 512n);
  assert.equal(core.evaluate('-2 ** 2').value, core.U64 - 3n);
  assert.equal(core.evaluate('-2 ** 2', { width: 8 }).value, 0xfcn);
  assert.equal(core.evaluate('10 - 20', { width: 8 }).value, 0xf6n);
  assert.equal(core.evaluate('10 - 20', { width: 8 }).truncated, false);
  assert.equal(core.evaluate('7 / 2').value, 3n);
  assert.equal(core.evaluate('7 % 2').value, 1n);
  assert.equal(core.evaluate('0xDEAD_BEEF & 0xFF').value, 0xefn);
});

test('expression width masking and truncation detection', () => {
  const eight = core.evaluate('0x1FF', { width: 8 });
  assert.equal(eight.value, 0xffn);
  assert.equal(eight.truncated, true);
  const negOne = core.evaluate('-1', { width: 8 });
  assert.equal(negOne.value, 0xffn);
  assert.equal(negOne.truncated, false);
  const negSmall = core.evaluate('-10', { width: 8 });
  assert.equal(negSmall.value, 0xf6n);
  assert.equal(negSmall.truncated, false);
  const negTooBig = core.evaluate('-200', { width: 8 });
  assert.equal(negTooBig.value, 0x38n);
  assert.equal(negTooBig.truncated, true);
  assert.equal(core.evaluate('1 << 8', { width: 8 }).value, 0n);
  assert.equal(core.evaluate('1 << 64').value, 0n);
});

test('width-aware functions', () => {
  assert.equal(core.evaluate('popcount(0xFF)').value, 8n);
  assert.equal(core.evaluate('popcount(0x1FF)', { width: 8 }).value, 8n);
  assert.equal(core.evaluate('clz(1)', { width: 8 }).value, 7n);
  assert.equal(core.evaluate('clz(1)', { width: 64 }).value, 63n);
  assert.equal(core.evaluate('ctz(0x100)', { width: 16 }).value, 8n);
  assert.equal(core.evaluate('clz(0)', { width: 16 }).value, 16n);
  assert.equal(core.evaluate('abs(0xFF)', { width: 8 }).value, 1n);
  assert.equal(core.evaluate('min(5, 3)').value, 3n);
  assert.equal(core.evaluate('max(5, 3)').value, 5n);
  assert.equal(core.evaluate('log2(8)').value, 3n);
  assert.equal(core.evaluate('pow(2, 10)').value, 1024n);
  assert.equal(core.evaluate('bswap(0x12345678)', { width: 32 }).value, 0x78563412n);
  assert.equal(core.evaluate('bitrev(0b1100)', { width: 4 }).value, 0b0011n);
  assert.equal(core.evaluate('rotl(0x81, 1)', { width: 8 }).value, 0x03n);
  assert.equal(core.evaluate('rotr(0x81, 1)', { width: 8 }).value, 0xc0n);
  assert.equal(core.evaluate('rotl(0x81, 9)', { width: 8 }).value, 0x03n);
  assert.equal(core.evaluate('asr(0x80, 1)', { width: 8 }).value, 0xc0n);
  assert.equal(core.evaluate('asr(0x40, 1)', { width: 8 }).value, 0x20n);
  assert.equal(core.evaluate('asr(0x80, 8)', { width: 8 }).value, 0xffn);
  assert.equal(core.evaluate('bswap(1)', { width: 12 }).ok, false);
});

test('expression errors are descriptive', () => {
  assert.match(core.evaluate('1 / 0').error.message, /不能除以 0/);
  assert.match(core.evaluate('log2(0)').error.message, /未定义/);
  assert.match(core.evaluate('0xGG').error.message, /无效的数字字面量/);
  assert.match(core.evaluate('nope(1)').error.message, /未知函数/);
  assert.match(core.evaluate('popcount(1, 2)').error.message, /需要 1 个参数/);
  assert.match(core.evaluate('1 +').error.message, /不完整/);
  assert.match(core.evaluate('1 2').error.message, /多余内容/);
  assert.match(core.evaluate('').error.message, /请输入表达式/);
  assert.match(core.evaluate('0x1FFFFFFFFFFFFFFFF').error.message, /超过 64 位/);
  assert.match(core.evaluate('2 ** -1').error.message, /指数/);
});

test('field parser supports explicit, sequential, single and comments', () => {
  const text = [
    '# instruction layout',
    'opcode 15:12',
    'dst 11:8',
    'src 7:4',
    'mode:3',
    'flag 0:0',
    'single 32',
    '// trailing comment',
    'tail:2 # comment',
  ].join('\n');
  const parsed = core.parseFields(text, 64);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(
    parsed.fields.map((f) => [f.name, f.hi, f.lo, f.width]),
    [
      ['opcode', 15, 12, 4],
      ['dst', 11, 8, 4],
      ['src', 7, 4, 4],
      ['mode', 3, 1, 3],
      ['flag', 0, 0, 1],
      ['single', 32, 32, 1],
      ['tail', 31, 30, 2],
    ]
  );
  assert.equal(parsed.stats.usedBits, 19);
});

test('field parser reports duplicates, range and overflow errors', () => {
  const dup = core.parseFields('a 3:0\nb:1\na 7:4', 8);
  assert.equal(dup.fields.length, 1); // b is the only non-duplicate valid field
  assert.ok(dup.errors.some((e) => /字段名重复：a/.test(e.message)));

  const range = core.parseFields('a 9:8\nb 1:0', 8);
  assert.equal(range.fields.length, 1);
  assert.ok(range.errors.some((e) => /超出当前 8 位/.test(e.message)));

  const overflow = core.parseFields('a:5\nb:4', 8);
  assert.equal(overflow.fields.length, 1);
  assert.ok(overflow.errors.some((e) => /超出当前 8 位/.test(e.message)));
});

test('field parser warns about overlaps but keeps fields', () => {
  const parsed = core.parseFields('a 7:4\nb 5:2', 8);
  assert.equal(parsed.fields.length, 2);
  assert.equal(parsed.fields[0].overlap, true);
  assert.equal(parsed.fields[1].overlap, true);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0].message, /重叠 2 位/);
});

test('field decoding and range operations', () => {
  const parsed = core.parseFields('opcode 15:12\ndst 11:8', 16);
  const value = 0xABCDn;
  assert.deepEqual(core.fieldValue(value, parsed.fields[0]), {
    unsigned: 0xAn,
    signed: -6n,
    hex: '0xA',
    binary: '0b1010',
  });
  assert.equal(core.readRange(value, 7, 4), 0xCn);
  assert.equal(core.writeRange(value, 11, 8, 0x5n), 0xA5CDn);
  assert.equal(core.writeRange(value, 11, 8, 0x15n), 0xA5CDn);
  assert.equal(core.flipRange(value, 15, 12), 0x5bcdn);
  assert.equal(core.setRange(value, 0, 0, 1), 0xABCDn);
  assert.equal(core.setRange(0xABCDn, 0, 0, 0), 0xABCCn);
  assert.equal(core.validRange(0, 15, 16).hi, 15);
  assert.equal(core.validRange(15, 0, 16).lo, 0);
  assert.equal(core.validRange(16, 0, 16), null);
});

test('direct value parsing accepts prefixes, signs and widths', () => {
  assert.equal(core.parseDirectValue('0xFF', 'DEC', 8).value, 255n);
  assert.equal(core.parseDirectValue('FF', 'HEX', 8).value, 255n);
  assert.equal(core.parseDirectValue('-1', 'DEC', 8).value, 255n);
  assert.equal(core.parseDirectValue('0b1010', 'HEX', 8).value, 10n);
  assert.equal(core.parseDirectValue('0o17', 'DEC', 8).value, 15n);
  assert.equal(core.parseDirectValue('1_000', 'DEC', 16).value, 1000n);
  assert.match(core.parseDirectValue('256', 'DEC', 8).message, /超出 8 位范围/);
  assert.match(core.parseDirectValue('-129', 'DEC', 8).message, /超出 8 位范围/);
  assert.match(core.parseDirectValue('1G', 'HEX', 8).message, /无效/);
  assert.match(core.parseDirectValue('', 'HEX', 8).message, /请输入数值/);
});

test('getBytes returns significance order', () => {
  assert.deepEqual(core.getBytes(0x1234n, 16), [
    { index: 0, value: 0x34, hex: '34' },
    { index: 1, value: 0x12, hex: '12' },
  ]);
  assert.deepEqual(core.getBytes(0x1234n, 8), [{ index: 0, value: 0x34, hex: '34' }]);
});

test('plugin.json is valid and the regex matcher works', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
  assert.equal(plugin.main, 'index.html');
  assert.equal(plugin.logo, 'logo.png');
  assert.ok(Array.isArray(plugin.features) && plugin.features.length >= 1);
  const feature = plugin.features.find((f) => f.code === 'bitcalc');
  assert.ok(feature);
  const regexCmd = feature.cmds.find((c) => typeof c === 'object' && c.type === 'regex');
  assert.ok(regexCmd, 'bitcalc must declare a regex command');
  const match = regexCmd.match;
  assert.ok(match.startsWith('/') && match.lastIndexOf('/') > 0);
  const body = match.slice(1, match.lastIndexOf('/'));
  const flags = match.slice(match.lastIndexOf('/') + 1);
  const re = new RegExp(body, flags);

  for (const sample of [
    '0xFF',
    '0xDEADBEEF & 0xFF',
    '1 << 4',
    '~0b1010',
    '0o777 | 1',
    '12 ^ 3',
    '0b1010_1010',
    '0xFF + 0b1',
  ]) {
    assert.ok(re.test(sample), 'should match: ' + sample);
  }
  for (const sample of [
    'hello world',
    '2026-11-26',
    'https://example.com/0xFF',
    '1 + 2',
    'deadbeef',
    'popcount(0xFF)',
  ]) {
    assert.ok(!re.test(sample), 'should not match: ' + sample);
  }
});

/**
 * test-parser.js — bitcalc parser + grid 纯函数单测
 *
 * 运行：node test-parser.js（零依赖，node:assert）
 * 覆盖：字面量（dec/hex/bin/oct）、全部运算符与优先级/结合性、一元运算、
 *       / 截断、% 符号、64 位边界、toUint64/toInt64 渲染语义、
 *       除零/语法/负移位/前导零等错误路径、grid 纯函数（mask 计算对照 bh_grid.py:73-76）。
 */
'use strict';

const assert = require('assert');
const { parse, toUint64, toInt64 } = require('./parser.js');
const { bitPosAt, computeMask, extractField, normalizeRange } = require('./grid.js');

let passed = 0;

function bigeq(actual, expected, name) {
  assert.ok(typeof actual === 'bigint' && actual === expected,
    name + ': 期望 ' + expected + '，实际 ' + actual);
  passed++;
}
function eq(actual, expected, name) {
  assert.strictEqual(actual, expected, name);
  passed++;
}
function throws(fn, re, name) {
  assert.throws(fn, re, name);
  passed++;
}

// ---------- 字面量 ----------
bigeq(parse('0'), 0n, '十进制 0');
bigeq(parse('42'), 42n, '十进制');
bigeq(parse('0xFF'), 255n, '十六进制');
bigeq(parse('0Xff'), 255n, '十六进制前缀大小写');
bigeq(parse('0b1010'), 10n, '二进制');
bigeq(parse('0B1010'), 10n, '二进制前缀大小写');
bigeq(parse('0o17'), 15n, '八进制');
bigeq(parse('0O17'), 15n, '八进制前缀大小写');
bigeq(parse('0x0'), 0n, '十六进制零');
bigeq(parse('123456789012345678901234567890'), 123456789012345678901234567890n, '大十进制字面量');

// ---------- 基本运算 ----------
bigeq(parse('1 + 2'), 3n, '加法');
bigeq(parse('7 - 10'), -3n, '减法');
bigeq(parse('3 * 4'), 12n, '乘法');
bigeq(parse('5 & 3'), 1n, '按位与');
bigeq(parse('5 | 3'), 7n, '按位或');
bigeq(parse('5 ^ 3'), 6n, '按位异或');
bigeq(parse('1 << 4'), 16n, '左移');
bigeq(parse('256 >> 4'), 16n, '右移');
bigeq(parse('-8 >> 1'), -4n, '算术右移（负数）');

// ---------- / 截断整除（已知差异：BitCalc 经 Python eval 得浮点真除，本实现整数截断） ----------
bigeq(parse('7 / 2'), 3n, '/ 截断');
bigeq(parse('-7 / 2'), -3n, '/ 截断（负数，向 0）');
bigeq(parse('7 / -2'), -3n, '/ 截断（负除数）');

// ---------- % BigInt 语义（结果符号随被除数） ----------
bigeq(parse('7 % 3'), 1n, '% 基本');
bigeq(parse('-7 % 3'), -1n, '% 符号随被除数');
bigeq(parse('7 % -3'), 1n, '% 负除数');
bigeq(parse('-7 % -3'), -1n, '% 双负');

// ---------- 一元运算 ----------
bigeq(parse('-42'), -42n, '一元负号');
bigeq(parse('+42'), 42n, '一元正号');
bigeq(parse('--5'), 5n, '双重取负');
bigeq(parse('~0'), -1n, '~0 === -1');
bigeq(parse('~~0'), 0n, '双重按位取反');
bigeq(parse('~-1'), 0n, '~(-1)');
bigeq(parse('1 + -2'), -1n, '二元后跟一元负号');

// ---------- 优先级与结合性 ----------
bigeq(parse('1 + 2 * 3'), 7n, '* 优先于 +');
bigeq(parse('(1 + 2) * 3'), 9n, '括号覆盖优先级');
bigeq(parse('1 << 2 + 1'), 8n, '移位优先级低于 +');
bigeq(parse('2 + 3 << 1'), 10n, '移位优先级低于 +（左结合）');
bigeq(parse('4 | 2 & 1'), 4n, '& 优先于 |');
bigeq(parse('1 ^ 2 | 4'), 7n, '^ 优先于 |');
bigeq(parse('1 | 2 ^ 4 & 8'), 3n, '优先级链 |<^<&');
bigeq(parse('10 - 3 - 2'), 5n, '减法左结合');
bigeq(parse('8 / 4 / 2'), 1n, '除法左结合');
bigeq(parse('20 % 7 % 3'), 0n, '取模左结合');
bigeq(parse('2 << 3 << 1'), 32n, '移位左结合');
bigeq(parse('1 << 3 + 2 << 1'), 64n, '移位链 (1<<5)<<1');
bigeq(parse('((((42))))'), 42n, '嵌套括号');
bigeq(parse('-(1 + 2)'), -3n, '一元负号+括号');
bigeq(parse('~0xFFFFFFFFFFFFFFFF'), -0x10000000000000000n, '64 位全 1 取反');

// ---------- 函数调用白名单（pow/abs/min/max/log2，全程 BigInt） ----------
bigeq(parse('pow(2, 10)'), 1024n, 'pow(2,10)');
bigeq(parse('pow(2, 0)'), 1n, 'pow 指数 0');
bigeq(parse('pow(0, 0)'), 1n, 'pow(0,0)');
bigeq(parse('pow(2, 63)'), 1n << 63n, 'pow(2,63) 64 位边界');
bigeq(parse('POW(2, 3)'), 8n, '函数名大小写不敏感');
bigeq(parse('pow(2 + 1, 2)'), 9n, 'pow 参数含表达式');
bigeq(parse('pow(2, 3) + 1'), 9n, 'pow 结果参与后续运算');
bigeq(parse('pow(2, 3) | 1'), 9n, 'pow 结果参与位运算');
bigeq(parse('abs(-5)'), 5n, 'abs 负数');
bigeq(parse('abs(5)'), 5n, 'abs 正数');
bigeq(parse('abs(-5) + abs(3)'), 8n, '两个函数相加');
bigeq(parse('min(3, 1, 2)'), 1n, 'min 三参数');
bigeq(parse('max(3, 1, 2)'), 3n, 'max 三参数');
bigeq(parse('min(0x10, 15)'), 15n, 'min 混合进制');
bigeq(parse('log2(1024)'), 10n, 'log2(1024)');
bigeq(parse('log2(1)'), 0n, 'log2(1)');
bigeq(parse('log2(1023)'), 9n, 'log2 向下取整');
bigeq(parse('pow(log2(256), 2)'), 64n, '嵌套函数调用');
bigeq(parse('abs(-(1 << 3))'), 8n, '函数参数含括号与一元负号');
throws(() => parse('pow(2, -1)'), /指数不能为负/, 'pow 负指数');
throws(() => parse('pow(2)'), /需要 2 个参数/, 'pow 参数不足');
throws(() => parse('pow(2, 3, 4)'), /需要 2 个参数/, 'pow 参数过多');
throws(() => parse('pow(2,)'), /期望数字/, '函数尾随逗号');
throws(() => parse('pow(2, 3'), /缺少 "\)"/, '函数缺右括号');
throws(() => parse('pow 2, 3'), /缺少 "\("/, '函数缺左括号');
throws(() => parse('foo(1)'), /未知函数/, '未知函数');
throws(() => parse('abc'), /未知函数/, '未知标识符');
throws(() => parse('min()'), /至少 1 个参数/, '空参数列表');
throws(() => parse('log2(0)'), /参数必须为正整数/, 'log2(0)');
throws(() => parse('log2(-8)'), /参数必须为正整数/, 'log2 负数');


bigeq(parse('  1 + 2  '), 3n, '两端空格');
bigeq(parse('1\t+\n2'), 3n, '制表符与换行');

// ---------- 64 位边界 ----------
bigeq(parse('1 << 63'), 1n << 63n, '1 << 63');
bigeq(parse('(1 << 63) + ((1 << 63) - 1)'), (1n << 64n) - 1n, '最大 uint64 表达式');
bigeq(parse('0xFFFFFFFFFFFFFFFF'), 0xFFFFFFFFFFFFFFFFn, '64 位十六进制字面量');
bigeq(parse('0x1FFFFFFFFFFFFFFFF'), 0x1FFFFFFFFFFFFFFFFn, '65 位字面量可解析（显示截断）');
bigeq(parse('1 << 100'), 1n << 100n, '大移位量可解析（显示截断）');
bigeq(parse('0 & 1'), 0n, '与零');

// ---------- toUint64 / toInt64（渲染前 64 位规范化语义） ----------
eq(toUint64(-1n), 0xFFFFFFFFFFFFFFFFn, 'toUint64(-1)');
eq(toUint64(1n << 64n), 0n, 'toUint64 截断 2^64');
eq(toUint64((1n << 64n) + 5n), 5n, 'toUint64 截断高位');
eq(toUint64(0xFFFFFFFFFFFFFFFFn), 0xFFFFFFFFFFFFFFFFn, 'toUint64 幂等');
eq(toInt64((1n << 63n) - 1n), 9223372036854775807n, 'toInt64 最大正');
eq(toInt64(1n << 63n), -9223372036854775808n, 'toInt64 最小负');
eq(toInt64(0xFFFFFFFFFFFFFFFFn), -1n, 'toInt64(-1)');
eq(toInt64(255n), 255n, 'toInt64 正值');

// ---------- 除零 / 语法 / 边界错误 ----------
throws(() => parse('1 / 0'), /除零/, '除零');
throws(() => parse('1 % 0'), /除零/, '模零');
throws(() => parse(''), /期望数字/, '空表达式');
throws(() => parse('   '), /期望数字/, '纯空白');
throws(() => parse('1 +'), /期望数字/, '尾部悬空运算符');
throws(() => parse('* 3'), /期望数字/, '首部运算符');
throws(() => parse('(1 + 2'), /期望 "\)"/, '未闭合括号');
throws(() => parse('1 + 2)'), /多余的输入/, '多余右括号');
throws(() => parse('1 << -1'), /移位量/, '左移负移位量');
throws(() => parse('1 >> -2'), /移位量/, '右移负移位量');
throws(() => parse('0123'), /前导零/, '十进制前导零');
throws(() => parse('0x'), /残缺的十六进制/, '残缺十六进制');
throws(() => parse('0b102'), /多余的输入/, '残缺二进制');
throws(() => parse('123abc'), /多余的输入/, '数字后跟字母');
throws(() => parse('1 @ 2'), /意外的字符/, '未知字符');
throws(() => parse('2 ** 3'), /期望数字/, '不支持 ** 运算符');
throws(() => parse('1 // 2'), /期望数字/, '不支持 // 运算符');
throws(() => parse('0b1111_0000'), /意外的字符/, '不支持下划线分隔符');

// ---------- 位级函数（统一按无符号 64 位视角） ----------
bigeq(parse('popcount(0b1011)'), 3n, 'popcount 置位数');
bigeq(parse('popcount(0)'), 0n, 'popcount 零');
bigeq(parse('popcount(-1)'), 64n, 'popcount 全 1');
bigeq(parse('popcount(0xFF00 | 0xF)'), 12n, 'popcount 组合表达式');
bigeq(parse('clz(1)'), 63n, 'clz 最小非零');
bigeq(parse('clz(0)'), 64n, 'clz 零');
bigeq(parse('clz(1 << 63)'), 0n, 'clz 最高位');
bigeq(parse('ctz(0x100)'), 8n, 'ctz 尾随零');
bigeq(parse('ctz(0)'), 64n, 'ctz 零');
bigeq(parse('ctz(0x8000000000000001)'), 0n, 'ctz 奇数');
bigeq(parse('bswap(0x1122334455667788)'), 0x8877665544332211n, 'bswap 字节反转');
bigeq(parse('bswap(0xFF)'), 0xFF00000000000000n, 'bswap 单字节');
bigeq(parse('bitrev(1)'), 0x8000000000000000n, 'bitrev 最低位');
bigeq(parse('bitrev(0x8000000000000000)'), 1n, 'bitrev 最高位');
bigeq(parse('rol(0x8000000000000000, 1)'), 1n, 'rol 跨位循环');
bigeq(parse('ror(1, 1)'), 0x8000000000000000n, 'ror 跨位循环');
bigeq(parse('rol(0xFF, 64)'), 0xFFn, 'rol 移位量取模');
bigeq(parse('rol(1, -1)'), 0x8000000000000000n, 'rol 负移位量=右移');
bigeq(parse('ror(0xFF, -8)'), 0xFF00n, 'ror 负移位量=左移');
bigeq(parse('POPCOUNT(0b111)'), 3n, '函数名大小写不敏感');
throws(() => parse('rol(1)'), /需要 2 个参数/, 'rol 参数不足');
throws(() => parse('popcount()'), /需要 1 个参数/, 'popcount 无参数');

// ---------- grid 纯函数（mask 计算对照 bh_grid.py:73-76） ----------
eq(computeMask(0, 63), 0xFFFFFFFFFFFFFFFFn, 'mask 全范围');
eq(computeMask(0, 0), 1n, 'mask bit0');
eq(computeMask(63, 63), 1n << 63n, 'mask bit63');
eq(computeMask(9, 13), 0x3E00n, 'mask 9..13');
eq(computeMask(5, 5), 32n, 'mask bit5');
eq(extractField(0x3E00n, 9, 13), 0x1Fn, '位域提取 9..13');
eq(extractField(0xABCDEF1234567890n, 0, 63), 0xABCDEF1234567890n, '位域提取全范围');
eq(extractField(0n, 0, 63), 0n, '位域提取零值');
eq(normalizeRange(13, 9).start, 9, '拖动归一化 start');
eq(normalizeRange(13, 9).end, 13, '拖动归一化 end');
eq(bitPosAt(0, 0), 63, '网格坐标 左上=63');
eq(bitPosAt(3, 15), 0, '网格坐标 右下=0');
eq(bitPosAt(0, 15), 48, '网格坐标 右上=48');
eq(bitPosAt(3, 0), 15, '网格坐标 左下=15');
eq(bitPosAt(1, 4), 43, '网格坐标 (1,4)=43');

console.log('全部 ' + passed + ' 个用例通过 ✅');

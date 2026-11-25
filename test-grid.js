/**
 * test-grid.js — bitcalc 网格纯函数单测
 *
 * 运行：node test-grid.js（零依赖，node:assert）
 * 重点锁死跨行框选：0–16 在 32/64 位下必须拆成「16」与「15–0」两段，
 * 不能只连接两个端点画一个窄矩形；3–4 即使中间有 nibble 间隙也仍是连续位段。
 */
'use strict';

const assert = require('assert');
const {
  bitPosAt,
  computeMask,
  extractField,
  normalizeRange,
  gridShape,
  rangeSegments
} = require('./grid.js');

let passed = 0;
function eq(actual, expected, name) {
  assert.strictEqual(actual, expected, name);
  passed++;
}
function deep(actual, expected, name) {
  assert.deepStrictEqual(actual, expected, name);
  passed++;
}
function bigeq(actual, expected, name) {
  assert.ok(typeof actual === 'bigint' && actual === expected,
    name + ': 期望 ' + expected + '，实际 ' + actual);
  passed++;
}

// ---------- 坐标与位宽 ----------
eq(bitPosAt(0, 0, 64), 63, '64 位左上 = bit63');
eq(bitPosAt(3, 15, 64), 0, '64 位右下 = bit0');
eq(bitPosAt(0, 0, 16), 15, '16 位左上 = bit15');
eq(bitPosAt(0, 7, 8), 0, '8 位右下 = bit0');
deep(gridShape(8), { cols: 8, rows: 1 }, '8 位形状');
deep(gridShape(16), { cols: 16, rows: 1 }, '16 位形状');
deep(gridShape(32), { cols: 16, rows: 2 }, '32 位形状');
deep(gridShape(64), { cols: 16, rows: 4 }, '64 位形状');

// ---------- 位域 mask / 提取 / 归一化 ----------
bigeq(computeMask(0, 0), 1n, 'bit0 mask');
bigeq(computeMask(3, 4), 0x18n, '跨 nibble 间隙的 3–4 mask');
bigeq(computeMask(0, 16), 0x1ffffn, '跨行 0–16 mask');
bigeq(computeMask(0, 63), 0xffffffffffffffffn, '全 64 位 mask');
bigeq(extractField(0x123456789abcdef0n, 0, 16), 0xdef0n, '提取低 16 位');
bigeq(extractField(0x123456789abcdef0n, 16, 31), 0x9abcn, '提取跨字节位段');
deep(normalizeRange(16, 0), { start: 0, end: 16 }, '反向拖动归一化');
deep(normalizeRange(4, 3), { start: 3, end: 4 }, '3–4 归一化');

// ---------- 跨行视觉分段（本次 bug 的回归核心） ----------
deep(rangeSegments(3, 4, 16), [
  { row: 0, start: 3, end: 4 }
], '16 位 3–4 是同一行的一段');
deep(rangeSegments(0, 16, 32), [
  { row: 1, start: 0, end: 15 },
  { row: 0, start: 16, end: 16 }
], '32 位 0–16：底行整段 + 顶行 bit16');
deep(rangeSegments(0, 16, 64), [
  { row: 3, start: 0, end: 15 },
  { row: 2, start: 16, end: 16 }
], '64 位 0–16：不能只框两个端点');
deep(rangeSegments(16, 0, 64), rangeSegments(0, 16, 64), '反向输入得到相同分段');
deep(rangeSegments(0, 63, 64), [
  { row: 3, start: 0, end: 15 },
  { row: 2, start: 16, end: 31 },
  { row: 1, start: 32, end: 47 },
  { row: 0, start: 48, end: 63 }
], '全选时每行一段');
deep(rangeSegments(31, 32, 64), [
  { row: 2, start: 31, end: 31 },
  { row: 1, start: 32, end: 32 }
], '跨行边界各自成段');
deep(rangeSegments(0, 7, 8), [
  { row: 0, start: 0, end: 7 }
], '8 位全选一段');
deep(rangeSegments(-10, 3, 16), [
  { row: 0, start: 0, end: 3 }
], '低于 bit0 的部分被夹掉');
deep(rangeSegments(62, 99, 64), [
  { row: 0, start: 62, end: 63 }
], '高于最高位的部分被夹掉');
deep(rangeSegments(20, 10, 8), [], '完全超出 8 位时无分段');

console.log('test-grid: ' + passed + ' 个断言通过');

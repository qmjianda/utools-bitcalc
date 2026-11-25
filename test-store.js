/**
 * test-store.js — bitcalc 持久化层（store.js）单测
 *
 * 运行：node test-store.js（零依赖，node:assert）
 * 覆盖：历史记录的写入/去重/上限/清空、命名方案的保存/覆盖/删除/排序、方案名裁剪、
 *       界面设置的合并写入、字段定义原文、storage 抛错时的降级行为。
 */
'use strict';

const assert = require('assert');
const { createStore, memoryStorage, KEYS } = require('./store.js');

let passed = 0;
function eq(actual, expected, name) {
  assert.strictEqual(actual, expected, name);
  passed++;
}
function deep(actual, expected, name) {
  assert.deepStrictEqual(actual, expected, name);
  passed++;
}

// ---------- 历史记录 ----------
const s = createStore(memoryStorage());
deep(s.historyList(), [], '初始历史为空');

s.historyPush({ expr: '1<<8', value: '256', width: 64, signed: false });
s.historyPush({ expr: '0xFF & 0x0F', value: '15', width: 64, signed: false });
eq(s.historyList().length, 2, '两条历史');
eq(s.historyList()[0].expr, '0xFF & 0x0F', '最新在前');
eq(s.historyList()[0].value, '15', '值按十进制字符串存');

// 同一条再次出现 → 去重并提到最前，而不是留两行
s.historyPush({ expr: '1<<8', value: '256', width: 64, signed: false });
eq(s.historyList().length, 2, '重复条目去重');
eq(s.historyList()[0].expr, '1<<8', '去重后提到最前');

// 空表达式不记
s.historyPush({ expr: '   ', value: '0' });
eq(s.historyList().length, 2, '空表达式不入历史');

// 上限：只留最近 historyMax 条
for (let i = 0; i < 80; i++) {
  s.historyPush({ expr: 'v' + i, value: String(i) });
}
eq(s.historyList().length, s.historyMax, '历史条数封顶');
eq(s.historyList()[0].expr, 'v79', '封顶后保留最新');

s.historyClear();
deep(s.historyList(), [], '清空历史');

// ---------- 命名方案 ----------
const p = createStore(memoryStorage());
const SPEC_A = 'opcode 15:12\nrd 11:8\nrs 7:4\nfunc 3:0';
const SPEC_B = 'mode:3';

eq(p.schemeList().length, 0, '初始无方案');
eq(p.clipName('  USB   请求  '), 'USB 请求', '方案名压空白');
eq(p.clipName('x'.repeat(40)).length, p.schemeNameMax, '方案名截断');

let r = p.schemeSave('RISC-V', SPEC_A, 32);
eq(r.ok, true, '保存方案成功');
eq(p.schemeList().length, 1, '一个方案');
eq(p.schemeGet('RISC-V').spec, SPEC_A, '读回定义原文');
eq(p.schemeGet('RISC-V').width, 32, '记住保存时的位宽');

r = p.schemeSave('mode', SPEC_B, 64);
eq(r.ok, true, '再存一个');
eq(p.schemeList().length, 2, '两个方案');
eq(p.schemeList()[0].name, 'mode', '按更新时间倒序');

// 同名覆盖：不新增，只更新内容
r = p.schemeSave('RISC-V', 'updated:2', 64);
eq(r.ok, true, '同名覆盖成功');
eq(p.schemeList().length, 2, '覆盖不新增条目');
eq(p.schemeGet('RISC-V').spec, 'updated:2', '覆盖写入新内容');

// 非法输入
eq(p.schemeSave('   ', SPEC_A, 64).ok, false, '空名字拒绝');
eq(p.schemeSave('空的', '  \n ', 64).ok, false, '空内容拒绝');
eq(p.schemeSave('空的', '', 64).reason, 'empty-spec', '空内容的错误码');

p.schemeDelete('mode');
eq(p.schemeList().length, 1, '删除后剩一个');
eq(p.schemeGet('mode'), null, '删掉的取不到');
p.schemeDelete('不存在');
eq(p.schemeList().length, 1, '删不存在的名字是幂等的');

// ---------- 字段定义原文 ----------
const q = createStore(memoryStorage());
eq(q.getSpec(), '', '初始无定义');
q.setSpec(SPEC_A);
eq(q.getSpec(), SPEC_A, '定义原文往返');

// ---------- 界面设置 ----------
deep(q.getSettings(), {}, '初始无设置');
q.patchSettings({ width: 32 });
eq(q.getSettings().width, 32, '写入位宽');
q.patchSettings({ signed: true, mode: 'proto' });
eq(q.getSettings().width, 32, '合并保留已有键');
eq(q.getSettings().signed, true, '写入符号');
eq(q.getSettings().mode, 'proto', '写入模式');

// ---------- 坏数据与 storage 抛错 ----------
const bad = memoryStorage();
bad.setItem(KEYS.history, '{不是 JSON');
bad.setItem(KEYS.schemes, '{"a":1}');
const b = createStore(bad);
deep(b.historyList(), [], '坏 JSON 退化成空列表');
deep(b.schemeList(), [], '非数组退化成空列表');
bad.setItem(KEYS.history, null);
deep(b.historyList(), [], 'null 退化成空列表');

const broken = memoryStorage();
broken.setItem = function () { throw new Error('QuotaExceededError'); };
const c = createStore(broken);
c.historyPush({ expr: '1+1', value: '2' });
deep(c.historyList(), [], '写失败时读回是空，但不抛错');
eq(c.schemeSave('n', 'x').ok, false, '写失败时方案保存返回失败');
eq(c.setSpec('x'), false, '写失败时 setSpec 返回 false');
eq(c.patchSettings({ width: 8 }).width, 8, '设置写失败仍返回合并结果');

console.log('test-store: ' + passed + ' 个断言通过');

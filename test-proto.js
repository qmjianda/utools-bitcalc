/**
 * test-proto.js — bitcalc 协议解析模式（proto.js）纯函数单测
 *
 * 运行：node test-proto.js（零依赖，node:assert；任一断言失败 → assert 抛出，退出码 1）
 * 覆盖：parseSpec 的位范围写法（空格/方括号）与按位宽写法（名称:宽、名称 宽）/中文名/空白与
 *       注释/写反自动交换/越界/重名/无法识别的行/空输入/行号/书写顺序/按位宽自动分配与总量溢出级联/
 *       totalWidth 显式基准；decode 的 0 值与全 1/跨字节/负数/位宽 1 与 64/signed 符号扩展/
 *       mask 掩码/hex 大小写与不补零/dec 千分位/bin 定宽与 4 位分组/入参不被修改；
 *       overlaps 的相交/包含/相邻不重叠/同一位/多处冲突/未归一化输入；specToText 排序与往返。
 */
'use strict';

const assert = require('assert');
const { parseSpec, decode, overlaps, specToText } = require('./proto.js');

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

// 取单行定义的第一个字段 / 第一条错误，省掉重复的下标噪音
function f0(text) { return parseSpec(text).fields[0]; }
function e0(text) { return parseSpec(text).errors[0]; }

// ---------- parseSpec：基本语法（题面示例） ----------
const SPEC4 = ['# 示例：RISC-V 风格', 'opcode 15:12', 'rd[11:8]', 'rs1 [7:4]', 'imm 3:0'].join('\n');
const R4 = parseSpec(SPEC4);

eq(R4.errors.length, 0, '示例 spec 无错误');
eq(R4.fields.length, 4, '示例 spec 字段数 4');
deep(R4.fields[0], { name: 'opcode', start: 12, end: 15 }, 'opcode 15:12');
deep(R4.fields[1], { name: 'rd', start: 8, end: 11 }, 'rd[11:8] 方括号写法');
deep(R4.fields[2], { name: 'rs1', start: 4, end: 7 }, 'rs1 [7:4] 方括号前有空格');
deep(R4.fields[3], { name: 'imm', start: 0, end: 3 }, 'imm 3:0');

// ---------- parseSpec：名称与分隔符的容错 ----------
deep(f0('rd [ 11 : 8 ]'), { name: 'rd', start: 8, end: 11 }, '方括号内与冒号两侧的空格');
deep(f0('rd\t11:8'), { name: 'rd', start: 8, end: 11 }, '制表符分隔');
deep(f0('rd    11:8'), { name: 'rd', start: 8, end: 11 }, '多个空格分隔');
deep(f0('   imm 3:0   '), { name: 'imm', start: 0, end: 3 }, '行首行尾空白被忽略');
deep(f0('操作码 15:12'), { name: '操作码', start: 12, end: 15 }, '中文名称');
deep(f0('f.exp 30:23'), { name: 'f.exp', start: 23, end: 30 }, '点号名称');
deep(f0('a-b_c.d 1:0'), { name: 'a-b_c.d', start: 0, end: 1 }, '连字符/下划线/点混合名称');
deep(f0('f1 3:0'), { name: 'f1', start: 0, end: 3 }, '名称以数字结尾（有空格分隔）');
deep(f0('OpCode 15:12'), { name: 'OpCode', start: 12, end: 15 }, '名称大小写原样保留');
deep(f0('rd11:8'), { name: 'rd11', start: 0, end: 7 }, '名称以数字结尾 + :宽（默认无空格写法按位宽解释）');

// ---------- parseSpec：位范围 ----------
deep(f0('op 3:8'), { name: 'op', start: 3, end: 8 }, 'start>end 自动交换');
deep(f0('op 31:24'), { name: 'op', start: 24, end: 31 }, '正常高段 31:24');
deep(f0('flag 5:5'), { name: 'flag', start: 5, end: 5 }, '单 bit 字段 5:5');
deep(f0('lo 0:0'), { name: 'lo', start: 0, end: 0 }, '边界 bit 0');
deep(f0('hi 63:63'), { name: 'hi', start: 63, end: 63 }, '边界 bit 63');
deep(f0('all 63:0'), { name: 'all', start: 0, end: 63 }, '全 64 位字段');

// ---------- parseSpec：注释 / 空行 / 空输入 ----------
const R_CMT = parseSpec('# 注释\n\n   \nopcode 15:12\n\t\n');
eq(R_CMT.fields.length, 1, '注释与空行被跳过');
eq(R_CMT.errors.length, 0, '注释与空行不产生错误');
eq(parseSpec('# opcode 15:12').fields.length, 0, '# 开头的行即使像字段也不解析');
eq(parseSpec('').fields.length, 0, '空字符串 → 无字段');
eq(parseSpec('').errors.length, 0, '空字符串 → 无错误');
eq(parseSpec('\n\n   \n\t\n').fields.length, 0, '纯空白输入 → 无字段');
eq(parseSpec(null).fields.length, 0, 'null 视为空定义');
eq(parseSpec('opcode 15:12\r\nimm 3:0').fields.length, 2, 'CRLF 换行');

// ---------- parseSpec：错误路径 ----------
eq(parseSpec('bad 64:0').fields.length, 0, '越界 64 → 该行不进 fields');
eq(e0('bad 64:0').line, 1, '越界错误带行号');
assert.ok(/位编号超出 0-63/.test(e0('bad 64:0').message), '越界错误信息');
assert.ok(/64/.test(e0('bad 64:0').message), '越界错误信息带越界数字');
passed++;
eq(parseSpec('bad 0:-1').errors.length, 1, '负位号 → 报错');
eq(parseSpec('bad 70:-1').errors.length, 1, '两端都越界 → 合并成一条错误');

const R_DUP = parseSpec('rd 7:4\nrd 3:0');
eq(R_DUP.fields.length, 1, '重名：先出现的保留');
eq(R_DUP.errors.length, 1, '重名：后出现的报错');
eq(R_DUP.errors[0].line, 2, '重名：行号指向后出现的那行');
eq(R_DUP.errors[0].message, '字段名重复: rd', '重名：错误信息');

const R_DUP2 = parseSpec('rd 7:4\nrd 3:0\nimm 2:0');
eq(R_DUP2.fields.length, 2, '重名后其余行照常解析');
eq(R_DUP2.fields[1].name, 'imm', '重名后字段顺序正确');

eq(parseSpec('opcode').errors.length, 1, '只有名称没有范围 → 无法识别');
assert.ok(/无法识别的行/.test(e0('opcode').message), '无法识别的行：信息前缀');
eq(e0('opcode').message, '无法识别的行: opcode', '无法识别的行：带回原始内容');
eq(parseSpec('opcode 15-12').errors.length, 1, '用 - 代替 : → 无法识别');
eq(parseSpec('a@b 1:0').errors.length, 1, '名称含非法字符 → 无法识别');
eq(parseSpec('[11:8]').errors.length, 1, '缺名称只有方括号 → 无法识别');
eq(parseSpec('opcode 15:12 extra').errors.length, 1, '行尾多余内容 → 无法识别');
eq(e0('rd 7:4\n\n@#$ 1:0').line, 3, '错误行号按物理行计算（空行计入）');

const R_MIX = parseSpec('opcode 64:0\nrd[11:8]\nrd 3:0\n???\nimm 3:0');
eq(R_MIX.errors.length, 3, '混合错误：越界 + 重名 + 无法识别');
eq(R_MIX.fields.length, 2, '混合错误：合法行仍然保留');
deep(R_MIX.fields.map(function (f) { return f.name; }), ['rd', 'imm'], '合法行保持书写顺序');

// ---------- decode：零值与全 1 ----------
const F_FULL = [{ name: 'all', start: 0, end: 63 }];

const D_ZERO = decode(0n, F_FULL)[0];
bigeq(D_ZERO.value, 0n, 'decode 零值');
eq(D_ZERO.hex, '0x0', 'decode 零值 hex');
eq(D_ZERO.dec, '0', 'decode 零值 dec');
eq(D_ZERO.bin, groupOf('0', 64), 'decode 零值 bin 定宽 64');

const D_ALL = decode(-1n, F_FULL)[0];
bigeq(D_ALL.value, 0xFFFFFFFFFFFFFFFFn, 'decode -1n → 无符号全 1');
eq(D_ALL.width, 64, 'decode 全 1 位宽 64');
eq(D_ALL.hex, '0xFFFFFFFFFFFFFFFF', 'decode 全 1 hex 无补零');
eq(D_ALL.dec, '18,446,744,073,709,551,615', 'decode 全 1 dec 千分位');
eq(D_ALL.bin.split(' ').length, 16, 'decode 全 1 bin 分 16 组');
eq(D_ALL.bin.length, 79, 'decode 全 1 bin 长度 64+15 空格');
bigeq(decode(-1n, F_FULL)[0].value, decode(0xFFFFFFFFFFFFFFFFn, F_FULL)[0].value, '-1n 与全 1 字面量结果一致');

// ---------- decode：跨字节字段 / 负数 / 归一化 ----------
const D_CROSS = decode(0xABCDn, [{ name: 'x', start: 4, end: 11 }])[0];
bigeq(D_CROSS.value, 0xBCn, '跨字节字段 11:4 → 0xBC');
eq(D_CROSS.width, 8, '跨字节字段位宽 8');
eq(D_CROSS.hex, '0xBC', '跨字节字段 hex 大写');
eq(D_CROSS.dec, '188', '跨字节字段 dec');
eq(D_CROSS.bin, '1011 1100', '跨字节字段 bin 分组');

const D_NEG = decode(-123456789n, F_FULL)[0];
bigeq(D_NEG.value, BigInt.asUintN(64, -123456789n), 'decode 负数按无符号 64 位解释');

const D_RAW = decode(0xF00n, [{ name: 'r', start: 11, end: 8 }])[0];
eq(D_RAW.start, 8, 'decode 对未归一化字段也能归一化 start');
eq(D_RAW.end, 11, 'decode 对未归一化字段也能归一化 end');
bigeq(D_RAW.value, 0xFn, 'decode 未归一化字段取值正确');

// ---------- decode：位宽 1 / 64 与格式细节 ----------
const D_ONE = decode(1n, [{ name: 'b', start: 0, end: 0 }])[0];
eq(D_ONE.width, 1, '位宽 1');
eq(D_ONE.bin, '1', '位宽 1 bin 只有一位');
eq(D_ONE.hex, '0x1', '位宽 1 hex 至少一位数字');
eq(D_ONE.dec, '1', '位宽 1 dec');
eq(decode(0n, [{ name: 'b', start: 0, end: 0 }])[0].bin, '0', '位宽 1 零值 bin 定宽为 1');

eq(decode(0x111n, [{ name: 'h', start: 4, end: 15 }])[0].hex, '0x11', 'hex 不补零（4 位十六进制位宽也只用 2 位）');
eq(decode(10376n, F_FULL)[0].dec, '10,376', 'dec 五位数千分位');
eq(decode(17n, F_FULL)[0].dec, '17', 'dec 两位数不加分隔');
eq(decode(999n, F_FULL)[0].dec, '999', 'dec 三位数不加分隔');
eq(decode(1000n, F_FULL)[0].dec, '1,000', 'dec 四位数千分位');
eq(decode(0x12n, [{ name: 'b', start: 0, end: 7 }])[0].bin, '0001 0010', 'bin 8 位分组');
eq(decode(3n, [{ name: 'b', start: 0, end: 5 }])[0].bin, '0000 11', 'bin 6 位分组（末组 2 位）');
eq(decode(5n, [{ name: 'b', start: 0, end: 2 }])[0].bin, '101', 'bin 3 位不分组');
eq(decode(17n, [{ name: 'b', start: 0, end: 4 }])[0].bin, '1000 1', 'bin 5 位分组');
eq(decode(5, [{ name: 'n', start: 0, end: 63 }])[0].bin.slice(-4), '0101', 'Number 入参兜底');

// ---------- decode：结构与顺序 ----------
const F_ORDER = [{ name: 'a', start: 8, end: 15 }, { name: 'b', start: 0, end: 7 }];
const D_ORDER = decode(0x1234n, F_ORDER);
eq(D_ORDER.length, 2, 'decode 输出条数等于字段数');
eq(D_ORDER[0].name, 'a', 'decode 顺序与 fields 一致（第一项）');
eq(D_ORDER[1].name, 'b', 'decode 顺序与 fields 一致（第二项）');
bigeq(D_ORDER[0].value, 0x12n, 'decode 第一项取值');
bigeq(D_ORDER[1].value, 0x34n, 'decode 第二项取值');
eq(decode(0n, []).length, 0, '空字段列表 → 空结果');
eq(decode(0n, null).length, 0, 'fields 为 null 不抛错');

const F_SNAPSHOT = parseSpec('rd 7:4\nimm 3:0').fields;
const F_COPY = JSON.parse(JSON.stringify(F_SNAPSHOT));
decode(0xFFn, F_SNAPSHOT);
deep(F_SNAPSHOT, F_COPY, 'decode 不修改入参 fields');

// ---------- 端到端：定义 + 值 → 读数 ----------
const D_E2E = decode(0xABCD1234n, R4.fields);
eq(D_E2E.length, 4, '端到端：四个字段');
bigeq(D_E2E[0].value, 1n, '端到端：opcode(15:12) = 1');
bigeq(D_E2E[1].value, 2n, '端到端：rd(11:8) = 2');
bigeq(D_E2E[2].value, 3n, '端到端：rs1(7:4) = 3');
bigeq(D_E2E[3].value, 4n, '端到端：imm(3:0) = 4');
eq(D_E2E[3].hex, '0x4', '端到端：imm hex');
eq(D_E2E[3].bin, '0100', '端到端：imm bin 定宽 4');
eq(decode(-1n, R4.fields)[0].hex, '0xF', '端到端：-1 时 opcode 全 1');

// ---------- overlaps：重叠检测 ----------
deep(overlaps([{ name: 'a', start: 11, end: 8 }, { name: 'b', start: 9, end: 4 }]),
  [{ a: 'a', b: 'b' }], '相交 → 报冲突');
deep(overlaps([{ name: 'a', start: 15, end: 0 }, { name: 'b', start: 7, end: 4 }]),
  [{ a: 'a', b: 'b' }], '包含 → 报冲突');
deep(overlaps([{ name: 'a', start: 11, end: 8 }, { name: 'b', start: 7, end: 4 }]),
  [], '相邻不重叠 → 无冲突');
deep(overlaps([{ name: 'a', start: 5, end: 5 }, { name: 'b', start: 5, end: 5 }]),
  [{ a: 'a', b: 'b' }], '同一位 → 报冲突');
deep(overlaps([{ name: 'a', start: 15, end: 0 }, { name: 'b', start: 3, end: 0 }, { name: 'c', start: 7, end: 4 }]),
  [{ a: 'a', b: 'b' }, { a: 'a', b: 'c' }], '多处冲突按书写顺序返回');
deep(overlaps([{ name: 'a', start: 7, end: 4 }, { name: 'b', start: 5, end: 2 }, { name: 'c', start: 6, end: 1 }]),
  [{ a: 'a', b: 'b' }, { a: 'a', b: 'c' }, { a: 'b', b: 'c' }], '三字段两两冲突 → 3 对');
deep(overlaps([]), [], '空字段列表 → 无冲突');
deep(overlaps([{ name: 'only', start: 63, end: 0 }]), [], '单字段 → 无冲突');
deep(overlaps([{ name: 'a', start: 0, end: 7 }, { name: 'b', start: 8, end: 15 }, { name: 'c', start: 16, end: 23 }]),
  [], '连续不重叠的三个字段 → 无冲突');
deep(overlaps([{ name: 'a', start: 0, end: 7 }, { name: 'b', start: 4, end: 2 }]),
  [{ a: 'a', b: 'b' }], '未归一化输入（4:2 等价 2:4）→ 报冲突');
deep(overlaps(null), [], 'null 不抛错');

// 端到端：合法定义不应产生重叠，典型冲突定义应被检出
deep(overlaps(R4.fields), [], '示例 spec 本身无重叠');
deep(overlaps(parseSpec('a 7:4\nb 6:0').fields), [{ a: 'a', b: 'b' }], '解析结果直接喂给 overlaps');

// ---------- parseSpec：按位宽写法（从最高位向下自动分配） ----------
const R_W = parseSpec('a:3\nb:4\nc:1');
deep(R_W.fields, [
  { name: 'a', start: 5, end: 7 },
  { name: 'b', start: 1, end: 4 },
  { name: 'c', start: 0, end: 0 }
], '按位宽自动分配：a:3 + b:4 + c:1 → 7:5 / 4:1 / 0:0');
eq(R_W.errors.length, 0, '按位宽写法：无错误');
deep(f0('mode:3'), { name: 'mode', start: 0, end: 2 }, '名称:宽（单字段自适配总宽 3 → 2:0）');
deep(f0('mode 3'), { name: 'mode', start: 0, end: 2 }, '名称 宽 与 名称:宽 同义');
deep(f0('mode : 3'), { name: 'mode', start: 0, end: 2 }, '冒号两侧带空格');
deep(f0('f1:3'), { name: 'f1', start: 0, end: 2 }, '名称以数字结尾 + :宽');
deep(f0('flag 5:5'), { name: 'flag', start: 5, end: 5 }, '冒号优先：flag 5:5 是位范围，不是位宽 5');

deep(parseSpec('a:3\nb:4\nc:1', 8).fields, R_W.fields, '显式 totalWidth=8 与自适配结果一致');
deep(parseSpec('a:3\nb:4\nc:1', 16).fields, [
  { name: 'a', start: 13, end: 15 },
  { name: 'b', start: 9, end: 12 },
  { name: 'c', start: 8, end: 8 }
], 'totalWidth=16：从 bit15 向下分配');
deep(parseSpec('a:1\nb:1\nc:1', 4).fields, [
  { name: 'a', start: 3, end: 3 },
  { name: 'b', start: 2, end: 2 },
  { name: 'c', start: 1, end: 1 }
], 'totalWidth=4：只用高 3 位，低位留空');
deep(f0('x:64'), { name: 'x', start: 0, end: 63 }, '单个 64 位字段');
deep(parseSpec('a:3\nb:2').fields, [
  { name: 'a', start: 2, end: 4 },
  { name: 'b', start: 0, end: 1 }
], '自适配按字段宽度之和（3+2=5 → bit4..0）');

// ---------- parseSpec：按位宽的非法宽度与总量溢出 ----------
eq(parseSpec('a:0').errors.length, 1, '宽度 0 → 报错');
assert.ok(/字段宽度非法/.test(e0('a:0').message), '宽度 0 → 字段宽度非法');
eq(parseSpec('a:-3').errors.length, 1, '负宽度 → 报错');
eq(parseSpec('a:0').fields.length, 0, '宽度非法 → 不进 fields');

const R_OVF = parseSpec('a:32\nb:32\nc:1');
eq(R_OVF.errors.length, 1, '累计 65 位 → 只报一条（第一个放不下的字段）');
eq(R_OVF.errors[0].line, 3, '溢出错误行号指向第一个放不下的字段');
eq(R_OVF.errors[0].message, '字段总宽度超出 64 位', '溢出错误信息');
deep(R_OVF.fields, [{ name: 'a', start: 32, end: 63 }, { name: 'b', start: 0, end: 31 }],
  '溢出：前面已分配的字段保留');
eq(parseSpec('a:65').errors.length, 1, '单字段宽度 65 → 溢出');

const R_OVF2 = parseSpec('a:40\nb:30\nc:8\nd:1');
eq(R_OVF2.errors.length, 3, '溢出后后续每一行都标错（级联 3 条）');
eq(R_OVF2.errors[0].line, 2, '级联：第一条错误是放不下的那一行');
eq(R_OVF2.errors[2].line, 4, '级联：最后一行也被标错');
deep(R_OVF2.fields.map(function (f) { return f.name; }), ['a'], '级联：溢出前的字段保留');
eq(parseSpec('a:4\nb:4\nc:4', 8).errors[0].line, 3, 'totalWidth=8 时第三个 4 位字段放不下');

const R_DUPW = parseSpec('rd 7:4\nrd:3');
eq(R_DUPW.errors.length, 1, '显式与按位宽混用：重名照样检出');
eq(R_DUPW.errors[0].message, '字段名重复: rd', '跨写法重名的错误信息');
eq(R_DUPW.fields.length, 1, '跨写法重名：先出现的保留');

const R_MIXW = parseSpec('opcode 15:12\nmode:3');
eq(R_MIXW.fields.length, 2, '显式位范围与按位宽可混用');
deep(R_MIXW.fields[1], { name: 'mode', start: 0, end: 2 }, '按位宽字段按自身宽度之和分配');
deep(overlaps(parseSpec('opcode 15:0\nmode:4').fields), [{ a: 'opcode', b: 'mode' }],
  '混用后重叠由 overlaps 检出');

// ---------- decode：signed（按字段宽度符号扩展） ----------
const D_SIGN = decode(0xF0n, [{ name: 'n', start: 4, end: 7 }])[0];
bigeq(D_SIGN.value, 15n, '新增 signed/mask 后 value 不变');
bigeq(D_SIGN.signed, -1n, 'signed：宽度 4 的 0xF → -1');
bigeq(decode(0x8000n, [{ name: 'n', start: 8, end: 15 }])[0].signed, -128n, 'signed：宽度 8 的 0x80 → -128');
bigeq(decode(0x7Fn, [{ name: 'n', start: 0, end: 7 }])[0].signed, 127n, 'signed：最高位为 0 时与 value 相同');
bigeq(decode(1n, [{ name: 'b', start: 0, end: 0 }])[0].signed, -1n, 'signed：宽度 1 的 1 → -1');
bigeq(decode(-1n, F_FULL)[0].signed, -1n, 'signed：宽度 64 全 1 → -1');
bigeq(decode(0xBC0n, [{ name: 'a', start: 4, end: 11 }])[0].signed, -68n, 'signed：跨字节字段 0xBC → -68');

// ---------- decode：mask（该字段在 64 位整数中的掩码） ----------
bigeq(D_SIGN.mask, 0xF0n, 'mask：字段 7:4 → 0xF0');
bigeq(decode(0n, [{ name: 'b', start: 0, end: 0 }])[0].mask, 1n, 'mask：bit0 → 1');
bigeq(decode(0n, [{ name: 'h', start: 63, end: 63 }])[0].mask, 1n << 63n, 'mask：bit63 → 1<<63');
bigeq(decode(0n, F_FULL)[0].mask, 0xFFFFFFFFFFFFFFFFn, 'mask：全 64 位');
bigeq(decode(0n, [{ name: 'x', start: 8, end: 19 }])[0].mask, 0xFFF00n, 'mask：跨字节字段 19:8');

const SRC_SELF = 0xDEADBEEFn;
const M_SELF = decode(SRC_SELF, [{ name: 'x', start: 8, end: 19 }])[0];
bigeq((BigInt.asUintN(64, SRC_SELF) & M_SELF.mask) >> 8n, M_SELF.value, 'mask 与 value 自洽：(u & mask) >> start === value');
eq(Object.keys(M_SELF).length, 10, 'decode 每行 10 个键（含 signed/mask）');

// ---------- specToText：字段回写成定义文本 ----------
eq(typeof specToText, 'function', 'specToText 已导出');
eq(specToText(R4.fields), 'opcode 15:12\nrd 11:8\nrs1 7:4\nimm 3:0', 'specToText 按 start 降序输出「名称 高:低」');
eq(specToText([]), '', 'specToText 空数组 → 空字符串');
eq(specToText([{ name: 'x', start: 3, end: 8 }]), 'x 8:3', 'specToText 对写反的字段输出 高:低');
eq(specToText([{ name: 'lo', start: 0, end: 3 }, { name: 'hi', start: 12, end: 15 }]),
  'hi 15:12\nlo 3:0', 'specToText 重排为 start 降序');
deep(parseSpec(specToText(R_W.fields)).fields, R_W.fields, 'specToText → parseSpec 往返一致（按位宽结果）');
deep(parseSpec(specToText([{ name: 'x', start: 3, end: 8 }])).fields,
  [{ name: 'x', start: 3, end: 8 }], 'specToText 往返修正写反的位范围');
deep(parseSpec(specToText(R4.fields)).fields, R4.fields, 'specToText → parseSpec 往返一致（示例 spec）');

// 二进制定宽字符串的期望值（宽度 64 全 0，每 4 位一组）
function groupOf(ch, width) {
  const s = ch.repeat(width);
  return s.match(new RegExp('.{1,4}', 'g')).join(' ');
}

console.log('全部 ' + passed + ' 个用例通过 ✅');

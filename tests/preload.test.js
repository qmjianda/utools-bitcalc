'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitcalc-preload-'));
const store = new Map();
const copied = [];

global.window = {};
global.utools = {
  dbStorage: {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  },
  getPluginLocalDataPath() {
    return tempDir;
  },
  copyText(text) {
    copied.push(text);
    return true;
  },
  showSaveDialog() {
    return path.join(tempDir, 'exported-schemes.json');
  },
};

require('../preload.js');
const host = global.window.bitcalcHost;

test.after(() => {
  delete global.window;
  delete global.utools;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('preload persists settings, value, fields and schemes', () => {
  assert.ok(host, 'window.bitcalcHost should be exposed');
  assert.deepEqual(host.loadState(), {
    ok: true,
    settings: null,
    value: null,
    fields: null,
    schemes: null,
  });

  assert.deepEqual(
    host.saveSettings({ width: 32, signed: true, endian: 'LE', base: 'HEX', theme: 'light' }),
    { ok: true }
  );
  assert.deepEqual(host.saveValue('305419896'), { ok: true });
  assert.deepEqual(host.saveFields('opcode 15:12'), { ok: true });
  assert.deepEqual(host.saveSchemes([{ id: 'a', name: 'A', text: 'x 1:0' }]), { ok: true });

  const loaded = host.loadState();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.settings, {
    width: 32,
    signed: true,
    endian: 'LE',
    base: 'HEX',
    theme: 'light',
  });
  assert.equal(loaded.value, '305419896');
  assert.equal(loaded.fields, 'opcode 15:12');
  assert.deepEqual(loaded.schemes, [{ id: 'a', name: 'A', text: 'x 1:0' }]);
});

test('preload persists history locally and caps it', () => {
  assert.deepEqual(host.loadHistory(), { ok: true, history: [] });
  const items = Array.from({ length: 250 }, (_, index) => ({ id: String(index), after: String(index) }));
  assert.deepEqual(host.saveHistory(items), { ok: true });
  const loaded = host.loadHistory();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.history.length, 200);
  assert.equal(loaded.history[0].id, '0');

  const file = path.join(tempDir, 'history.json');
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, '{broken', 'utf8');
  const broken = host.loadHistory();
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.history, []);
});

test('preload copies text through uTools', () => {
  const result = host.copyText('0xDEADBEEF');
  assert.equal(result.ok, true);
  assert.equal(result.method, 'utools');
  assert.deepEqual(copied, ['0xDEADBEEF']);
});

test('preload saves a text file through the system dialog', () => {
  const result = host.saveTextFile('schemes.json', '{\"version\":1}');
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(tempDir, 'exported-schemes.json'));
  assert.equal(fs.readFileSync(result.path, 'utf8'), '{\"version\":1}');
});

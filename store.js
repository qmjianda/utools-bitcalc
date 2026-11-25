/**
 * store.js — 本地持久化：字段定义原文 / 历史记录 / 命名方案
 *
 * 为什么单独成文件：
 *   main.js 负责交互，不该再纠缠 localStorage 的读写与容错（配额、隐私模式抛错）。
 *   这里全是纯数据操作，可以脱离浏览器单测（test-store.js 注入假 storage）。
 *
 * 数据都是 JSON 数组，写入前统一 try/catch：uTools 里 localStorage 偶尔被清、或配额满，
 * 失败只能退化成"本次会话可用"，绝不能让插件因此白屏。
 */
(function (root, factory) {
  // root 要显式传进工厂：之前工厂不接参数，detectStorage 里的 root.* 在
  // 浏览器里只是碰巧能从「别的脚本留下的全局 root」读到，Node 下直接 ReferenceError。
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root);
  } else {
    root.BitCalcStore = factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var KEYS = {
    spec: 'bitcalc.fields.v1',
    history: 'bitcalc.history.v1',
    schemes: 'bitcalc.schemes.v1',
    settings: 'bitcalc.settings.v1'
  };

  var HISTORY_MAX = 60;
  var SCHEMES_MAX = 40;
  var NAME_MAX = 24;

  /** 内存版 storage：localStorage 不可用时兜底，形状与 Storage 一致 */
  function memoryStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  /**
   * 选存储后端：uTools 的 dbStorage → localStorage → 内存。
   *
   * 为什么不直接用 localStorage：uTools 的插件页是本地文件，localStorage 的
   * 可用性和生命周期都随 Electron 版本/清缓存而变；dbStorage 是官方持久层，
   * 插件升级与清缓存后仍在，所以只要在 uTools 里就优先用它。浏览器预览
   * （没有 utools 对象）再退回 localStorage。
   */
  function detectStorage() {
    var ut = root.utools;
    if (ut && ut.dbStorage && typeof ut.dbStorage.getItem === 'function') {
      try {
        var db = ut.dbStorage;
        db.setItem('__bitcalc_probe__', '1');
        var kept = db.getItem('__bitcalc_probe__') === '1';
        db.removeItem('__bitcalc_probe__');
        if (kept) {
          return {
            getItem: function (k) {
              var v = db.getItem(k);
              return v == null ? null : String(v);
            },
            setItem: function (k, v) { db.setItem(k, String(v)); },
            removeItem: function (k) { db.removeItem(k); }
          };
        }
      } catch (err) { /* 落到 localStorage */ }
    }
    try {
      var s = root.localStorage;
      if (!s) { return memoryStorage(); }
      var probe = '__bitcalc_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (err) {
      return memoryStorage();
    }
  }

  function createStore(storage) {
    var box = storage || memoryStorage();

    function readArray(key) {
      try {
        var raw = box.getItem(key);
        if (!raw) { return []; }
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (err) {
        return [];
      }
    }

    function writeArray(key, arr) {
      try {
        box.setItem(key, JSON.stringify(arr));
        return true;
      } catch (err) {
        return false;
      }
    }

    function readText(key) {
      try { return box.getItem(key) || ''; } catch (err) { return ''; }
    }

    function writeText(key, text) {
      try { box.setItem(key, String(text == null ? '' : text)); return true; } catch (err) { return false; }
    }

    function clipName(name) {
      return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    }

    // ---------- 字段定义原文 ----------
    function getSpec() { return readText(KEYS.spec); }
    function setSpec(text) { return writeText(KEYS.spec, text); }

    // ---------- 历史记录 ----------
    // 每条：{ expr, value(十进制字符串), width, signed, ts }
    // value 存字符串是因为 BigInt 不能直接 JSON 化，而 64 位会超 Number 安全整数。
    function historyList() {
      return readArray(KEYS.history).filter(function (e) {
        return e && typeof e.expr === 'string' && e.expr && typeof e.value === 'string';
      });
    }

    function historyPush(entry) {
      var expr = String((entry && entry.expr) || '').trim();
      if (!expr) { return historyList(); }
      var value = String((entry && entry.value) || '0');
      var width = Number((entry && entry.width) || 64);
      var signed = !!(entry && entry.signed);
      var ts = Number((entry && entry.ts) || Date.now());

      var list = historyList().filter(function (e) {
        return !(e.expr === expr && e.value === value && e.width === width);
      });
      list.unshift({ expr: expr, value: value, width: width, signed: signed, ts: ts });
      list = list.slice(0, HISTORY_MAX);
      writeArray(KEYS.history, list);
      return list;
    }

    function historyClear() {
      writeArray(KEYS.history, []);
      return [];
    }

    // ---------- 命名方案 ----------
    // 每条：{ name, spec, width, ts }，按更新时间倒序
    function schemeList() {
      return readArray(KEYS.schemes).filter(function (s) {
        return s && typeof s.name === 'string' && s.name && typeof s.spec === 'string';
      }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    }

    function schemeGet(name) {
      var key = clipName(name);
      var list = schemeList();
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === key) { return list[i]; }
      }
      return null;
    }

    function schemeSave(name, spec, width) {
      var key = clipName(name);
      if (!key) { return { ok: false, reason: 'empty-name', list: schemeList() }; }
      var text = String(spec == null ? '' : spec);
      if (!text.trim()) { return { ok: false, reason: 'empty-spec', list: schemeList() }; }

      var list = schemeList().filter(function (s) { return s.name !== key; });
      list.unshift({ name: key, spec: text, width: Number(width) || 64, ts: Date.now() });
      list = list.slice(0, SCHEMES_MAX);
      var ok = writeArray(KEYS.schemes, list);
      return { ok: ok, reason: ok ? '' : 'storage', list: ok ? list : schemeList() };
    }

    function schemeDelete(name) {
      var key = clipName(name);
      var list = schemeList().filter(function (s) { return s.name !== key; });
      writeArray(KEYS.schemes, list);
      return list;
    }

    // ---------- 界面设置 ----------
    // { width, signed, le, mode }：位宽/符号/字节序/模式，下次进入沿用
    function getSettings() {
      try {
        var raw = box.getItem(KEYS.settings);
        if (!raw) { return {}; }
        var obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
      } catch (err) {
        return {};
      }
    }

    function patchSettings(patch) {
      var next = getSettings();
      if (patch && typeof patch === 'object') {
        Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      }
      try { box.setItem(KEYS.settings, JSON.stringify(next)); } catch (err) { /* 忽略 */ }
      return next;
    }

    return {
      keys: KEYS,
      historyMax: HISTORY_MAX,
      schemeNameMax: NAME_MAX,
      getSpec: getSpec,
      setSpec: setSpec,
      historyList: historyList,
      historyPush: historyPush,
      historyClear: historyClear,
      schemeList: schemeList,
      schemeGet: schemeGet,
      schemeSave: schemeSave,
      schemeDelete: schemeDelete,
      getSettings: getSettings,
      patchSettings: patchSettings,
      clipName: clipName
    };
  }

  var api = createStore(detectStorage());
  api.createStore = createStore;
  api.memoryStorage = memoryStorage;
  api.KEYS = KEYS;
  return api;
});

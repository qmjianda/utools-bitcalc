'use strict';

const fs = require('node:fs');
const path = require('node:path');

let electron = null;
try {
  electron = require('electron');
} catch (error) {
  electron = null;
}

const STORE_KEYS = {
  settings: 'bitcalc.settings',
  value: 'bitcalc.value',
  fields: 'bitcalc.fields',
  schemes: 'bitcalc.schemes',
};

function hasUtools() {
  return typeof utools !== 'undefined';
}

function readStored(key) {
  if (!hasUtools() || !utools.dbStorage) return null;
  try {
    const raw = utools.dbStorage.getItem(key);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (error) {
        return raw;
      }
    }
    return raw;
  } catch (error) {
    return null;
  }
}

function writeStored(key, value) {
  if (!hasUtools() || !utools.dbStorage) {
    return { ok: false, error: 'uTools 数据存储不可用' };
  }
  try {
    utools.dbStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : '保存失败' };
  }
}

function historyFilePath() {
  return path.join(utools.getPluginLocalDataPath(), 'history.json');
}

function loadHistory() {
  if (!hasUtools()) return { ok: false, error: 'uTools 环境不可用', history: [] };
  try {
    const file = historyFilePath();
    if (!fs.existsSync(file)) return { ok: true, history: [] };
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return { ok: true, history: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ok: true, history: parsed };
    if (parsed && Array.isArray(parsed.items)) return { ok: true, history: parsed.items };
    return { ok: true, history: [] };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : '读取历史失败',
      history: [],
    };
  }
}

function saveHistory(items) {
  if (!hasUtools()) return { ok: false, error: 'uTools 环境不可用' };
  try {
    const list = Array.isArray(items) ? items.slice(0, 200) : [];
    const dir = utools.getPluginLocalDataPath();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'history.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, items: list }), 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : '保存历史失败' };
  }
}

function copyText(text) {
  const value = String(text == null ? '' : text);
  if (hasUtools() && typeof utools.copyText === 'function') {
    try {
      if (utools.copyText(value)) return { ok: true, method: 'utools' };
    } catch (error) {
      // Fall through to Electron clipboard.
    }
  }
  if (electron && electron.clipboard) {
    try {
      electron.clipboard.writeText(value);
      return { ok: true, method: 'electron' };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : '复制失败' };
    }
  }
  return { ok: false, error: '复制不可用' };
}

function saveTextFile(defaultName, text) {
  if (!hasUtools()) return { ok: false, error: 'uTools 环境不可用' };
  if (typeof utools.showSaveDialog !== 'function') return { ok: false, error: '保存对话框不可用' };
  try {
    const savePath = utools.showSaveDialog({
      title: '导出字段方案',
      defaultPath: defaultName,
      buttonLabel: '保存',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!savePath) return { ok: false, canceled: true };
    fs.writeFileSync(savePath, String(text == null ? '' : text), 'utf8');
    return { ok: true, path: savePath };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : '保存失败' };
  }
}

window.bitcalcHost = {
  loadState() {
    const settings = readStored(STORE_KEYS.settings);
    const value = readStored(STORE_KEYS.value);
    const fields = readStored(STORE_KEYS.fields);
    const schemes = readStored(STORE_KEYS.schemes);
    return {
      ok: hasUtools(),
      settings: settings,
      value: value,
      fields: fields,
      schemes: schemes,
    };
  },
  saveSettings(settings) {
    return writeStored(STORE_KEYS.settings, settings);
  },
  saveValue(value) {
    return writeStored(STORE_KEYS.value, String(value));
  },
  saveFields(text) {
    return writeStored(STORE_KEYS.fields, String(text));
  },
  saveSchemes(schemes) {
    return writeStored(STORE_KEYS.schemes, Array.isArray(schemes) ? schemes : []);
  },
  loadHistory() {
    return loadHistory();
  },
  saveHistory(items) {
    return saveHistory(items);
  },
  copyText(text) {
    return copyText(text);
  },
  saveTextFile(defaultName, text) {
    return saveTextFile(defaultName, text);
  },
};

'use strict';

(function () {
  const core = window.BitcalcCore;
  if (!core) {
    document.body.textContent = 'bitcalc 核心加载失败。';
    return;
  }

  const WIDTHS = core.WIDTHS;
  const BASES = core.BASES;
  const STORAGE_KEYS = {
    settings: 'bitcalc.settings',
    value: 'bitcalc.value',
    fields: 'bitcalc.fields',
    schemes: 'bitcalc.schemes',
    history: 'bitcalc.history',
    theme: 'bitcalc.theme',
  };
  // 字段定义上限：防止超大粘贴内容进入账号同步库（约 400 行定义）。
  const FIELD_TEXT_MAX = 10000;
  const TYPE_LABELS = {
    expr: '表达式',
    field: '字段',
    range: '位段',
    bit: '位操作',
    direct: '赋值',
  };
  const COPY_LABELS = {
    hex: 'HEX',
    dec: 'DEC',
    oct: 'OCT',
    bin: 'BIN',
    f32: 'F32',
    f64: 'F64',
  };
  const EXAMPLE_FIELDS_16 = [
    '# 16 位指令示例',
    'opcode 15:12',
    'dst 11:8',
    'src 7:4',
    'mode:3',
    'flag 0:0',
  ].join('\n');
  const EXAMPLE_FIELDS_8 = [
    '# 8 位寄存器示例',
    'kind 7:6',
    'payload 5:2',
    'flag 1:1',
    'valid 0:0',
  ].join('\n');

  const state = {
    value: 0n,
    settings: normalizeSettings(null),
    fieldText: '',
    fieldResult: { fields: [], errors: [], warnings: [], stats: { fieldCount: 0, errorCount: 0, warningCount: 0, usedBits: 0 } },
    schemes: [],
    history: [],
    range: null,
    rangeAnchor: null,
    focusBit: 0,
    selectedFieldName: null,
    hoverFieldName: null,
    exprHistoryCursor: null,
    exprHistoryDraft: null,
    undoStack: [],
    redoStack: [],
    storageMode: 'browser',
    initialized: false,
    saveErrorShown: false,
  };

  let els = {};
  let appReady = null;
  let confirmState = null;
  let draggingBits = false;
  let dragAnchor = null;
  let dragMoved = false;
  let suppressBitClick = false;
  let fieldSaveTimer = null;
  let historySaveTimer = null;
  const copyTimers = new WeakMap();

  /* ------------------------------------------------------------------ */
  /* Utilities                                                          */
  /* ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeIcon(name, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className || 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function getUtools() {
    return window.utools && typeof window.utools === 'object' ? window.utools : null;
  }

  function getHost() {
    return window.bitcalcHost && typeof window.bitcalcHost === 'object' ? window.bitcalcHost : null;
  }

  function makeId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(ts) {
    const date = new Date(Number(ts) || Date.now());
    return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function formatFullTime(ts) {
    try {
      return new Date(Number(ts) || Date.now()).toLocaleString('zh-CN');
    } catch (error) {
      return formatTime(ts);
    }
  }

  function safeParse(text, fallback) {
    if (text === null || text === undefined || text === '') return fallback;
    if (typeof text !== 'string') return text;
    try {
      return JSON.parse(text);
    } catch (error) {
      return fallback;
    }
  }

  function readLocal(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return safeParse(raw, fallback);
    } catch (error) {
      return fallback;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function readDbKey(key) {
    const utools = getUtools();
    if (!utools || !utools.dbStorage) return null;
    try {
      const raw = utools.dbStorage.getItem(key);
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'string') return safeParse(raw, raw);
      return raw;
    } catch (error) {
      return null;
    }
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const attrTheme = document.documentElement.getAttribute('data-theme');
    return {
      width: WIDTHS.indexOf(Number(source.width)) >= 0 ? Number(source.width) : 64,
      signed: !!source.signed,
      endian: source.endian === 'LE' ? 'LE' : 'BE',
      base: BASES.indexOf(source.base) >= 0 ? source.base : 'HEX',
      theme: source.theme === 'dark' || source.theme === 'light'
        ? source.theme
        : (attrTheme === 'dark' ? 'dark' : 'light'),
      showFloat: !!source.showFloat,
    };
  }

  function normalizeSchemes(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .filter(function (item) {
        return item && typeof item.name === 'string' && typeof item.text === 'string';
      })
      .slice(0, 120)
      .map(function (item) {
        const now = Date.now();
        return {
          id: typeof item.id === 'string' && item.id ? item.id : makeId('scheme'),
          name: item.name.slice(0, 60),
          text: item.text.slice(0, FIELD_TEXT_MAX),
          createdAt: Number(item.createdAt) || now,
          updatedAt: Number(item.updatedAt) || Number(item.createdAt) || now,
          width: WIDTHS.indexOf(Number(item.width)) >= 0 ? Number(item.width) : null,
          fieldCount: Number.isFinite(Number(item.fieldCount)) ? Number(item.fieldCount) : null,
        };
      });
  }

  function normalizeHistory(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .filter(function (item) {
        return item && TYPE_LABELS[item.type] && item.before !== undefined && item.after !== undefined;
      })
      .slice(0, 100)
      .map(function (item) {
        return {
          id: typeof item.id === 'string' && item.id ? item.id : makeId('history'),
          ts: Number(item.ts) || Date.now(),
          type: TYPE_LABELS[item.type] ? item.type : 'direct',
          label: typeof item.label === 'string' ? item.label : TYPE_LABELS[item.type] || '操作',
          expression: typeof item.expression === 'string' ? item.expression : '',
          fieldName: typeof item.fieldName === 'string' ? item.fieldName : '',
          hi: Number.isInteger(item.hi) ? item.hi : null,
          lo: Number.isInteger(item.lo) ? item.lo : null,
          before: String(item.before),
          after: String(item.after),
          width: WIDTHS.indexOf(Number(item.width)) >= 0 ? Number(item.width) : 64,
        };
      });
  }

  function parseStoredValue(raw, width) {
    try {
      const text = String(raw === null || raw === undefined ? '0' : raw).trim() || '0';
      return core.toWidth(BigInt(text), width);
    } catch (error) {
      return 0n;
    }
  }

  function setPressed(container, dataKey, value) {
    if (!container) return;
    container.querySelectorAll('button').forEach(function (button) {
      const actual = button.dataset[dataKey];
      button.setAttribute('aria-pressed', String(actual) === String(value) ? 'true' : 'false');
    });
  }

  function fieldColor(field) {
    const index = field && Number.isInteger(field.colorIndex) ? field.colorIndex % 8 : 0;
    return 'var(--field-' + (index + 1) + ')';
  }

  function fieldsAtBit(bit) {
    return state.fieldResult.fields.filter(function (field) {
      return bit >= field.lo && bit <= field.hi;
    });
  }

  function getFieldForRange(hi, lo) {
    return state.fieldResult.fields.find(function (field) {
      return field.hi === hi && field.lo === lo;
    }) || null;
  }

  function getSelectedField() {
    if (!state.selectedFieldName) return null;
    return state.fieldResult.fields.find(function (field) {
      return field.name === state.selectedFieldName;
    }) || null;
  }

  function isEditable(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function groupFromLeft(text, size) {
    return text.replace(new RegExp('(.{' + size + '})(?=.)', 'g'), '$1 ');
  }

  function groupFromRight(text, size) {
    return text.replace(new RegExp('\\B(?=(?:\\d{' + size + '})+(?!\\d))', 'g'), ',');
  }

  function groupDecimal(text) {
    const negative = text.charAt(0) === '-';
    const body = negative ? text.slice(1) : text;
    return (negative ? '-' : '') + groupFromRight(body, 3);
  }

  function compactHex(value, width) {
    return core.toWidth(value, width).toString(16).toUpperCase();
  }

  function compactOct(value, width) {
    return core.toWidth(value, width).toString(8);
  }

  function compactBin(value, width) {
    const body = core.toWidth(value, width).toString(2);
    const padded = body.padStart(Math.max(4, Math.ceil(body.length / 4) * 4), '0');
    return padded;
  }

  function groupHex(text) {
    return text.replace(/\B(?=(?:[0-9A-F]{4})+$)/g, ' ');
  }

  function getDisplayWidth() {
    return state.range ? state.range.hi - state.range.lo + 1 : state.settings.width;
  }

  function getDisplayValue() {
    if (!state.range) return state.value;
    return core.readRange(state.value, state.range.hi, state.range.lo);
  }

  function setExpressionFromValue(value, width) {
    if (!els.exprInput) return;
    els.exprInput.value = '0x' + (compactHex(value, width) || '0');
    state.exprHistoryCursor = null;
    state.exprHistoryDraft = null;
    hideExprMessages();
  }

  /* ------------------------------------------------------------------ */
  /* Storage                                                            */
  /* ------------------------------------------------------------------ */

  function loadPersisted() {
    const host = getHost();
    const utools = getUtools();
    const localFallback = {
      settings: readLocal(STORAGE_KEYS.settings, null),
      value: readLocal(STORAGE_KEYS.value, null),
      fields: readLocal(STORAGE_KEYS.fields, null),
      schemes: readLocal(STORAGE_KEYS.schemes, null),
      history: readLocal(STORAGE_KEYS.history, []),
    };

    let loaded = {};
    let canUseUtools = false;

    if (host && typeof host.loadState === 'function') {
      canUseUtools = true;
      try {
        const result = host.loadState();
        if (result && result.ok) loaded = result;
      } catch (error) {
        // Fall back to direct dbStorage or localStorage below.
      }
    }

    if ((!loaded || Object.keys(loaded).length === 0) && utools && utools.dbStorage) {
      canUseUtools = true;
      loaded = {
        settings: readDbKey(STORAGE_KEYS.settings),
        value: readDbKey(STORAGE_KEYS.value),
        fields: readDbKey(STORAGE_KEYS.fields),
        schemes: readDbKey(STORAGE_KEYS.schemes),
      };
    }

    state.storageMode = canUseUtools ? 'utools' : 'browser';

    const settingsRaw = loaded.settings !== null && loaded.settings !== undefined ? loaded.settings : localFallback.settings;
    state.settings = normalizeSettings(settingsRaw);
    applyTheme(state.settings.theme, false);

    const valueRaw = loaded.value !== null && loaded.value !== undefined ? loaded.value : localFallback.value;
    state.value = parseStoredValue(valueRaw, state.settings.width);

    const fieldsRaw = loaded.fields !== null && loaded.fields !== undefined ? loaded.fields : localFallback.fields;
    state.fieldText = typeof fieldsRaw === 'string' ? fieldsRaw.slice(0, FIELD_TEXT_MAX) : '';

    const schemesRaw = loaded.schemes !== null && loaded.schemes !== undefined ? loaded.schemes : localFallback.schemes;
    state.schemes = normalizeSchemes(schemesRaw);

    let historyRaw = null;
    if (host && typeof host.loadHistory === 'function') {
      try {
        const result = host.loadHistory();
        if (result && result.ok && Array.isArray(result.history)) historyRaw = result.history;
      } catch (error) {
        historyRaw = null;
      }
    }
    if (!historyRaw) historyRaw = localFallback.history;
    state.history = normalizeHistory(historyRaw);
  }

  function noteSaveFailure() {
    if (state.saveErrorShown) return;
    state.saveErrorShown = true;
    showToast('本地保存失败，请检查存储权限', 'error');
  }

  function writePersistent(kind, value) {
    let ok = false;
    const host = getHost();
    if (host) {
      try {
        let result = null;
        if (kind === 'settings' && typeof host.saveSettings === 'function') result = host.saveSettings(value);
        else if (kind === 'value' && typeof host.saveValue === 'function') result = host.saveValue(value);
        else if (kind === 'fields' && typeof host.saveFields === 'function') result = host.saveFields(value);
        else if (kind === 'schemes' && typeof host.saveSchemes === 'function') result = host.saveSchemes(value);
        if (result === true || (result && result.ok)) ok = true;
      } catch (error) {
        ok = false;
      }
    }

    if (!ok) {
      const utools = getUtools();
      if (utools && utools.dbStorage) {
        try {
          utools.dbStorage.setItem(STORAGE_KEYS[kind], JSON.stringify(value));
          ok = true;
        } catch (error) {
          ok = false;
        }
      }
    }

    if (!ok) ok = writeLocal(STORAGE_KEYS[kind], value);
    if (ok) state.saveErrorShown = false;
    else noteSaveFailure();
    return ok;
  }

  function writeHistoryPersistent(items) {
    let ok = false;
    const host = getHost();
    if (host && typeof host.saveHistory === 'function') {
      try {
        const result = host.saveHistory(items);
        if (result === true || (result && result.ok)) ok = true;
      } catch (error) {
        ok = false;
      }
    }
    if (!ok) ok = writeLocal(STORAGE_KEYS.history, items);
    if (ok) state.saveErrorShown = false;
    else noteSaveFailure();
    return ok;
  }

  function persistSettings() {
    writePersistent('settings', state.settings);
  }

  function persistValue() {
    writePersistent('value', state.value.toString());
  }

  function persistFields() {
    writePersistent('fields', state.fieldText.slice(0, FIELD_TEXT_MAX));
  }

  function persistSchemes() {
    writePersistent('schemes', state.schemes);
  }

  function persistHistory() {
    writeHistoryPersistent(state.history);
  }

  function scheduleFieldSave() {
    if (fieldSaveTimer) clearTimeout(fieldSaveTimer);
    fieldSaveTimer = setTimeout(function () {
      fieldSaveTimer = null;
      persistFields();
    }, 220);
  }

  function scheduleHistorySave() {
    if (historySaveTimer) clearTimeout(historySaveTimer);
    historySaveTimer = setTimeout(function () {
      historySaveTimer = null;
      persistHistory();
    }, 300);
  }

  function flushAll() {
    if (!state.initialized) return;
    if (fieldSaveTimer) {
      clearTimeout(fieldSaveTimer);
      fieldSaveTimer = null;
    }
    if (historySaveTimer) {
      clearTimeout(historySaveTimer);
      historySaveTimer = null;
    }
    persistSettings();
    persistValue();
    persistFields();
    persistSchemes();
    persistHistory();
  }

  /* ------------------------------------------------------------------ */
  /* Theme / toast / clipboard                                          */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme, persist) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    state.settings.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEYS.theme, next);
    } catch (error) {
      // Theme still applies for this session.
    }
    if (els.menuThemeText) {
      els.menuThemeText.textContent = next === 'dark' ? '切换浅色主题' : '切换深色主题';
    }
    if (persist) persistSettings();
  }

  function toggleTheme() {
    applyTheme(state.settings.theme === 'dark' ? 'light' : 'dark', true);
  }

  function showToast(message, kind) {
    if (!els.toastRegion) return;
    const type = kind === 'error' || kind === 'warn' ? kind : 'success';
    const toast = el('div', 'toast' + (type !== 'success' ? ' is-' + type : ''));
    toast.append(makeIcon(type === 'success' ? 'check' : 'alert'));
    toast.append(el('span', '', message));
    while (els.toastRegion.children.length >= 4) {
      els.toastRegion.firstElementChild.remove();
    }
    els.toastRegion.append(toast);
    const life = type === 'error' ? 3800 : type === 'warn' ? 3000 : 2200;
    setTimeout(function () {
      toast.classList.add('is-leaving');
      setTimeout(function () {
        toast.remove();
      }, 160);
    }, life);
  }

  function announce(message) {
    if (!els.srStatus) return;
    els.srStatus.textContent = '';
    window.setTimeout(function () {
      els.srStatus.textContent = message;
    }, 20);
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    const host = getHost();
    if (host && typeof host.copyText === 'function') {
      try {
        const result = host.copyText(text);
        if (result === true || (result && result.ok)) return true;
      } catch (error) {
        // Continue.
      }
    }
    const utools = getUtools();
    if (utools && typeof utools.copyText === 'function') {
      try {
        if (utools.copyText(text)) return true;
      } catch (error) {
        // Continue.
      }
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        // Continue.
      }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch (error) {
      return false;
    }
  }

  function markCopied(button, label) {
    if (button) {
      const previous = copyTimers.get(button);
      if (previous) clearTimeout(previous);
      const use = button.querySelector('use');
      const original = use ? use.getAttribute('href') : null;
      if (use) use.setAttribute('href', '#i-check');
      button.classList.add('is-copied');
      const timer = setTimeout(function () {
        button.classList.remove('is-copied');
        if (use && original) use.setAttribute('href', original);
        copyTimers.delete(button);
      }, 1100);
      copyTimers.set(button, timer);
    }
    announce('已复制 ' + label);
  }

  function getCopyValue(kind) {
    const width = getDisplayWidth();
    const value = getDisplayValue();
    switch (kind) {
      case 'hex': {
        const body = core.formatHex(value, width, state.settings.endian).slice(2);
        return '0x' + (body.replace(/^0+(?=[0-9A-F])/, '') || '0');
      }
      case 'dec':
        return core.formatDec(value, width, state.settings.signed);
      case 'oct':
        return '0o' + compactOct(value, width);
      case 'bin':
        return '0b' + compactBin(value, width);
      case 'f32':
        return core.formatFloat(value, width, 'F32') || '';
      case 'f64':
        return core.formatFloat(value, width, 'F64') || '';
      default:
        return '';
    }
  }

  async function handleCopyKind(kind, button) {
    const text = getCopyValue(kind);
    if (!text) {
      showToast('当前读数不可用', 'warn');
      return;
    }
    const ok = await copyToClipboard(text);
    if (!ok) {
      showToast('复制失败，请检查剪贴板权限', 'error');
      return;
    }
    markCopied(button, COPY_LABELS[kind] || '读数');
  }

  /* ------------------------------------------------------------------ */
  /* Value rendering                                                    */
  /* ------------------------------------------------------------------ */

  function renderValue() {
    const width = getDisplayWidth();
    const value = getDisplayValue();
    const base = state.settings.base;

    if (state.range) {
      const hi = state.range.hi;
      const lo = state.range.lo;
      const field = getFieldForRange(hi, lo);
      els.bitHint.hidden = true;
      els.enableControls.hidden = false;
      els.enableRange.textContent = hi + ':' + lo;
      els.enableWidth.textContent = (hi - lo + 1) + ' 位';
      els.enableField.hidden = !field;
      els.enableField.textContent = field ? field.name : '';
      const mask = core.rangeMask(hi, lo);
      els.bitStatus.title = '位使能 ' + hi + ':' + lo + ' · 掩码 ' + core.formatHex(mask, state.settings.width, 'BE');
      els.enableExpandSelect.disabled = false;
      Array.from(els.enableExpandSelect.options).forEach(function (option) {
        if (option.value) option.disabled = Number(option.value) > state.settings.width;
      });
      els.enableExpandSelect.value = '';
    } else {
      els.bitHint.hidden = false;
      els.enableControls.hidden = true;
      els.bitStatus.removeAttribute('title');
      els.enableExpandSelect.disabled = true;
    }
    els.enableFlipBtn.disabled = !state.range;
    els.enableSet0Btn.disabled = !state.range;
    els.enableSet1Btn.disabled = !state.range;

    document.querySelectorAll('.base-main').forEach(function (button) {
      const active = button.dataset.base === base;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      const row = button.closest('.base-row');
      if (row) row.classList.toggle('is-active', active);
    });

    const hexRaw = core.formatHex(value, width, state.settings.endian);
    const hexBody = hexRaw.slice(2).replace(/^0+(?=[0-9A-F])/, '') || '0';
    els.valueHex.textContent = groupHex(hexBody);
    els.valueHex.title = '0x' + hexBody;

    const decRaw = core.formatDec(value, width, state.settings.signed);
    els.valueDec.textContent = groupDecimal(decRaw);
    els.valueDec.title = decRaw;

    const octBody = compactOct(value, width);
    els.valueOct.textContent = groupFromRight(octBody, 3);
    els.valueOct.title = '0o' + octBody;

    const binBody = compactBin(value, width);
    els.valueBin.textContent = groupFromLeft(binBody, 4);
    els.valueBin.title = '0b' + binBody;

    const supportsFloat = width >= 32 && !state.range;
    els.floatList.hidden = !supportsFloat || !state.settings.showFloat;
    els.floatF64Row.hidden = width < 64;

    const f32 = supportsFloat ? core.formatFloat(value, width, 'F32') : null;
    const f64 = supportsFloat ? core.formatFloat(value, width, 'F64') : null;
    els.valueF32.textContent = f32 === null ? '—' : f32;
    els.valueF32.title = f32 === null ? '部分位使能或当前位宽下不可用' : f32;
    els.valueF64.textContent = f64 === null ? '—' : f64;
    els.valueF64.title = f64 === null ? '部分位使能或当前位宽下不可用' : f64;
    toggleCopyDisabled('f32', f32 === null);
    toggleCopyDisabled('f64', f64 === null);

    renderSettingsControls();
  }

  function toggleCopyDisabled(kind, disabled) {
    const button = document.querySelector('[data-copy-kind="' + kind + '"]');
    if (!button) return;
    button.disabled = !!disabled;
  }

  function renderSettingsControls() {
    setPressed(els.dialogWidthSwitch, 'width', state.settings.width);
    setPressed(els.dialogSignSwitch, 'signed', state.settings.signed ? '1' : '0');
    setPressed(els.dialogEndianSwitch, 'endian', state.settings.endian);
    if (els.dialogFloatToggle) {
      const supportsFloat = state.settings.width >= 32 && !state.range;
      els.dialogFloatToggle.checked = !!state.settings.showFloat;
      els.dialogFloatToggle.disabled = !supportsFloat;
      const label = els.dialogFloatToggle.closest('.checkbox-row');
      if (label) label.title = supportsFloat ? '' : 'F32 / F64 需要 32 位或 64 位位宽';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bit grid                                                           */
  /* ------------------------------------------------------------------ */

  function buildBitGrid() {
    const width = state.settings.width;
    const rows = Math.ceil(width / 16);
    els.bitGrid.setAttribute('aria-rowcount', String(rows));
    els.bitGrid.setAttribute('aria-colcount', '16');
    els.bitGrid.setAttribute('aria-label', '位状态，共 ' + width + ' 位');
    els.bitGrid.replaceChildren();

    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const hi = width - 1 - rowIndex * 16;
      const lo = Math.max(0, hi - 15);
      const row = el('div', 'bit-row');
      row.setAttribute('role', 'row');
      for (let start = hi; start >= lo; start -= 4) {
        const nibble = el('div', 'nibble');
        for (let bit = start; bit >= Math.max(start - 3, lo); bit -= 1) {
          const cell = el('button', 'bit');
          cell.type = 'button';
          cell.dataset.bit = String(bit);
          cell.setAttribute('role', 'gridcell');
          cell.setAttribute('aria-selected', 'false');
          cell.tabIndex = -1;
          cell.append(el('span', 'bit-index', String(bit)));
          cell.append(el('span', 'bit-value', '0'));
          nibble.append(cell);
        }
        row.append(nibble);
      }
      els.bitGrid.append(row);
    }

    state.focusBit = Math.min(Math.max(state.focusBit, 0), width - 1);
    updateBitGrid();
  }

  function updateBitGrid() {
    const range = state.range;
    els.bitGrid.querySelectorAll('.bit').forEach(function (cell) {
      const bit = Number(cell.dataset.bit);
      const one = ((state.value >> BigInt(bit)) & 1n) === 1n;
      const selected = !!range && bit >= range.lo && bit <= range.hi;
      const disabled = !!range && !selected;
      const fields = fieldsAtBit(bit);
      const first = fields[0] || null;
      const hoveredField = state.hoverFieldName
        ? fields.find(function (field) { return field.name === state.hoverFieldName; })
        : null;
      cell.classList.toggle('is-one', one);
      cell.classList.toggle('is-selected', selected);
      cell.classList.toggle('is-disabled', disabled);
      cell.classList.toggle('is-field', !!first);
      cell.classList.toggle('is-field-hover', !!hoveredField);
      if (first) cell.style.setProperty('--field-color', fieldColor(first));
      else cell.style.removeProperty('--field-color');
      cell.tabIndex = bit === state.focusBit ? 0 : -1;
      cell.setAttribute('aria-selected', selected ? 'true' : 'false');
      cell.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      const fieldText = fields.length
        ? '，字段 ' + fields.map(function (field) { return field.name + ' ' + field.hi + ':' + field.lo; }).join('、')
        : '';
      const label = 'bit ' + bit + '，值 ' + (one ? '1' : '0') + fieldText + (disabled ? '，未使能' : '');
      cell.setAttribute('aria-label', label);
      cell.title = label;
      const value = cell.querySelector('.bit-value');
      if (value) value.textContent = one ? '1' : '0';
    });
  }

  function focusBitCell(bit, options) {
    const cell = els.bitGrid.querySelector('.bit[data-bit="' + bit + '"]');
    if (cell) cell.focus(options || { preventScroll: true });
  }

  function toggleBit(bit) {
    if (state.range && (bit < state.range.lo || bit > state.range.hi)) return;
    state.focusBit = bit;
    const next = core.flipRange(state.value, bit, bit, state.settings.width);
    if (state.range) {
      setExpressionFromValue(core.readRange(next, state.range.hi, state.range.lo), state.range.hi - state.range.lo + 1);
    }
    commitValue(next, {
      type: 'bit',
      label: '翻转 bit ' + bit,
      hi: bit,
      lo: bit,
      undoLabel: '翻转 bit ' + bit,
    });
  }

  function handleShiftRange(bit) {
    state.focusBit = bit;
    if (state.rangeAnchor === null) state.rangeAnchor = bit;
    state.selectedFieldName = null;
    setRange(state.rangeAnchor, bit);
    focusBitCell(bit);
  }

  function handleBitKeydown(event) {
    const cell = event.target.closest('.bit');
    if (!cell) return;
    const bit = Number(cell.dataset.bit);
    const width = state.settings.width;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) handleShiftRange(bit);
      else toggleBit(bit);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clearRange();
      return;
    }
    let next = null;
    if (event.key === 'ArrowLeft') next = Math.min(bit + 1, width - 1);
    else if (event.key === 'ArrowRight') next = Math.max(bit - 1, 0);
    else if (event.key === 'ArrowUp') next = Math.min(bit + 16, width - 1);
    else if (event.key === 'ArrowDown') next = Math.max(bit - 16, 0);
    else if (event.key === 'Home') next = width - 1;
    else if (event.key === 'End') next = 0;
    if (next !== null) {
      event.preventDefault();
      if (event.shiftKey) {
        const anchor = state.rangeAnchor === null ? bit : state.rangeAnchor;
        state.rangeAnchor = anchor;
        state.selectedFieldName = null;
        state.focusBit = next;
        setRange(anchor, next);
        updateBitGrid();
        focusBitCell(next);
        return;
      }
      if (state.range) {
        next = Math.min(Math.max(next, state.range.lo), state.range.hi);
      }
      state.focusBit = next;
      updateBitGrid();
      focusBitCell(next);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Range                                                              */
  /* ------------------------------------------------------------------ */

  function setRange(hi, lo) {
    const range = core.validRange(hi, lo, state.settings.width);
    if (!range) return false;
    state.range = range;
    const field = getFieldForRange(range.hi, range.lo);
    state.selectedFieldName = field ? field.name : null;
    setExpressionFromValue(core.readRange(state.value, range.hi, range.lo), range.hi - range.lo + 1);
    renderValue();
    updateBitGrid();
    renderFieldStrip();
    if (els.fieldsDialog.open) renderFieldList();
    return true;
  }

  function clearRange() {
    state.range = null;
    state.rangeAnchor = null;
    state.selectedFieldName = null;
    setExpressionFromValue(state.value, state.settings.width);
    renderValue();
    updateBitGrid();
    renderFieldStrip();
    if (els.fieldsDialog.open) renderFieldList();
  }

  function expandRange(size) {
    if (!state.range || !size) return;
    const width = state.settings.width;
    if (size > width) return;
    const start = Math.floor(state.range.lo / size) * size;
    const end = Math.min(width - 1, (Math.floor(state.range.hi / size) + 1) * size - 1);
    if (start === state.range.lo && end === state.range.hi) return;
    state.rangeAnchor = start;
    setRange(start, end);
    updateBitGrid();
    focusExpression(false);
  }

  function applyRangeAction(action) {
    if (!state.range) return;
    const hi = state.range.hi;
    const lo = state.range.lo;
    const field = getFieldForRange(hi, lo);
    let next;
    let actionLabel;
    if (action === 'flip') {
      next = core.flipRange(state.value, hi, lo, state.settings.width);
      actionLabel = '翻转';
    } else if (action === 'zero') {
      next = core.setRange(state.value, hi, lo, 0, state.settings.width);
      actionLabel = '置 0';
    } else {
      next = core.setRange(state.value, hi, lo, 1, state.settings.width);
      actionLabel = '置 1';
    }
    const label = field
      ? actionLabel + '字段 ' + field.name
      : actionLabel + '位段 ' + hi + ':' + lo;
    commitValue(next, {
      type: field ? 'field' : 'range',
      label: label,
      fieldName: field ? field.name : '',
      hi: hi,
      lo: lo,
      undoLabel: label,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Fields                                                             */
  /* ------------------------------------------------------------------ */

  function reparseFields(options) {
    state.fieldResult = core.parseFields(state.fieldText, state.settings.width);
    const selected = getSelectedField();
    if (state.selectedFieldName) {
      if (selected) {
        state.range = { hi: selected.hi, lo: selected.lo };
        setExpressionFromValue(core.readRange(state.value, selected.hi, selected.lo), selected.width);
      } else {
        state.selectedFieldName = null;
      }
    }
    updateMenuCount();
    updateBitGrid();
    renderValue();
    renderFieldStrip();
    if (els.fieldsDialog && els.fieldsDialog.open) renderFieldsDialog();
    else {
      renderFieldHeaderSummary();
      renderSchemeList();
    }
    return state.fieldResult;
  }

  function updateMenuCount() {
    if (els.menuFieldCount) els.menuFieldCount.textContent = String(state.fieldResult.fields.length);
  }

  function renderFieldHeaderSummary() {
    if (!els.fieldHeaderSummary) return;
    const stats = state.fieldResult.stats;
    if (!stats.fieldCount && !stats.errorCount) {
      els.fieldHeaderSummary.textContent = '未定义';
      return;
    }
    const parts = [stats.fieldCount + ' 个字段'];
    if (stats.usedBits) parts.push('覆盖 ' + stats.usedBits + '/' + state.settings.width + ' 位');
    if (stats.errorCount) parts.push(stats.errorCount + ' 个错误');
    if (stats.warningCount) parts.push(stats.warningCount + ' 个提示');
    els.fieldHeaderSummary.textContent = parts.join(' · ');
  }

  function openFieldsDialog() {
    renderFieldsDialog();
    closeMenu();
    if (!els.fieldsDialog.open) els.fieldsDialog.showModal();
    window.requestAnimationFrame(function () {
      els.fieldText.focus();
    });
  }

  function renderFieldsDialog() {
    if (!els.fieldsDialog) return;
    renderFieldHeaderSummary();
    renderFieldValidation();
    renderFieldList();
    renderSchemeList();
  }

  function renderFieldValidation() {
    els.fieldValidation.replaceChildren();
    const errors = state.fieldResult.errors;
    const warnings = state.fieldResult.warnings;
    errors.slice(0, 6).forEach(function (item) {
      const row = el('div', 'validation-item is-error');
      row.append(el('span', 'validation-line', 'L' + item.line));
      row.append(el('span', '', item.message));
      els.fieldValidation.append(row);
    });
    if (errors.length > 6) {
      els.fieldValidation.append(el('div', 'validation-more', '还有 ' + (errors.length - 6) + ' 条错误'));
    }
    warnings.slice(0, 3).forEach(function (item) {
      const row = el('div', 'validation-item is-warn');
      row.append(el('span', 'validation-line', 'L' + item.line));
      row.append(el('span', '', item.message));
      els.fieldValidation.append(row);
    });
    if (warnings.length > 3) {
      els.fieldValidation.append(el('div', 'validation-more', '还有 ' + (warnings.length - 3) + ' 条重叠提示'));
    }
  }

  function renderFieldList() {
    const fields = state.fieldResult.fields;
    els.fieldList.replaceChildren();
    els.fieldEmpty.hidden = fields.length > 0;
    els.fieldList.hidden = fields.length === 0;

    fields.forEach(function (field) {
      const values = core.fieldValue(state.value, field);
      const row = el('button', 'field-row');
      row.type = 'button';
      row.dataset.fieldName = field.name;
      row.classList.toggle('is-active', state.selectedFieldName === field.name);
      row.setAttribute('aria-pressed', state.selectedFieldName === field.name ? 'true' : 'false');
      row.title = '选择位段并写入字段 ' + field.name;
      row.setAttribute('aria-label', field.name + '，bit ' + field.hi + ':' + field.lo +
        '，无符号 ' + values.unsigned + '，有符号 ' + values.signed +
        '，HEX ' + values.hex + '，BIN ' + values.binary);

      const main = el('span', 'field-row-main');
      const swatch = el('span', 'field-swatch');
      swatch.style.setProperty('--field-color', fieldColor(field));
      main.append(swatch);
      main.append(el('span', 'field-name', field.name));
      main.append(el('span', 'field-bits', field.hi + ':' + field.lo));
      if (field.overlap) main.append(el('span', 'field-warn', '重叠'));
      main.append(el('span', 'field-hex', values.hex));
      row.append(main);

      const sub = el('span', 'field-row-sub');
      sub.append(el('span', '', 'U ' + values.unsigned));
      sub.append(el('span', '', 'S ' + values.signed));
      sub.append(el('span', '', 'BIN ' + values.binary));
      row.append(sub);

      els.fieldList.append(row);
    });
  }

  function enableFieldByName(name) {
    const field = state.fieldResult.fields.find(function (item) { return item.name === name; });
    if (!field) return;
    if (state.selectedFieldName === field.name && state.range &&
        state.range.hi === field.hi && state.range.lo === field.lo) {
      clearRange();
      focusExpression(true);
      return;
    }
    state.selectedFieldName = field.name;
    state.rangeAnchor = null;
    setRange(field.hi, field.lo);
    focusExpression(true);
  }

  function fieldCopyText(field) {
    const values = core.fieldValue(state.value, field);
    return field.name + ' [' + field.hi + ':' + field.lo + '] = ' + values.hex +
      ' (U ' + values.unsigned + ', S ' + values.signed + ', BIN ' + values.binary + ')';
  }

  function renderFieldStrip() {
    if (!els.fieldStrip) return;
    const fields = state.fieldResult.fields;
    if (state.hoverFieldName && !fields.some(function (field) { return field.name === state.hoverFieldName; })) {
      state.hoverFieldName = null;
    }
    els.fieldStrip.hidden = fields.length === 0;
    els.fieldStripList.replaceChildren();
    fields.forEach(function (field) {
      const values = core.fieldValue(state.value, field);
      const item = el('div', 'field-strip-item');
      item.dataset.fieldName = field.name;
      item.classList.toggle('is-active', state.selectedFieldName === field.name);

      const card = el('button', 'field-strip-card');
      card.type = 'button';
      card.dataset.fieldName = field.name;
      card.title = '选中字段 ' + field.name + ' 的位段，并在计算框中修改';
      card.setAttribute('aria-label', field.name + '，bit ' + field.hi + ':' + field.lo +
        '，无符号 ' + values.unsigned + '，有符号 ' + values.signed + '，HEX ' + values.hex);

      const main = el('span', 'field-strip-main');
      const swatch = el('span', 'field-swatch');
      swatch.style.setProperty('--field-color', fieldColor(field));
      main.append(swatch, el('span', 'field-name', field.name), el('span', 'field-bits', field.hi + ':' + field.lo));
      main.append(el('span', 'field-hex', values.hex));
      card.append(main);

      const sub = el('span', 'field-strip-sub');
      sub.append(el('span', '', 'U ' + values.unsigned));
      sub.append(el('span', '', 'S ' + values.signed));
      sub.append(el('span', '', 'BIN ' + values.binary));
      card.append(sub);
      item.append(card);

      const copy = el('button', 'copy-btn field-strip-copy');
      copy.type = 'button';
      copy.dataset.copyField = field.name;
      copy.title = '复制字段值';
      copy.setAttribute('aria-label', '复制字段 ' + field.name + ' 的值');
      copy.append(makeIcon('copy'));
      item.append(copy);
      els.fieldStripList.append(item);
    });
  }

  function exampleFields() {
    return state.settings.width === 8 ? EXAMPLE_FIELDS_8 : EXAMPLE_FIELDS_16;
  }

  async function insertExample() {
    const example = exampleFields();
    if (state.fieldText.trim() && state.fieldText.trim() !== example.trim()) {
      const ok = await showConfirm({
        title: '替换字段定义',
        message: '当前字段定义将被示例替换，已保存的方案不受影响。',
        confirmLabel: '替换',
        tone: 'primary',
      });
      if (!ok) return;
    }
    state.fieldText = example;
    els.fieldText.value = example;
    state.selectedFieldName = null;
    reparseFields();
    persistFields();
    showToast('已插入示例字段定义', 'success');
  }

  function renderSchemeList() {
    const schemes = state.schemes;
    if (els.schemeCount) els.schemeCount.textContent = String(schemes.length);
    if (!els.schemeList) return;
    els.schemeList.replaceChildren();
    if (els.schemeEmpty) els.schemeEmpty.hidden = schemes.length > 0;

    schemes.forEach(function (scheme) {
      const item = el('div', 'scheme-item');
      item.dataset.schemeId = scheme.id;
      const info = el('div', 'scheme-info');
      info.append(el('div', 'scheme-name', scheme.name));
      const parsed = core.parseFields(scheme.text, state.settings.width);
      const meta = (scheme.width ? scheme.width + '-bit · ' : '') +
        parsed.fields.length + ' 字段 · ' + formatTime(scheme.updatedAt);
      info.append(el('div', 'scheme-meta', meta));
      item.append(info);

      const actions = el('div', 'scheme-actions');
      const load = el('button', 'btn btn-quiet', '载入');
      load.type = 'button';
      load.dataset.action = 'load';
      load.title = '载入方案 ' + scheme.name;
      const remove = el('button', 'icon-btn');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.title = '删除方案 ' + scheme.name;
      remove.setAttribute('aria-label', '删除方案 ' + scheme.name);
      remove.append(makeIcon('trash'));
      actions.append(load, remove);
      item.append(actions);
      els.schemeList.append(item);
    });
  }

  async function saveScheme() {
    const name = els.schemeName.value.trim();
    if (!name) {
      showToast('请输入方案名称', 'warn');
      els.schemeName.focus();
      return;
    }
    if (state.fieldResult.errors.length) {
      showToast('字段定义存在错误，修正后再保存', 'error');
      els.fieldText.focus();
      return;
    }
    if (!state.fieldResult.fields.length) {
      showToast('字段定义为空，无法保存方案', 'warn');
      els.fieldText.focus();
      return;
    }

    const existing = state.schemes.find(function (scheme) { return scheme.name === name; });
    if (existing) {
      const ok = await showConfirm({
        title: '更新方案',
        message: '方案「' + name + '」已存在，是否用当前字段定义覆盖？',
        confirmLabel: '覆盖',
        tone: 'primary',
      });
      if (!ok) return;
    }

    const now = Date.now();
    const record = {
      id: existing ? existing.id : makeId('scheme'),
      name: name,
      text: state.fieldText,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      width: state.settings.width,
      fieldCount: state.fieldResult.fields.length,
    };
    state.schemes = [record].concat(state.schemes.filter(function (scheme) { return scheme.name !== name; }));
    persistSchemes();
    renderSchemeList();
    els.schemeName.value = '';
    showToast(existing ? '已更新方案「' + name + '」' : '已保存方案「' + name + '」', 'success');
  }

  async function loadScheme(id) {
    const scheme = state.schemes.find(function (item) { return item.id === id; });
    if (!scheme) return;
    if (scheme.width && scheme.width !== state.settings.width) {
      const switchWidth = await showConfirm({
        title: '载入方案',
        message: '方案「' + scheme.name + '」保存于 ' + scheme.width + ' 位，当前为 ' + state.settings.width +
          ' 位。切换位宽可能会截断当前值。',
        confirmLabel: '切换并载入',
        cancelLabel: '保持当前位宽',
        tone: 'primary',
      });
      if (switchWidth) setWidth(scheme.width);
    }
    const fieldText = scheme.text.slice(0, FIELD_TEXT_MAX);
    state.fieldText = fieldText;
    state.selectedFieldName = null;
    state.range = null;
    state.rangeAnchor = null;
    els.fieldText.value = fieldText;
    els.schemeName.value = scheme.name;
    reparseFields();
    persistFields();
    if (state.fieldResult.errors.length) {
      showToast('已载入方案「' + scheme.name + '」，存在 ' + state.fieldResult.errors.length + ' 个字段错误', 'warn', 3200);
    } else {
      showToast('已载入方案「' + scheme.name + '」', 'success');
    }
  }

  async function deleteScheme(id) {
    const scheme = state.schemes.find(function (item) { return item.id === id; });
    if (!scheme) return;
    const ok = await showConfirm({
      title: '删除方案',
      message: '确定删除方案「' + scheme.name + '」？该操作不可撤销。',
      confirmLabel: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    state.schemes = state.schemes.filter(function (item) { return item.id !== id; });
    if (els.schemeName.value.trim() === scheme.name) els.schemeName.value = '';
    persistSchemes();
    renderSchemeList();
    showToast('已删除方案「' + scheme.name + '」', 'success');
  }

  function exportSchemes() {
    if (!state.schemes.length) {
      showToast('还没有可导出的方案', 'warn');
      return;
    }
    const payload = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      schemes: state.schemes,
    }, null, 2);
    const host = getHost();
    if (host && typeof host.saveTextFile === 'function') {
      try {
        const result = host.saveTextFile('bitcalc-schemes.json', payload);
        if (result && result.ok) {
          showToast('已导出 ' + state.schemes.length + ' 个方案', 'success');
          return;
        }
        if (result && result.canceled) return;
      } catch (error) {
        // Fall back to browser download.
      }
    }
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bitcalc-schemes.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      showToast('已导出 ' + state.schemes.length + ' 个方案', 'success');
    } catch (error) {
      showToast('导出失败', 'error');
    }
  }

  async function importSchemes(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const raw = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.schemes) ? parsed.schemes : null);
      if (!raw) throw new Error('invalid');
      const imported = normalizeSchemes(raw);
      if (!imported.length) throw new Error('empty');
      const names = new Set(imported.map(function (scheme) { return scheme.name; }));
      state.schemes = imported.concat(state.schemes.filter(function (scheme) { return !names.has(scheme.name); }));
      persistSchemes();
      renderSchemeList();
      showToast('已导入 ' + imported.length + ' 个方案', 'success');
    } catch (error) {
      showToast('方案 JSON 无法解析', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* History                                                            */
  /* ------------------------------------------------------------------ */

  function openHistoryDialog() {
    renderHistoryDialog();
    closeMenu();
    if (!els.historyDialog.open) els.historyDialog.showModal();
  }

  function renderHistoryDialog() {
    const entries = state.history;
    els.historyCount.textContent = entries.length + ' 条';
    els.clearHistoryBtn.disabled = entries.length === 0;
    els.historyList.replaceChildren();
    els.historyEmpty.hidden = entries.length > 0;

    entries.forEach(function (entry) {
      const item = el('div', 'history-item');
      item.dataset.historyId = entry.id;
      const type = el('span', 'history-type', TYPE_LABELS[entry.type] || '操作');
      type.dataset.type = entry.type;

      const main = el('div', 'history-main');
      const title = el('div', 'history-title');
      if (entry.type === 'expr') {
        title.append(el('code', '', entry.expression || entry.label));
      } else if (entry.type === 'field') {
        title.append(document.createTextNode('字段 ' + (entry.fieldName || entry.label) + (entry.expression ? ' ' : '')));
        if (entry.expression) title.append(el('code', '', entry.expression));
      } else if (entry.type === 'range') {
        title.append(document.createTextNode('位段 ' + (entry.hi !== null ? entry.hi + ':' + entry.lo : '') + (entry.expression ? ' ' : '')));
        if (entry.expression) title.append(el('code', '', entry.expression));
      } else {
        title.append(document.createTextNode(entry.label || TYPE_LABELS[entry.type] || '操作'));
      }
      main.append(title);

      const values = el('div', 'history-values');
      const width = WIDTHS.indexOf(entry.width) >= 0 ? entry.width : state.settings.width;
      let beforeText;
      let afterText;
      try {
        beforeText = core.formatHex(BigInt(entry.before), width, 'BE');
        afterText = core.formatHex(BigInt(entry.after), width, 'BE');
      } catch (error) {
        beforeText = '?';
        afterText = '?';
      }
      const before = el('span', 'before', beforeText);
      before.title = entry.before;
      const after = el('span', 'after', afterText);
      after.title = entry.after;
      values.append(before, el('span', '', '→'), after);
      main.append(values);

      const side = el('div', 'history-side');
      const time = el('span', 'history-time', formatTime(entry.ts));
      time.title = formatFullTime(entry.ts);
      const actions = el('div', 'history-actions');
      const restore = el('button', 'btn btn-quiet', '恢复');
      restore.type = 'button';
      restore.dataset.historyAction = 'restore';
      restore.title = '恢复该历史值';
      const copy = el('button', 'icon-btn');
      copy.type = 'button';
      copy.dataset.historyAction = 'copy';
      copy.title = '复制该历史值';
      copy.setAttribute('aria-label', '复制该历史值');
      copy.append(makeIcon('copy'));
      actions.append(restore, copy);
      side.append(time, actions);

      item.append(type, main, side);
      els.historyList.append(item);
    });
  }

  function restoreHistory(id) {
    const entry = state.history.find(function (item) { return item.id === id; });
    if (!entry) return;
    let raw;
    try {
      raw = BigInt(entry.after);
    } catch (error) {
      showToast('历史值无法解析', 'error');
      return;
    }
    const masked = core.toWidth(raw, state.settings.width);
    closeDialog('historyDialog');
    commitValue(masked, {
      history: false,
      undoLabel: '恢复历史值',
    });
    announce(raw !== masked ? '已恢复历史值，并按当前位宽截断' : '已恢复历史值');
  }

  async function copyHistoryValue(id, button) {
    const entry = state.history.find(function (item) { return item.id === id; });
    if (!entry) return;
    let raw;
    try {
      raw = BigInt(entry.after);
    } catch (error) {
      showToast('历史值无法解析', 'error');
      return;
    }
    const width = WIDTHS.indexOf(entry.width) >= 0 ? entry.width : state.settings.width;
    const text = core.formatByBase(raw, width, state.settings.base, {
      signed: state.settings.signed,
      endian: state.settings.endian,
      group: false,
    });
    const ok = await copyToClipboard(text);
    if (!ok) {
      showToast('复制失败，请检查剪贴板权限', 'error');
      return;
    }
    markCopied(button, '历史值');
  }

  async function clearHistory() {
    if (!state.history.length) return;
    const ok = await showConfirm({
      title: '清空操作历史',
      message: '将删除全部 ' + state.history.length + ' 条本机历史记录，且不可恢复。',
      confirmLabel: '清空',
      tone: 'danger',
    });
    if (!ok) return;
    state.history = [];
    if (historySaveTimer) {
      clearTimeout(historySaveTimer);
      historySaveTimer = null;
    }
    persistHistory();
    renderHistoryDialog();
    showToast('操作历史已清空', 'success');
  }

  /* ------------------------------------------------------------------ */
  /* Settings and display actions                                       */
  /* ------------------------------------------------------------------ */

  function openSettingsDialog() {
    renderSettingsControls();
    closeMenu();
    if (!els.settingsDialog.open) els.settingsDialog.showModal();
  }

  function setWidth(width) {
    if (WIDTHS.indexOf(width) < 0 || width === state.settings.width) return;
    const previous = state.value;
    state.settings.width = width;
    state.value = core.toWidth(state.value, width);
    state.range = null;
    state.rangeAnchor = null;
    state.selectedFieldName = null;
    persistSettings();
    persistValue();
    reparseFields();
    buildBitGrid();
    renderAll();
    if (previous !== state.value) {
      showToast('当前值已按 ' + width + ' 位截断', 'warn');
    }
  }

  function setSigned(signed) {
    const next = !!signed;
    if (next === state.settings.signed) return;
    state.settings.signed = next;
    persistSettings();
    renderValue();
  }

  function setEndian(endian) {
    const next = endian === 'LE' ? 'LE' : 'BE';
    if (next === state.settings.endian) return;
    state.settings.endian = next;
    persistSettings();
    renderValue();
  }

  function setBase(base) {
    if (BASES.indexOf(base) < 0 || base === state.settings.base) return;
    state.settings.base = base;
    persistSettings();
    renderValue();
  }

  /* ------------------------------------------------------------------ */
  /* Value changes                                                      */
  /* ------------------------------------------------------------------ */

  function addHistory(entry) {
    state.history.unshift({
      id: makeId('history'),
      ts: Date.now(),
      type: entry.type || 'bit',
      label: entry.label || '数值修改',
      expression: entry.expression || '',
      fieldName: entry.fieldName || '',
      hi: Number.isInteger(entry.hi) ? entry.hi : null,
      lo: Number.isInteger(entry.lo) ? entry.lo : null,
      before: String(entry.before),
      after: String(entry.after),
      width: state.settings.width,
    });
    if (state.history.length > 100) state.history.length = 100;
    scheduleHistorySave();
  }

  function commitValue(nextValue, options) {
    const opts = options || {};
    const before = state.value;
    const after = core.toWidth(nextValue, state.settings.width);
    const changed = before !== after;
    if (changed) {
      state.undoStack.push({ value: before, label: opts.undoLabel || opts.label || '数值修改' });
      if (state.undoStack.length > 60) state.undoStack.shift();
      state.redoStack = [];
    }
    state.value = after;
    persistValue();
    if (opts.history !== false) {
      addHistory({
        type: opts.type,
        label: opts.label,
        expression: opts.expression,
        fieldName: opts.fieldName,
        hi: opts.hi,
        lo: opts.lo,
        before: before,
        after: after,
      });
    }
    renderAll();
    return changed;
  }

  function undo() {
    if (!state.undoStack.length) return;
    const item = state.undoStack.pop();
    state.redoStack.push({ value: state.value, label: item.label });
    if (state.redoStack.length > 60) state.redoStack.shift();
    state.value = core.toWidth(item.value, state.settings.width);
    persistValue();
    renderAll();
    announce('已撤销：' + item.label);
  }

  function redo() {
    if (!state.redoStack.length) return;
    const item = state.redoStack.pop();
    state.undoStack.push({ value: state.value, label: item.label });
    if (state.undoStack.length > 60) state.undoStack.shift();
    state.value = core.toWidth(item.value, state.settings.width);
    persistValue();
    renderAll();
    announce('已重做：' + item.label);
  }

  function updateUndoRedo() {
    els.undoBtn.disabled = state.undoStack.length === 0;
    els.redoBtn.disabled = state.redoStack.length === 0;
    els.undoBtn.title = state.undoStack.length
      ? '撤销：' + state.undoStack[state.undoStack.length - 1].label + ' (Ctrl/⌘+Z)'
      : '撤销 (Ctrl/⌘+Z)';
    els.redoBtn.title = state.redoStack.length
      ? '重做：' + state.redoStack[state.redoStack.length - 1].label + ' (Ctrl/⌘+Shift+Z)'
      : '重做 (Ctrl/⌘+Shift+Z)';
  }

  function renderAll() {
    renderValue();
    updateBitGrid();
    renderFieldStrip();
    updateUndoRedo();
    updateMenuCount();
    if (els.fieldsDialog.open) renderFieldsDialog();
  }

  /* ------------------------------------------------------------------ */
  /* Expression                                                         */
  /* ------------------------------------------------------------------ */

  function hideExprMessages() {
    els.exprError.hidden = true;
    els.exprErrorText.textContent = '';
    els.exprNote.hidden = true;
    els.exprNoteText.textContent = '';
    els.exprInput.removeAttribute('aria-invalid');
  }

  function getRecentExpressions() {
    const list = state.history
      .filter(function (entry) { return entry.type === 'expr' && entry.expression; })
      .map(function (entry) { return entry.expression; });
    return list.filter(function (value, index) { return list.indexOf(value) === index; });
  }

  function navigateExpressionHistory(up) {
    const expressions = getRecentExpressions();
    if (!expressions.length) return false;
    if (up) {
      if (state.exprHistoryCursor === null) {
        state.exprHistoryDraft = els.exprInput.value;
        state.exprHistoryCursor = 0;
      } else {
        state.exprHistoryCursor = Math.min(state.exprHistoryCursor + 1, expressions.length - 1);
      }
    } else {
      if (state.exprHistoryCursor === null) return false;
      state.exprHistoryCursor -= 1;
      if (state.exprHistoryCursor < 0) {
        state.exprHistoryCursor = null;
        els.exprInput.value = state.exprHistoryDraft || '';
        state.exprHistoryDraft = null;
        hideExprMessages();
        return true;
      }
    }
    const value = expressions[state.exprHistoryCursor];
    els.exprInput.value = value;
    els.exprInput.setSelectionRange(value.length, value.length);
    hideExprMessages();
    return true;
  }

  function calculateExpression() {
    const expression = els.exprInput.value.trim();
    if (!expression) {
      els.exprErrorText.textContent = '请输入表达式';
      els.exprError.hidden = false;
      els.exprNote.hidden = true;
      els.exprInput.setAttribute('aria-invalid', 'true');
      els.exprInput.focus();
      return;
    }
    const displayWidth = getDisplayWidth();
    const result = core.evaluate(expression, { width: displayWidth });
    if (!result.ok) {
      const position = Number.isInteger(result.error.position) ? result.error.position : 0;
      els.exprErrorText.textContent = result.error.message + '（位置 ' + (position + 1) + '）';
      els.exprError.hidden = false;
      els.exprNote.hidden = true;
      els.exprInput.setAttribute('aria-invalid', 'true');
      els.exprInput.focus();
      try {
        els.exprInput.setSelectionRange(position, position);
      } catch (error) {
        // Ignore.
      }
      return;
    }

    els.exprError.hidden = true;
    els.exprErrorText.textContent = '';
    els.exprInput.removeAttribute('aria-invalid');
    if (result.truncated) {
      els.exprNoteText.textContent = '结果超出 ' + displayWidth + ' 位，已截断';
      els.exprNote.hidden = false;
    } else {
      els.exprNote.hidden = true;
    }

    if (state.range) {
      const hi = state.range.hi;
      const lo = state.range.lo;
      const field = getFieldForRange(hi, lo);
      const next = core.writeRange(state.value, hi, lo, result.value, state.settings.width);
      commitValue(next, {
        type: field ? 'field' : 'range',
        label: field ? '写入字段 ' + field.name : '位使能 ' + hi + ':' + lo,
        fieldName: field ? field.name : '',
        expression: expression,
        hi: hi,
        lo: lo,
        undoLabel: field ? '写入字段 ' + field.name : '位使能 ' + hi + ':' + lo,
      });
      return;
    }

    commitValue(result.value, {
      type: 'expr',
      label: '表达式计算',
      expression: expression,
      undoLabel: '表达式计算',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Dialogs and menu                                                  */
  /* ------------------------------------------------------------------ */

  function closeDialog(id) {
    const dialog = $(id);
    if (dialog && dialog.open) dialog.close();
  }

  function closeMenu() {
    if (els.moreMenu) els.moreMenu.open = false;
  }

  function openHelp() {
    closeMenu();
    if (!els.helpDialog.open) els.helpDialog.showModal();
  }

  function showConfirm(options) {
    const opts = options || {};
    if (confirmState) {
      const previous = confirmState;
      confirmState = null;
      previous.resolve(false);
      if (els.confirmDialog.open) els.confirmDialog.close();
    }
    els.confirmTitle.textContent = opts.title || '确认操作';
    els.confirmMessage.textContent = opts.message || '';
    els.confirmOkBtn.textContent = opts.confirmLabel || '确认';
    els.confirmCancelBtn.textContent = opts.cancelLabel || '取消';
    els.confirmOkBtn.className = 'btn ' + (opts.tone === 'primary' ? 'btn-primary' : 'btn-danger');
    if (!els.confirmDialog.open) els.confirmDialog.showModal();
    window.requestAnimationFrame(function () {
      els.confirmCancelBtn.focus();
    });
    return new Promise(function (resolve) {
      confirmState = { resolve: resolve };
    });
  }

  function settleConfirm(value) {
    if (!confirmState) {
      if (els.confirmDialog.open) els.confirmDialog.close();
      return;
    }
    const pending = confirmState;
    confirmState = null;
    if (els.confirmDialog.open) els.confirmDialog.close();
    pending.resolve(value);
  }

  function renderFunctionTable() {
    if (!els.functionTable) return;
    els.functionTable.replaceChildren();
    Object.keys(core.FUNCTION_DEFS).forEach(function (name) {
      const row = el('div', 'fn-row');
      row.append(el('code', '', name + '()'));
      row.append(el('span', '', core.FUNCTION_DEFS[name].description));
      els.functionTable.append(row);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Plugin integration                                                 */
  /* ------------------------------------------------------------------ */

  function focusExpression(selectAll) {
    window.requestAnimationFrame(function () {
      if (!els.exprInput) return;
      els.exprInput.focus({ preventScroll: true });
      if (selectAll) els.exprInput.select();
    });
  }

  function handlePluginEnter(action) {
    if (!action) return;
    if (action.type === 'regex' && typeof action.payload === 'string') {
      const payload = action.payload.trim();
      if (!payload) return;
      els.exprInput.value = payload;
      hideExprMessages();
      calculateExpression();
      els.exprInput.focus();
      if (!els.exprError.hidden) showToast('已载入表达式，但计算失败；当前值未改变', 'warn');
      return;
    }
    if (action.type === 'text') focusExpression(true);
  }

  function registerUtools() {
    const utools = getUtools();
    if (!utools) return;
    try {
      if (typeof utools.onPluginReady === 'function') utools.onPluginReady(function () { return appReady; });
    } catch (error) {
      // Ignore lifecycle registration failures.
    }
    try {
      if (typeof utools.onPluginEnter === 'function') {
        utools.onPluginEnter(function (action) {
          Promise.resolve(appReady).then(function () { handlePluginEnter(action); }).catch(function () {});
        });
      }
    } catch (error) {
      // Ignore.
    }
    try {
      if (typeof utools.onPluginOut === 'function') utools.onPluginOut(function () { flushAll(); });
    } catch (error) {
      // Ignore.
    }
  }

  /* ------------------------------------------------------------------ */
  /* DOM cache and events                                               */
  /* ------------------------------------------------------------------ */

  function cacheDom() {
    els = {
      undoBtn: $('undoBtn'),
      redoBtn: $('redoBtn'),
      moreMenu: $('moreMenu'),
      fieldsBtn: $('fieldsBtn'),
      menuHistory: $('menuHistory'),
      menuSettings: $('menuSettings'),
      menuHelp: $('menuHelp'),
      menuTheme: $('menuTheme'),
      menuThemeText: $('menuThemeText'),
      menuFieldCount: $('menuFieldCount'),
      bitStatus: $('bitStatus'),
      bitHint: $('bitHint'),
      enableControls: $('enableControls'),
      enableRange: $('enableRange'),
      enableWidth: $('enableWidth'),
      enableField: $('enableField'),
      enableExpandSelect: $('enableExpandSelect'),
      enableClearBtn: $('enableClearBtn'),
      valueHex: $('valueHex'),
      valueDec: $('valueDec'),
      valueOct: $('valueOct'),
      valueBin: $('valueBin'),
      floatList: $('floatList'),
      floatF64Row: $('floatF64Row'),
      valueF32: $('valueF32'),
      valueF64: $('valueF64'),
      exprForm: $('exprForm'),
      exprInput: $('exprInput'),
      exprError: $('exprError'),
      exprErrorText: $('exprErrorText'),
      exprNote: $('exprNote'),
      exprNoteText: $('exprNoteText'),
      bitGrid: $('bitGrid'),
      enableFlipBtn: $('enableFlipBtn'),
      enableSet0Btn: $('enableSet0Btn'),
      enableSet1Btn: $('enableSet1Btn'),
      fieldStrip: $('fieldStrip'),
      fieldStripList: $('fieldStripList'),
      fieldStripEditBtn: $('fieldStripEditBtn'),
      settingsDialog: $('settingsDialog'),
      dialogWidthSwitch: $('dialogWidthSwitch'),
      dialogSignSwitch: $('dialogSignSwitch'),
      dialogEndianSwitch: $('dialogEndianSwitch'),
      dialogFloatToggle: $('dialogFloatToggle'),
      fieldsDialog: $('fieldsDialog'),
      fieldHeaderSummary: $('fieldHeaderSummary'),
      insertExampleBtn: $('insertExampleBtn'),
      fieldText: $('fieldText'),
      fieldValidation: $('fieldValidation'),
      fieldList: $('fieldList'),
      fieldEmpty: $('fieldEmpty'),
      schemeForm: $('schemeForm'),
      schemeName: $('schemeName'),
      schemeList: $('schemeList'),
      schemeEmpty: $('schemeEmpty'),
      schemeCount: $('schemeCount'),
      exportSchemesBtn: $('exportSchemesBtn'),
      importSchemesBtn: $('importSchemesBtn'),
      importSchemesInput: $('importSchemesInput'),
      historyDialog: $('historyDialog'),
      historyCount: $('historyCount'),
      clearHistoryBtn: $('clearHistoryBtn'),
      historyList: $('historyList'),
      historyEmpty: $('historyEmpty'),
      helpDialog: $('helpDialog'),
      functionTable: $('functionTable'),
      confirmDialog: $('confirmDialog'),
      confirmTitle: $('confirmTitle'),
      confirmMessage: $('confirmMessage'),
      confirmOkBtn: $('confirmOkBtn'),
      confirmCancelBtn: $('confirmCancelBtn'),
      toastRegion: $('toastRegion'),
      srStatus: $('srStatus'),
    };

    if (!els.bitGrid || !els.exprInput || !els.fieldText) {
      throw new Error('bitcalc UI 初始化失败：缺少关键元素');
    }
  }

  function bindEvents() {
    document.querySelectorAll('.base-main').forEach(function (button) {
      button.addEventListener('click', function () {
        setBase(button.dataset.base);
      });
    });

    els.dialogFloatToggle.addEventListener('change', function () {
      state.settings.showFloat = els.dialogFloatToggle.checked;
      persistSettings();
      renderValue();
    });

    document.addEventListener('click', function (event) {
      const copy = event.target.closest('[data-copy-kind]');
      if (copy) handleCopyKind(copy.dataset.copyKind, copy);

      const close = event.target.closest('[data-close-dialog]');
      if (close) closeDialog(close.dataset.closeDialog);

      if (els.moreMenu.open && !els.moreMenu.contains(event.target)) closeMenu();
    });

    els.undoBtn.addEventListener('click', undo);
    els.redoBtn.addEventListener('click', redo);

    els.fieldsBtn.addEventListener('click', openFieldsDialog);
    els.enableClearBtn.addEventListener('click', clearRange);
    els.menuHistory.addEventListener('click', openHistoryDialog);
    els.menuSettings.addEventListener('click', openSettingsDialog);
    els.menuHelp.addEventListener('click', openHelp);
    els.menuTheme.addEventListener('click', function () {
      closeMenu();
      toggleTheme();
    });

    els.dialogWidthSwitch.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-width]');
      if (button) setWidth(Number(button.dataset.width));
    });
    els.dialogSignSwitch.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-signed]');
      if (button) setSigned(button.dataset.signed === '1');
    });
    els.dialogEndianSwitch.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-endian]');
      if (button) setEndian(button.dataset.endian);
    });

    els.exprForm.addEventListener('submit', function (event) {
      event.preventDefault();
      calculateExpression();
    });
    els.exprInput.addEventListener('input', function () {
      state.exprHistoryCursor = null;
      state.exprHistoryDraft = null;
      hideExprMessages();
    });
    els.exprInput.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowUp' && els.exprInput.selectionStart === 0 && !event.shiftKey && !event.altKey) {
        if (navigateExpressionHistory(true)) event.preventDefault();
      } else if (event.key === 'ArrowDown' && els.exprInput.selectionStart === els.exprInput.value.length && !event.shiftKey && !event.altKey) {
        if (navigateExpressionHistory(false)) event.preventDefault();
      }
    });

    els.bitGrid.addEventListener('pointerdown', function (event) {
      const cell = event.target.closest('.bit');
      if (!cell || event.button !== 0) return;
      event.preventDefault();
      draggingBits = true;
      dragAnchor = Number(cell.dataset.bit);
      dragMoved = false;
      state.focusBit = dragAnchor;
      cell.focus({ preventScroll: true, focusVisible: false });
    });
    els.bitGrid.addEventListener('pointerover', function (event) {
      const cell = event.target.closest('.bit');
      if (!cell) return;
      const bit = Number(cell.dataset.bit);
      if (!draggingBits || !(event.buttons & 1)) return;
      if (bit === dragAnchor) return;
      dragMoved = true;
      state.focusBit = bit;
      setRange(dragAnchor, bit);
      focusBitCell(bit, { preventScroll: true, focusVisible: false });
    });
    document.addEventListener('pointerup', function () {
      if (!draggingBits) return;
      draggingBits = false;
      if (dragMoved) {
        suppressBitClick = true;
        setTimeout(function () {
          suppressBitClick = false;
        }, 0);
      }
      dragAnchor = null;
    });
    document.addEventListener('pointercancel', function () {
      draggingBits = false;
      dragAnchor = null;
    });
    els.bitGrid.addEventListener('click', function (event) {
      if (suppressBitClick) {
        suppressBitClick = false;
        return;
      }
      const cell = event.target.closest('.bit');
      if (!cell) return;
      toggleBit(Number(cell.dataset.bit));
    });
    els.bitGrid.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      clearRange();
    });
    els.bitGrid.addEventListener('keydown', handleBitKeydown);
    els.bitGrid.addEventListener('focusin', function (event) {
      const cell = event.target.closest('.bit');
      if (!cell) return;
      state.focusBit = Number(cell.dataset.bit);
      updateBitGrid();
    });

    els.enableClearBtn.addEventListener('click', clearRange);
    els.enableExpandSelect.addEventListener('change', function () {
      const size = Number(els.enableExpandSelect.value);
      els.enableExpandSelect.value = '';
      expandRange(size);
    });
    els.enableFlipBtn.addEventListener('click', function () { applyRangeAction('flip'); });
    els.enableSet0Btn.addEventListener('click', function () { applyRangeAction('zero'); });
    els.enableSet1Btn.addEventListener('click', function () { applyRangeAction('one'); });
    els.fieldStripEditBtn.addEventListener('click', openFieldsDialog);
    els.fieldStripList.addEventListener('click', async function (event) {
      const copy = event.target.closest('[data-copy-field]');
      if (copy) {
        const field = state.fieldResult.fields.find(function (item) { return item.name === copy.dataset.copyField; });
        if (!field) return;
        const ok = await copyToClipboard(fieldCopyText(field));
        if (!ok) {
          showToast('复制失败，请检查剪贴板权限', 'error');
          return;
        }
        markCopied(copy, '字段 ' + field.name);
        return;
      }
      const card = event.target.closest('.field-strip-card');
      if (!card) return;
      enableFieldByName(card.dataset.fieldName);
    });
    els.fieldStripList.addEventListener('pointerover', function (event) {
      const item = event.target.closest('.field-strip-item');
      if (!item) return;
      if (state.hoverFieldName === item.dataset.fieldName) return;
      state.hoverFieldName = item.dataset.fieldName;
      updateBitGrid();
    });
    els.fieldStripList.addEventListener('pointerout', function (event) {
      const item = event.target.closest('.field-strip-item');
      if (!item) return;
      const next = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest('.field-strip-item') : null;
      if (next === item) return;
      state.hoverFieldName = null;
      updateBitGrid();
    });

    els.fieldText.addEventListener('input', function () {
      state.fieldText = els.fieldText.value;
      reparseFields();
      scheduleFieldSave();
    });
    els.insertExampleBtn.addEventListener('click', insertExample);
    els.fieldList.addEventListener('click', function (event) {
      const row = event.target.closest('.field-row');
      if (!row) return;
      enableFieldByName(row.dataset.fieldName);
      closeDialog('fieldsDialog');
    });

    els.schemeForm.addEventListener('submit', function (event) {
      event.preventDefault();
      saveScheme();
    });
    els.exportSchemesBtn.addEventListener('click', exportSchemes);
    els.importSchemesBtn.addEventListener('click', function () {
      els.importSchemesInput.click();
    });
    els.importSchemesInput.addEventListener('change', async function () {
      const file = els.importSchemesInput.files && els.importSchemesInput.files[0];
      els.importSchemesInput.value = '';
      if (file) await importSchemes(file);
    });
    els.schemeList.addEventListener('click', function (event) {
      const action = event.target.closest('[data-action]');
      if (!action) return;
      const item = action.closest('.scheme-item');
      if (!item) return;
      if (action.dataset.action === 'load') loadScheme(item.dataset.schemeId);
      else if (action.dataset.action === 'delete') deleteScheme(item.dataset.schemeId);
    });

    els.clearHistoryBtn.addEventListener('click', clearHistory);
    els.historyList.addEventListener('click', function (event) {
      const action = event.target.closest('[data-history-action]');
      if (!action) return;
      const item = action.closest('.history-item');
      if (!item) return;
      if (action.dataset.historyAction === 'restore') restoreHistory(item.dataset.historyId);
      else if (action.dataset.historyAction === 'copy') copyHistoryValue(item.dataset.historyId, action);
    });

    [els.settingsDialog, els.fieldsDialog, els.historyDialog, els.helpDialog].forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close();
      });
    });

    els.confirmOkBtn.addEventListener('click', function () { settleConfirm(true); });
    els.confirmCancelBtn.addEventListener('click', function () { settleConfirm(false); });
    els.confirmDialog.querySelectorAll('[data-confirm-cancel]').forEach(function (button) {
      button.addEventListener('click', function () { settleConfirm(false); });
    });
    els.confirmDialog.addEventListener('click', function (event) {
      if (event.target === els.confirmDialog) settleConfirm(false);
    });
    els.confirmDialog.addEventListener('close', function () {
      if (confirmState) {
        const pending = confirmState;
        confirmState = null;
        pending.resolve(false);
      }
    });

    window.addEventListener('beforeunload', flushAll);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushAll();
    });
    window.addEventListener('keydown', handleGlobalKeydown);
  }

  function handleGlobalKeydown(event) {
    if (els.moreMenu.open && event.key === 'Escape') {
      closeMenu();
      event.preventDefault();
      return;
    }
    const dialogOpen = els.settingsDialog.open || els.fieldsDialog.open ||
      els.historyDialog.open || els.helpDialog.open || els.confirmDialog.open;
    if (dialogOpen) return;

    const editable = isEditable(event.target);
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (mod && !event.altKey && (key === 'z' || key === 'Z')) {
      if (editable) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && !event.altKey && (key === 'y' || key === 'Y')) {
      if (editable) return;
      event.preventDefault();
      redo();
      return;
    }
    if (key === '?' && !editable) {
      event.preventDefault();
      openHelp();
      return;
    }
    if (key === '/' && !editable) {
      event.preventDefault();
      focusExpression(true);
      return;
    }
    if (key === 'Escape') {
      if (state.range) {
        event.preventDefault();
        clearRange();
      } else if (editable) {
        event.target.blur();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */

  async function init() {
    cacheDom();
    renderFunctionTable();
    bindEvents();
    try {
      loadPersisted();
    } catch (error) {
      state.settings = normalizeSettings(null);
      state.value = 0n;
      state.fieldText = '';
      state.schemes = [];
      state.history = [];
      showToast('读取本地数据失败，已使用默认值', 'error');
    }

    els.fieldText.value = state.fieldText;
    state.focusBit = Math.min(state.focusBit, state.settings.width - 1);
    reparseFields();
    buildBitGrid();
    renderAll();
    state.initialized = true;
    focusExpression(false);
  }

  appReady = init().catch(function (error) {
    console.error('bitcalc init failed', error);
    const region = document.getElementById('toastRegion');
    if (region) {
      const toast = document.createElement('div');
      toast.className = 'toast is-error';
      toast.textContent = 'bitcalc 初始化失败：' + (error && error.message ? error.message : '未知错误');
      region.append(toast);
    }
  });
  registerUtools();
})();

/**
 * editor.js — Guerrilha Editor S
 * Editor USB CDC para o controlador ESP32-S3 linha S.
 *
 * PROTOCOLO CDC (editor_cdc.c):
 *   → Envio: JSON-line (uma linha JSON + \n)
 *   ← Resposta: JSON-line com { ok, cmd, id, data? }
 *
 * ATENÇÃO — update_request:
 *   Este editor NUNCA envia update_request automaticamente.
 *   O modo update é controlado exclusivamente pelo site de atualização oficial.
 */

'use strict';

/* ============================================================
   CONSTANTES
   ============================================================ */
const BANK_LETTERS = ['A','B','C','D','E','F','G','H','I'];

const USB_PRESETS_BY_MODE = {
  0: [
    { v: 18, l: 'TONEX CUSTOM' },
    { v: 0,  l: 'TONEX ONE A' },
    { v: 11, l: 'TONEX ONE B' },
    { v: 16, l: 'TONEX PEDAL A' },
    { v: 17, l: 'TONEX PEDAL B' }
  ],
  1: [
    { v: 9,  l: 'AMPERO MINI' },
    { v: 14, l: 'BLACK BOX' },
    { v: 2,  l: 'BOSS GT-1' },
    { v: 19, l: 'BOSS GT-1B' },
    { v: 3,  l: 'GP5' },
    { v: 22, l: 'GP100' },
    { v: 24, l: 'KEMPER PLAYER' },
    { v: 25, l: 'KEMPER PLAYER(OZIEL MT-6)' },
    { v: 1,  l: 'MIDI USB CUSTOM' },
    { v: 10, l: 'NANO CORTEX' },
    { v: 12, l: 'POCKET MASTER' },
    { v: 7,  l: 'ZOOM G1 FOUR' },
    { v: 15, l: 'ZOOM G3' },
    { v: 20, l: 'ZOOM G3X' },
    { v: 21, l: 'ZOOM G3N/G3XN' },
    { v: 4,  l: 'ZOOM MS50G' },
    { v: 13, l: 'ZOOM MS50GPLUS' },
    { v: 5,  l: 'ZOOM MS60B' },
    { v: 6,  l: 'ZOOM MS70CDR' }
  ],
  2: [{ v: 8, l: 'MIDI PC' }],
  3: [{ v: 23, l: 'HUB MULTI MIDI (custom + rotação)' }],
  4: [
    { v: 26, l: 'MIDI SERIAL' },
    { v: 27, l: 'MIDI SERIAL CUSTOM' }
  ]
};

/* ============================================================
   TRANSPORTE SERIAL (Web Serial API)
   ============================================================ */
class SerialTransport {
  constructor() {
    this.port = null;
    this._reader = null;
    this._writer = null;
    this._encoder = new TextEncoder();
    this._cmdId = 0;
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._lineBuffer = '';
    this._readTask = null;
    this.connected = false;
  }

  static isSupported() {
    return ('serial' in navigator);
  }

  async connect() {
    if (!SerialTransport.isSupported()) {
      throw new Error('Web Serial não suportado neste browser.\nUse Chrome / Edge 89+.');
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this._writer = this.port.writable.getWriter();
    this.connected = true;
    this._startReading();
  }

  async disconnect() {
    this.connected = false;
    this._pending.forEach(({ reject }) => reject(new Error('Desconectado')));
    this._pending.clear();
    try {
      if (this._reader) {
        await this._reader.cancel();
        this._reader.releaseLock();
      }
    } catch (_) {}
    try {
      if (this._writer) {
        this._writer.releaseLock();
      }
    } catch (_) {}
    try {
      await this.port.close();
    } catch (_) {}
    this._reader = null;
    this._writer = null;
  }

  async send(cmd, params = {}) {
    const id = ++this._cmdId;
    const req = { cmd, id, ...params };
    const line = JSON.stringify(req) + '\n';
    await this._writer.write(this._encoder.encode(line));

    return new Promise((resolve, reject) => {
      // midi_config POST pode demorar até ~15s salvando 9 bancos no SPIFFS
      const timeoutMs = cmd === 'midi_config' ? 20000 : 8000;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout (${timeoutMs/1000}s): cmd="${cmd}" id=${id}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  _startReading() {
    const self = this;
    const decoder = new TextDecoder();
    this._readTask = (async () => {
      while (self.connected && self.port.readable) {
        self._reader = self.port.readable.getReader();
        try {
          while (true) {
            const { value, done } = await self._reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            self._lineBuffer += chunk;
            const lines = self._lineBuffer.split('\n');
            self._lineBuffer = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (t) self._processLine(t);
            }
          }
        } catch (e) {
          if (self.connected) {
            console.warn('[serial] read error:', e.message);
            // Dispositivo desconectado inesperadamente
            if (e.message && (e.message.includes('lost') || e.message.includes('closed') || e.message.includes('disconnected'))) {
              self.connected = false;
              // Rejeitar todos os comandos pendentes
              self._pending.forEach(({ reject: rej }) => rej(new Error('Dispositivo desconectado')));
              self._pending.clear();
              // Notificar o app
              if (typeof onDeviceLost === 'function') onDeviceLost();
            }
          }
        } finally {
          if (self._reader) { self._reader.releaseLock(); self._reader = null; }
        }
      }
    })();
  }

  _processLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      console.warn('[cdc rx] JSON inválido:', line.slice(0, 120));
      return;
    }
    const id = obj.id;
    if (id !== undefined && this._pending.has(id)) {
      const { resolve, timer } = this._pending.get(id);
      clearTimeout(timer);
      this._pending.delete(id);
      resolve(obj);
    } else {
      // Push não solicitado (ex.: notificação futura)
      console.log('[cdc push]', obj);
    }
  }
}

/* ============================================================
   TRANSPORTE MOCK (teste offline)
   ============================================================ */
class MockTransport {
  constructor() {
    this.connected = false;
    this._cmdId = 0;
  }

  static isSupported() { return true; }

  async connect() {
    await new Promise(r => setTimeout(r, 400)); // simular latência
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async send(cmd, params = {}) {
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
    const id = ++this._cmdId;
    return window.mockDispatch(cmd, { ...params, id });
  }
}

/* ============================================================
   APP STATE
   ============================================================ */
const State = {
  transport: null,
  isMock: false,
  connected: false,
  currentBank: 0,
  activeFs: 0,
  fsCount: 8,
  config: { banks: {} },   // bancos carregados (keyed por bank number string)
  usbConfig: null,
  systemStatus: null,
  copyBuffer: null,         // clipboard copiar/colar FS
  bankCopyBuffer: null,     // clipboard banco inteiro
  activeFsCardTab: {},      // fs -> tab name
};

/* ============================================================
   UTILITÁRIOS
   ============================================================ */
const $ = id => document.getElementById(id);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => {
    const h = Math.max(0, Math.min(255, Math.round(v || 0))).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

let _notifTimer = null;
function notify(msg, type = 'info', ms = 3500) {
  const el = $('notification');
  if (!el) return;
  clearTimeout(_notifTimer);
  el.textContent = msg;
  el.className = 'notification show ' + type;
  _notifTimer = setTimeout(() => { el.className = 'notification'; }, ms);
}

/* ============================================================
   CONEXÃO
   ============================================================ */
async function doConnect() {
  const btn = $('connectBtn');
  btn.disabled = true;
  setConnState('connecting', 'Conectando…');
  try {
    State.transport = new SerialTransport();
    State.isMock = false;
    await State.transport.connect();
    State.connected = true;
    setConnState('connected', 'Conectado');
    notify('Conectado ao controlador', 'success');
    await onConnected();
  } catch (e) {
    State.connected = false;
    State.transport = null;
    setConnState('', 'Desconectado');
    notify(e.message || 'Erro de conexão', 'error');
  }
  btn.disabled = false;
}

async function doMock() {
  const btn = $('mockBtn');
  btn.disabled = true;
  setConnState('connecting', 'Iniciando modo teste…');
  try {
    State.transport = new MockTransport();
    State.isMock = true;
    await State.transport.connect();
    State.connected = true;
    setConnState('mock', 'Modo Teste [MOCK]');
    notify('Modo de teste ativo — sem hardware', 'warning', 5000);
    await onConnected();
  } catch (e) {
    State.connected = false;
    State.transport = null;
    setConnState('', 'Desconectado');
    notify(e.message || 'Erro no modo teste', 'error');
  }
  btn.disabled = false;
}

function setConnState(state, label) {
  const dot = $('connDot');
  const lbl = $('connLabel');
  dot.className = 'conn-dot' + (state ? ' ' + state : '');
  lbl.textContent = label;
  $('connectBtn').textContent = State.connected ? 'Desconectar' : 'Conectar USB';
}

async function doDisconnect() {
  stopExpMonitor();
  if (State.transport) {
    await State.transport.disconnect().catch(() => {});
  }
  State.connected = false;
  State.transport = null;
  State.isMock = false;
  setConnState('', 'Desconectado');
  notify('Desconectado', 'info');
}

/* Chamado automaticamente quando o dispositivo USB é perdido */
function onDeviceLost() {
  stopExpMonitor();
  State.connected = false;
  State.transport = null;
  State.isMock = false;
  setConnState('', 'Desconectado');
  notify('⚠️ Dispositivo USB desconectado — reconecte para continuar', 'warning', 6000);
  const btn = $('saveBanksBtn');
  if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar configuração'; }
}

/* ============================================================
   PÓS CONEXÃO — carrega dados iniciais
   ============================================================ */
async function onConnected() {
  try {
    const pong = await send('ping');
    if (pong.ok) {
      $('dashFw').textContent = pong.firmware || '—';
    }
  } catch (e) { console.warn('[ping]', e.message); }

  await loadSystemStatus();
  await loadUsbConfig();
  await loadDeviceConfig();
  await loadBank(null);
  updateDashboard();
}

/* ============================================================
   ENVIO SEGURO (wraps transport.send)
   ============================================================ */
async function send(cmd, params = {}) {
  if (!State.transport || !State.connected) throw new Error('Não conectado');
  return State.transport.send(cmd, params);
}

/* ============================================================
   SYSTEM STATUS
   ============================================================ */
async function loadSystemStatus() {
  try {
    const r = await send('system_status');
    if (!r.ok) return;
    State.systemStatus = r.data;
    applySystemStatusToUI(r.data);
  } catch (e) {
    console.warn('[system_status]', e.message);
  }
}

function applySystemStatusToUI(d) {
  if (!d) return;
  if (d.fsCount && [4, 6, 8].includes(d.fsCount)) {
    State.fsCount = d.fsCount;
    updateFsCountSelect(d.fsCount);
    rebuildFsGrid();
  }
  if (d.currentBank !== undefined) {
    State.currentBank = d.currentBank;
    updateBankHighlight(d.currentBank);
  }
  if (d.activePreset !== undefined) {
    setVal('dashPresetSelect', String(d.activePreset));
  }
  if (d.presetNames) {
    updatePresetSelectLabels(d.presetNames);
    const nm = d.presetNames[d.activePreset] || '';
    $('dashPresetNameInput').value = nm;
    $('dashPresetName').textContent = nm || `Profile ${(d.activePreset || 0) + 1}`;
  }
  // Status panel
  setText('stFirmware', d.firmwareVersion || d.appVersion || '—');
  setText('stUsbMode', d.usbModeDescription || String(d.usbMode));
  setText('stMidiInit', d.midiConfigInitialized ? 'OK' : 'Não inicializado');
  setText('stBank', BANK_LETTERS[d.currentBank] || String(d.currentBank));
  setText('stPreset', `Profile ${(d.activePreset || 0) + 1}` + (d.presetNames?.[d.activePreset] ? ` — ${d.presetNames[d.activePreset]}` : ''));
  setText('stFsCount', String(d.fsCount || '—'));
  if (d.spiffs) {
    const sp = d.spiffs;
    setText('stSpiffsTotal', fmtBytes(sp.total));
    setText('stSpiffsUsed', fmtBytes(sp.used));
    setText('stSpiffsFree', fmtBytes(sp.free));
    setText('stSpiffsPct', `${sp.usePercent}%`);
    // Storage bars
    const pct = Math.min(100, sp.usePercent || 0);
    const fill = $('spiffsFill');
    if (fill) fill.style.width = pct + '%';
    setText('spiffsMetric', `${fmtBytes(sp.used)} / ${fmtBytes(sp.total)}`);
    setText('spiffsSub', `${sp.usePercent}% utilizado — ${fmtBytes(sp.free)} livre`);
  }
}

/* ============================================================
   USB CONFIG
   ============================================================ */
async function loadUsbConfig() {
  try {
    const r = await send('usb_config');
    if (!r.ok) return;
    State.usbConfig = r.data;
    applyUsbConfigToUI(r.data);
  } catch (e) {
    console.warn('[usb_config]', e.message);
  }
}

function applyUsbConfigToUI(d) {
  if (!d) return;
  setVal('usbModeSelect', String(d.usbMode !== undefined ? d.usbMode : d.usbmode || 0));
  const mode = d.usbMode !== undefined ? d.usbMode : d.usbmode || 0;
  const preset = d.usbPreset !== undefined ? d.usbPreset : d.usbpreset || 0;
  updateUsbPresetOptions(mode);
  ensureSelectHasValue($('usbPresetSelect'), preset, `Profile ${preset}`);
  setVal('usbPresetSelect', String(preset));
  if (d.fsCount && [4, 6, 8].includes(d.fsCount)) {
    updateFsCountSelect(d.fsCount);
  }
  // Globals LED
  setVal('ledHoldModeSelect', String(d.ledHoldMode || 0));
  setVal('ledClickModeSelect', String(d.ledClickMode || 0));
  setVal('resetOnFootSelect', String(d.resetOnFootChange || 0));
  setVal('resetOnHoldSelect', String(d.resetOnHoldChange || 0));
  setVal('ledCustomSourceSelect', String(d.ledCustomSource || 0));
  // PC Global
  setChk('pcSharedChk', !!d.midiPcUpDownShared);
  setNum('pcStartInput', d.midiPcGlobalStart ?? 0);
  setNum('pcEndInput', d.midiPcGlobalEnd ?? 127);
  setNum('pcIncInput', d.midiPcGlobalInc ?? 1);
  setChk('pcLoopChk', !!d.midiPcGlobalLoop);
  setNum('pcValueInput', d.midiPcSharedValue ?? 255);
  // CC Global
  setChk('ccSharedChk', !!d.midiCcUpDownShared);
  setNum('ccStartInput', d.midiCcGlobalStart ?? 0);
  setNum('ccEndInput', d.midiCcGlobalEnd ?? 127);
  setNum('ccIncInput', d.midiCcGlobalInc ?? 1);
  setChk('ccLoopChk', !!d.midiCcGlobalLoop);
  setNum('ccValueInput', d.midiCcSharedValue ?? 255);
  // Preset names
  if (d.presetNames) {
    updatePresetSelectLabels(d.presetNames);
    if (d.activePreset !== undefined) {
      setVal('dashPresetSelect', String(d.activePreset));
      $('dashPresetNameInput').value = d.presetNames[d.activePreset] || '';
    }
  }
  // Stomp e EXP vêm no mesmo payload usb_config
  applyStompToUI(d);
  applyExpToUI(d);
}

async function saveUsbConfig() {
  const usbMode   = parseInt($('usbModeSelect').value,   10);
  const usbPreset = parseInt($('usbPresetSelect').value, 10);
  const payload = {
    __method: 'POST',
    usbMode,
    usbPreset,
    ledHoldMode: parseInt($('ledHoldModeSelect').value, 10),
    ledClickMode: parseInt($('ledClickModeSelect').value, 10),
    resetOnFootChange: parseInt($('resetOnFootSelect').value, 10),
    resetOnHoldChange: parseInt($('resetOnHoldSelect').value, 10),
    ledCustomSource: parseInt($('ledCustomSourceSelect').value, 10),
    midiPcUpDownShared: $('pcSharedChk').checked ? 1 : 0,
    midiPcGlobalStart: parseInt($('pcStartInput').value, 10),
    midiPcGlobalEnd: parseInt($('pcEndInput').value, 10),
    midiPcGlobalInc: parseInt($('pcIncInput').value, 10),
    midiPcGlobalLoop: $('pcLoopChk').checked ? 1 : 0,
    midiPcSharedValue: parseInt($('pcValueInput').value, 10),
    midiCcUpDownShared: $('ccSharedChk').checked ? 1 : 0,
    midiCcGlobalStart: parseInt($('ccStartInput').value, 10),
    midiCcGlobalEnd: parseInt($('ccEndInput').value, 10),
    midiCcGlobalInc: parseInt($('ccIncInput').value, 10),
    midiCcGlobalLoop: $('ccLoopChk').checked ? 1 : 0,
    midiCcSharedValue: parseInt($('ccValueInput').value, 10),
    presetNames: getPresetNames()
  };
  try {
    const r = await send('usb_config', payload);
    if (r.ok) {
      notify('Configurações globais salvas', 'success');
      if (r.data) applyUsbConfigToUI(r.data);
    } else {
      notify('Erro ao salvar: ' + (r.error || '?'), 'error');
    }
  } catch (e) {
    notify('Erro: ' + e.message, 'error');
  }
}

async function saveFsCount() {
  const fsCount = parseInt($('fsCountSelect').value, 10);
  State.fsCount = fsCount;
  rebuildFsGrid();
  await loadBank(State.currentBank);
  notify(`Modelo ${fsCount === 4 ? 'MT-4' : fsCount === 6 ? 'MT-6' : 'MT-8'} aplicado`, 'info');
}

/* ============================================================
   STOMP
   ============================================================ */
function applyStompToUI(d) {
  if (!d) return;
  setChk('stompEnabledChk',       !!d.customStompEnabled);
  setChk('stompSceneEnabledChk',  !!d.customStompSceneEnabled);
  setVal('stompSceneOutputSelect', String(d.customSceneOutput  ?? 0));
  setVal('stompSceneTriggerSelect',String(d.customSceneTriggerMode ?? 0));
  // Renderizar lista FX
  const list = $('stompFxList');
  if (!list) return;
  list.innerHTML = '';
  const fx = Array.isArray(d.customFx) ? d.customFx : [];
  fx.forEach((item, i) => appendStompFxRow(list, item, i));
  updateStompFxNums();
}

function appendStompFxRow(list, data, idx) {
  const tpl = document.getElementById('stompFxTpl');
  if (!tpl) return;
  const node = tpl.content.cloneNode(true);
  const row  = node.querySelector('.stomp-fx-row');
  const fxNum = (idx ?? list.querySelectorAll('.stomp-fx-row').length) + 1;
  row.querySelector('.stomp-fx-num').textContent = `FX${fxNum}`;
  row.querySelector('.stomp-fx-name').value = data?.name    ?? '';
  const iconInput = row.querySelector('.stomp-fx-icon');
  if (iconInput) {
    iconInput.value = data?.icon ?? '';
    iconInput.setAttribute('list', 'iconDatalist');
    const img = ensureStompFxIconPreview(iconInput);
    updateStompFxIconPreview(iconInput, img);
    iconInput.addEventListener('input', () => updateStompFxIconPreview(iconInput, img));
    iconInput.addEventListener('focus', () => {
      ensureIconPackLoaded().then(() => updateStompFxIconPreview(iconInput, img)).catch(() => {});
    });
    const btn = ensureStompFxIconPickerButton(iconInput);
    btn && btn.addEventListener('click', () => {
      ensureIconPackLoaded().then(() => StompIconPicker.openForInput(iconInput, `Escolher ícones (FX${fxNum})`)).catch(() => StompIconPicker.openForInput(iconInput, `Escolher ícones (FX${fxNum})`));
    });
    iconInput.addEventListener('dblclick', () => {
      ensureIconPackLoaded().then(() => StompIconPicker.openForInput(iconInput, `Escolher ícones (FX${fxNum})`)).catch(() => StompIconPicker.openForInput(iconInput, `Escolher ícones (FX${fxNum})`));
    });
  }
  row.querySelector('.stomp-fx-ch'  ).value = data?.channel ?? 1;
  row.querySelector('.stomp-fx-cc'  ).value = data?.cc      ?? 0;
  row.querySelector('.stomp-fx-von' ).value = data?.valueOn  ?? 127;
  row.querySelector('.stomp-fx-voff').value = data?.valueOff ?? 0;
  row.querySelector('.stomp-fx-fs'  ).value = String(data?.assignedFs ?? 0);
  // Cor
  const colorInp = row.querySelector('.stomp-fx-color');
  const r = data?.colorR ?? 255, g = data?.colorG ?? 0, b = data?.colorB ?? 0;
  colorInp.value = '#' + [r, g, b].map(v => v.toString(16).padStart(2,'0')).join('');
  row.querySelector('.stomp-fx-remove').addEventListener('click', () => {
    row.remove();
    updateStompFxNums();
  });
  list.appendChild(node);
  // Registrar color picker no novo input
  if (colorInp) CPK.attachToInput(colorInp);
}

let ICON_PACK_MAP = null;
let ICON_PACK_KEYS = [];
let ICON_PACK_META = null;
let ICON_PACK_LOAD_PROMISE = null;
let ICON_PACK_TRIED = false;

const BUILTIN_STOMP_ICON_KEYS = [
  'edit_dly', 'edit_dly_on',
  'edit_rvb', 'edit_rvb_on',
  'edit_drv',
  'edit_mod', 'edit_mod_on',
  'edit_eq', 'edit_eq_on',
  'edit_dyn',
  'edit_wah',
  'edit_amp', 'edit_amp_on',
  'edit_pre_amp', 'edit_pre_on',
  'edit_nr_on',
  'edit_tc_on',
  'edit_dst_on',
  'edit_cab', 'edit_cab_on',
  'edit_ir',
  'edit_vol',
  'edit_freq',
  'edit_fx_loop', 'edit_fx_snd', 'edit_fx_rtn',
  'delay', 'reverb', 'drive', 'mod', 'comp', 'filter', 'fx',
  'ac30', 'elgntblu', 'evh', 'mesamkv', 'mesamkwd', 'msbogdul', 'orngr120', 'tnxablk', 'tnxared',
  '●', '■', '▲', '◆', '★', '✚', '≈', '☰', '⋯', '◎'
];

function getIconPackKeys() {
  return Array.isArray(ICON_PACK_KEYS) ? ICON_PACK_KEYS : [];
}

function normalizeDataUrl(raw) {
  const s = String(raw || '').trim().replace(/;$/, '');
  if (!s) return '';
  if (s.startsWith('data:image/')) return s;
  if (/^[A-Za-z0-9+/=]+$/.test(s) && (s.startsWith('iVBOR') || s.startsWith('/9j/'))) {
    return `data:image/png;base64,${s}`;
  }
  return '';
}

function parseIconPackText(text) {
  const map = {};
  const meta = {};
  let section = '';
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('//')) {
      section = line.replace(/^\/\/+/, '').trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let left = line.slice(0, eq).trim();
    let right = line.slice(eq + 1).trim();
    if (!left || !right) continue;
    if (left.startsWith('const ')) left = left.slice(6).trim();
    left = left.replace(/\s+/g, ' ').trim();
    right = right.replace(/;$/, '');
    const key = left.replace(/\s/g, '');
    if (!key) continue;
    const dataUrl = normalizeDataUrl(right);
    if (!dataUrl) continue;
    map[key] = dataUrl;
    meta[key] = section || '';
  }
  const aliases = {
    edit_module_icon_amp: 'edit_amp',
    edit_module_icon_cab: 'edit_cab',
    edit_module_icon_dly: 'edit_dly',
    edit_module_icon_drv: 'edit_drv',
    edit_module_icon_dyn: 'edit_dyn',
    edit_module_icon_eq: 'edit_eq',
    edit_module_icon_freq: 'edit_freq',
    edit_module_icon_ir: 'edit_ir',
    edit_module_icon_mod: 'edit_mod',
    edit_module_icon_pre_amp: 'edit_pre_amp',
    edit_module_icon_rvb: 'edit_rvb',
    edit_module_icon_vol: 'edit_vol',
    edit_module_icon_wah: 'edit_wah',
    edit_module_icon_fx_loop: 'edit_fx_loop'
  };
  for (const [from, to] of Object.entries(aliases)) {
    if (map[from] && !map[to]) {
      map[to] = map[from];
      meta[to] = meta[from] || meta[to] || '';
    }
  }
  return { map, meta };
}

async function ensureIconPackLoaded() {
  if (ICON_PACK_MAP) return ICON_PACK_MAP;
  if (ICON_PACK_TRIED) return null;
  if (ICON_PACK_LOAD_PROMISE) return ICON_PACK_LOAD_PROMISE;
  ICON_PACK_TRIED = true;
  ICON_PACK_LOAD_PROMISE = (async () => {
    const r = await fetch('./base64.txt', { cache: 'no-store' });
    if (!r.ok) return null;
    const t = await r.text();
    const parsed = parseIconPackText(t);
    ICON_PACK_MAP = parsed?.map || {};
    ICON_PACK_META = parsed?.meta || {};
    ICON_PACK_KEYS = Object.keys(ICON_PACK_MAP).filter((k) => k && k.length <= 23);
    refreshIconDatalist();
    return ICON_PACK_MAP;
  })();
  return ICON_PACK_LOAD_PROMISE;
}

const TEXT_ICON_PALETTE = [
  '#3b82f6',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#14b8a6'
];

function parseTextIconKey(iconKey) {
  const k = String(iconKey || '').trim();
  const m = /^t:([^:]{1,4}):(\d{1,2})$/i.exec(k);
  if (!m) return null;
  const text = String(m[1] || '').trim().toUpperCase().slice(0, 4);
  const idx = parseInt(m[2], 10);
  if (!text) return null;
  if (isNaN(idx) || idx < 0 || idx >= TEXT_ICON_PALETTE.length) return null;
  return { text, idx };
}

function buildTextIconSvgDataUrl(text, hex) {
  const label = String(text || '').trim().toUpperCase().slice(0, 4);
  const color = String(hex || '').trim() || '#ffffff';
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="6" y="6" width="52" height="52" rx="14" ry="14" fill="rgba(0,0,0,0)" stroke="${color}" stroke-width="3"/>
  <text x="32" y="38" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-weight="800" font-size="18" fill="${color}">${label}</text>
</svg>`.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getIconDataUrlForKey(iconKey) {
  const k = String(iconKey || '').trim();
  if (!k) return '';
  const textIcon = parseTextIconKey(k);
  if (textIcon) {
    const color = TEXT_ICON_PALETTE[textIcon.idx] || '#ffffff';
    return buildTextIconSvgDataUrl(textIcon.text, color);
  }
  const m = ICON_PACK_MAP;
  return (m && typeof m === 'object') ? (m[k] || '') : '';
}

function getIconSectionForKey(iconKey) {
  const k = String(iconKey || '').trim();
  if (!k) return '';
  const m = ICON_PACK_META;
  return (m && typeof m === 'object') ? String(m[k] || '') : '';
}

function ensureStompFxIconPreview(iconInput) {
  const cell = iconInput?.closest?.('.param-cell');
  if (!cell) return null;
  let img = cell.querySelector('.stomp-fx-icon-preview');
  if (!img) {
    img = document.createElement('img');
    img.className = 'stomp-fx-icon-preview';
    img.alt = '';
    img.decoding = 'async';
    cell.appendChild(img);
  }
  return img;
}

function updateStompFxIconPreview(iconInput, imgEl) {
  if (!imgEl) return;
  const key = String(iconInput?.value || '').trim();
  const url = getIconDataUrlForKey(key);
  if (!url) {
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
    return;
  }
  imgEl.src = url;
  imgEl.style.display = '';
}

function ensureStompFxIconPickerButton(iconInput) {
  const cell = iconInput?.closest?.('.param-cell');
  if (!cell) return null;
  let btn = cell.querySelector('.stomp-fx-icon-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--icon stomp-fx-icon-btn';
    btn.textContent = '▦';
    btn.title = 'Escolher ícone';
    cell.appendChild(btn);
  }
  return btn;
}

const StompIconPicker = (() => {
  let overlay, modal, header, titleEl, grid, filterSelect, closeBtn;
  let bankPanel, bankHead, bankTitle, labelWrap, textInput, paletteEl, textApplyBtn;
  let textPreview;
  let textColorIdx = 0;
  let activeInput = null;
  let activeTitle = 'Escolher ícones';

  function ensureUi() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'live-icon-picker-overlay';
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    modal = document.createElement('div');
    modal.className = 'live-icon-picker-modal';
    overlay.appendChild(modal);

    header = document.createElement('div');
    header.className = 'live-icon-picker-header';
    modal.appendChild(header);

    titleEl = document.createElement('div');
    titleEl.className = 'live-icon-picker-title';
    titleEl.textContent = activeTitle;
    header.appendChild(titleEl);

    filterSelect = document.createElement('select');
    filterSelect.className = 'live-icon-type-select';
    filterSelect.addEventListener('change', render);
    filterSelect.setAttribute('aria-label', 'Filtrar por tipo');
    header.appendChild(filterSelect);

    closeBtn = document.createElement('button');
    closeBtn.className = 'live-icon-picker-close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Fechar';
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);

    bankPanel = document.createElement('div');
    bankPanel.className = 'live-icon-picker-bank-panel';
    modal.appendChild(bankPanel);

    bankHead = document.createElement('div');
    bankHead.className = 'live-icon-picker-bank-head';
    bankPanel.appendChild(bankHead);

    bankTitle = document.createElement('span');
    bankTitle.className = 'live-icon-picker-bank-title';
    bankTitle.textContent = 'Texto — cor e label';
    bankHead.appendChild(bankTitle);

    labelWrap = document.createElement('label');
    labelWrap.className = 'live-icon-picker-custom-label';
    labelWrap.innerHTML = `<span>Texto</span>`;
    bankHead.appendChild(labelWrap);

    textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.placeholder = 'A ou DRV';
    textInput.maxLength = 4;
    textInput.addEventListener('input', updateTextPreview);
    textInput.autocomplete = 'off';
    labelWrap.appendChild(textInput);

    textApplyBtn = document.createElement('button');
    textApplyBtn.className = 'live-icon-picker-close';
    textApplyBtn.type = 'button';
    textApplyBtn.textContent = 'Aplicar';
    textApplyBtn.addEventListener('click', () => applyTextIcon());
    bankHead.appendChild(textApplyBtn);

    const hint = document.createElement('p');
    hint.className = 'live-icon-picker-bank-hint';
    hint.textContent = '1) Escolhe uma cor · 2) (opcional) escreve texto · 3) Aplicar para gravar no campo ÍCONE.';
    bankPanel.appendChild(hint);

    paletteEl = document.createElement('div');
    paletteEl.className = 'live-icon-picker-palette';
    bankPanel.appendChild(paletteEl);

    const paletteRow = document.createElement('div');
    paletteRow.className = 'live-icon-picker-palette-row';
    paletteEl.appendChild(paletteRow);

    TEXT_ICON_PALETTE.forEach((hex, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'live-icon-picker-swatch';
      b.style.background = hex;
      b.addEventListener('click', () => {
        textColorIdx = idx;
        paletteRow.querySelectorAll('.live-icon-picker-swatch').forEach((x, i) => x.classList.toggle('is-selected', i === idx));
        updateTextPreview();
      });
      if (idx === textColorIdx) b.classList.add('is-selected');
      paletteRow.appendChild(b);
    });

    textPreview = document.createElement('img');
    textPreview.className = 'stomp-icon-textpreview';
    textPreview.alt = '';
    textPreview.decoding = 'async';
    bankHead.appendChild(textPreview);

    grid = document.createElement('div');
    grid.className = 'live-icon-picker-grid';
    modal.appendChild(grid);

    document.body.appendChild(overlay);
  }

  function updateTextPreview() {
    if (!textPreview) return;
    const t = String(textInput?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (!t) {
      textPreview.removeAttribute('src');
      textPreview.style.display = 'none';
      return;
    }
    const hex = TEXT_ICON_PALETTE[textColorIdx] || '#ffffff';
    textPreview.src = buildTextIconSvgDataUrl(t, hex);
    textPreview.style.display = '';
  }

  function applyTextIcon() {
    if (!activeInput) return;
    const t = String(textInput?.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (!t) return;
    const key = `t:${t}:${textColorIdx}`;
    activeInput.value = key;
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }

  function buildFilters() {
    const opts = [
      { v: 'texto', l: 'Texto (3 letras)' },
      { v: 'all', l: 'Todos (efeitos + amps)' },
      { v: 'effects', l: 'Efeitos' },
      { v: 'guitar amps', l: 'Amps (Guitarra)' },
      { v: 'bass amps', l: 'Amps (Baixo)' },
      { v: 'outros', l: 'Outros' }
    ];
    filterSelect.innerHTML = opts.map(o => `<option value="${o.v}">${o.l}</option>`).join('');
  }

  function norm(s) {
    return String(s || '').toLowerCase().trim();
  }

  function isCompatibleKey(k) {
    return !!(k && k.length <= 23);
  }

  function render() {
    const selected = norm(filterSelect?.value || 'all') || 'all';
    overlay && overlay.classList.toggle('is-banks-only', selected === 'texto');
    if (selected === 'texto') {
      grid.innerHTML = '';
      return;
    }
    const keys = Object.keys(ICON_PACK_MAP || {});
    const entries = [];

    for (const key of keys) {
      if (!key) continue;
      const url = getIconDataUrlForKey(key);
      if (!url) continue;
      const section = norm(getIconSectionForKey(key)) || 'outros';
      const compatible = isCompatibleKey(key);
      if (selected !== 'all' && section !== selected) continue;
      entries.push({ key, url, section, compatible });
    }

    const sectionLabels = {
      'effects': 'Efeitos',
      'guitar amps': 'Amps (Guitarra)',
      'bass amps': 'Amps (Baixo)',
      'outros': 'Outros'
    };
    const order = ['effects', 'guitar amps', 'bass amps', 'outros'];

    grid.innerHTML = '';
    const renderBtn = (e) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'live-icon-option';
      btn.dataset.key = e.key;
      btn.title = e.key;
      btn.disabled = !e.compatible;
      btn.innerHTML = `<div class="live-icon-row"><img alt="" src="${e.url}"></div>`;
      btn.addEventListener('click', () => {
        if (!activeInput) return;
        activeInput.value = e.key;
        activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        close();
      });
      grid.appendChild(btn);
    };

    if (selected === 'all') {
      const by = new Map();
      for (const e of entries) {
        const list = by.get(e.section) || [];
        list.push(e);
        by.set(e.section, list);
      }
      order.forEach((sec) => {
        const list = (by.get(sec) || []).slice();
        if (!list.length) return;
        const headerEl = document.createElement('div');
        headerEl.className = 'live-icon-type-header';
        headerEl.textContent = sectionLabels[sec] || sec;
        grid.appendChild(headerEl);
        list.sort((a, b) => a.key.localeCompare(b.key));
        list.forEach(renderBtn);
      });
    } else {
      entries.sort((a, b) => a.key.localeCompare(b.key));
      entries.forEach(renderBtn);
    }
  }

  function openForInput(inputEl, title) {
    activeInput = inputEl;
    activeTitle = String(title || 'Escolher ícones');
    ensureUi();
    if (titleEl) titleEl.textContent = activeTitle;
    buildFilters();
    render();
    overlay.classList.add('is-open');
    textInput.value = '';
    updateTextPreview();
    textInput.focus();
  }

  function close() {
    overlay && overlay.classList.remove('is-open');
    activeInput = null;
  }

  return { openForInput, close };
})();

function ensureIconDatalist() {
  let dl = document.getElementById('iconDatalist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'iconDatalist';
    document.body.appendChild(dl);
  }
  return dl;
}

function getIconLibrary() {
  try {
    const raw = localStorage.getItem('stompIconLibrary') || '[]';
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()) : [];
  } catch (_) {
    return [];
  }
}

function setIconLibrary(list) {
  const arr = Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim()) : [];
  localStorage.setItem('stompIconLibrary', JSON.stringify(arr.slice(0, 300)));
  refreshIconDatalist();
}

function refreshIconDatalist() {
  const dl = ensureIconDatalist();
  const merged = new Set();
  BUILTIN_STOMP_ICON_KEYS.forEach((k) => merged.add(k));
  getIconPackKeys().forEach((k) => merged.add(k));
  getIconLibrary().forEach((k) => merged.add(k));
  const icons = Array.from(merged).filter(Boolean);
  dl.innerHTML = icons.map(i => `<option value="${String(i).replace(/"/g, '&quot;')}"></option>`).join('');
}

async function tryLoadIconManifest() {
  const url = (localStorage.getItem('iconManifestUrl') || '').trim();
  if (!url) return;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (Array.isArray(j)) {
      const cur = new Set(getIconLibrary());
      j.forEach(x => { if (typeof x === 'string' && x.trim()) cur.add(x.trim()); });
      setIconLibrary(Array.from(cur));
    }
  } catch (_) {}
}

function updateStompFxNums() {
  const list = $('stompFxList');
  if (!list) return;
  list.querySelectorAll('.stomp-fx-row').forEach((row, i) => {
    const n = row.querySelector('.stomp-fx-num');
    if (n) n.textContent = `FX${i + 1}`;
  });
  const btn = $('stompAddFxBtn');
  if (btn) btn.disabled = list.querySelectorAll('.stomp-fx-row').length >= 12;
}

function collectStompFx() {
  const rows = ($('stompFxList') || { querySelectorAll: () => [] }).querySelectorAll('.stomp-fx-row');
  return Array.from(rows).map(row => {
    const hex = row.querySelector('.stomp-fx-color')?.value || '#ff0000';
    const rgb = hexToRgb(hex);
    return {
      name:       row.querySelector('.stomp-fx-name')?.value || '',
      icon:       row.querySelector('.stomp-fx-icon')?.value || '',
      channel:    parseInt(row.querySelector('.stomp-fx-ch')?.value  || '1', 10),
      cc:         parseInt(row.querySelector('.stomp-fx-cc')?.value  || '0', 10),
      valueOn:    parseInt(row.querySelector('.stomp-fx-von')?.value  || '127', 10),
      valueOff:   parseInt(row.querySelector('.stomp-fx-voff')?.value || '0', 10),
      assignedFs: parseInt(row.querySelector('.stomp-fx-fs')?.value  || '0', 10),
      colorR: rgb.r, colorG: rgb.g, colorB: rgb.b
    };
  });
}

async function loadStompConfig() {
  try {
    const r = await send('usb_config');
    if (r.ok) applyStompToUI(r.data);
  } catch (e) { console.warn('[stomp] load', e.message); }
}

async function saveStompConfig() {
  const fx = collectStompFx();
  const payload = {
    __method: 'POST',
    customStompEnabled:      $('stompEnabledChk').checked      ? 1 : 0,
    customStompSceneEnabled: $('stompSceneEnabledChk').checked  ? 1 : 0,
    customSceneOutput:       parseInt($('stompSceneOutputSelect').value,  10),
    customSceneTriggerMode:  parseInt($('stompSceneTriggerSelect').value, 10),
    customFx: fx
  };
  try {
    const r = await send('usb_config', payload);
    if (r.ok) { notify('Stomp salvo ✓', 'success'); if (r.data) applyStompToUI(r.data); }
    else notify('Erro ao salvar Stomp: ' + (r.error || '?'), 'error');
  } catch (e) { notify('Erro: ' + e.message, 'error'); }
}

/* ============================================================
   EXP
   ============================================================ */
function applyExpToUI(d) {
  if (!d) return;
  setVal('expModeSelect',  String(d.expMode  ?? 0));
  setNum('expHzInput',     d.expSendHz    ?? 20);
  setNum('expDeltaInput',  d.expMinDelta  ?? 2);
  setNum('expSmoothInput', d.expSmoothing ?? 4);
  setVal('expInvertSelect',String(d.expInvert ?? 0));
  setNum('expCalMinInput', d.expCalMinRaw ?? 0);
  setNum('expCalMaxInput', d.expCalMaxRaw ?? 1023);
}

let _expMonTimer = null;
let _expLastStatus = null;

function applyExpStatusToUI(d) {
  if (!d) return;
  const raw = Math.max(0, Math.min(1023, parseInt(d.raw ?? 0, 10) || 0));
  const v7  = Math.max(0, Math.min(127, parseInt(d.value7 ?? 0, 10) || 0));
  const pct = Math.round((raw / 1023) * 100);
  const fill = $('expRawFill');
  if (fill) fill.style.width = pct + '%';
  setText('expRawMetric', `${raw} / 1023`);
  const cal = d.calibrated ? 'calibrado' : 'sem calibração';
  const adc = d.adcReady ? 'ADC ok' : 'ADC erro';
  const expMode = parseInt(d.expMode ?? 0, 10);
  const modeLbl = expMode === 1 ? 'EXP on' : 'EXP off';
  const maps = parseInt(d.expMapCount ?? 0, 10) || 0;
  const midiEn = parseInt(d.midiSerialEn ?? 0, 10) ? 'MIDI TRS on' : 'MIDI TRS off';
  const sendReason = parseInt(d.expSendReason ?? 0, 10);
  const reasonLbl = {
    0: 'enviando',
    1: 'expMode off',
    2: 'sem calibração',
    3: 'banco EXP inativo',
    4: 'sem comandos',
    5: 'delta raw',
    6: 'baseline',
    7: 'sem mudança'
  }[sendReason] ?? `motivo ${sendReason}`;
  setText('expRawSub', `MIDI ${v7} · ${pct}% · ${cal} · ${adc} · ${modeLbl} · maps ${maps} · ${midiEn} · ${reasonLbl}`);
}

async function loadExpStatusOnce() {
  if (!State.connected) return false;
  try {
    const r = await send('exp_status');
    if (r.ok) {
      _expLastStatus = r.data || null;
      applyExpStatusToUI(_expLastStatus);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function normalizeExpCalInputs() {
  let minV = Math.max(0, Math.min(1023, parseInt($('expCalMinInput')?.value || '0', 10) || 0));
  let maxV = Math.max(0, Math.min(1023, parseInt($('expCalMaxInput')?.value || '0', 10) || 0));
  if (maxV < minV) {
    const t = minV;
    minV = maxV;
    maxV = t;
  }
  if (maxV <= minV + 8) {
    maxV = Math.min(1023, minV + 32);
  }
  setNum('expCalMinInput', minV);
  setNum('expCalMaxInput', maxV);
}

function setExpMonitorRunning(isRunning) {
  const btn = $('expMonitorBtn');
  if (btn) btn.textContent = isRunning ? '■ Parar' : '▶ Monitorar';
  const capMin = $('expCapMinBtn');
  const capMax = $('expCapMaxBtn');
  const enableCaps = !!(isRunning && _expLastStatus);
  if (capMin) capMin.disabled = !enableCaps;
  if (capMax) capMax.disabled = !enableCaps;
}

function stopExpMonitor() {
  if (_expMonTimer) {
    clearInterval(_expMonTimer);
    _expMonTimer = null;
  }
  setExpMonitorRunning(false);
}

function startExpMonitor() {
  if (_expMonTimer) return;
  setExpMonitorRunning(true);
  _expMonTimer = setInterval(() => {
    if (!State.connected) return;
    loadExpStatusOnce().then(() => setExpMonitorRunning(true)).catch(() => {});
  }, 120);
  loadExpStatusOnce().then(() => setExpMonitorRunning(true)).catch(() => {});
}

function toggleExpMonitor() {
  if (_expMonTimer) stopExpMonitor();
  else startExpMonitor();
}

async function loadExpConfig() {
  try {
    const r = await send('usb_config');
    if (r.ok) applyExpToUI(r.data);
  } catch (e) { console.warn('[exp] load', e.message); }
}

async function saveExpConfig() {
  const payload = {
    __method: 'POST',
    expMode:      parseInt($('expModeSelect').value,  10),
    expSendHz:    parseInt($('expHzInput').value,     10),
    expMinDelta:  parseInt($('expDeltaInput').value,  10),
    expSmoothing: parseInt($('expSmoothInput').value, 10),
    expInvert:    parseInt($('expInvertSelect').value, 10),
    expCalMinRaw: parseInt($('expCalMinInput').value, 10),
    expCalMaxRaw: parseInt($('expCalMaxInput').value, 10)
  };
  try {
    const r = await send('usb_config', payload);
    if (r.ok) { notify('EXP salvo ✓', 'success'); if (r.data) applyExpToUI(r.data); }
    else notify('Erro ao salvar EXP: ' + (r.error || '?'), 'error');
  } catch (e) { notify('Erro: ' + e.message, 'error'); }
}

/* ============================================================
   EXP BANK COMMANDS — CRUD por banco
   ============================================================ */

const EXP_OUTPUT_DEFAULT = 6;

function normalizeExpOutput(raw, fallback = EXP_OUTPUT_DEFAULT) {
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > 6) return fallback;
  return parsed;
}

function updateExpCmdNums() {
  const list = $('expCmdList');
  if (!list) return;
  list.querySelectorAll('.exp-cmd-row').forEach((row, i) => {
    const num = row.querySelector('.exp-cmd-num');
    if (num) num.textContent = '#' + (i + 1);
  });
}

function appendExpCmdRow(list, data, idx) {
  const tpl = document.getElementById('expCmdTpl');
  if (!tpl) return;
  const node = tpl.content.cloneNode(true);
  const row  = node.querySelector('.exp-cmd-row');

  const type = parseInt(data?.type ?? 0, 10);
  row.dataset.expType = String(type);

  // Preencher tipo
  const typeSelect = row.querySelector('.exp-cmd-type');
  if (typeSelect) typeSelect.value = String(type);

  // Mostrar/ocultar campos conforme tipo
  const fieldsCC = row.querySelector('.exp-cmd-fields--cc');
  const fieldsSX = row.querySelector('.exp-cmd-fields--sysex');
  if (fieldsCC) fieldsCC.style.display = type === 0 ? '' : 'none';
  if (fieldsSX) fieldsSX.style.display = type === 1 ? '' : 'none';

  if (type === 0) {
    // CC
    const sel = v => row.querySelector(v);
    const outEl = sel('.exp-cmd-output');
    if (outEl) outEl.value = String(normalizeExpOutput(data?.output, EXP_OUTPUT_DEFAULT));
    const chEl = sel('.exp-cmd-channel');
    if (chEl) chEl.value = String(data?.channel ?? 1);
    const ccEl = sel('.exp-cmd-cc');
    if (ccEl) ccEl.value = String(data?.cc ?? 7);
    const minEl = sel('.exp-cmd-outmin');
    if (minEl) minEl.value = String(data?.outMin ?? 0);
    const maxEl = sel('.exp-cmd-outmax');
    if (maxEl) maxEl.value = String(data?.outMax ?? 127);
    const invEl = sel('.exp-cmd-invert');
    if (invEl) invEl.checked = !!(data?.invert);
  } else {
    // SysEx
    const outEl = row.querySelector('.exp-cmd-output-sx');
    if (outEl) outEl.value = String(normalizeExpOutput(data?.output, EXP_OUTPUT_DEFAULT));
    const sxEl = row.querySelector('.exp-cmd-sysex');
    if (sxEl) sxEl.value = data?.sysex ?? '';
    const idxEl = row.querySelector('.exp-cmd-sysex-idx');
    if (idxEl) idxEl.value = String(data?.sysexValueIndex ?? 0);
  }

  // Evento: troca tipo
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const t = parseInt(typeSelect.value, 10);
      row.dataset.expType = String(t);
      if (fieldsCC) fieldsCC.style.display = t === 0 ? '' : 'none';
      if (fieldsSX) fieldsSX.style.display = t === 1 ? '' : 'none';
    });
  }

  // Evento: remover
  const delBtn = row.querySelector('.exp-cmd-del');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      row.remove();
      updateExpCmdNums();
    });
  }

  list.appendChild(row);
  updateExpCmdNums();
}

function collectExpCmds() {
  const list = $('expCmdList');
  const messages = [];
  if (!list) return messages;
  list.querySelectorAll('.exp-cmd-row').forEach(row => {
    const type = parseInt(row.dataset.expType ?? '0', 10);
    if (type === 0) {
      messages.push({
        type:    0,
        output:  normalizeExpOutput(row.querySelector('.exp-cmd-output')?.value, EXP_OUTPUT_DEFAULT),
        channel: parseInt(row.querySelector('.exp-cmd-channel')?.value ?? '1', 10),
        cc:      parseInt(row.querySelector('.exp-cmd-cc')?.value      ?? '7', 10),
        outMin:  parseInt(row.querySelector('.exp-cmd-outmin')?.value  ?? '0', 10),
        outMax:  parseInt(row.querySelector('.exp-cmd-outmax')?.value  ?? '127', 10),
        invert:  row.querySelector('.exp-cmd-invert')?.checked ? 1 : 0
      });
    } else {
      messages.push({
        type:             1,
        output:           normalizeExpOutput(row.querySelector('.exp-cmd-output-sx')?.value, EXP_OUTPUT_DEFAULT),
        sysex:            row.querySelector('.exp-cmd-sysex')?.value?.trim()?.replace(/\s+/g, '') ?? '',
        sysexValueIndex:  parseInt(row.querySelector('.exp-cmd-sysex-idx')?.value  ?? '0', 10)
      });
    }
  });
  return messages;
}

function applyExpBankToUI(bank, expData) {
  const label = $('expBankLabel');
  if (label) label.textContent = BANK_LETTERS[bank] ?? String(bank);
  const chk = $('expBankEnabledChk');
  if (chk) chk.checked = !!(expData?.enabled);
  const list = $('expCmdList');
  if (!list) return;
  list.innerHTML = '';
  const msgs = Array.isArray(expData?.messages) ? expData.messages : [];
  msgs.forEach((m, i) => appendExpCmdRow(list, m, i));
}

async function saveExpBank() {
  const messages = collectExpCmds();
  const needsSerial = messages.some(m => [3, 4, 5, 6].includes(m.output));
  if (needsSerial && !parseInt($('midiSerialEnSelect')?.value || '0', 10)) {
    notify('Saída MIDI no EXP requer MIDI TRS ativo (menu MIDI TRS → Habilitado)', 'warning', 6000);
  }
  const enabledChk = $('expBankEnabledChk');
  if (enabledChk && messages.length > 0) enabledChk.checked = true;
  const expPayload = {
    enabled:  enabledChk?.checked ? 1 : 0,
    messages
  };
  const params = {
    __method: 'POST',
    banks: { [String(State.currentBank)]: { exp: expPayload } }
  };
  const r = await send('midi_config', params);
  if (!r.ok) {
    const msg = r.error || r.message || '?';
    notify('Erro ao salvar comandos EXP: ' + msg, 'error');
    throw new Error(msg);
  }
  return r;
}

/* ============================================================
   DEVICE CONFIG (BT / MIDI Serial / Wi-Fi)
   ============================================================ */
async function loadDeviceConfig() {
  let okAny = false;
  try {
    const r = await send('device_config');
    if (r.ok) {
      applyDeviceConfigToUI(r.data);
      okAny = true;
      return true;
    }
    if (r && r.error) {
      console.warn('[device_config] load:', r.error);
    }
  } catch (e) {
    console.warn('[device_config] load', e.message);
  }

  try {
    const r2 = await send('GETCONFIG');
    if (r2.ok) {
      applyGetconfigCompatToUI(r2.data);
      okAny = true;
      return true;
    }
    console.warn('[GETCONFIG] load:', r2.error || 'unknown');
  } catch (e2) {
    console.warn('[GETCONFIG] load', e2.message);
  }

  if (!okAny) {
    notify('Menus BT/MIDI/Wi‑Fi não responderam via USB (precisa firmware com GETCONFIG/SETCONFIG/SETWIFI ou device_config)', 'warning', 6500);
  }
  return false;
}

function applyDeviceConfigToUI(d) {
  if (!d) return;
  // BT
  setVal('btModeSelect',   String(d.btMode    ?? 0));
  setVal('btPresetSelect', String(d.btPreset  ?? 0));
  setVal('btMidiCcSelect', String(d.btMidiCc  ?? 0));
  setChk('btCustomEnChk',  !!d.btCustomEn);
  if ($('btCustomNameInput')) $('btCustomNameInput').value = d.btCustomName || '';
  // MIDI Serial
  setVal('midiSerialEnSelect',  String(d.midiSerialEn  ?? 0));
  setVal('midiSerialChSelect',  String(d.midiSerialCh  ?? 1));
  setVal('midiSerialPreSelect', String(d.midiSerialPre ?? 0));
  // WiFi
  if ($('wifiSsidInput')) $('wifiSsidInput').value = d.wifiSsid || '';
  if ($('wifiPwInput'))   $('wifiPwInput').value   = d.wifiPw   || '';
}

function applyGetconfigCompatToUI(d) {
  if (!d) return;
  // Bluetooth (nomes compatíveis com wifi_config.c / manual)
  setVal('btModeSelect',   String(d.BT_MODE    ?? 0));
  setVal('btPresetSelect', String(d.BT_PRESET  ?? 0));
  setVal('btMidiCcSelect', String(d.BT_MIDI_CC ?? 0));
  setChk('btCustomEnChk',  !!d.BT_CUST_EN);
  if ($('btCustomNameInput')) $('btCustomNameInput').value = d.BT_CUST_NAME || '';

  // MIDI Serial (DIN/UART)
  setVal('midiSerialEnSelect',  String(d.S_MIDI_EN   ?? 0));
  setVal('midiSerialChSelect',  String(d.S_MIDI_CH   ?? 1));
  setVal('midiSerialPreSelect', String(d.MIDI_PRESET ?? 0));

  // Wi‑Fi AP
  if ($('wifiSsidInput')) $('wifiSsidInput').value = d.WIFI_SSID || '';
  if ($('wifiPwInput'))   $('wifiPwInput').value   = d.WIFI_PW   || '';
}

function fieldsToLegacySetconfig(fields) {
  const out = {};
  if (fields.btMode      !== undefined) out.BT_MODE     = fields.btMode;
  if (fields.btPreset    !== undefined) out.BT_PRESET   = fields.btPreset;
  if (fields.btMidiCc    !== undefined) out.BT_MIDI_CC  = fields.btMidiCc;
  if (fields.btCustomEn  !== undefined) out.BT_CUST_EN  = fields.btCustomEn;
  if (fields.btCustomName!== undefined) out.BT_CUST_NAME= fields.btCustomName;
  if (fields.midiSerialEn!== undefined) out.S_MIDI_EN   = fields.midiSerialEn;
  if (fields.midiSerialCh!== undefined) out.S_MIDI_CH   = fields.midiSerialCh;
  if (fields.midiSerialPre!== undefined) out.MIDI_PRESET= fields.midiSerialPre;
  return out;
}

function fieldsToLegacySetwifi(fields) {
  const out = {};
  if (fields.wifiSsid !== undefined) out.WIFI_SSID = fields.wifiSsid;
  if (fields.wifiPw   !== undefined) out.WIFI_PW   = fields.wifiPw;
  return out;
}

async function saveDeviceConfig(fields) {
  const payload = { __method: 'POST', ...fields };
  try {
    const r = await send('device_config', payload);
    if (r.ok) {
      notify('Salvo ✓ (reinicie o controlador para aplicar)', 'success');
      if (r.data) applyDeviceConfigToUI(r.data);
      return true;
    } else {
      if (r && r.error === 'unknown_cmd') {
        throw new Error('unknown_cmd');
      }
      notify('Erro ao salvar: ' + (r.error || '?'), 'error');
    }
  } catch (e) {
    if (String(e.message || '').includes('unknown_cmd')) {
      const legacyCfg = fieldsToLegacySetconfig(fields);
      const legacyWifi = fieldsToLegacySetwifi(fields);
      try {
        let appliedAny = false;
        if (Object.keys(legacyCfg).length) {
          const r1 = await send('SETCONFIG', legacyCfg);
          appliedAny = appliedAny || !!r1.ok;
          if (r1.ok && r1.data) applyGetconfigCompatToUI(r1.data);
          if (!r1.ok) console.warn('[SETCONFIG] save:', r1.error || 'unknown');
        }
        if (Object.keys(legacyWifi).length) {
          const r2 = await send('SETWIFI', legacyWifi);
          appliedAny = appliedAny || !!r2.ok;
          if (r2.ok && r2.data) applyGetconfigCompatToUI(r2.data);
          if (!r2.ok) console.warn('[SETWIFI] save:', r2.error || 'unknown');
        }
        if (appliedAny) {
          notify('Salvo ✓ (reinicie o controlador para aplicar)', 'success');
          return true;
        }
        notify('Erro ao salvar (legacy): firmware não tem SETCONFIG/SETWIFI', 'error', 6500);
      } catch (e2) {
        notify('Erro (legacy): ' + e2.message, 'error');
      }
      return false;
    }
    notify('Erro: ' + e.message, 'error');
    return false;
  }
  return false;
}

/* ============================================================
   MIDI CONFIG — carregar banco
   ============================================================ */
async function loadBankChunked(bankNum) {
  const first = (bankNum === null || Number.isNaN(bankNum))
    ? await send('midi_config', { fs: 1 })
    : await send('midi_config', { bank: bankNum, fs: 1 });
  if (!first.ok) {
    const bkLabel = (bankNum === null || Number.isNaN(bankNum)) ? '(atual)' : (BANK_LETTERS[bankNum] || String(bankNum));
    notify('Erro ao ler banco ' + bkLabel + ': ' + (first.error || '?'), 'error');
    return false;
  }
  const data = first.data || {};
  const resolvedBank = (data.bank !== undefined) ? parseInt(data.bank, 10) : (bankNum ?? State.currentBank);
  const fsCount = (data.fsCount && [4, 6, 8].includes(data.fsCount)) ? data.fsCount : State.fsCount;

  if (resolvedBank !== null && !Number.isNaN(resolvedBank) && resolvedBank !== State.currentBank) {
    State.currentBank = resolvedBank;
    updateBankHighlight(resolvedBank);
  }
  if (fsCount !== State.fsCount) {
    State.fsCount = fsCount;
    updateFsCountSelect(fsCount);
    rebuildFsGrid();
  }

  const bk = {};
  for (let fi = 1; fi <= fsCount; fi++) {
    let rr;
    if (fi === 1) rr = first;
    else rr = await send('midi_config', { bank: resolvedBank, fs: fi });
    if (rr && rr.ok && rr.data && rr.data['fs' + fi]) {
      bk['fs' + fi] = rr.data['fs' + fi];
    }
    if (fi === 1 && rr?.data?.exp) bk.exp = rr.data.exp;
  }
  const bankKey = String(resolvedBank ?? State.currentBank);
  State.config.banks[bankKey] = bk;
  applyBankToUI(resolvedBank ?? State.currentBank, bk);
  applyExpBankToUI(resolvedBank ?? State.currentBank, bk.exp ?? null);
  setText('configSource', `Lido do controlador · banco ${BANK_LETTERS[resolvedBank ?? State.currentBank]}`);
  return true;
}

/** True se alguma chave visível está em modo STG (MT4/MT6/MT8). */
function bankUiHasStgMode() {
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (card?.dataset?.mode === 'stg') return true;
  }
  return false;
}

async function loadBank(bank) {
  try {
    const bankNum = (bank === undefined || bank === null) ? null : parseInt(bank, 10);
    /* Só STG: GET do banco inteiro estoura heap (4/6/8 chaves). Outros modos: fluxo normal. */
    if (bankUiHasStgMode()) {
      return await loadBankChunked(bankNum);
    }
    const r = (bankNum === null || Number.isNaN(bankNum))
      ? await send('midi_config', {})
      : await send('midi_config', { bank: bankNum });
    if (!r.ok) {
      if ((r.error || '') === 'out_of_memory') {
        try {
          return await loadBankChunked(bankNum);
        } catch (e) {
          notify('Erro ao carregar banco (chunks): ' + e.message, 'error');
          return false;
        }
      }
      if (bankNum !== null && !Number.isNaN(bankNum)) {
        const r2 = await send('midi_config', {});
        if (r2.ok) {
          const data2 = r2.data;
          const resolvedBank2 = (data2 && data2.bank !== undefined) ? parseInt(data2.bank, 10) : null;
          if (resolvedBank2 !== null && !Number.isNaN(resolvedBank2) && resolvedBank2 !== State.currentBank) {
            State.currentBank = resolvedBank2;
            updateBankHighlight(resolvedBank2);
          }
          if (data2.fsCount && [4, 6, 8].includes(data2.fsCount)) {
            const changed = data2.fsCount !== State.fsCount;
            State.fsCount = data2.fsCount;
            updateFsCountSelect(data2.fsCount);
            if (changed) rebuildFsGrid();
          }
          const bk2 = {};
          for (let fi = 1; fi <= State.fsCount; fi++) {
            const k = 'fs' + fi;
            if (data2[k]) bk2[k] = data2[k];
          }
          if (data2.exp) bk2.exp = data2.exp;
          const bankKey2 = String(resolvedBank2 ?? State.currentBank);
          State.config.banks[bankKey2] = bk2;
          applyBankToUI(resolvedBank2 ?? State.currentBank, bk2);
          applyExpBankToUI(resolvedBank2 ?? State.currentBank, bk2.exp ?? null);
          setText('configSource', `Lido do controlador · banco ${BANK_LETTERS[resolvedBank2 ?? State.currentBank]}`);
          return true;
        }
      }
      const bkLabel = (bankNum === null || Number.isNaN(bankNum)) ? '(atual)' : (BANK_LETTERS[bankNum] || String(bankNum));
      notify('Erro ao ler banco ' + bkLabel + ': ' + (r.error || '?'), 'error');
      return false;
    }
    const data = r.data;
    const resolvedBank = (data && data.bank !== undefined) ? parseInt(data.bank, 10) : bankNum;
    if (resolvedBank !== null && !Number.isNaN(resolvedBank) && resolvedBank !== State.currentBank) {
      State.currentBank = resolvedBank;
      updateBankHighlight(resolvedBank);
    }
    console.log('[loadBank] banco', resolvedBank, 'fsCount:', data.fsCount, 'chaves:', Object.keys(data).filter(k => k.startsWith('fs')));
    // Log completo de TODOS os FS retornados pelo dispositivo
    for (let fi = 1; fi <= (data.fsCount || State.fsCount); fi++) {
      const fsD = data['fs' + fi];
      if (fsD) {
        console.log(`[loadBank] RESPONSE fs${fi}: stgEnabled=${fsD.stgEnabled} | ricochetEnabled=${fsD.ricochetEnabled} | ricochetRiseTimeMs=${fsD.ricochetRiseTimeMs} | extraClick=${JSON.stringify(fsD.extraClick)} | extraHold=${JSON.stringify(fsD.extraHold)}`);
      }
    }
    if (data.fsCount && [4, 6, 8].includes(data.fsCount)) {
      const changed = data.fsCount !== State.fsCount;
      State.fsCount = data.fsCount;
      updateFsCountSelect(data.fsCount);
      if (changed) rebuildFsGrid();
    }
    const bk = {};
    for (let fi = 1; fi <= State.fsCount; fi++) {
      const k = 'fs' + fi;
      if (data[k]) bk[k] = data[k];
    }
    if (data.exp) bk.exp = data.exp;
    const bankKey = String(resolvedBank ?? State.currentBank);
    State.config.banks[bankKey] = bk;
    applyBankToUI(resolvedBank ?? State.currentBank, bk);
    applyExpBankToUI(resolvedBank ?? State.currentBank, bk.exp ?? null);
    setText('configSource', `Lido do controlador · banco ${BANK_LETTERS[resolvedBank ?? State.currentBank]}`);
    return true;
  } catch (e) {
    console.error('[loadBank]', e);
    notify('Erro ao carregar banco: ' + e.message, 'error');
    return false;
  }
}

/* ============================================================
   MIDI CONFIG — salvar banco(s)
   ============================================================ */
async function saveBanks() {
  /* Salva cada FS individualmente para contornar limitação de memória do firmware.
   * O firmware copia o objeto "banks" com cJSON_Duplicate() antes de processar.
   * Com todos os 6 FS em um único payload (~6KB JSON = ~40KB árvore cJSON),
   * essa cópia falha por falta de heap, resultando em salvar silenciosamente nada.
   * Enviando um FS por vez (~700 bytes JSON = ~6KB), a cópia sempre tem sucesso. */
  const presetEl = $('dashPresetSelect');
  const activePreset = presetEl ? parseInt(presetEl.value, 10) : 0;
  let savedCount = 0;
  const deferFlashUntilLastFs = bankUiHasStgMode();

  try {
    for (let fi = 1; fi <= State.fsCount; fi++) {
      const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
      if (!card) continue;

      let fsData;
      try {
        fsData = collectFsFromCard(card);
      } catch (e) {
        console.error(`[collectFsFromCard FS${fi}]`, e);
        const stored = State.config.banks[String(State.currentBank)];
        fsData = stored?.['fs' + fi] ?? null;
      }
      if (!fsData) continue;

      const fsKey = 'fs' + fi;
      const banks  = { [String(State.currentBank)]: { [fsKey]: fsData } };
      const isLastFs = (fi === State.fsCount);
      const skipFlash = deferFlashUntilLastFs && !isLastFs;
      // Enviar activePreset apenas no primeiro FS para definir o preset correto
      const params = (fi === 1)
        ? { __method: 'POST', banks, activePreset, ...(skipFlash ? { __skipSave: true } : {}) }
        : { __method: 'POST', banks, ...(skipFlash ? { __skipSave: true } : {}) };

      const fsJson = JSON.stringify({ cmd: 'midi_config', id: 0, ...params });
      console.log(`[saveBanks] FS${fi} payload: ${fsJson.length} bytes | stgEnabled=${fsData.stgEnabled} | stgStageCount=${fsData.stgStageCount} | ricochetEnabled=${fsData.ricochetEnabled} | ricochetRiseTimeMs=${fsData.ricochetRiseTimeMs} | extraClick=${JSON.stringify(fsData.extraClick)}`);

      const r = await send('midi_config', params);
      console.log(`[saveBanks] FS${fi} resposta: ok=${r.ok} | error=${r.error ?? '—'}`);

      if (!r.ok) {
        const errMsg = r.error || r.message || JSON.stringify(r);
        console.error(`[saveBanks] FS${fi} falhou:`, errMsg);
        notify(`Erro ao salvar FS${fi}: ${errMsg}`, 'error');
        return;
      }
      savedCount++;
      if (skipFlash) await new Promise(r => setTimeout(r, 80));
    }

    console.log(`[saveBanks] ${savedCount} FS salvos com sucesso`);

    // Salvar comandos EXP do banco (payload separado e pequeno)
    try {
      await saveExpBank();
      console.log('[saveBanks] EXP banco salvo');
    } catch (e) {
      console.warn('[saveBanks] EXP banco falhou:', e.message);
    }

    // Atualizar cache local
    const bk = {};
    for (let fi = 1; fi <= State.fsCount; fi++) {
      const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
      if (card) { try { bk['fs' + fi] = collectFsFromCard(card); } catch (_) {} }
    }
    State.config.banks[String(State.currentBank)] = bk;
    setText('configSource', `Verificando…`);

    if (State.connected && !State.isMock) {
      await loadBank(State.currentBank);
      notify('Configuração salva e verificada ✓', 'success');
    } else {
      notify('Configuração salva com sucesso!', 'success');
      setText('configSource', `Salvo · banco ${BANK_LETTERS[State.currentBank]}`);
    }
  } catch (e) {
    console.error('[saveBanks] exceção:', e);
    notify('Erro ao salvar: ' + e.message, 'error');
  }
}

/* ============================================================
   DASHBOARD — active key polling
   ============================================================ */
let _dashPollInterval = null;

function updateDashboard() {
  clearInterval(_dashPollInterval);
  if (!State.connected) return;
  _dashPollInterval = setInterval(pollActiveKey, 2000);
  pollActiveKey();
}

async function pollActiveKey() {
  if (!State.connected) { clearInterval(_dashPollInterval); return; }
  try {
    const r = await send('active_key');
    if (!r.ok) return;
    const d = r.data;
    const fs = d.activeFootswitch || 0;
    $('dashActiveFs').textContent = fs > 0 ? ('FS' + fs) : '—';
    $('dashBank').textContent = BANK_LETTERS[d.activeBank] || '—';
    $('dashPreset').textContent = `Profile ${(d.currentBank !== undefined ? '' : '—')}`;
    // Highlight active FS dot
    $$('.fs-status-dot').forEach(dot => dot.classList.remove('active'));
    if (fs > 0) {
      const dot = document.querySelector(`.fs-card[data-fs="${fs}"] .fs-status-dot`);
      if (dot) dot.classList.add('active');
      $('dashActiveFs').textContent = 'FS' + fs;
    }
  } catch (_) {}
}

/* ============================================================
   BANCO — construir FS grid (NOVO MODELO)
   ============================================================ */
/* ============================================================
   TIPO NUM ↔ STR (compatível com controlador-midi.js)
   ============================================================ */
const TYPE_STR_MAP = { cc:0, pc:1, sysex:2, cc_up:3, cc_down:4, pc_up:5, pc_down:6, bank_up_int:7, bank_down_int:8, fs_sync:9, midi_clock:10, midi_clock_tap:11, ampero_tap:12 };
const TYPE_NUM_MAP = Object.fromEntries(Object.entries(TYPE_STR_MAP).map(([k,v])=>[v,k]));
function typeToStr(n) { return TYPE_NUM_MAP[n] ?? 'cc'; }
function typeToNum(s) { return TYPE_STR_MAP[s] ?? 0; }

/* Deriva o modo a partir dos campos do FS JSON */
function getFsModeFromConfig(fs) {
  if (fs?.stgEnabled)      return 'stg';
  if (fs?.ricochetEnabled) return 'ricochet';
  if (!fs?.holdEnabled)    return 'normal';
  return fs?.holdToggle ? 'tap' : 'momentary';
}

function rebuildFsGrid() {
  const grid = $('fsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const tpl = document.getElementById('fsTpl');
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('.fs-card');
    card.dataset.fs = fi;
    card.querySelector('.fs-number').textContent = 'FS' + fi;

    // Mode pills (apenas os que têm data-mode; layer pills têm data-layer e são tratados em initFsLayerControls)
    $$('.mode-pill[data-mode]', card).forEach(pill => {
      pill.addEventListener('click', () => setFsMode(card, pill.dataset.mode));
    });

    // Add button
    card.querySelector('.fs-add-cmd').addEventListener('click', () => {
      const mode = card.dataset.mode || 'normal';
      appendCmdRow(card.querySelector('[data-cmdlist="main"]'), {}, mode);
    });

    grid.appendChild(node);
    // Registrar color pickers nos novos inputs de cor do card (após append ao DOM)
    const addedCard = grid.lastElementChild;
    if (addedCard) {
      addedCard.querySelectorAll('input[type=color]').forEach(inp => CPK.attachToInput(inp));
    }
  }
}

/* -------- MODE pills -------- */
function setFsMode(card, mode) {
  $$('.mode-pill', card).forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  card.dataset.mode = mode;

  // Visibilidade dos painéis de configuração
  $$('.fs-mode-config', card).forEach(c => c.style.display = 'none');
  const ricEl = card.querySelector('.fs-ricochet-cfg');
  const stgEl = card.querySelector('.fs-stg-cfg');
  if (mode === 'ricochet' && ricEl) ricEl.style.display = 'block';
  if (mode === 'stg' && stgEl) {
    stgEl.style.display = 'block';
    // Inicializa os stage cards se ainda não existirem (troca manual de modo)
    const stagesWrap = stgEl.querySelector('.stg-stages');
    if (stagesWrap && !stagesWrap.querySelector('.stg-stage-card')) {
      buildStgSection(card, {});
    }
  }

  // Seção de comandos: visível para Normal/Momentâneo/Tap
  const cmdSection = card.querySelector('.fs-cmd-section');
  if (cmdSection) cmdSection.style.display = (mode === 'ricochet' || mode === 'stg') ? 'none' : 'block';

  // Título da seção de comandos
  const cmdTitle = card.querySelector('.fs-cmd-section-title');
  if (cmdTitle) {
    const labels = { normal: 'Comandos MIDI', momentary: 'Comandos MIDI — Momentâneo', tap: 'Comandos MIDI — Tap' };
    cmdTitle.textContent = labels[mode] ?? 'Comandos MIDI';
  }

  // Atualizar tipos disponíveis e visibilidade de Gatilho/Estado em cada linha existente
  $$('.cmd-row', card).forEach(row => updateCmdRowMode(row, mode));
}

/* -------- CMD ROW: criação -------- */
function appendCmdRow(list, data, mode) {
  if (!list) return;
  mode = mode || list.closest('.fs-card')?.dataset?.mode || 'normal';
  const tpl = document.getElementById('cmdRowTpl');
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector('.cmd-row');

  // Preencher valores
  const typeStr = data.typeStr ?? typeToStr(data.type ?? 0);
  row.querySelector('.cmd-type').value  = typeStr;
  row.querySelector('.cmd-ch').value    = data.channel ?? 1;
  row.querySelector('.cmd-trig').value  = String(data.trigger ?? 0);
  row.querySelector('.cmd-state').value = String(data.onOff ?? 0);
  row.querySelector('.cmd-out').value   = String(data.output ?? 2);
  row.querySelector('.cmd-ccnum').value = data.cc ?? 64;
  row.querySelector('.cmd-ccval').value = data.value ?? 127;
  row.querySelector('.cmd-pc').value    = data.pc ?? 0;
  row.querySelector('.cmd-udstart').value = data.pcRangeStart ?? 0;
  row.querySelector('.cmd-udend').value   = data.pcRangeEnd ?? 127;
  row.querySelector('.cmd-udstep').value  = data.pcIncrement ?? 1;
  row.querySelector('.cmd-udloop').checked = !!data.pcLoop;
  row.querySelector('.cmd-bpm').value   = data.value ?? 120;
  // FS Sync
  row.querySelector('.cmd-synctgt').value   = data.cc ?? 1;
  row.querySelector('.cmd-syncmode').value  = String(data.value ?? 2);
  row.querySelector('.cmd-syncstate').value = String(data.state ?? 0);
  // SysEx
  if (data.sysex && Array.isArray(data.sysex)) {
    row.querySelector('.cmd-sysex').value = data.sysex.map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  }

  // Atualizar opções do tipo-select conforme modo
  updateCmdTypeOptions(row, mode);
  // Atualizar visibilidade dos campos
  updateCmdRowFields(row, typeStr, mode);

  // Eventos
  row.querySelector('.cmd-type').addEventListener('change', e => {
    const m = row.closest('.fs-card')?.dataset?.mode || 'normal';
    updateCmdRowFields(row, e.target.value, m);
  });
  row.querySelector('.cmd-remove').addEventListener('click', () => row.remove());

  list.appendChild(node);
}

/* Atualiza opções disponíveis no select de tipo conforme modo */
function updateCmdTypeOptions(row, mode) {
  const sel = row.querySelector('.cmd-type');
  if (!sel) return;
  const cur = sel.value;

  const NORMAL_TYPES  = ['cc','cc_up','cc_down','pc','pc_up','pc_down','sysex','bank_up_int','bank_down_int','fs_sync'];
  const MOMENT_TYPES  = ['cc','pc','sysex'];
  const TAP_TYPES     = ['cc','fs_sync','midi_clock','midi_clock_tap','ampero_tap'];

  const TYPE_LABELS = {
    cc:'CC', cc_up:'CC Up', cc_down:'CC Down', pc:'PC', pc_up:'PC Up', pc_down:'PC Down',
    sysex:'SysEx', bank_up_int:'Banco+', bank_down_int:'Banco−', fs_sync:'FS Sync',
    midi_clock:'MIDI Clock', midi_clock_tap:'Clock Tap', ampero_tap:'Ampero Tap'
  };

  let allowed;
  if (mode === 'tap')       allowed = TAP_TYPES;
  else if (mode === 'momentary') allowed = MOMENT_TYPES;
  else                      allowed = NORMAL_TYPES;  // normal — sem tipos Tap-only

  sel.innerHTML = allowed.map(v => `<option value="${v}">${TYPE_LABELS[v]}</option>`).join('');
  sel.value = allowed.includes(cur) ? cur : 'cc';
}

/* Mostra/oculta campos de uma row conforme tipo e modo do FS */
function updateCmdRowFields(row, typeStr, mode) {
  const isCC    = typeStr === 'cc';
  const isCCUD  = typeStr === 'cc_up' || typeStr === 'cc_down';
  const isPC    = typeStr === 'pc';
  const isPCUD  = typeStr === 'pc_up'  || typeStr === 'pc_down';
  const isUD    = isCCUD || isPCUD;
  const isSysEx = typeStr === 'sysex';
  const isFsSync = typeStr === 'fs_sync';
  const isBank  = typeStr === 'bank_up_int' || typeStr === 'bank_down_int';
  const isClock = typeStr === 'midi_clock';
  const isClockTap = typeStr === 'midi_clock_tap';
  const isAmpero = typeStr === 'ampero_tap';
  const hideTrig  = mode === 'tap' || mode === 'momentary';
  const hideState = isUD || isBank || isClock || isClockTap || isAmpero || isFsSync;

  const sf = (cls, v) => { const el = row.querySelector(`.cmd-f-${cls}`); if (el) el.style.display = v ? '' : 'none'; };
  sf('ch',      !isFsSync && !isBank);
  sf('trig',    !hideTrig);
  sf('state',   !hideState);
  sf('out',     !isFsSync && !isBank && !isAmpero);
  sf('ccnum',   isCC || isCCUD);
  sf('ccval',   isCC);
  sf('pc',      isPC);
  sf('udstart', isUD);
  sf('udend',   isUD);
  sf('udstep',  isUD);
  sf('udloop',  isUD);
  sf('sysex',   isSysEx);
  sf('bpm',     isClock);
  sf('synctgt', isFsSync);
  sf('syncmode',isFsSync);
  sf('syncstate',isFsSync);

  // Labels dinâmicos conforme modo
  const stLbl = row.querySelector('.cmd-state-lbl');
  const stOn  = row.querySelector('.cmd-state-on-opt');
  const stOff = row.querySelector('.cmd-state-off-opt');
  if (mode === 'momentary') {
    if (stLbl) stLbl.textContent = 'Momento';
    if (stOn)  stOn.textContent  = 'Aperta';
    if (stOff) stOff.textContent = 'Solta';
  } else {
    if (stLbl) stLbl.textContent = 'Estado';
    if (stOn)  stOn.textContent  = 'On';
    if (stOff) stOff.textContent = 'Off';
  }

  // Ampero Tap força saída = MIDI Serial
  const outEl = row.querySelector('.cmd-out');
  if (outEl) {
    outEl.disabled = isAmpero;
    if (isAmpero) outEl.value = '3';
  }

  row.dataset.type = typeStr;
}

/* Atualiza as rows existentes quando o modo muda */
function updateCmdRowMode(row, mode) {
  updateCmdTypeOptions(row, mode);
  updateCmdRowFields(row, row.querySelector('.cmd-type')?.value || 'cc', mode);
}

/* ============================================================
   STG — Estágios
   ============================================================ */
function buildStgSection(card, fs) {
  const cfg = card.querySelector('.fs-stg-cfg');
  if (!cfg) return;

  const stageCount = Math.min(5, Math.max(2, fs.stgStageCount ?? 2));
  const stageCountSel = cfg.querySelector('.stg-stage-count');
  if (stageCountSel) stageCountSel.value = String(stageCount);

  const wrap = cfg.querySelector('.stg-stages');
  if (!wrap) return;
  wrap.innerHTML = '';

  // Criar 5 stage cards mas mostrar só stageCount
  const tpl = document.getElementById('stgStageTpl');
  for (let si = 0; si < 5; si++) {
    const node = tpl.content.cloneNode(true);
    const sc = node.querySelector('.stg-stage-card');
    sc.dataset.stage = si;
    sc.querySelector('.stg-stage-title').textContent = `Estágio ${si + 1}`;
    sc.style.display = si < stageCount ? '' : 'none';

    const ledInput = sc.querySelector('.stg-led-pct');
    const st = (fs.stgStages ?? [])[si] ?? {};
    const lp = Math.min(100, Math.max(0, st.ledPercent ?? 100));
    ledInput.value = lp;
    updateStgLedPreview(sc, lp);
    ledInput.addEventListener('input', () => updateStgLedPreview(sc, ledInput.value));

    const cmdsWrap = sc.querySelector('.stg-cmds');
    const cmds = Array.isArray(st.cmds) ? st.cmds.slice(0, 4) : [];
    cmds.forEach(cmd => appendStgCmd(cmdsWrap, cmd));
    updateStgAddBtn(sc);

    sc.querySelector('.stg-add-cmd').addEventListener('click', () => {
      const n = cmdsWrap.querySelectorAll('.stg-cmd-row').length;
      if (n >= 4) return;
      appendStgCmd(cmdsWrap, {});
      updateStgAddBtn(sc);
    });

    wrap.appendChild(node);
  }

  // Listener para mudar qtd de estágios (registra só uma vez usando dataset flag)
  if (stageCountSel && !stageCountSel.dataset.listenerSet) {
    stageCountSel.dataset.listenerSet = '1';
    stageCountSel.addEventListener('change', () => {
      const n = parseInt(stageCountSel.value, 10);
      cfg.querySelectorAll('.stg-stage-card').forEach((c, i) => {
        c.style.display = i < n ? '' : 'none';
      });
    });
  }
}

function appendStgCmd(cmdsWrap, data) {
  const tpl = document.getElementById('stgCmdTpl');
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector('.stg-cmd-row');
  row.querySelector('.stg-cmd-out').value = String(data.output ?? 2);
  row.querySelector('.stg-cmd-ch').value  = data.channel ?? 1;
  row.querySelector('.stg-cmd-cc').value  = data.cc ?? 0;
  row.querySelector('.stg-cmd-val').value = data.value ?? 0;
  row.querySelector('.stg-cmd-remove').addEventListener('click', () => {
    const sc = row.closest('.stg-stage-card');
    row.remove();
    updateStgAddBtn(sc);
  });
  cmdsWrap.appendChild(node);
}

function updateStgAddBtn(stageCard) {
  const n = stageCard.querySelectorAll('.stg-cmd-row').length;
  const btn = stageCard.querySelector('.stg-add-cmd');
  if (btn) btn.disabled = n >= 4;
}

function updateStgLedPreview(stageCard, pct) {
  const v = Math.round(Math.min(100, Math.max(0, parseInt(pct, 10) || 0)) * 255 / 100);
  const preview = stageCard.querySelector('.stg-led-preview');
  if (preview) preview.textContent = `≈ ${v}/255`;
}

function collectStgFromCard(card) {
  const cfg = card.querySelector('.fs-stg-cfg');
  if (!cfg) return null;
  const stageCount = Math.min(5, Math.max(2, parseInt(cfg.querySelector('.stg-stage-count')?.value ?? '2', 10)));
  const stgStages = [];
  for (let si = 0; si < stageCount; si++) {
    const sc = cfg.querySelector(`.stg-stage-card[data-stage="${si}"]`);
    const ledPercent = Math.min(100, Math.max(0, parseInt(sc?.querySelector('.stg-led-pct')?.value ?? '100', 10)));
    const cmds = [];
    sc?.querySelectorAll('.stg-cmd-row').forEach(r => {
      cmds.push({
        output:  parseInt(r.querySelector('.stg-cmd-out')?.value ?? '2', 10),
        channel: parseInt(r.querySelector('.stg-cmd-ch')?.value  ?? '1', 10) || 1,
        cc:      parseInt(r.querySelector('.stg-cmd-cc')?.value  ?? '0', 10),
        value:   parseInt(r.querySelector('.stg-cmd-val')?.value ?? '0', 10)
      });
    });
    stgStages.push({ ledPercent, cmds });
  }
  return { stgStageCount: stageCount, stgStages };
}

/* ============================================================
   BANCO → UI
   ============================================================ */
function applyBankToUI(bank, bankData) {
  if (!bankData) return;
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const fsKey = 'fs' + fi;
    const fs = bankData[fsKey];
    if (!fs) continue;
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (!card) continue;
    applyFsToCard(card, fs);
  }
}

function applyFsToCard(card, fs) {
  if (!card || !fs) return;
  const fsNum = card.dataset.fs;
  const detectedMode = getFsModeFromConfig(fs);
  console.log(`[applyFsToCard] FS${fsNum}: modo=${detectedMode} | ricochetRiseTimeMs=${fs.ricochetRiseTimeMs} | extraClick.length=${(fs.extraClick||[]).length} | extraHold.length=${(fs.extraHold||[]).length}`);

  card.dataset.extraClickCache = JSON.stringify(fs.extraClick ?? []);
  card.dataset.extraHoldCache = JSON.stringify(fs.extraHold ?? []);
  card.dataset.extraStompClickCache = JSON.stringify(fs.extraStompClick ?? []);
  // 'scene' e 'stompLed' não são mais incluídos no GET do firmware (causavam OOM/crash).
  // O editor não edita esses campos; o firmware os preserva pois o POST não os inclui.
  // Sempre resetar para camada 'preset' ao carregar dados do controlador.
  // Se o usuário tinha selecionado 'stomp', os comandos normais ficariam ocultos
  // pois buildFsCmdListFromCard usaria extraStompClick (que costuma estar vazio).
  card.dataset.cmdLayer = 'preset';

  // Nome
  const nameInput = card.querySelector('.fs-name');
  if (nameInput) nameInput.value = fs.fsName || '';

  // LED cores
  if (fs.ledColors) {
    const lc = fs.ledColors;
    setColorPicker(card, '[data-led="on"]',      rgbToHex(lc.r_on,      lc.g_on,      lc.b_on));
    setColorPicker(card, '[data-led="off"]',     rgbToHex(lc.r_off,     lc.g_off,     lc.b_off));
    setColorPicker(card, '[data-led="hold_on"]', rgbToHex(lc.r_hold_on, lc.g_hold_on, lc.b_hold_on));
    setColorPicker(card, '[data-led="hold_off"]',rgbToHex(lc.r_hold_off,lc.g_hold_off,lc.b_hold_off));
  }

  // Detectar e aplicar modo
  const mode = getFsModeFromConfig(fs);
  setFsMode(card, mode);

  // Preservar campos da ação principal para round-trip (não exibidos na lista)
  card.dataset.mainAction = JSON.stringify({
    actionType: fs.actionType ?? 0, channel: fs.channel ?? 1, toggle: fs.toggle ?? 0,
    ccParameter: fs.ccParameter ?? 64, ccValue: fs.ccValue ?? 127, pcPreset: fs.pcPreset ?? 0,
    ccParameter2: fs.ccParameter2 ?? 64, ccValue1: fs.ccValue1 ?? 127, ccValue2: fs.ccValue2 ?? 0,
    pcPreset1: fs.pcPreset1 ?? 0, pcPreset2: fs.pcPreset2 ?? 0,
    holdActionType: fs.holdActionType ?? 0, holdChannel: fs.holdChannel ?? 1,
    holdCcParameter: fs.holdCcParameter ?? 64, holdCcValue: fs.holdCcValue ?? 127,
    holdPcPreset: fs.holdPcPreset ?? 0, holdCcParameter2: fs.holdCcParameter2 ?? 64,
    holdCcValue1: fs.holdCcValue1 ?? 127, holdCcValue2: fs.holdCcValue2 ?? 0,
    tapTarget: fs.tapTarget ?? 0, tapChannel: fs.tapChannel ?? 1,
    pcUpDownMode: fs.pcUpDownMode ?? 0, pcRangeStart: fs.pcRangeStart ?? 0,
    pcRangeEnd: fs.pcRangeEnd ?? 127, pcIncrement: fs.pcIncrement ?? 1,
    pcLoop: fs.pcLoop ?? 0, pcUpDownTrigger: fs.pcUpDownTrigger ?? 0, pcUpDownOutput: fs.pcUpDownOutput ?? 2,
    ccUpDownMode: fs.ccUpDownMode ?? 0, ccUpDownCc: fs.ccUpDownCc ?? 0,
    ccRangeStart: fs.ccRangeStart ?? 0, ccRangeEnd: fs.ccRangeEnd ?? 127,
    ccIncrement: fs.ccIncrement ?? 1, ccLoop: fs.ccLoop ?? 0,
    ccUpDownTrigger: fs.ccUpDownTrigger ?? 0, ccUpDownOutput: fs.ccUpDownOutput ?? 2
  });

  // Config Ricochet
  const gS = (sel, val) => { const el = card.querySelector(sel); if (el) el.value = String(val ?? ''); };
  const gI = (sel, val) => { const el = card.querySelector(sel); if (el) el.value = val ?? 0; };
  const gC = (sel, val) => { const el = card.querySelector(sel); if (el) el.checked = !!val; };
  gI('.fs-ric-ch',    fs.ricochetChannel ?? 1);
  gI('.fs-ric-cc',    fs.ricochetCc ?? 0);
  gI('.fs-ric-start', fs.ricochetStartValue ?? 0);
  gI('.fs-ric-end',   fs.ricochetEndValue ?? 127);
  gI('.fs-ric-rise',  fs.ricochetRiseTimeMs ?? 500);
  gI('.fs-ric-fall',  fs.ricochetFallTimeMs ?? 500);
  if (detectedMode === 'ricochet') {
    const riseEl = card.querySelector('.fs-ric-rise');
    console.log(`[applyFsToCard] FS${fsNum} ricochet: rise input found=${!!riseEl} | valor aplicado=${fs.ricochetRiseTimeMs ?? 500} | valor DOM=${riseEl?.value}`);
  }
  gS('.fs-ric-curve', fs.ricochetCurve ?? 0);
  gS('.fs-ric-mode',  fs.ricochetMode ?? 0);
  gS('.fs-ric-out',   fs.ricochetOutput ?? 2);
  gC('.fs-ric-invert',fs.ricochetInvert);

  // Lista unificada de comandos (click trigger=0, hold trigger=1)
  const mainList = card.querySelector('[data-cmdlist="main"]');
  if (mainList) {
    mainList.innerHTML = '';
    buildFsCmdListFromCard(card, fs, mode).forEach(cmd => appendCmdRow(mainList, cmd, mode));
  }

  // STG: construir seção de estágios
  if (mode === 'stg') buildStgSection(card, fs);

  initFsLayerControls(card);
}

function initFsLayerControls(card) {
  const bar = card.querySelector('.fs-layer-bar');
  if (!bar) return;
  const layer = card.dataset.cmdLayer || 'preset';
  bar.style.display = '';
  const pills = bar.querySelectorAll('.mode-pill[data-layer]');
  pills.forEach(p => {
    p.classList.toggle('active', p.dataset.layer === layer);
    if (!p.dataset.bound) {
      p.dataset.bound = '1';
      p.addEventListener('click', () => setFsCmdLayer(card, p.dataset.layer));
    }
  });
}

function parseJsonArray(str) {
  try {
    const v = JSON.parse(str || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function captureCmdListToCaches(card) {
  const list = card.querySelector('[data-cmdlist="main"]');
  if (!list) return;
  const mode = card.dataset.mode || 'normal';
  if (mode === 'ricochet' || mode === 'stg') return;
  const allCmds = collectCmdList(list);
  const clickCmds = allCmds.filter(c => c.trigger === 0);
  const holdCmds  = allCmds.filter(c => c.trigger === 1);
  const layer = card.dataset.cmdLayer || 'preset';
  if (layer === 'stomp') {
    card.dataset.extraStompClickCache = JSON.stringify(clickCmds.map(toExtraCmd));
  } else {
    card.dataset.extraClickCache = JSON.stringify(clickCmds.map(toExtraCmd));
    card.dataset.extraHoldCache  = JSON.stringify(holdCmds.map(toExtraCmd));
  }
}

function setFsCmdLayer(card, layer) {
  if (!card) return;
  if (layer !== 'preset' && layer !== 'stomp') return;
  if ((card.dataset.cmdLayer || 'preset') === layer) return;
  captureCmdListToCaches(card);
  card.dataset.cmdLayer = layer;
  initFsLayerControls(card);
  const mode = card.dataset.mode || 'normal';

  // Atualizar título da seção de comandos conforme a layer
  const cmdTitle = card.querySelector('.fs-cmd-section-title');
  if (cmdTitle) {
    if (layer === 'stomp') {
      cmdTitle.textContent = 'Comandos Stomp';
    } else {
      const modeLabels = { normal: 'Comandos MIDI', momentary: 'Comandos MIDI — Momentâneo', tap: 'Comandos MIDI — Tap' };
      cmdTitle.textContent = modeLabels[mode] ?? 'Comandos MIDI';
    }
  }

  const mainList = card.querySelector('[data-cmdlist="main"]');
  if (mainList) {
    mainList.innerHTML = '';
    const fsStub = {
      extraClick: parseJsonArray(card.dataset.extraClickCache),
      extraHold: parseJsonArray(card.dataset.extraHoldCache),
      extraStompClick: parseJsonArray(card.dataset.extraStompClickCache)
    };
    buildFsCmdListFromCard(card, fsStub, mode).forEach(cmd => appendCmdRow(mainList, cmd, mode));
    if (layer === 'stomp') {
      $$('.cmd-row', mainList).forEach(row => {
        const trig = row.querySelector('.cmd-trig');
        if (trig) { trig.value = '0'; trig.disabled = true; }
      });
    } else {
      $$('.cmd-row', mainList).forEach(row => {
        const trig = row.querySelector('.cmd-trig');
        if (trig) trig.disabled = false;
      });
    }
  }
}

/* Monta lista unificada de comandos.
 * A ação principal (actionType/ccParameter…) é estrutural do firmware —
 * os usuários configuram tudo via extraClick/extraHold.
 * Mostramos APENAS os extras; a ação principal é preservada internamente.
 */
function buildFsCmdListFromCard(card, fs, mode) {
  const cmds = [];
  if (mode === 'ricochet' || mode === 'stg') return cmds;

  const layer = card?.dataset?.cmdLayer || 'preset';
  if (layer === 'stomp') {
    (fs.extraStompClick ?? []).forEach(e => cmds.push(normalizeCmd(e, 0)));
  } else {
    (fs.extraClick ?? []).forEach(e => cmds.push(normalizeCmd(e, 0)));
    (fs.extraHold ?? []).forEach(e => cmds.push(normalizeCmd(e, 1)));
  }

  return cmds;
}

function normalizeCmd(e, defaultTrigger) {
  return {
    typeStr: typeToStr(e.type ?? 0),
    channel: e.channel ?? 1,
    cc:      e.cc ?? e.ccParameter ?? 0,
    pc:      e.pc ?? e.pcPreset ?? 0,
    value:   e.value ?? e.ccValue ?? 0,
    onOff:   e.onOff ?? 0,
    state:   e.state ?? 0,
    output:  e.output ?? 2,
    trigger: e.trigger ?? defaultTrigger ?? 0,
    pcRangeStart: e.pcRangeStart ?? 0,
    pcRangeEnd:   e.pcRangeEnd ?? 127,
    pcIncrement:  e.pcIncrement ?? 1,
    pcLoop:       e.pcLoop ?? false,
    sysex:   e.sysex ?? []
  };
}

/* ============================================================
   UI → BANCO (coleta)
   ============================================================ */
function collectFsFromCard(card) {
  captureCmdListToCaches(card);
  const lc = {};
  ['on','off','hold_on','hold_off'].forEach(k => {
    const inp = card.querySelector(`[data-led="${k}"]`);
    const rgb = hexToRgb(inp ? inp.value : '#000000');
    if (k === 'on')       { lc.r_on  = rgb.r; lc.g_on  = rgb.g; lc.b_on  = rgb.b; }
    if (k === 'off')      { lc.r_off = rgb.r; lc.g_off = rgb.g; lc.b_off = rgb.b; }
    if (k === 'hold_on')  { lc.r_hold_on  = rgb.r; lc.g_hold_on  = rgb.g; lc.b_hold_on  = rgb.b; }
    if (k === 'hold_off') { lc.r_hold_off = rgb.r; lc.g_hold_off = rgb.g; lc.b_hold_off = rgb.b; }
  });

  const ni = v => parseInt(v, 10) || 0;
  const b  = chk => chk ? 1 : 0;
  const gEl = sel => card.querySelector(sel);
  const gv  = sel => gEl(sel)?.value ?? '0';
  const gc  = sel => !!gEl(sel)?.checked;
  const gn  = sel => ni(gv(sel));

  const mode = card.dataset.mode || 'normal';

  // Recuperar ação principal preservada (salva ao carregar o card)
  let savedMain = {};
  try { savedMain = JSON.parse(card.dataset.mainAction || '{}'); } catch (_) {}

  // Coletar todos os comandos da lista unificada e separar por trigger
  const allCmds   = collectCmdList(card.querySelector('[data-cmdlist="main"]'));
  const clickCmds = allCmds.filter(c => c.trigger === 0);
  const holdCmds  = allCmds.filter(c => c.trigger === 1);

  // Flags de modo → firmware
  // Quando STG está ativo, holdEnabled/holdToggle devem ser false (como no app original)
  const holdEnabled = (mode === 'stg') ? false : (mode === 'momentary' || mode === 'tap' || holdCmds.length > 0);
  const holdToggle  = (mode === 'stg') ? false : (mode === 'tap');

  // STG data
  const stgData = (mode === 'stg') ? (collectStgFromCard(card) ?? {}) : {};

  // STG: payload mínimo (~300 B) — evita OOM no ESP32 ao salvar FS6+ (MT-6)
  if (mode === 'stg') {
    return {
      fsName: gEl('.fs-name')?.value || '',
      stgEnabled: 1,
      stgStageCount: stgData.stgStageCount ?? 2,
      stgStages: stgData.stgStages ?? [],
      holdEnabled: 0,
      holdToggle: 0,
      ricochetEnabled: 0,
      extraClick: [],
      extraHold: [],
      extraStompClick: [],
      ledColors: lc
    };
  }

  return {
    fsName: gEl('.fs-name')?.value || '',
    // Preservar ação principal original (usuários usam só extras)
    actionType:   savedMain.actionType   ?? 0,
    channel:      savedMain.channel      ?? 1,
    toggle:       savedMain.toggle       ?? 0,
    ccParameter:  savedMain.ccParameter  ?? 64,
    ccValue:      savedMain.ccValue      ?? 127,
    pcPreset:     savedMain.pcPreset     ?? 0,
    ccParameter2: savedMain.ccParameter2 ?? 64,
    ccValue1:     savedMain.ccValue1     ?? 127,
    ccValue2:     savedMain.ccValue2     ?? 0,
    pcPreset1:    savedMain.pcPreset1    ?? 0,
    pcPreset2:    savedMain.pcPreset2    ?? 0,
    holdEnabled: b(holdEnabled),
    holdToggle:  b(holdToggle),
    holdActionType: savedMain.holdActionType ?? 0,
    holdChannel:    savedMain.holdChannel    ?? 1,
    holdCcParameter:  savedMain.holdCcParameter  ?? 64,
    holdCcValue:      savedMain.holdCcValue      ?? 127,
    holdPcPreset:     savedMain.holdPcPreset     ?? 0,
    holdCcParameter2: savedMain.holdCcParameter2 ?? 64,
    holdCcValue1:     savedMain.holdCcValue1     ?? 127,
    holdCcValue2:     savedMain.holdCcValue2     ?? 0,
    holdPcPreset1: 0, holdPcPreset2: 0,
    tapTarget: savedMain.tapTarget ?? 0,
    tapChannel: savedMain.tapChannel ?? 1,
    pcUpDownMode: savedMain.pcUpDownMode ?? 0,
    pcRangeStart: savedMain.pcRangeStart ?? 0,
    pcRangeEnd:   savedMain.pcRangeEnd   ?? 127,
    pcIncrement:  savedMain.pcIncrement  ?? 1,
    pcLoop:       savedMain.pcLoop       ?? 0,
    pcUpDownTrigger: savedMain.pcUpDownTrigger ?? 0,
    pcUpDownOutput:  savedMain.pcUpDownOutput  ?? 2,
    ccUpDownMode: savedMain.ccUpDownMode ?? 0,
    ccUpDownCc:   savedMain.ccUpDownCc   ?? 0,
    ccRangeStart: savedMain.ccRangeStart ?? 0,
    ccRangeEnd:   savedMain.ccRangeEnd   ?? 127,
    ccIncrement:  savedMain.ccIncrement  ?? 1,
    ccLoop:       savedMain.ccLoop       ?? 0,
    ccUpDownTrigger: savedMain.ccUpDownTrigger ?? 0,
    ccUpDownOutput:  savedMain.ccUpDownOutput  ?? 2,
    ricochetEnabled:    b(mode === 'ricochet'),
    stgEnabled:         0,
    ricochetChannel:    gn('.fs-ric-ch'),
    ricochetCc:         gn('.fs-ric-cc'),
    ricochetStartValue: gn('.fs-ric-start'),
    ricochetEndValue:   gn('.fs-ric-end'),
    ricochetRiseTimeMs: gn('.fs-ric-rise'),
    ricochetFallTimeMs: gn('.fs-ric-fall'),
    ricochetCurve:  gn('.fs-ric-curve'),
    ricochetMode:   gn('.fs-ric-mode'),
    ricochetOutput: gn('.fs-ric-out'),
    ricochetInvert: b(gc('.fs-ric-invert')),
    extraClick: parseJsonArray(card.dataset.extraClickCache),
    extraHold:  parseJsonArray(card.dataset.extraHoldCache),
    // Extras (stomp layer)
    extraStompClick: parseJsonArray(card.dataset.extraStompClickCache),
    // 'scene' e 'stompLed' não são enviados: o firmware os preserva intactos
    // quando ausentes no payload — evita apagar config Stomp feita pelo app.
    ledColors: lc
  };
}

/* Coleta linhas .cmd-row de uma lista (novo template) */
function collectCmdList(list) {
  if (!list) return [];
  return $$('.cmd-row', list).map(row => {
    const typeStr = row.querySelector('.cmd-type')?.value ?? 'cc';
    const isFsSync = typeStr === 'fs_sync';
    const isAmpero = typeStr === 'ampero_tap';
    return {
      typeStr,
      type:    typeToNum(typeStr),
      channel: parseInt(row.querySelector('.cmd-ch')?.value ?? '1', 10) || 1,
      trigger: parseInt(row.querySelector('.cmd-trig')?.value ?? '0', 10),
      onOff:   parseInt(row.querySelector('.cmd-state')?.value ?? '0', 10),
      output:  isAmpero ? 3 : parseInt(row.querySelector('.cmd-out')?.value ?? '2', 10),
      cc:      isFsSync ? parseInt(row.querySelector('.cmd-synctgt')?.value ?? '1', 10)
                        : parseInt(row.querySelector('.cmd-ccnum')?.value ?? '0', 10),
      value:   isFsSync ? parseInt(row.querySelector('.cmd-syncmode')?.value ?? '2', 10)
                        : (typeStr === 'midi_clock' ? parseInt(row.querySelector('.cmd-bpm')?.value ?? '120', 10)
                          : parseInt(row.querySelector('.cmd-ccval')?.value ?? '0', 10)),
      state:   isFsSync ? parseInt(row.querySelector('.cmd-syncstate')?.value ?? '0', 10) : 0,
      pc:      parseInt(row.querySelector('.cmd-pc')?.value ?? '0', 10),
      pcRangeStart: parseInt(row.querySelector('.cmd-udstart')?.value ?? '0', 10),
      pcRangeEnd:   parseInt(row.querySelector('.cmd-udend')?.value ?? '127', 10),
      pcIncrement:  Math.max(1, parseInt(row.querySelector('.cmd-udstep')?.value ?? '1', 10)),
      pcLoop:       !!row.querySelector('.cmd-udloop')?.checked,
      sysex: parseSysExHex(row.querySelector('.cmd-sysex')?.value ?? ''),
      sysex_len: (parseSysExHex(row.querySelector('.cmd-sysex')?.value ?? '')).length
    };
  });
}

function parseSysExHex(str) {
  return str.trim().split(/\s+/).filter(Boolean).map(h => parseInt(h, 16) || 0).slice(0, 32);
}

function toExtraCmd(c) {
  return { type: c.type, channel: c.channel, cc: c.cc, value: c.value, pc: c.pc, onOff: c.onOff, state: c.state ?? 0, output: c.output, trigger: c.trigger ?? 0, pcRangeStart: c.pcRangeStart ?? 0, pcRangeEnd: c.pcRangeEnd ?? 127, pcIncrement: c.pcIncrement ?? 1, pcLoop: c.pcLoop ? 1 : 0, sysex: c.sysex ?? [], sysex_len: c.sysex_len ?? 0 };
}

function collectAllBanksFromUI() {
  const banks = {};
  for (let bi = 0; bi <= 8; bi++) {
    const stored = State.config.banks[String(bi)];
    if (!stored) continue;
    banks[String(bi)] = stored;
  }
  const bk = {};
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (!card) continue;
    try {
      bk['fs' + fi] = collectFsFromCard(card);
    } catch (e) {
      console.error(`[collectFsFromCard FS${fi}]`, e);
      // Preservar dados originais se a coleta falhar
      const stored = State.config.banks[String(State.currentBank)];
      if (stored?.['fs' + fi]) bk['fs' + fi] = stored['fs' + fi];
    }
  }
  banks[String(State.currentBank)] = bk;
  return banks;
}

/* ============================================================
   BANCO — selecionar
   ============================================================ */
async function selectBank(bank) {
  // Guardar UI actual no state antes de trocar
  const current = State.currentBank;
  try {
    const currentBk = State.config.banks[String(current)] || {};
    for (let fi = 1; fi <= State.fsCount; fi++) {
      const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
      if (card) currentBk['fs' + fi] = collectFsFromCard(card);
    }
    currentBk.exp = {
      enabled: $('expBankEnabledChk')?.checked ? 1 : 0,
      messages: collectExpCmds()
    };
    State.config.banks[String(current)] = currentBk;
  } catch (e) {
    console.error('[selectBank collect]', e);
  }

  State.currentBank = bank;
  updateBankHighlight(bank);

  // Verificar se já temos o banco em cache
  if (State.config.banks[String(bank)]) {
    applyBankToUI(bank, State.config.banks[String(bank)]);
    applyExpBankToUI(bank, State.config.banks[String(bank)].exp ?? null);
    setText('configSource', `Cache · banco ${BANK_LETTERS[bank]}`);
    if (State.connected) {
      // Notificar o controlador do banco activo
      send('set_current_bank', { bank }).catch(() => {});
    }
  } else {
    if (State.connected) {
      await loadBank(bank);
      send('set_current_bank', { bank }).catch(() => {});
    }
  }
}

function updateBankHighlight(bank) {
  $$('.bank-tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.bank, 10) === bank);
  });
  const lbl = $('expBankLabel');
  if (lbl) lbl.textContent = BANK_LETTERS[bank] ?? String(bank);
}

/* ============================================================
   COPIAR / COLAR
   ============================================================ */
function copyActiveFs() {
  // Copia o primeiro FS visível (FS1 por padrão — usuário pode selecionar)
  const card = document.querySelector('.fs-card[data-fs="1"]');
  if (!card) { notify('Nenhum FS disponível', 'warning'); return; }
  State.copyBuffer = collectFsFromCard(card);
  notify('FS1 copiado para o clipboard', 'info');
}

function pasteActiveFs() {
  if (!State.copyBuffer) { notify('Clipboard vazio — copie primeiro', 'warning'); return; }
  const card = document.querySelector('.fs-card[data-fs="1"]');
  if (!card) return;
  applyFsToCard(card, State.copyBuffer);
  notify('Configuração colada em FS1', 'success');
}

function copyBank() {
  const bk = {};
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (card) bk['fs' + fi] = collectFsFromCard(card);
  }
  State.bankCopyBuffer = bk;
  notify(`Banco ${BANK_LETTERS[State.currentBank]} copiado`, 'info');
}

function pasteBank() {
  if (!State.bankCopyBuffer) { notify('Clipboard de banco vazio', 'warning'); return; }
  const target = parseInt($('pasteBankTarget').value, 10);
  State.config.banks[String(target)] = JSON.parse(JSON.stringify(State.bankCopyBuffer));
  if (target === State.currentBank) {
    applyBankToUI(target, State.bankCopyBuffer);
  }
  notify(`Banco colado em ${BANK_LETTERS[target]}`, 'success');
}

/* ============================================================
   BACKUP / RESTAURAR
   ============================================================ */
function doBackup() {
  // Coleta estado actual antes de fazer backup
  const bk = {};
  for (let fi = 1; fi <= State.fsCount; fi++) {
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (card) bk['fs' + fi] = collectFsFromCard(card);
  }
  State.config.banks[String(State.currentBank)] = bk;

  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: State.isMock ? 'mock' : 'device',
    activePreset: parseInt($('dashPresetSelect').value, 10),
    fsCount: State.fsCount,
    presetNames: getPresetNames(),
    banks: State.config.banks,
    usbConfig: State.usbConfig || {}
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `guerrilha_s_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify('Backup salvo', 'success');
}

function doRestore() {
  $('restoreFileInput').click();
}

function onRestoreFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.banks) throw new Error('Arquivo inválido — campo "banks" não encontrado');
      State.config.banks = data.banks;
      if (data.fsCount && [4, 6, 8].includes(data.fsCount)) {
        State.fsCount = data.fsCount;
        updateFsCountSelect(data.fsCount);
        rebuildFsGrid();
      }
      if (data.presetNames) updatePresetSelectLabels(data.presetNames);
      applyBankToUI(State.currentBank, State.config.banks[String(State.currentBank)] || {});
      setText('configSource', `Restaurado do arquivo · ${file.name}`);
      notify('Backup restaurado com sucesso', 'success');
    } catch (err) {
      notify('Erro ao restaurar: ' + err.message, 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/* ============================================================
   UTILITÁRIOS DE DOM
   ============================================================ */
function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
function setVal(id, val)  { const el = $(id); if (el) el.value = val; }
function setNum(id, val)  { const el = $(id); if (el) el.value = val; }
function setChk(id, v)    { const el = $(id); if (el) el.checked = v; }

function setColorPicker(card, sel, hex) {
  const el = card.querySelector(sel);
  if (!el) return;
  CPK.setInputValue(el, hex);
}
function setSelectInCard(card, sel, val) {
  const el = card.querySelector(sel);
  if (el) el.value = val;
}
function setInputInCard(card, sel, val) {
  const el = card.querySelector(sel);
  if (el) el.value = val;
}
function setChkInCard(card, sel, val) {
  const el = card.querySelector(sel);
  if (el) el.checked = val;
}
function setSelectInCtx(ctx, sel, val) {
  const el = ctx.querySelector(sel);
  if (el) el.value = val;
}
function setInputInCtx(ctx, sel, val) {
  const el = ctx.querySelector(sel);
  if (el) el.value = val;
}

function getPresetNames() {
  const sel = $('dashPresetSelect');
  if (!sel) return ['','','','',''];
  return Array.from({ length: 5 }, (_, i) => {
    // Apenas o nome atual do input se o profile estiver ativo
    if (i === parseInt(sel.value, 10)) {
      return $('dashPresetNameInput')?.value || '';
    }
    const opt = sel.options[i];
    return opt ? (opt.dataset.name || '') : '';
  });
}

function updatePresetSelectLabels(names) {
  const sel = $('dashPresetSelect');
  names.forEach((nm, i) => {
    const labelDash = nm || `Profile ${i + 1}`;
    if (sel?.options?.[i]) {
      sel.options[i].textContent = labelDash;
      sel.options[i].dataset.name = nm || '';
    }
  });
}

function updateFsCountSelect(count) {
  const sel = $('fsCountSelect');
  if (sel) sel.value = String(count);
}

function updateUsbPresetOptions(mode) {
  const sel = $('usbPresetSelect');
  if (!sel) return;
  const presets = USB_PRESETS_BY_MODE[mode] || USB_PRESETS_BY_MODE[0];
  sel.innerHTML = presets.map(p => `<option value="${p.v}">${p.l}</option>`).join('');
}

function ensureSelectHasValue(selectEl, value, label) {
  if (!selectEl) return;
  const v = String(value);
  if (v === '') return;
  for (const opt of Array.from(selectEl.options)) {
    if (opt.value === v) return;
  }
  const opt = document.createElement('option');
  opt.value = v;
  opt.textContent = label || `Preset ${v}`;
  selectEl.appendChild(opt);
}

/* ============================================================
   TABS DE NAVEGAÇÃO PRINCIPAL
   ============================================================ */
function showTab(name) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'stomp') {
    ensureIconPackLoaded().catch(() => {});
  }
  if (name === 'exp') {
    if (State.connected) {
      loadExpConfig().catch(() => {});
      loadBank(State.currentBank).catch(() => {});
      loadExpStatusOnce().catch(() => {});
    } else {
      const cached = State.config.banks[String(State.currentBank)];
      if (cached?.exp) applyExpBankToUI(State.currentBank, cached.exp);
    }
  } else {
    stopExpMonitor();
  }
}

/* ============================================================
   LED DO BANCO GLOBAL
   ============================================================ */
function applyBankLedGlobal() {
  const on = hexToRgb($('bankLedOnPicker').value);
  const off = hexToRgb($('bankLedOffPicker').value);
  const hon = hexToRgb($('bankLedHoldOnPicker').value);
  const hoff = hexToRgb($('bankLedHoldOffPicker').value);

  for (let fi = 1; fi <= State.fsCount; fi++) {
    const card = document.querySelector(`.fs-card[data-fs="${fi}"]`);
    if (!card) continue;
    setColorPicker(card, '[data-led="on"]', rgbToHex(on.r, on.g, on.b));
    setColorPicker(card, '[data-led="off"]', rgbToHex(off.r, off.g, off.b));
    setColorPicker(card, '[data-led="hold_on"]', rgbToHex(hon.r, hon.g, hon.b));
    setColorPicker(card, '[data-led="hold_off"]', rgbToHex(hoff.r, hoff.g, hoff.b));
  }
  notify(`LED global aplicado a todos os ${State.fsCount} FS`, 'success');
}

/* ============================================================
   INIT
   ============================================================ */
function initTheme() {
  const saved = localStorage.getItem('gs_theme') || 'dark';
  applyTheme(saved);
  const btn = $('themeBtn');
  if (btn) btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('gs_theme', next);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeBtn');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  btn && (btn.title = theme === 'light' ? 'Mudar para tema escuro' : 'Mudar para tema claro');
}

/* ============================================================
   COLOR PICKER CUSTOMIZADO (CPK)
   ============================================================ */
const CPK = (() => {
  const LED_PRESETS = [
    '#FF0000','#FF5500','#FFAA00','#FFFF00','#AAFF00',
    '#00FF00','#00FFAA','#00FFFF','#0055FF','#0000FF',
    '#8800FF','#FF00FF','#FF0088','#FFFFFF','#888888',
    '#444444','#221100','#002211','#001122','#000000'
  ];

  let popup, canvas, ctx, hueSlider, hexInput, preview, cursor;
  let activeInput = null, activeSwatch = null;
  let hue = 0, sat = 1, val = 1;
  let isDraggingSV = false;

  /* ---- Conversões ---- */
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r, g, b;
    if (h < 60)       [r,g,b] = [c,x,0];
    else if (h < 120) [r,g,b] = [x,c,0];
    else if (h < 180) [r,g,b] = [0,c,x];
    else if (h < 240) [r,g,b] = [0,x,c];
    else if (h < 300) [r,g,b] = [x,0,c];
    else              [r,g,b] = [c,0,x];
    return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return [h, s, v];
  }

  function hexToRgbArr(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
    const n = parseInt(hex, 16);
    return isNaN(n) ? [0,0,0] : [(n>>16)&255, (n>>8)&255, n&255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
  }

  /* ---- Canvas SV ---- */
  function drawSV() {
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    // Cor pura do matiz atual
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    const hueColor = `rgb(${hr},${hg},${hb})`;
    // Gradiente horizontal: branco → matiz
    const gH = ctx.createLinearGradient(0, 0, W, 0);
    gH.addColorStop(0, '#fff');
    gH.addColorStop(1, hueColor);
    ctx.fillStyle = gH;
    ctx.fillRect(0, 0, W, H);
    // Overlay vertical: transparente → preto
    const gV = ctx.createLinearGradient(0, 0, 0, H);
    gV.addColorStop(0, 'rgba(0,0,0,0)');
    gV.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gV;
    ctx.fillRect(0, 0, W, H);
  }

  function updateCursor() {
    const W = canvas.width, H = canvas.height;
    cursor.style.left  = (sat * W) + 'px';
    cursor.style.top   = ((1 - val) * H) + 'px';
  }

  function updateAll() {
    drawSV();
    updateCursor();
    const [r, g, b] = hsvToRgb(hue, sat, val);
    const hex = rgbToHex(r, g, b);
    preview.style.background = hex;
    hexInput.value = hex.toUpperCase();
    if (activeInput) {
      activeInput.value = hex;
      // Dispara change para compatibilidade
      activeInput.dispatchEvent(new Event('input', {bubbles:true}));
      activeInput.dispatchEvent(new Event('change', {bubbles:true}));
    }
    if (activeSwatch) updateSwatchColor(activeSwatch, hex);
  }

  /* ---- Posicionar cursor SV ---- */
  function svFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width,  (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top)  * scaleY));
    sat = x / canvas.width;
    val = 1 - y / canvas.height;
    updateAll();
  }

  /* ---- Popup position ---- */
  function positionPopup(trigger) {
    popup.style.display = 'block';
    const r = trigger.getBoundingClientRect();
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    const vw = window.innerWidth,  vh = window.innerHeight;
    let left = (r.left + (r.width / 2)) - (pw / 2);
    let top  = r.bottom + 6;
    if (top + ph > vh - 8) {
      top = r.top - ph - 6;
    }
    left = Math.max(8, Math.min(left, vw - pw - 8));
    top  = Math.max(8, Math.min(top,  vh - ph - 8));
    popup.style.top  = top  + 'px';
    popup.style.left = left + 'px';
  }

  /* ---- Swatch visual ---- */
  function updateSwatchColor(swatch, hex) {
    swatch.style.background = hex;
    const [r, g, b] = hexToRgbArr(hex);
    const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
    swatch.classList.toggle('is-dark', lum < 0.08);
    // Glow quando a cor for brilhante
    if (lum > 0.2) swatch.style.boxShadow = `0 0 8px 1px ${hex}88`;
    else swatch.style.boxShadow = '';
  }

  /* ---- API pública ---- */
  function attachToInput(input) {
    // Cria swatch ao lado do input
    const swatch = document.createElement('div');
    swatch.className = 'cpk-swatch';
    const hex = input.value || '#000000';
    updateSwatchColor(swatch, hex);
    input.parentNode.insertBefore(swatch, input.nextSibling);
    const isStompFxColor = !!(input.classList && input.classList.contains('stomp-fx-color'));
    if (isStompFxColor) {
      input.style.display = 'none';
      input.tabIndex = -1;
      input.disabled = true;
    }

    swatch.addEventListener('mousedown', (e) => {
      if (isStompFxColor) e.preventDefault();
    });
    swatch.addEventListener('click', (e) => {
      if (isStompFxColor) e.preventDefault();
      e.stopPropagation();
      if (activeInput === input && popup.style.display !== 'none') {
        hide(); return;
      }
      if (activeSwatch) activeSwatch.classList.remove('active');
      activeInput  = input;
      activeSwatch = swatch;
      swatch.classList.add('active');

      // Inicializar estado HSV a partir do valor atual
      const [r, g, b] = hexToRgbArr(input.value || '#000000');
      [hue, sat, val] = rgbToHsv(r, g, b);
      hueSlider.value = Math.round(hue);

      drawSV();
      updateCursor();
      preview.style.background = input.value;
      hexInput.value = (input.value || '#000000').toUpperCase();

      positionPopup(swatch);
    });

    // Quando o valor do input muda externamente (ex: setColorPicker)
    input.addEventListener('change', () => {
      updateSwatchColor(swatch, input.value || '#000000');
    });
  }

  function hide() {
    popup.style.display = 'none';
    if (activeSwatch) activeSwatch.classList.remove('active');
    activeInput  = null;
    activeSwatch = null;
  }

  function setInputValue(input, hex) {
    input.value = hex;
    input.dispatchEvent(new Event('change', {bubbles:true}));
    // Atualiza swatch do input
    const swatch = input.nextSibling;
    if (swatch && swatch.classList && swatch.classList.contains('cpk-swatch')) {
      updateSwatchColor(swatch, hex);
    }
  }

  function init() {
    popup      = document.getElementById('cpkPopup');
    canvas     = document.getElementById('cpkCanvas');
    ctx        = canvas ? canvas.getContext('2d') : null;
    hueSlider  = document.getElementById('cpkHue');
    hexInput   = document.getElementById('cpkHex');
    preview    = document.getElementById('cpkPreview');
    cursor     = document.getElementById('cpkCursor');
    if (!popup) return;

    // Presets
    const presetsEl = document.getElementById('cpkPresets');
    if (presetsEl) {
      LED_PRESETS.forEach(hex => {
        const dot = document.createElement('div');
        dot.className = 'cpk-preset-dot';
        dot.style.background = hex;
        dot.title = hex;
        dot.addEventListener('click', () => {
          const [r, g, b] = hexToRgbArr(hex);
          [hue, sat, val] = rgbToHsv(r, g, b);
          hueSlider.value = Math.round(hue);
          updateAll();
        });
        presetsEl.appendChild(dot);
      });
    }

    // Canvas SV — mouse
    canvas.addEventListener('mousedown', (e) => {
      isDraggingSV = true;
      svFromEvent(e);
    });
    window.addEventListener('mousemove', (e) => { if (isDraggingSV) svFromEvent(e); });
    window.addEventListener('mouseup',   ()  => { isDraggingSV = false; });

    // Canvas SV — touch
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      isDraggingSV = true;
      svFromEvent(e.touches[0]);
    }, {passive: false});
    window.addEventListener('touchmove',  (e) => { if (isDraggingSV) svFromEvent(e.touches[0]); });
    window.addEventListener('touchend',   ()  => { isDraggingSV = false; });

    // Hue slider
    hueSlider.addEventListener('input', () => {
      hue = parseInt(hueSlider.value, 10);
      updateAll();
    });

    // Hex input
    hexInput.addEventListener('input', () => {
      const raw = hexInput.value.trim();
      const h = raw.startsWith('#') ? raw : '#' + raw;
      if (/^#[0-9a-fA-F]{6}$/.test(h)) {
        const [r, g, b] = hexToRgbArr(h);
        [hue, sat, val] = rgbToHsv(r, g, b);
        hueSlider.value = Math.round(hue);
        drawSV();
        updateCursor();
        preview.style.background = h;
        if (activeInput) {
          activeInput.value = h.toLowerCase();
          activeInput.dispatchEvent(new Event('change', {bubbles:true}));
        }
        if (activeSwatch) updateSwatchColor(activeSwatch, h);
      }
    });

    // Fecha ao clicar fora
    document.addEventListener('click', (e) => {
      if (popup.style.display === 'none') return;
      if (!popup.contains(e.target) && !e.target.classList.contains('cpk-swatch')) {
        hide();
      }
    });

    window.addEventListener('resize', () => {
      if (popup.style.display !== 'none' && activeSwatch) positionPopup(activeSwatch);
    });
    const contentEl = document.getElementById('content');
    if (contentEl) {
      contentEl.addEventListener('scroll', () => {
        if (popup.style.display !== 'none' && activeSwatch) positionPopup(activeSwatch);
      }, { passive: true });
    }

    // Anexar a todos os inputs de cor existentes
    document.querySelectorAll('input[type=color]').forEach(inp => attachToInput(inp));
  }

  return { init, attachToInput, setInputValue, hide };
})();

function initColorPickers() {
  CPK.init();
}

function init() {
  console.log('[init] starting...');
  initTheme();
  initColorPickers();
  // Verificar suporte Web Serial
  if (!SerialTransport.isSupported()) {
    const btn = $('connectBtn');
    if (btn) {
      btn.disabled = true;
      btn.title = 'Web Serial não suportado — use Chrome / Edge 89+';
    }
    notify('Web Serial não disponível. Use o botão "Modo Teste" para explorar o editor.', 'warning', 8000);
  }

  // Construir grid de FS inicial
  rebuildFsGrid();

  // Botões de conexão
  $('connectBtn').addEventListener('click', () => {
    if (State.connected) doDisconnect();
    else doConnect();
  });
  $('mockBtn').addEventListener('click', () => {
    if (State.connected) doDisconnect();
    else doMock();
  });

  // Navigation
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Dashboard
  $('dashRefreshBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadSystemStatus();
    await pollActiveKey();
  });
  $('tapTempoBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    try {
      await send('tap_tempo');
      notify('Tap tempo enviado', 'info', 1500);
    } catch (e) { notify(e.message, 'error'); }
  });
  $('dashPresetSaveBtn').addEventListener('click', async () => {
    const names = getPresetNames();
    names[parseInt($('dashPresetSelect').value, 10)] = $('dashPresetNameInput').value;
    if (State.connected) {
      try {
        await send('usb_config', { __method: 'POST', presetNames: names });
        updatePresetSelectLabels(names);
        notify('Nome do profile salvo', 'success');
      } catch (e) { notify(e.message, 'error'); }
    } else {
      updatePresetSelectLabels(names);
      notify('Nome atualizado localmente', 'info');
    }
  });
  $('dashPresetSelect').addEventListener('change', async () => {
    const preset = parseInt($('dashPresetSelect').value, 10);
    if (State.connected) {
      try {
        await send('set_current_bank', { preset });
        await loadSystemStatus();
        await loadUsbConfig();
        await loadDeviceConfig();
        await loadBank(null);
        const nm = $('dashPresetSelect').options[preset]?.dataset.name || '';
        $('dashPresetNameInput').value = nm;
      } catch (e) { notify(e.message, 'error'); }
    }
  });

  refreshIconDatalist();
  tryLoadIconManifest();
  $('stompFxList')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cur = localStorage.getItem('iconManifestUrl') || '';
    const url = window.prompt('URL do manifest de ícones (JSON array). Ex: ./icons/icons.json\nDeixe vazio para desativar.', cur);
    if (url === null) return;
    localStorage.setItem('iconManifestUrl', String(url || '').trim());
    tryLoadIconManifest();
    notify('Config de manifest de ícones atualizada', 'success');
  });

  // Banco tabs
  $$('.bank-tab').forEach(t => {
    t.addEventListener('click', () => selectBank(parseInt(t.dataset.bank, 10)));
  });
  $('syncBankBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    const ok = await loadBank(State.currentBank);
    if (ok) notify(`Banco ${BANK_LETTERS[State.currentBank]} sincronizado`, 'success');
  });

  // Salvar / Backup / Restaurar
  $('saveBanksBtn').addEventListener('click', async () => {
    console.log('[saveBanksBtn] clicked — connected:', State.connected, '| isMock:', State.isMock);
    const btn = $('saveBanksBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Salvando…';
    try {
      if (!State.connected) {
        notify('Não conectado — conecte ao controlador ou use Modo Teste', 'warning');
        return;
      }
      await saveBanks();
    } catch (e) {
      console.error('[saveBanksBtn]', e);
      notify('Erro inesperado: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Salvar configuração';
    }
  });
  $('backupBtn').addEventListener('click', doBackup);
  $('restoreBtn').addEventListener('click', doRestore);
  $('restoreFileInput').addEventListener('change', onRestoreFile);

  // Copiar / Colar
  $('copyFsBtn').addEventListener('click', copyActiveFs);
  $('pasteFsBtn').addEventListener('click', pasteActiveFs);
  $('copyBankBtn').addEventListener('click', copyBank);
  $('pasteBankBtn').addEventListener('click', pasteBank);

  // USB
  $('usbModeSelect').addEventListener('change', () => {
    updateUsbPresetOptions(parseInt($('usbModeSelect').value, 10));
  });
  $('usbSaveBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveUsbConfig();
  });
  $('usbRefreshBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadUsbConfig();
  });
  $('fsCountSaveBtn').addEventListener('click', () => {
    if (!State.connected) {
      State.fsCount = parseInt($('fsCountSelect').value, 10);
      rebuildFsGrid();
      notify('Modelo atualizado localmente', 'info');
      return;
    }
    saveFsCount();
  });

  // Globais (GB)
  $('gbSaveBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveUsbConfig();
  });
  $('gbRefreshBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadUsbConfig();
    notify('Configurações globais lidas', 'success');
  });
  $('applyBankLedBtn').addEventListener('click', applyBankLedGlobal);

  // ---- Stomp ----
  $('stompSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveStompConfig();
  });
  $('stompRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadStompConfig();
    notify('Stomp lido', 'success');
  });
  $('stompAddFxBtn')?.addEventListener('click', () => {
    const list = $('stompFxList');
    if (!list) return;
    const n = list.querySelectorAll('.stomp-fx-row').length;
    if (n >= 12) return;
    appendStompFxRow(list, {}, n);
    updateStompFxNums();
  });
  $('stompFxList')?.addEventListener('dblclick', () => {
    const cur = getIconLibrary().join('\n');
    const txt = window.prompt('Cole uma lista de ícones (1 por linha). Deixe vazio para limpar.', cur);
    if (txt === null) return;
    const icons = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    setIconLibrary(icons);
    notify(`Biblioteca de ícones atualizada (${icons.length})`, 'success');
  });

  // ---- EXP ----
  $('expSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveExpConfig();
  });
  $('expRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadExpConfig();
    await loadExpStatusOnce();
    notify('EXP lido', 'success');
  });
  $('expMonitorBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    toggleExpMonitor();
  });
  $('expCapMinBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    if (!_expLastStatus) await loadExpStatusOnce();
    const raw = Math.max(0, Math.min(1023, parseInt(_expLastStatus?.raw ?? 0, 10) || 0));
    setNum('expCalMinInput', raw);
    normalizeExpCalInputs();
    notify('MIN capturado', 'success', 1200);
  });
  $('expCapMaxBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    if (!_expLastStatus) await loadExpStatusOnce();
    const raw = Math.max(0, Math.min(1023, parseInt(_expLastStatus?.raw ?? 0, 10) || 0));
    setNum('expCalMaxInput', raw);
    normalizeExpCalInputs();
    notify('MAX capturado', 'success', 1200);
  });

  // ---- EXP comandos por banco ----
  $('expCmdAddBtn')?.addEventListener('click', () => {
    const list = $('expCmdList');
    if (!list) return;
    const enChk = $('expBankEnabledChk');
    if (enChk) enChk.checked = true;
    appendExpCmdRow(list, { type: 0, output: EXP_OUTPUT_DEFAULT, channel: 1, cc: 7, outMin: 0, outMax: 127, invert: 0 }, list.querySelectorAll('.exp-cmd-row').length);
  });
  $('expCmdAddSysexBtn')?.addEventListener('click', () => {
    const list = $('expCmdList');
    if (!list) return;
    const enChk = $('expBankEnabledChk');
    if (enChk) enChk.checked = true;
    appendExpCmdRow(list, { type: 1, output: EXP_OUTPUT_DEFAULT, sysex: '', sysexValueIndex: 0 }, list.querySelectorAll('.exp-cmd-row').length);
  });
  $('expBankSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    try {
      await saveExpBank();
      notify('Comandos EXP salvos ✓', 'success');
      await loadBank(State.currentBank);
    } catch (_) {}
  });
  $('expBankRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadBank(State.currentBank);
    notify('Banco EXP lido', 'success');
  });

  // ---- Bluetooth ----
  $('btSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveDeviceConfig({
      btMode:       parseInt($('btModeSelect').value,   10),
      btPreset:     parseInt($('btPresetSelect').value, 10),
      btMidiCc:     parseInt($('btMidiCcSelect').value, 10),
      btCustomEn:   $('btCustomEnChk').checked ? 1 : 0,
      btCustomName: $('btCustomNameInput')?.value || ''
    });
  });
  $('btRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    const ok = await loadDeviceConfig();
    notify(ok ? 'Bluetooth lido' : 'Bluetooth: leitura falhou', ok ? 'success' : 'warning');
  });

  // ---- MIDI Serial ----
  $('midiSerialSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveDeviceConfig({
      midiSerialEn:  parseInt($('midiSerialEnSelect').value,  10),
      midiSerialCh:  parseInt($('midiSerialChSelect').value,  10),
      midiSerialPre: parseInt($('midiSerialPreSelect').value, 10)
    });
  });
  $('midiSerialRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    const ok = await loadDeviceConfig();
    notify(ok ? 'MIDI Serial lido' : 'MIDI Serial: leitura falhou', ok ? 'success' : 'warning');
  });

  // ---- Wi-Fi ----
  $('wifiSaveBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await saveDeviceConfig({
      wifiSsid: $('wifiSsidInput')?.value || '',
      wifiPw:   $('wifiPwInput')?.value   || ''
    });
  });
  $('wifiRefreshBtn')?.addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    const ok = await loadDeviceConfig();
    notify(ok ? 'Wi‑Fi lido' : 'Wi‑Fi: leitura falhou', ok ? 'success' : 'warning');
  });

  // ---- Status ----
  $('statusRefreshBtn').addEventListener('click', async () => {
    if (!State.connected) { notify('Não conectado', 'warning'); return; }
    await loadSystemStatus();
    notify('Status atualizado', 'success');
  });
}

// Aguardar DOM pronto
function safeInit() {
  try {
    init();
    console.log('[init] OK');
  } catch (e) {
    console.error('[init FATAL]', e);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="position:fixed;top:0;left:0;right:0;background:#ef4444;color:#fff;padding:12px;z-index:9999;font-family:monospace;font-size:13px">
        ⚠️ Erro ao inicializar o editor: ${e.message} — abra o Console (F12) para detalhes.
      </div>`
    );
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', safeInit);
} else {
  safeInit();
}

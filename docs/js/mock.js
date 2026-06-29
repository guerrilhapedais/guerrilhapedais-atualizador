/**
 * mock.js — Dados de teste offline para o Guerrilha Editor S
 * Simula as respostas do ESP32-S3 via CDC sem hardware conectado.
 */

/* eslint-disable no-unused-vars */

window.MOCK_STATE = {
  activePreset: 0,
  currentBank: 0,
  fsCount: 8,
  usbMode: 0,
  usbPreset: 0,
  ledHoldMode: 1,
  ledClickMode: 1,
  resetOnFootChange: 0,
  resetOnHoldChange: 0,
  ledCustomSource: 0,
  midiPcUpDownShared: 0,
  midiPcGlobalStart: 0,
  midiPcGlobalEnd: 127,
  midiPcGlobalInc: 1,
  midiPcGlobalLoop: 0,
  midiPcSharedValue: 255,
  midiCcUpDownShared: 0,
  midiCcGlobalStart: 0,
  midiCcGlobalEnd: 127,
  midiCcGlobalInc: 1,
  midiCcGlobalLoop: 0,
  midiCcSharedValue: 255,
  presetNames: ['Profile 1','Profile 2','Profile 3','Profile 4','Profile 5'],
  version: 42,
  btMode: 1,
  btPreset: 0,
  btMidiCc: 0,
  btCustomEn: 0,
  btCustomName: 'GuerrilhaBox',
  midiSerialEn: 1,
  midiSerialCh: 1,
  midiSerialPre: 1,
  wifiSsid: 'GuerrilhaBox',
  wifiPw: '',
  banks: {}
};

/* Gerar bancos de exemplo (A–I, FS1–FS8) */
(function initMockBanks() {
  const bankNames = ['A','B','C','D','E','F','G','H','I'];
  const ledColors = [
    [0,0,255,  0,0,0,   60,0,255,  0,0,0],  // A - azul
    [255,120,0, 0,0,0,   255,60,0,  0,0,0],  // B - laranja
    [0,200,80,  0,0,0,   0,100,40,  0,0,0],  // C - verde
    [200,0,200, 0,0,0,   100,0,100, 0,0,0],  // D - roxo
    [255,0,60,  0,0,0,   150,0,30,  0,0,0],  // E - vermelho
    [0,200,200, 0,0,0,   0,100,100, 0,0,0],  // F - ciano
    [200,200,0, 0,0,0,   100,100,0, 0,0,0],  // G - amarelo
    [255,255,255,0,0,0,  180,180,180,0,0,0], // H - branco
    [0,120,255, 0,0,0,   0,60,180,  0,0,0],  // I - azul claro
  ];

  bankNames.forEach((letter, bi) => {
    const bank = {};
    const lc = ledColors[bi];
    for (let fi = 1; fi <= 8; fi++) {
      bank[`fs${fi}`] = {
        index: fi - 1,
        fsName: `${letter}${fi}`,
        actionType: 0,
        channel: 1,
        toggle: false,
        ccParameter: 64 + (fi - 1),
        ccValue: 127,
        pcPreset: fi - 1,
        ccParameter2: 64 + (fi - 1),
        ccValue1: 127,
        ccValue2: 0,
        pcPreset1: fi - 1,
        pcPreset2: fi,
        holdEnabled: false,
        holdActionType: 0,
        holdChannel: 1,
        holdToggle: false,
        holdCcParameter: 64,
        holdCcValue: 0,
        holdPcPreset: 0,
        holdCcParameter2: 64,
        holdCcValue1: 127,
        holdCcValue2: 0,
        holdPcPreset1: 0,
        holdPcPreset2: 1,
        tapTarget: 0,
        tapChannel: 1,
        pcUpDownMode: 0,
        pcRangeStart: 0,
        pcRangeEnd: 127,
        pcIncrement: 1,
        pcLoop: false,
        pcUpDownTrigger: 0,
        pcUpDownOutput: 2,
        ccUpDownMode: 0,
        ccUpDownCc: 0,
        ccRangeStart: 0,
        ccRangeEnd: 127,
        ccIncrement: 1,
        ccLoop: false,
        ccUpDownTrigger: 0,
        ccUpDownOutput: 2,
        ricochetEnabled: false,
        ricochetChannel: 1,
        ricochetCc: 0,
        ricochetStartValue: 0,
        ricochetEndValue: 127,
        ricochetRiseTimeMs: 500,
        ricochetFallTimeMs: 500,
        ricochetCurve: 0,
        ricochetOutput: 2,
        ricochetMode: 0,
        ricochetInvert: 0,
        extraClick: [],
        extraHold: [],
        ledColors: {
          r_on: lc[0], g_on: lc[1], b_on: lc[2],
          r_off: lc[3], g_off: lc[4], b_off: lc[5],
          r_hold_on: lc[6], g_hold_on: lc[7], b_hold_on: lc[8],
          r_hold_off: lc[9], g_hold_off: lc[10], b_hold_off: lc[11]
        }
      };
    }
    MOCK_STATE.banks[String(bi)] = bank;
  });
})();

/**
 * Despacha um comando mock e retorna a resposta simulada.
 * @param {string} cmd
 * @param {object} params
 * @returns {object} resposta JSON simulada
 */
window.mockDispatch = function(cmd, params) {
  const id = params.id || 0;

  if (cmd === 'ping') {
    return { ok: true, cmd: 'ping', id,
      firmware: 'v3.4.0-MOCK', device: 'MT8', name: 'Guerrilha Box [MOCK]' };
  }

  if (cmd === 'system_status') {
    return {
      ok: true, cmd: 'system_status', id,
      data: {
        activePreset: MOCK_STATE.activePreset,
        presetCount: 5,
        presetNames: MOCK_STATE.presetNames,
        usbMode: MOCK_STATE.usbMode,
        usbPreset: MOCK_STATE.usbPreset,
        usbModeDescription: ['Tonex','MIDI HOST USB','MIDI USB PC','HUB MIDI USB','MIDI SERIAL DIN'][MOCK_STATE.usbMode] || 'Tonex',
        midiConfigInitialized: true,
        currentBank: MOCK_STATE.currentBank,
        ledHoldMode: MOCK_STATE.ledHoldMode,
        ledClickMode: MOCK_STATE.ledClickMode,
        resetOnFootChange: MOCK_STATE.resetOnFootChange,
        resetOnHoldChange: MOCK_STATE.resetOnHoldChange,
        ledCustomSource: MOCK_STATE.ledCustomSource,
        fsCount: MOCK_STATE.fsCount,
        version: MOCK_STATE.version,
        appVersion: 'v3.4.0-MOCK',
        firmwareVersion: 'v3.4.0-MOCK',
        spiffs: { ok: true, total: 1966080, used: 512000, free: 1454080, usePercent: 26 }
      }
    };
  }

  if (cmd === 'active_key') {
    return {
      ok: true, cmd: 'active_key', id,
      data: {
        keyActive: false,
        activeBank: MOCK_STATE.currentBank,
        activeKey: 255,
        activeType: 2,
        currentBank: MOCK_STATE.currentBank,
        activeFootswitch: 0,
        activeTypeDescription: 'none',
        ledClickMode: MOCK_STATE.ledClickMode,
        ledHoldMode: MOCK_STATE.ledHoldMode
      }
    };
  }

  if (cmd === 'usb_config') {
    if (params.__method === 'POST') {
      // Aplicar campos recebidos no estado mock
      const fields = ['ledHoldMode','ledClickMode','resetOnFootChange','resetOnHoldChange','ledCustomSource',
        'midiPcUpDownShared','midiPcGlobalStart','midiPcGlobalEnd','midiPcGlobalInc','midiPcGlobalLoop','midiPcSharedValue',
        'midiCcUpDownShared','midiCcGlobalStart','midiCcGlobalEnd','midiCcGlobalInc','midiCcGlobalLoop','midiCcSharedValue'];
      fields.forEach(f => { if (params[f] !== undefined) MOCK_STATE[f] = params[f]; });
      if (Array.isArray(params.presetNames)) MOCK_STATE.presetNames = params.presetNames;
    }
    return {
      ok: true, cmd: 'usb_config', id,
      data: {
        usbmode: MOCK_STATE.usbMode,
        usbpreset: MOCK_STATE.usbPreset,
        usbMode: MOCK_STATE.usbMode,
        usbPreset: MOCK_STATE.usbPreset,
        usbModeDescription: ['Tonex','MIDI HOST USB','MIDI USB PC','HUB MIDI USB','MIDI SERIAL DIN'][MOCK_STATE.usbMode] || 'Tonex',
        activePreset: MOCK_STATE.activePreset,
        presetCount: 5,
        presetNames: MOCK_STATE.presetNames,
        ledHoldMode: MOCK_STATE.ledHoldMode,
        ledClickMode: MOCK_STATE.ledClickMode,
        resetOnFootChange: MOCK_STATE.resetOnFootChange,
        resetOnHoldChange: MOCK_STATE.resetOnHoldChange,
        ledCustomSource: MOCK_STATE.ledCustomSource,
        fsCount: MOCK_STATE.fsCount,
        midiPcUpDownShared: MOCK_STATE.midiPcUpDownShared,
        midiPcGlobalStart: MOCK_STATE.midiPcGlobalStart,
        midiPcGlobalEnd: MOCK_STATE.midiPcGlobalEnd,
        midiPcGlobalInc: MOCK_STATE.midiPcGlobalInc,
        midiPcGlobalLoop: MOCK_STATE.midiPcGlobalLoop,
        midiPcSharedValue: MOCK_STATE.midiPcSharedValue,
        midiCcUpDownShared: MOCK_STATE.midiCcUpDownShared,
        midiCcGlobalStart: MOCK_STATE.midiCcGlobalStart,
        midiCcGlobalEnd: MOCK_STATE.midiCcGlobalEnd,
        midiCcGlobalInc: MOCK_STATE.midiCcGlobalInc,
        midiCcGlobalLoop: MOCK_STATE.midiCcGlobalLoop,
        midiCcSharedValue: MOCK_STATE.midiCcSharedValue
      }
    };
  }

  if (cmd === 'midi_config') {
    const isPost = params.__method === 'POST' || params.banks !== undefined;
    if (isPost) {
      // Aplicar bancos recebidos
      if (params.banks) {
        Object.keys(params.banks).forEach(bk => {
          MOCK_STATE.banks[bk] = params.banks[bk];
        });
      }
      if (params.activePreset !== undefined) MOCK_STATE.activePreset = params.activePreset;
      return { ok: true, cmd: 'midi_config', id, message: 'Configurações MIDI atualizadas com sucesso' };
    }
    // GET
    let bank = params.bank !== undefined ? parseInt(params.bank, 10) : MOCK_STATE.currentBank;
    if (isNaN(bank) || bank < 0 || bank > 8) bank = MOCK_STATE.currentBank;
    const bankData = MOCK_STATE.banks[String(bank)] || {};
    return {
      ok: true, cmd: 'midi_config', id,
      data: {
        bank,
        fsCount: MOCK_STATE.fsCount,
        ...bankData
      }
    };
  }

  if (cmd === 'set_current_bank') {
    if (params.bank !== undefined) MOCK_STATE.currentBank = parseInt(params.bank, 10);
    if (params.preset !== undefined) MOCK_STATE.activePreset = parseInt(params.preset, 10);
    return { ok: true, cmd: 'set_current_bank', id,
      currentBank: MOCK_STATE.currentBank, activePreset: MOCK_STATE.activePreset };
  }

  if (cmd === 'tap_tempo') {
    return { ok: true, cmd: 'tap_tempo', id };
  }

  if (cmd === 'device_config') {
    if (params.__method === 'POST') {
      if (params.btMode !== undefined) MOCK_STATE.btMode = params.btMode;
      if (params.btPreset !== undefined) MOCK_STATE.btPreset = params.btPreset;
      if (params.btMidiCc !== undefined) MOCK_STATE.btMidiCc = params.btMidiCc;
      if (params.btCustomEn !== undefined) MOCK_STATE.btCustomEn = params.btCustomEn ? 1 : 0;
      if (params.btCustomName !== undefined) MOCK_STATE.btCustomName = String(params.btCustomName || '');
      if (params.midiSerialEn !== undefined) MOCK_STATE.midiSerialEn = params.midiSerialEn ? 1 : 0;
      if (params.midiSerialCh !== undefined) MOCK_STATE.midiSerialCh = params.midiSerialCh;
      if (params.midiSerialPre !== undefined) MOCK_STATE.midiSerialPre = params.midiSerialPre;
      if (params.wifiSsid !== undefined) MOCK_STATE.wifiSsid = String(params.wifiSsid || '');
      if (params.wifiPw !== undefined) MOCK_STATE.wifiPw = String(params.wifiPw || '');
    }
    return {
      ok: true, cmd: 'device_config', id,
      data: {
        btMode: MOCK_STATE.btMode,
        btPreset: MOCK_STATE.btPreset,
        btMidiCc: MOCK_STATE.btMidiCc,
        btCustomEn: MOCK_STATE.btCustomEn,
        btCustomName: MOCK_STATE.btCustomName,
        midiSerialEn: MOCK_STATE.midiSerialEn,
        midiSerialCh: MOCK_STATE.midiSerialCh,
        midiSerialPre: MOCK_STATE.midiSerialPre,
        wifiSsid: MOCK_STATE.wifiSsid,
        wifiPw: MOCK_STATE.wifiPw
      }
    };
  }

  if (cmd === 'GETCONFIG') {
    return {
      ok: true, cmd: 'GETCONFIG', id,
      data: {
        BT_MODE: MOCK_STATE.btMode,
        BT_PRESET: MOCK_STATE.btPreset,
        BT_MIDI_CC: MOCK_STATE.btMidiCc,
        BT_CUST_EN: MOCK_STATE.btCustomEn,
        BT_CUST_NAME: MOCK_STATE.btCustomName,
        S_MIDI_EN: MOCK_STATE.midiSerialEn,
        S_MIDI_CH: MOCK_STATE.midiSerialCh,
        MIDI_PRESET: MOCK_STATE.midiSerialPre,
        WIFI_SSID: MOCK_STATE.wifiSsid,
        WIFI_PW: MOCK_STATE.wifiPw
      }
    };
  }

  if (cmd === 'SETCONFIG') {
    if (params.BT_MODE !== undefined) MOCK_STATE.btMode = params.BT_MODE;
    if (params.BT_PRESET !== undefined) MOCK_STATE.btPreset = params.BT_PRESET;
    if (params.BT_MIDI_CC !== undefined) MOCK_STATE.btMidiCc = params.BT_MIDI_CC ? 1 : 0;
    if (params.BT_CUST_EN !== undefined) MOCK_STATE.btCustomEn = params.BT_CUST_EN ? 1 : 0;
    if (params.BT_CUST_NAME !== undefined) MOCK_STATE.btCustomName = String(params.BT_CUST_NAME || '');
    if (params.S_MIDI_EN !== undefined) MOCK_STATE.midiSerialEn = params.S_MIDI_EN ? 1 : 0;
    if (params.S_MIDI_CH !== undefined) MOCK_STATE.midiSerialCh = params.S_MIDI_CH;
    if (params.MIDI_PRESET !== undefined) MOCK_STATE.midiSerialPre = params.MIDI_PRESET;
    return { ok: true, cmd: 'SETCONFIG', id, applied: 1, data: window.mockDispatch('GETCONFIG', { id }).data };
  }

  if (cmd === 'SETWIFI') {
    if (params.WIFI_SSID !== undefined) MOCK_STATE.wifiSsid = String(params.WIFI_SSID || '');
    if (params.WIFI_PW !== undefined) MOCK_STATE.wifiPw = String(params.WIFI_PW || '');
    return { ok: true, cmd: 'SETWIFI', id, applied: 1, data: window.mockDispatch('GETCONFIG', { id }).data };
  }

  // IMPORTANTE: update_request NÃO responde automaticamente no mock — proteção extra
  if (cmd === 'update_request') {
    return { ok: false, cmd: 'update_request', id, error: 'update_disabled_in_mock' };
  }

  return { ok: false, cmd, id, error: 'unknown_cmd_mock' };
};

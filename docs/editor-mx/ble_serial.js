/*
 * ble_serial.js — Bluetooth (Nordic UART) para o Editor Guerrilha PRO.
 *
 * O editor fala JSON por linhas com a porta USB (Web Serial). O firmware aceita
 * exatamente o mesmo protocolo pelo Bluetooth (servico NUS). Este ficheiro cria
 * uma "porta serie" falsa por cima do Web Bluetooth, com a mesma interface que o
 * editor ja usa (open/close/readable/writable), e mostra a escolha
 * "USB ou Bluetooth" quando se clica no botao de ligar.
 *
 * Tem de ser carregado ANTES de controlador-midi.js.
 */
(function () {
    'use strict';

    var NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    var NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; /* escrita: editor -> pedal */
    var NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; /* notify:  pedal -> editor */

    var hasBle = typeof navigator !== 'undefined' && !!navigator.bluetooth;
    var nativeSerial = (typeof navigator !== 'undefined' && navigator.serial) ? navigator.serial : null;

    var state = {
        mode: 'usb',        /* ultima escolha: 'usb' | 'ble' */
        port: null          /* BleSerialPort atual (para religar sozinho) */
    };

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /* ------------------------------------------------------------------ */
    /* Porta serie sobre BLE                                               */
    /* ------------------------------------------------------------------ */
    function BleSerialPort(device) {
        this.device = device;
        this.readable = null;
        this.writable = null;
        this._rx = null;
        this._tx = null;
        this._ctrl = null;
        this._chunk = 244;          /* ajusta-se sozinho se o MTU for menor */
        this._onNotify = this._onNotify.bind(this);
        this._onGone = this._onGone.bind(this);
        device.addEventListener('gattserverdisconnected', this._onGone);
    }

    BleSerialPort.prototype.getInfo = function () { return { bluetooth: true, name: this.device.name || '' }; };
    BleSerialPort.prototype.addEventListener = function () {};
    BleSerialPort.prototype.removeEventListener = function () {};

    BleSerialPort.prototype.open = async function () {
        if (this.readable) return;
        var server = this.device.gatt.connected ? this.device.gatt : await this.device.gatt.connect();
        var svc;
        try {
            svc = await server.getPrimaryService(NUS_SERVICE);
        } catch (e) {
            throw new Error('O controlador nao tem o servico Bluetooth do editor. No Windows, remova o "' +
                (this.device.name || 'GUERRILHA') + '" em Configuracoes > Bluetooth e ligue de novo.');
        }
        this._tx = await svc.getCharacteristic(NUS_TX);
        this._rx = await svc.getCharacteristic(NUS_RX);
        await this._tx.startNotifications();
        this._tx.addEventListener('characteristicvaluechanged', this._onNotify);

        var self = this;
        this.readable = new ReadableStream({
            start: function (c) { self._ctrl = c; },
            cancel: function () { self._ctrl = null; }
        });
        this.writable = new WritableStream({
            write: function (chunk) { return self._send(chunk); }
        });
        await sleep(300); /* deixa o pedal gravar o CCCD antes do 1.o pedido */
    };

    BleSerialPort.prototype._onNotify = function (ev) {
        var v = ev.target.value;
        if (!this._ctrl || !v) return;
        try {
            this._ctrl.enqueue(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
        } catch (e) {}
    };

    BleSerialPort.prototype._onGone = function () {
        var c = this._ctrl;
        this._ctrl = null;
        this.readable = null;
        this.writable = null;
        if (c) { try { c.error(new Error('Bluetooth desconectado')); } catch (e) {} }
    };

    BleSerialPort.prototype._writeOne = function (bytes) {
        var rx = this._rx;
        if (rx.writeValueWithoutResponse) return rx.writeValueWithoutResponse(bytes);
        return rx.writeValue(bytes);
    };

    BleSerialPort.prototype._send = async function (data) {
        if (!this._rx) throw new Error('Bluetooth indisponivel');
        var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        var off = 0;
        while (off < bytes.length) {
            var n = Math.min(this._chunk, bytes.length - off);
            try {
                await this._writeOne(bytes.slice(off, off + n));
            } catch (e) {
                /* MTU menor que o bloco: reduz e repete o mesmo pedaco */
                if (this._chunk > 20 && this.device.gatt.connected) {
                    this._chunk = this._chunk > 100 ? 100 : 20;
                    continue;
                }
                throw e;
            }
            off += n;
            if (off < bytes.length) await sleep(4);
        }
    };

    BleSerialPort.prototype.close = async function () {
        var c = this._ctrl;
        this._ctrl = null;
        this.readable = null;
        this.writable = null;
        if (c) { try { c.close(); } catch (e) {} }
        if (this._tx) {
            try { this._tx.removeEventListener('characteristicvaluechanged', this._onNotify); } catch (e) {}
            try { await this._tx.stopNotifications(); } catch (e) {}
        }
        try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
    };

    /* requestDevice tem de correr direto no clique (gesto do utilizador). */
    function pickBleDevice() {
        return navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'GUERRILHA' },
                { namePrefix: 'Guerrilha' },
                { services: [NUS_SERVICE] }
            ],
            optionalServices: [NUS_SERVICE]
        }).then(function (device) {
            if (state.port && state.port.device === device) return state.port;
            state.port = new BleSerialPort(device);
            return state.port;
        });
    }

    /* ------------------------------------------------------------------ */
    /* Janela "USB ou Bluetooth"                                           */
    /* ------------------------------------------------------------------ */
    /* Icones brancos (SVG) da janela de escolha. */
    var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
        'stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
    var ICON_USB = ICON_SVG + '<circle cx="10" cy="7" r="1"/><circle cx="4" cy="20" r="1"/><path d="M4.7 19.3 19 5"/>' +
        '<path d="m21 3-3 1 2 2Z"/><path d="M9.26 7.68 5 12l2 5"/><path d="m10 14 5 2 3.5-3.5"/>' +
        '<path d="m18 12 1-1 1 1-1 1Z"/></svg>';
    var ICON_BT = ICON_SVG + '<path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>';
    var ICON_BOX = '<span style="flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:10px;' +
        'background:#26262c;border:1px solid #3f3f46">';
    var ICON_BOX_BT = '<span style="flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:10px;' +
        'background:#1d4ed8;border:1px solid #3b82f6;box-shadow:0 0 14px rgba(59,130,246,.45)">';

    function chooseTransport() {
        var knownUsb = null;
        if (nativeSerial) {
            nativeSerial.getPorts().then(function (ports) {
                knownUsb = ports && ports[0] ? ports[0] : null;
            }).catch(function () {});
        }
        return new Promise(function (resolve, reject) {
            var ov = document.createElement('div');
            ov.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);' +
                'display:flex;align-items:center;justify-content:center;padding:16px;' +
                'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
            var btn = 'display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;margin-top:10px;' +
                'border-radius:12px;border:1px solid #2a2a30;background:#16161a;color:#f4f4f5;font-size:15px;' +
                'font-weight:600;cursor:pointer;text-align:left';
            var sub = 'display:block;font-size:12px;font-weight:400;color:#a1a1aa;margin-top:2px';
            ov.innerHTML =
                '<div style="width:100%;max-width:340px;background:#0f0f12;border:1px solid #27272a;border-radius:16px;' +
                'padding:18px 18px 16px;box-shadow:0 20px 60px rgba(0,0,0,.6)">' +
                '<div style="color:#f4f4f5;font-size:16px;font-weight:700">Conectar ao controlador</div>' +
                '<div style="color:#a1a1aa;font-size:13px;margin-top:4px">Escolha como ligar</div>' +
                '<button type="button" data-c="usb" style="' + btn + '">' +
                ICON_BOX + ICON_USB + '</span><span>Cabo USB<span style="' + sub + '">' +
                (nativeSerial ? 'Porta CDC (modo USB = MIDI Device)' : 'Nao disponivel neste navegador') +
                '</span></span></button>' +
                '<button type="button" data-c="ble" style="' + btn + '">' +
                ICON_BOX_BT + ICON_BT + '</span><span>Bluetooth<span style="' + sub + '">' +
                (hasBle ? 'Controlador em Periferico ou Dual' : 'Nao disponivel neste navegador') +
                '</span></span></button>' +
                '<button type="button" data-c="x" style="width:100%;margin-top:12px;padding:10px;border:none;' +
                'background:none;color:#a1a1aa;font-size:13px;cursor:pointer">Cancelar</button></div>';

            function done(fn, arg) {
                try { document.body.removeChild(ov); } catch (e) {}
                fn(arg);
            }
            ov.addEventListener('click', function (ev) {
                var b = ev.target.closest ? ev.target.closest('button[data-c]') : null;
                if (!b) { if (ev.target === ov) done(reject, new Error('Cancelado')); return; }
                var c = b.getAttribute('data-c');
                if (c === 'x') return done(reject, new Error('Cancelado'));
                if (c === 'ble') {
                    if (!hasBle) return done(reject, new Error('Web Bluetooth indisponivel neste navegador'));
                    var pb = pickBleDevice(); /* ainda dentro do clique */
                    done(function () {
                        pb.then(function (p) { state.mode = 'ble'; resolve(p); }, reject);
                    });
                    return;
                }
                if (!nativeSerial) return done(reject, new Error('Web Serial indisponivel neste navegador'));
                if (knownUsb) {
                    /* Porta USB ja autorizada antes: liga direto, como antes. */
                    return done(function () { state.mode = 'usb'; resolve(knownUsb); });
                }
                var pr = nativeSerial.requestPort(); /* dentro do clique */
                done(function () {
                    pr.then(function (p) { state.mode = 'usb'; resolve(p); }, reject);
                });
            });
            document.body.appendChild(ov);
        });
    }

    /* ------------------------------------------------------------------ */
    /* navigator.serial "alargado": USB real + porta Bluetooth             */
    /* ------------------------------------------------------------------ */
    var serialApi = {
        getPorts: function () {
            if (state.mode === 'ble' && state.port) return Promise.resolve([state.port]);
            return nativeSerial ? nativeSerial.getPorts() : Promise.resolve([]);
        },
        requestPort: function () { return chooseTransport(); },
        addEventListener: function (t, f, o) { if (nativeSerial) nativeSerial.addEventListener(t, f, o); },
        removeEventListener: function (t, f, o) { if (nativeSerial) nativeSerial.removeEventListener(t, f, o); }
    };

    if (nativeSerial || hasBle) {
        try {
            Object.defineProperty(navigator, 'serial', { configurable: true, get: function () { return serialApi; } });
        } catch (e) {
            console.warn('[Editor BLE] nao foi possivel instalar o Bluetooth:', e);
        }
    }

    /* Animacao da barra de "a ligar" (loading do editor). */
    try {
        var st = document.createElement('style');
        st.textContent = '@keyframes gmxIndet{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}' +
            '@keyframes gmxSpin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(st);
    } catch (e) {}

    window.gmxEditorTransportLabel = function () { return state.mode === 'ble' ? 'Bluetooth' : 'USB'; };
})();

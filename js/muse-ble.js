/* Web Bluetooth client for Muse 2 (same GATT flow as urish/muse-js).
 * connect: requestDevice(service 0xfe8d / name 'Muse') -> gatt.connect -> subscribe to
 * control, telemetry, gyro, accel, PPG x3, EEG x4 -> commands h, p50, s, d. */
(function (root) {
  'use strict';
  const P = root.MuseProtocol;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class MuseBLE {
    constructor(handlers) {
      this.h = handlers || {};           // onPacket(kind, index, bytes), onStatus(state, info), onControl(json)
      this.device = null; this.server = null; this.control = null;
      this.chars = []; this.userDisconnect = false; this.hasPPG = false;
      this.lastData = 0; this.watchdog = null; this.ctrlBuf = '';
      this.streaming = false; this.recovering = false;
      this._onDisc = this._onDisconnected.bind(this);
    }
    static supported() { return !!(root.navigator && navigator.bluetooth && navigator.bluetooth.requestDevice); }
    status(s, info) { if (this.h.onStatus) this.h.onStatus(s, info || {}); }

    /* Must be called from a user gesture (click). */
    async requestAndConnect() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [P.MUSE_SERVICE] }, { namePrefix: 'Muse' }],
        optionalServices: [P.MUSE_SERVICE],
      });
      if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this._onDisc);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this._onDisc);
      await this.connect();
    }
    /* Re-connect to the previously chosen device (no chooser, no gesture needed). */
    async connect() {
      if (!this.device) throw new Error('No device selected');
      this.userDisconnect = false;
      this.connecting = true;
      try { return await this._connectLoop(); } finally { this.connecting = false; }
    }
    async _connectLoop() {
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          this.status('connecting', { name: this.device.name, attempt });
          await this._setup();
          return;
        } catch (e) {
          lastErr = e;
          console.warn('Muse connect attempt ' + attempt + ' failed:', e);
          try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch (_) {}
          if (this.userDisconnect) throw e;
          await sleep(700 * attempt);
        }
      }
      throw lastErr;
    }
    async _setup() {
      this.server = await this.device.gatt.connect();
      const service = await this.server.getPrimaryService(P.MUSE_SERVICE);
      this.chars.forEach(({ ch, fn }) => { try { ch.removeEventListener('characteristicvaluechanged', fn); } catch (_) {} });
      this.chars = []; this.ctrlBuf = ''; this.recovering = false;
      const sub = async (uuid, kind, index, optional) => {
        let ch;
        try { ch = await service.getCharacteristic(uuid); }
        catch (e) { if (optional) return false; throw e; }
        const fn = (ev) => {
          const v = ev.target.value;
          const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
          if (kind === 'control') this._control(bytes);
          else { if (kind === 'eeg') this.lastData = performance.now(); if (this.h.onPacket) this.h.onPacket(kind, index, bytes); }
        };
        ch.addEventListener('characteristicvaluechanged', fn);
        await ch.startNotifications();          // GATT ops are awaited one at a time (Chrome requirement)
        this.chars.push({ ch, fn });
        return ch;
      };
      this.control = await sub(P.CHAR.control, 'control', 0);
      await sub(P.CHAR.telemetry, 'telemetry', 0, true);
      await sub(P.CHAR.gyro, 'gyro', 0, true);
      await sub(P.CHAR.accel, 'accel', 0, true);
      this.hasPPG = true;
      for (let i = 0; i < 3; i++) {
        const ok = await sub(P.CHAR.ppg[i], 'ppg', i, true);
        if (!ok) this.hasPPG = false;       // original Muse 2016 has no PPG
      }
      for (let i = 0; i < 4; i++) await sub(P.CHAR.eeg[i], 'eeg', i);
      await this.start();
      if (this.userDisconnect) {                // Disconnect was pressed while we were connecting
        this.streaming = false;
        try { await this.send('h'); } catch (_) {}
        try { this.device.gatt.disconnect(); } catch (_) {}
        throw new Error('Connection cancelled');
      }
      this.status('streaming', { name: this.device.name, ppg: this.hasPPG });
      this._startWatchdog();
    }
    async send(cmd) {
      const data = P.encodeCommand(cmd);
      const c = this.control;
      if (c.writeValueWithoutResponse && c.properties && c.properties.writeWithoutResponse && !c.properties.write) await c.writeValueWithoutResponse(data);
      else if (c.writeValue) await c.writeValue(data);
      else await c.writeValueWithResponse(data);
    }
    /* h (halt) -> p50 (Muse 2 preset with PPG) -> s (status) -> d (start data) */
    async start() {
      this.streaming = false;
      await this.send('h'); await sleep(60);
      await this.send(this.hasPPG ? 'p50' : 'p21'); await sleep(60);
      await this.send('s'); await sleep(60);
      await this.send('d');
      this.lastData = performance.now();
      this.streaming = true;
    }
    _control(bytes) {
      this.ctrlBuf += P.decodeControl(bytes);
      let end;
      while ((end = this.ctrlBuf.indexOf('}')) >= 0) {
        const start = this.ctrlBuf.lastIndexOf('{', end);
        const chunk = this.ctrlBuf.slice(start >= 0 ? start : 0, end + 1);
        this.ctrlBuf = this.ctrlBuf.slice(end + 1);
        try { const j = JSON.parse(chunk); if (this.h.onControl) this.h.onControl(j); } catch (_) { /* partial */ }
      }
      if (this.ctrlBuf.length > 2000) this.ctrlBuf = '';
    }
    /* If EEG stops arriving while connected: resend 'd', then the full start sequence. */
    _startWatchdog() {
      clearInterval(this.watchdog);
      this.watchdog = setInterval(async () => {
        if (!this.server || !this.server.connected || !this.streaming || this.recovering) return;
        const idle = performance.now() - this.lastData;
        if (idle < 3000) return;
        this.recovering = true;
        try {
          if (idle < 8000) { await this.send('k'); await this.send('d'); }
          else { this.status('stalled', {}); await this.start(); }
        } catch (e) { console.warn('watchdog', e); }
        this.recovering = false;
      }, 1500);
    }
    _onDisconnected() {
      clearInterval(this.watchdog);
      if (this.connecting) return;          // handled by the retry loop
      this.streaming = false; this.server = null;
      this.status(this.userDisconnect ? 'disconnected' : 'lost', { name: this.device && this.device.name });
    }
    async disconnect() {
      this.userDisconnect = true;
      clearInterval(this.watchdog);
      try { if (this.control && this.server && this.server.connected) await this.send('h'); } catch (_) {}
      try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (_) {}
      this.streaming = false;
    }
  }
  root.MuseBLE = MuseBLE;
})(typeof self !== 'undefined' ? self : this);

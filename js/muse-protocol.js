/* Muse 2 BLE protocol: constants, packet parsers and encoders.
 * Mirrors urish/muse-js (src/muse.ts, lib/muse-parse.ts, lib/muse-utils.ts).
 * Works in the browser (window.MuseProtocol) and in Node (module.exports) for unit tests. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.MuseProtocol = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb'; // full string: Bluefy (iPhone) can't parse numeric UUIDs
  const uuid = (s) => '273e00' + s + '-4c4d-454d-96be-f03bac821358';
  const CHAR = {
    control: uuid('01'),
    eeg: [uuid('03'), uuid('04'), uuid('05'), uuid('06')], // TP9, AF7, AF8, TP10
    aux: uuid('07'),
    gyro: uuid('09'),
    accel: uuid('0a'),
    telemetry: uuid('0b'),
    ppg: [uuid('0f'), uuid('10'), uuid('11')], // ambient, infrared, red
  };
  const EEG_NAMES = ['TP9', 'AF7', 'AF8', 'TP10'];
  const PPG_NAMES = ['ambient', 'infrared', 'red'];
  const EEG_FS = 256, EEG_PER_PACKET = 12;
  const PPG_FS = 64, PPG_PER_PACKET = 6;
  const IMU_FS = 52, IMU_PER_PACKET = 3;
  const EEG_SCALE = 0.48828125;      // uV per LSB, centred on 0x800
  const ACCEL_SCALE = 0.0000610352;  // g per LSB
  const GYRO_SCALE = 0.0074768;      // deg/s per LSB

  function bytesOf(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof DataView) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return Uint8Array.from(v);
  }
  function viewOf(v) {
    if (v instanceof DataView) return v;
    const b = bytesOf(v);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  /* Command framing: [length] + ASCII + '\n', length counts ASCII + newline. 'd' -> 02 64 0a */
  function encodeCommand(cmd) {
    const out = new Uint8Array(cmd.length + 2);
    out[0] = cmd.length + 1;
    for (let i = 0; i < cmd.length; i++) out[i + 1] = cmd.charCodeAt(i) & 0x7f;
    out[cmd.length + 1] = 0x0a;
    return out;
  }
  /* Control notifications: first byte = payload length, then ASCII fragment of a JSON reply. */
  function decodeControl(v) {
    const b = bytesOf(v);
    let s = '';
    const n = Math.min(b[0] || 0, b.length - 1);
    for (let i = 1; i <= n; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  /* 12-bit unsigned big-endian packing: 3 bytes carry 2 samples. */
  function decodeUnsigned12(bytes, offset, count) {
    const out = new Array(count);
    for (let k = 0; k < count; k++) {
      const i = offset + (k >> 1) * 3;
      out[k] = (k & 1) === 0
        ? (bytes[i] << 4) | (bytes[i + 1] >> 4)
        : ((bytes[i + 1] & 0x0f) << 8) | bytes[i + 2];
    }
    return out;
  }
  function decodeUnsigned24(bytes, offset, count) {
    const out = new Array(count);
    for (let k = 0; k < count; k++) {
      const i = offset + k * 3;
      out[k] = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    }
    return out;
  }

  /* EEG packet: uint16 seq + 12 x 12-bit samples (20 bytes). Returns uV. */
  function parseEEG(v) {
    const b = bytesOf(v);
    const seq = (b[0] << 8) | b[1];
    const raw = decodeUnsigned12(b, 2, EEG_PER_PACKET);
    return { seq, samples: raw.map((n) => EEG_SCALE * (n - 0x800)) };
  }
  /* PPG packet: uint16 seq + 6 x 24-bit samples (20 bytes). */
  function parsePPG(v) {
    const b = bytesOf(v);
    return { seq: (b[0] << 8) | b[1], samples: decodeUnsigned24(b, 2, PPG_PER_PACKET) };
  }
  /* IMU packet: uint16 seq + 3 x (x,y,z) int16 big-endian (20 bytes). */
  function parseIMU(v, scale) {
    const d = viewOf(v);
    const s = (o) => ({ x: scale * d.getInt16(o), y: scale * d.getInt16(o + 2), z: scale * d.getInt16(o + 4) });
    return { seq: d.getUint16(0), samples: [s(2), s(8), s(14)] };
  }
  const parseAccel = (v) => parseIMU(v, ACCEL_SCALE);
  const parseGyro = (v) => parseIMU(v, GYRO_SCALE);
  /* Telemetry: seq, battery/512 (%), fuel gauge mV*2.2, ?, temperature. */
  function parseTelemetry(v) {
    const d = viewOf(v);
    return {
      seq: d.getUint16(0),
      battery: d.getUint16(2) / 512,
      voltage: d.getUint16(4) * 2.2,
      temperature: d.byteLength >= 10 ? d.getUint16(8) : null,
    };
  }

  /* ---- Encoders (used by the demo simulator and unit tests) ---- */
  function encodeEEG(seq, uv) {
    const b = new Uint8Array(20);
    b[0] = (seq >> 8) & 0xff; b[1] = seq & 0xff;
    for (let k = 0; k < 12; k += 2) {
      const r0 = Math.max(0, Math.min(4095, Math.round(uv[k] / EEG_SCALE) + 0x800));
      const r1 = Math.max(0, Math.min(4095, Math.round(uv[k + 1] / EEG_SCALE) + 0x800));
      const i = 2 + (k >> 1) * 3;
      b[i] = r0 >> 4;
      b[i + 1] = ((r0 & 0x0f) << 4) | (r1 >> 8);
      b[i + 2] = r1 & 0xff;
    }
    return b;
  }
  function encodePPG(seq, vals) {
    const b = new Uint8Array(20);
    b[0] = (seq >> 8) & 0xff; b[1] = seq & 0xff;
    for (let k = 0; k < 6; k++) {
      const v = Math.max(0, Math.min(0xffffff, Math.round(vals[k])));
      b[2 + k * 3] = (v >> 16) & 0xff; b[3 + k * 3] = (v >> 8) & 0xff; b[4 + k * 3] = v & 0xff;
    }
    return b;
  }
  function encodeIMU(seq, samples, scale) {
    const b = new Uint8Array(20);
    const d = new DataView(b.buffer);
    d.setUint16(0, seq & 0xffff);
    const c = (x) => Math.max(-32768, Math.min(32767, Math.round(x / scale)));
    samples.forEach((s, k) => {
      d.setInt16(2 + k * 6, c(s.x)); d.setInt16(4 + k * 6, c(s.y)); d.setInt16(6 + k * 6, c(s.z));
    });
    return b;
  }
  function encodeTelemetry(seq, batteryPct, voltageMv, temp) {
    const b = new Uint8Array(20);
    const d = new DataView(b.buffer);
    d.setUint16(0, seq & 0xffff);
    d.setUint16(2, Math.round(batteryPct * 512));
    d.setUint16(4, Math.round((voltageMv || 3900) / 2.2));
    d.setUint16(8, temp || 30);
    return b;
  }

  return {
    MUSE_SERVICE, CHAR, EEG_NAMES, PPG_NAMES,
    EEG_FS, EEG_PER_PACKET, PPG_FS, PPG_PER_PACKET, IMU_FS, IMU_PER_PACKET,
    EEG_SCALE, ACCEL_SCALE, GYRO_SCALE,
    encodeCommand, decodeControl, decodeUnsigned12, decodeUnsigned24,
    parseEEG, parsePPG, parseIMU, parseAccel, parseGyro, parseTelemetry,
    encodeEEG, encodePPG, encodeIMU, encodeTelemetry,
  };
});

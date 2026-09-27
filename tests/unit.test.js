const assert = require('assert');
const P = require('../js/muse-protocol.js');
const D = require('../js/dsp.js');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ok -', m); };
const near = (a, b, e) => Math.abs(a - b) <= e;

console.log('Protocol');
// command framing (matches muse-js encodeCommand: `X${cmd}\n` with X = length-1)
ok(Buffer.from(P.encodeCommand('d')).equals(Buffer.from([0x02, 0x64, 0x0a])), "encodeCommand('d') = 02 64 0a");
ok(Buffer.from(P.encodeCommand('p50')).equals(Buffer.from([0x04, 0x70, 0x35, 0x30, 0x0a])), "encodeCommand('p50') = 04 70 35 30 0a");
ok(P.decodeControl(Uint8Array.from([5, 0x7b, 0x22, 0x72, 0x63, 0x22, 0, 0])) === '{"rc"', 'decodeControl respects length byte');

// EEG 12-bit: hand-packed bytes. samples 0x800,0xFFF | 0x000,0x123 | 0xABC,0x801 ...
const eegBytes = Uint8Array.from([0x12, 0x34, 0x80, 0x0F, 0xFF, 0x00, 0x01, 0x23, 0xAB, 0xC8, 0x01, 0x80, 0x08, 0x00, 0x7F, 0xF8, 0x00, 0x00, 0x00, 0x00]);
const raw12 = P.decodeUnsigned12(eegBytes, 2, 12);
ok(JSON.stringify(raw12) === JSON.stringify([0x800, 0xFFF, 0x000, 0x123, 0xABC, 0x801, 0x800, 0x800, 0x7FF, 0x800, 0x000, 0x000]), '12-bit unpack of hand-packed bytes');
const eeg = P.parseEEG(new DataView(eegBytes.buffer));
ok(eeg.seq === 0x1234, 'EEG seq big-endian = 0x1234');
ok(eeg.samples[0] === 0 && near(eeg.samples[1], 0.48828125 * 2047, 1e-9) && eeg.samples[2] === -1000, 'EEG uV = 0.48828125*(raw-0x800) (0 / +999.5 / -1000)');
// muse-js reference implementation (copied loop) must agree on random data
function museJs12(samples) { const out = []; for (let i = 0; i < samples.length; i++) { if (i % 3 === 0) out.push((samples[i] << 4) | (samples[i + 1] >> 4)); else { out.push(((samples[i] & 0xf) << 8) | samples[i + 1]); i++; } } return out; }
for (let t = 0; t < 200; t++) { const b = Uint8Array.from({ length: 18 }, () => Math.random() * 256 | 0); assert.deepStrictEqual(P.decodeUnsigned12(b, 0, 12), museJs12(b)); }
ok(true, '12-bit unpack identical to muse-js algorithm on 200 random packets');
const uv = [0, 10, -10, 100.5, -250, 999, -1000, 3.3, 7, -7, 0.49, 500];
const back = P.parseEEG(P.encodeEEG(77, uv));
ok(back.seq === 77 && back.samples.every((v, i) => near(v, uv[i], 0.2442)), 'EEG encode->parse round trip within 1/2 LSB');

// PPG 24-bit
const ppgBytes = Uint8Array.from([0x00, 0x05, 0x01, 0x02, 0x03, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x02, 0x49, 0xF0, 0x80, 0x00, 0x01, 0x12, 0x34, 0x56]);
const ppg = P.parsePPG(ppgBytes);
ok(ppg.seq === 5 && JSON.stringify(ppg.samples) === JSON.stringify([0x010203, 0xFFFFFF, 0, 0x0249F0, 0x800001, 0x123456]), 'PPG 24-bit unpack (incl. 0xFFFFFF, 0x800001 unsigned)');

// IMU int16 big-endian
const imu = Uint8Array.from([0x00, 0x09, 0x40, 0x00, 0xC0, 0x00, 0x00, 0x01, 0x7F, 0xFF, 0x80, 0x00, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0]);
const acc = P.parseAccel(imu);
ok(acc.seq === 9, 'IMU seq');
ok(near(acc.samples[0].x, 16384 * 0.0000610352, 1e-9) && near(acc.samples[0].x, 1.0, 1e-4), 'accel 0x4000 -> +1.000 g');
ok(near(acc.samples[0].y, -1.0, 1e-4) && near(acc.samples[0].z, 0.0000610352, 1e-12), 'accel 0xC000 -> -1 g, 0x0001 -> 1 LSB');
ok(near(acc.samples[1].x, 32767 * 0.0000610352, 1e-9) && near(acc.samples[1].y, -32768 * 0.0000610352, 1e-9) && near(acc.samples[1].z, -0.0000610352, 1e-12), 'accel int16 extremes / -1 sign extension');
const gy = P.parseGyro(imu);
ok(near(gy.samples[0].x, 16384 * 0.0074768, 1e-6), 'gyro scale 0.0074768 deg/s');
const imuRT = P.parseAccel(P.encodeIMU(3, [{ x: 0.1, y: -0.2, z: 0.98 }, { x: 0, y: 0, z: 1 }, { x: -1.5, y: 1.5, z: 0 }], P.ACCEL_SCALE));
ok(near(imuRT.samples[0].z, 0.98, 1e-4) && near(imuRT.samples[2].x, -1.5, 1e-4), 'IMU encode->parse round trip');
const tel = P.parseTelemetry(P.encodeTelemetry(1, 83.5, 3900, 31));
ok(near(tel.battery, 83.5, 0.01) && tel.temperature === 31, 'telemetry battery = uint16/512');

console.log('DSP');
// Band powers: 10 Hz sine should land in alpha
const fs = 256, sa = new D.SpectrumAnalyzer(512, fs);
const x = new Float64Array(512).map((_, i) => 20 * Math.sin(2 * Math.PI * 10 * i / fs) + 5 * Math.sin(2 * Math.PI * 20 * i / fs) + 300);
sa.compute(x); const rel = D.relativeBands(sa.bands());
ok(rel.alpha > 0.85 && rel.beta > 0.05 && rel.beta < 0.14, `10 Hz+20 Hz sine -> alpha ${(rel.alpha * 100).toFixed(1)}%, beta ${(rel.beta * 100).toFixed(1)}%`);
const x2 = new Float64Array(512).map((_, i) => 20 * Math.sin(2 * Math.PI * 6 * i / fs));
sa.compute(x2); const rel2 = D.relativeBands(sa.bands());
ok(rel2.theta > 0.9, `6 Hz sine -> theta ${(rel2.theta * 100).toFixed(1)}%`);

// HR detector on synthetic PPG
function synthPPG(bpm, secs, opts) {
  opts = opts || {};
  const f = 64, out = []; let ph = 0, seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < secs * f; i++) {
    const t = i / f;
    const inst = bpm * (1 + (opts.hrv || 0.03) * Math.sin(2 * Math.PI * 0.2 * t));
    ph = (ph + inst / 60 / f) % 1;
    // realistic pulse: fast systolic upstroke (gamma-shaped), slow decay, dicrotic bump
    const p = Math.pow(ph / 0.15, 2) * Math.exp(2 * (1 - ph / 0.15)) + 0.25 * Math.exp(-(((ph - 0.5) / 0.07) ** 2));
    const pol = opts.invert === false ? 1 : -1;  // reflected IR light dips with each pulse
    out.push(150000 + pol * 900 * p + 500 * Math.sin(2 * Math.PI * 0.15 * t) + 2000 * t / secs + (opts.noise || 60) * rnd() * 2);
  }
  return out;
}
for (const bpm of [48, 65, 90, 120, 160]) {
  const hr = new D.HeartRateDetector(64); let beats = 0; hr.onBeat = () => beats++;
  let firstConf = null;
  synthPPG(bpm, 30).forEach((v, i) => { hr.push(v); if (firstConf === null && hr.value() !== null) firstConf = i / 64; });
  const est = hr.value();
  ok(est !== null && near(est, bpm, Math.max(2, bpm * 0.03)) && (bpm > 150 || hr.sign === -1), `HR ${bpm} bpm -> ${est && est.toFixed(1)} bpm (confident after ${firstConf && firstConf.toFixed(1)} s, polarity ${hr.sign}, ${beats} beats in 30 s)`);
}
{ const hr = new D.HeartRateDetector(64); synthPPG(72, 30, { invert: false }).forEach((v) => hr.push(v));
  ok(near(hr.value(), 72, 2.2) && hr.sign === 1, `non-inverted PPG 72 bpm -> ${hr.value().toFixed(1)}, polarity +1`); }
{ const hr = new D.HeartRateDetector(64); synthPPG(65, 30, { noise: 350 }).forEach((v) => hr.push(v));
  ok(hr.value() !== null && near(hr.value(), 65, 2.5), `noisy PPG (SNR~1.3) 65 bpm -> ${hr.value() && hr.value().toFixed(1)}`); }
{ const hr = new D.HeartRateDetector(64); let seed = 7; for (let i = 0; i < 64 * 30; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; hr.push(150000 + 500 * (seed / 0x7fffffff - 0.5)); }
  ok(hr.value() === null, 'pure noise -> no confident HR (shows --)'); }

// Calm engine: baseline then alpha rise -> score climbs
{ const c = new D.CalmEngine({ calibSeconds: 30 }); let t = 0;
  for (; t < 30; t += 0.25) c.update({ alpha: 0.15 + 0.02 * Math.sin(t), beta: 0.25, theta: 0.2, delta: 0.3, gamma: 0.1 }, true, 0.25);
  const base = c.score; ok(!c.calibrating, 'calibration completes after 30 s of valid frames');
  for (let k = 0; k < 60; k++) c.update({ alpha: 0.15, beta: 0.25 }, true, 0.25);
  const neutral = c.score;
  for (let k = 0; k < 80; k++) c.update({ alpha: 0.30, beta: 0.18 }, true, 0.25);
  ok(neutral > 30 && neutral < 55 && c.score > 85, `calm score: baseline ${neutral.toFixed(0)} -> relaxed ${c.score.toFixed(0)}`);
  const held = c.score; c.update(null, false, 0.25); ok(c.score === held, 'invalid (artifact) frames hold the score'); }
console.log(`\n${pass} checks passed`);

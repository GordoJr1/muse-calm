/* Demo mode: synthesises realistic Muse 2 data and feeds it through the SAME byte-level
 * parsers as the real headband (EEG 12-bit packets, PPG 24-bit, IMU int16, telemetry). */
(function (root) {
  'use strict';
  const P = root.MuseProtocol, D = root.DSP;

  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* Band-limited noise source with unit RMS output */
  class BandNoise {
    constructor(fs, f0, Q) {
      this.bq = new D.Biquad('bandpass', fs, f0, Q);
      let e = 0; for (let i = 0; i < fs * 4; i++) { const y = this.bq.process(gauss()); if (i > fs) e += y * y; }
      this.g = 1 / Math.sqrt(e / (fs * 3));
    }
    next() { return this.g * this.bq.process(gauss()); }
  }

  class MuseSimulator {
    constructor(onPacket, speed) {
      this.onPacket = onPacket; this.timer = null; this.speed = speed || 1;
      this.drops = []; this.sessStart = null; this.calibDelay = 40;
      const fs = P.EEG_FS;
      this.ch = [0, 1, 2, 3].map((c) => ({
        delta: new BandNoise(fs, 2, 0.8), theta: new BandNoise(fs, 6, 1.5), alpha: new BandNoise(fs, 10, 4),
        beta: new BandNoise(fs, 20, 1.2), gamma: new BandNoise(fs, 38, 1.5),
        pink: 0, offset: [18, -12, 9, -20][c], blink: 0,
      }));
    }
    /* scripted relaxation arc (0..1): baseline during calibration, then settling into calm, with dips */
    /* call when a meditation session starts; the relaxation arc begins after calibration */
    markSession(calibrating) { this.sessStart = this.now(); this.calibDelay = calibrating === false ? 3 : 40; this.autoDropAt = this.now() + this.calibDelay + 8; }
    endSession() { this.sessStart = null; }
    /* make one electrode lose contact for a while (big broadband noise + mains hum) */
    dropSensor(ch, secs) { const t = this.now(); this.drops.push({ ch, from: t, to: t + (secs || 6) }); }
    now() { return (performance.now() - this.t0) * this.speed / 1000; }
    contactNoise(ch, t) {
      let n = 0;
      if (ch === 3 && t < 3.5) n = 110;               // putting the band on: right ear not seated yet
      if (ch === 1 && t < 2) n = 32;                  // left forehead settling
      for (const d of this.drops) if (d.ch === ch && t >= d.from && t < d.to) n = 150;
      return n;
    }
    calm(t) {
      if (this.sessStart === null) return 0.28 + 0.05 * Math.sin(t / 6);
      const st = t - this.sessStart - this.calibDelay + 5;
      if (st < 5) return 0.28 + 0.05 * Math.sin(t / 6);
      let c = 0.28 + 0.62 * (1 - Math.exp(-(st - 5) / 12)) + 0.07 * Math.sin((st - 5) / 11);
      const cyc = (st - 5) % 150;
      if (cyc > 105 && cyc < 125) c -= 0.45 * Math.sin(Math.PI * (cyc - 105) / 20);  // a distracted moment
      return D.clamp(c, 0.05, 1);
    }
    start() {
      this.t0 = performance.now();
      this.nEEG = 0; this.nPPG = 0; this.nIMU = 0; this.seq = { eeg: 0, ppg: 0, imu: 0, tel: 0 };
      this.ph = 0; this.lastTel = -99; this.nextBlink = 3; this.battery = 86;
      this.drops = []; this.sessStart = null; this.autoDropAt = null;
      this.timer = setInterval(() => this.tick(), 20);
      this.tick();
    }
    stop() { clearInterval(this.timer); this.timer = null; }
    get running() { return !!this.timer; }
    tick() {
      const now = this.now();
      if (this.autoDropAt && now >= this.autoDropAt) { this.autoDropAt = null; this.dropSensor(2, 9); }   // demo: AF8 slips for 9 s (banner after ~3 s)
      const cap = (n, fs) => Math.max(n, Math.floor(now * fs) - fs);   // skip backlog after tab sleep
      this.nEEG = cap(this.nEEG, 256); this.nPPG = cap(this.nPPG, 64); this.nIMU = cap(this.nIMU, 52);
      while (this.nEEG + 12 <= now * 256) this.eegPacket();
      while (this.nPPG + 6 <= now * 64) this.ppgPacket();
      while (this.nIMU + 3 <= now * 52) this.imuPacket();
      if (now - this.lastTel > 10) {
        this.lastTel = now; this.battery = Math.max(5, this.battery - 0.05);
        this.onPacket('telemetry', 0, P.encodeTelemetry(this.seq.tel++, this.battery, 3950, 31));
      }
    }
    eegPacket() {
      const out = [[], [], [], []];
      for (let k = 0; k < 12; k++) {
        const t = (this.nEEG + k) / 256;
        const c = this.calm(t);
        if (t > this.nextBlink) { this.blinkT = t; this.nextBlink = t + (c > 0.6 ? 7 : 3.5) + Math.random() * 4; }
        const bt = t - (this.blinkT || -9);
        const blink = bt >= 0 && bt < 0.35 ? 140 * Math.sin(Math.PI * bt / 0.35) ** 2 : 0;
        const spindle = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.23 * t);
        for (let i = 0; i < 4; i++) {
          const s = this.ch[i], temporal = i === 0 || i === 3;
          s.pink = 0.995 * s.pink + 0.8 * gauss();
          let v = s.offset + 0.6 * s.pink
            + (7 + 2 * (1 - c)) * s.delta.next()
            + 4.5 * s.theta.next()
            + (4.5 + 6.5 * c) * spindle * (temporal ? 1.15 : 0.85) * s.alpha.next()
            + (5.2 - 1.6 * c) * s.beta.next()
            + (1.6 - 0.6 * c) * s.gamma.next()
            + 1.2 * gauss();
          if (!temporal) v += blink * (i === 1 ? 1 : 0.9);
          const cn = this.contactNoise(i, t);
          if (cn) v += cn * gauss() + cn * 0.8 * Math.sin(2 * Math.PI * 60 * t + i);
          out[i].push(v);
        }
      }
      for (let i = 0; i < 4; i++) this.onPacket('eeg', i, P.encodeEEG(this.seq.eeg & 0xffff, out[i]));
      this.seq.eeg++; this.nEEG += 12;
    }
    ppgPacket() {
      const ir = [], red = [], amb = [];
      for (let k = 0; k < 6; k++) {
        const t = (this.nPPG + k) / 64;
        const c = this.calm(t);
        const hr = 68 - 5 * c + 3 * Math.sin(2 * Math.PI * 0.16 * t);    // resp. sinus arrhythmia
        this.ph = (this.ph + hr / 60 / 64) % 1;
        const f = this.ph;
        const pulse = Math.pow(f / 0.15, 2) * Math.exp(2 * (1 - f / 0.15)) + 0.25 * Math.exp(-(((f - 0.5) / 0.07) ** 2));
        const breath = Math.sin(2 * Math.PI * 0.16 * t);
        ir.push(162000 - 1100 * pulse + 380 * breath + 60 * gauss());
        red.push(98000 - 520 * pulse + 200 * breath + 50 * gauss());
        amb.push(2400 + 30 * gauss());
      }
      const s = this.seq.ppg++ & 0xffff;
      this.onPacket('ppg', 0, P.encodePPG(s, amb));
      this.onPacket('ppg', 1, P.encodePPG(s, ir));
      this.onPacket('ppg', 2, P.encodePPG(s, red));
      this.nPPG += 6;
    }
    imuPacket() {
      const acc = [], gyr = [], d2r = Math.PI / 180;
      for (let k = 0; k < 3; k++) {
        const t = (this.nIMU + k) / 52;
        const c = this.calm(t), m = 1.4 - c;
        const nod = t > 20 && t < 23 ? 9 * Math.sin(Math.PI * (t - 20) / 3) * Math.sin(2 * Math.PI * 1.2 * (t - 20)) : 0;
        const pitch = 4 * m * Math.sin(2 * Math.PI * 0.05 * t) + 1.2 * Math.sin(2 * Math.PI * 0.16 * t) + nod;
        const roll = 3 * m * Math.sin(2 * Math.PI * 0.035 * t + 1);
        const dp = 4 * m * 2 * Math.PI * 0.05 * Math.cos(2 * Math.PI * 0.05 * t) + 1.2 * 2 * Math.PI * 0.16 * Math.cos(2 * Math.PI * 0.16 * t) + (nod ? 9 * 2 * Math.PI * 1.2 * Math.cos(2 * Math.PI * 1.2 * (t - 20)) : 0);
        const dr = 3 * m * 2 * Math.PI * 0.035 * Math.cos(2 * Math.PI * 0.035 * t + 1);
        const p = pitch * d2r, r = roll * d2r;
        acc.push({ x: -Math.sin(p) + 0.004 * gauss(), y: Math.cos(p) * Math.sin(r) + 0.004 * gauss(), z: Math.cos(p) * Math.cos(r) + 0.004 * gauss() });
        gyr.push({ x: dr + 0.4 * gauss(), y: dp + 0.4 * gauss(), z: 0.8 * Math.sin(t / 3) * m + 0.4 * gauss() });
      }
      const s = this.seq.imu++ & 0xffff;
      this.onPacket('accel', 0, P.encodeIMU(s, acc, P.ACCEL_SCALE));
      this.onPacket('gyro', 0, P.encodeIMU(s, gyr, P.GYRO_SCALE));
      this.nIMU += 3;
    }
  }
  root.MuseSimulator = MuseSimulator;
})(typeof self !== 'undefined' ? self : this);

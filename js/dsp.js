/* Signal processing for Muse Calm: ring buffers, biquads, FFT band powers,
 * signal quality, PPG heart-rate detection and the adaptive calm score.
 * Browser: window.DSP. Node: module.exports (unit tests). */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.DSP = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  class Ring {
    constructor(n) { this.n = n; this.buf = new Float64Array(n); this.i = 0; this.count = 0; }
    push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.n; if (this.count < this.n) this.count++; }
    /* last m samples, oldest first */
    latest(m, out) {
      m = Math.min(m, this.count);
      if (!out || out.length !== m) out = new Float64Array(m);
      let s = (this.i - m + this.n) % this.n;
      for (let k = 0; k < m; k++) { out[k] = this.buf[s]; s = s + 1 === this.n ? 0 : s + 1; }
      return out;
    }
    last() { return this.count ? this.buf[(this.i - 1 + this.n) % this.n] : 0; }
    clear() { this.i = 0; this.count = 0; this.buf.fill(0); }
  }

  /* RBJ cookbook biquad, direct form I */
  class Biquad {
    constructor(type, fs, f0, Q) {
      Q = Q || Math.SQRT1_2;
      const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * Q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
      else if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
      else if (type === 'bandpass') { b0 = al; b1 = 0; b2 = -al; }
      else if (type === 'notch') { b0 = 1; b1 = -2 * cw; b2 = 1; }
      else throw new Error('biquad type ' + type);
      a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al;
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
    reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  }

  /* Display / quality filter for EEG: DC tracker + HP 1 Hz + LP 40 Hz + 50/60 Hz notches */
  class EEGFilter {
    constructor(fs) {
      this.dc = null; this.a = 1 - Math.exp(-1 / (fs * 2));
      this.f = [new Biquad('highpass', fs, 1, 0.707), new Biquad('lowpass', fs, 40, 0.707),
        new Biquad('notch', fs, 60, 4), new Biquad('notch', fs, 50, 4)];
    }
    process(x) {
      if (this.dc === null) this.dc = x;
      this.dc += this.a * (x - this.dc);
      let y = x - this.dc;
      for (let i = 0; i < this.f.length; i++) y = this.f[i].process(y);
      return y;
    }
  }

  /* In-place iterative radix-2 complex FFT (forward) */
  function createFFT(n) {
    const bits = Math.round(Math.log2(n));
    if (1 << bits !== n) throw new Error('FFT size must be power of 2');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cs[k] + im[l] * sn[k];
            const tim = -re[l] * sn[k] + im[l] * cs[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim; re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  const BANDS = [
    { key: 'delta', lo: 1, hi: 4 },
    { key: 'theta', lo: 4, hi: 8 },
    { key: 'alpha', lo: 8, hi: 13 },
    { key: 'beta', lo: 13, hi: 30 },
    { key: 'gamma', lo: 30, hi: 44 },
  ];

  /* Hann-windowed power spectrum on n-sample windows (default 512 = 2 s @ 256 Hz) */
  class SpectrumAnalyzer {
    constructor(n, fs) {
      this.n = n; this.fs = fs; this.fft = createFFT(n);
      this.win = new Float64Array(n);
      for (let i = 0; i < n; i++) this.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
      this.re = new Float64Array(n); this.im = new Float64Array(n);
      this.psd = new Float64Array(n / 2 + 1);
      this.df = fs / n;
    }
    compute(x) {
      const n = this.n; let mean = 0;
      for (let i = 0; i < n; i++) mean += x[i];
      mean /= n;
      for (let i = 0; i < n; i++) { this.re[i] = (x[i] - mean) * this.win[i]; this.im[i] = 0; }
      this.fft(this.re, this.im);
      for (let k = 0; k <= n / 2; k++) this.psd[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      return this.psd;
    }
    power(lo, hi) {
      let s = 0; const k0 = Math.ceil(lo / this.df), k1 = Math.ceil(hi / this.df);
      for (let k = k0; k < k1 && k < this.psd.length; k++) s += this.psd[k];
      return s;
    }
    bands() {
      const out = {}; let total = 0;
      for (const b of BANDS) { out[b.key] = this.power(b.lo, b.hi); total += out[b.key]; }
      out.total = total;
      out.mains = this.power(48, 62);
      return out;
    }
  }

  function relativeBands(b) {
    const t = b.total || 1e-12, out = {};
    for (const x of BANDS) out[x.key] = b[x.key] / t;
    return out;
  }

  /* Per-channel signal quality from the 1-40 Hz filtered signal (1 s window) */
  function stats(arr) {
    let m = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < arr.length; i++) { m += arr[i]; if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i]; }
    m /= arr.length || 1;
    let v = 0;
    for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
    return { mean: m, std: Math.sqrt(v / (arr.length || 1)), ptp: mx - mn };
  }
  /* robust std (1.4826 * median absolute deviation): brief blinks barely move it */
  function robustStd(arr) {
    const n = arr.length; if (!n) return 0;
    const a = Float64Array.from(arr).sort(), med = n % 2 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
    for (let i = 0; i < n; i++) a[i] = Math.abs(arr[i] - med);
    a.sort();
    return 1.4826 * (n % 2 ? a[n >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]));
  }
  function qualityLevel(std, mainsRatio) {
    if (!(std > 0.4)) return 'off';          // flat line: no data / railed
    if (std > 100 || mainsRatio > 6) return 'poor';
    if (std > 35 || mainsRatio > 2) return 'fair';
    return 'good';
  }

  /* ---------- Heart rate from PPG (infrared, 64 Hz) ---------- */
  class HeartRateDetector {
    constructor(fs) {
      this.fs = fs || 64;
      this.reset();
    }
    reset() {
      const fs = this.fs;
      this.dc = null; this.dcA = 1 - Math.exp(-1 / (fs * 1.5));
      this.hp = new Biquad('highpass', fs, 0.6, 0.707);
      this.lp1 = new Biquad('lowpass', fs, 3.5, 0.707);
      this.lp2 = new Biquad('lowpass', fs, 3.5, 0.707);
      this.filt = new Ring(fs * 12);
      this.n = 0; this.sign = 1; this.flipVotes = 0;
      this.bpm = null; this.confident = false; this.streak = 0; this.lastGoodN = -1e9;
      this.confidence = 0; this.acBpm = null; this.pkBpm = null;
      this.env = 0; this.inPk = false; this.pkVal = 0; this.pkN = 0; this.lastBeatN = -1e9;
      this.beats = [];
      this.onBeat = null;
    }
    push(x) {
      const fs = this.fs;
      if (this.dc === null) this.dc = x;
      this.dc += this.dcA * (x - this.dc);
      const y = this.lp2.process(this.lp1.process(this.hp.process(x - this.dc)));
      this.filt.push(y);
      this.n++;
      if (this.n > fs * 2) this._peak(this.sign * y);
      if (this.n % Math.round(fs / 2) === 0 && this.n >= fs * 6) this._update();
    }
    _peak(v) {
      const fs = this.fs;
      this.env = Math.max(this.env * Math.exp(-1 / (fs * 2.5)), Math.abs(v));
      if (!this.inPk) {
        if (v > 0.3 * this.env) { this.inPk = true; this.pkVal = v; this.pkN = this.n; }
      } else {
        if (v > this.pkVal) { this.pkVal = v; this.pkN = this.n; }
        if (v < 0) {
          this.inPk = false;
          const gap = this.pkN - this.lastBeatN;
          const minGap = Math.max(0.3 * fs, this.bpm ? 0.6 * 60 * fs / this.bpm : 0);
          if (gap >= minGap) {
            this.lastBeatN = this.pkN;
            this.beats.push(this.pkN);
            while (this.beats.length && this.beats[0] < this.n - fs * 10) this.beats.shift();
            if (this.onBeat) this.onBeat(this.confident);
          }
        }
      }
    }
    _update() {
      const fs = this.fs, N = fs * 8;
      const x = this.filt.latest(N);
      let m = 0; for (let i = 0; i < N; i++) m += x[i]; m /= N;
      let e = 0; for (let i = 0; i < N; i++) { x[i] -= m; e += x[i] * x[i]; }
      if (e < 1e-9) { this._bad(); return; }
      // Polarity: the blood-volume pulse has sharp systolic peaks and broad troughs,
      // so the correctly oriented waveform is positively skewed.
      let s2 = 0, s3 = 0;
      for (let i = 0; i < N; i++) { s2 += x[i] * x[i]; s3 += x[i] * x[i] * x[i]; }
      const skew = (s3 / N) / Math.pow(s2 / N, 1.5);
      const want = skew >= 0 ? 1 : -1;
      if (Math.abs(skew) > 0.2 && want !== this.sign) { if (++this.flipVotes >= 3) { this.sign = want; this.flipVotes = 0; this.inPk = false; } }
      else this.flipVotes = 0;
      // Normalised autocorrelation over 40-200 bpm
      const minL = Math.floor(fs * 60 / 200), maxL = Math.ceil(fs * 60 / 40);
      const r = new Float64Array(maxL + 2);
      for (let L = minL - 1; L <= maxL + 1; L++) {
        let s = 0, a = 0, b = 0;
        for (let i = 0; i + L < N; i++) { s += x[i] * x[i + L]; a += x[i] * x[i]; b += x[i + L] * x[i + L]; }
        r[L] = s / Math.sqrt(a * b + 1e-12);
      }
      const peaks = [];
      let best = -1;
      for (let L = minL; L <= maxL; L++) {
        if (r[L] > r[L - 1] && r[L] >= r[L + 1] && r[L] > 0) { peaks.push(L); if (r[L] > best) best = r[L]; }
      }
      if (!peaks.length) { this._bad(); return; }
      // peak-interval estimate
      const ibis = [];
      for (let i = 1; i < this.beats.length; i++) if (this.beats[i] > this.n - N) ibis.push(this.beats[i] - this.beats[i - 1]);
      let pk = null;
      if (ibis.length >= 3) {
        const s = ibis.slice().sort((a, b) => a - b);
        pk = 60 * fs / s[s.length >> 1];
      }
      this.pkBpm = pk;
      // choose lag: shortest strong peak, or the strong peak closest to the beat-interval estimate
      let L = peaks.find((p) => r[p] >= 0.9 * best);
      if (pk) {
        let bestD = Infinity;
        for (const p of peaks) {
          if (r[p] < 0.6 * best) continue;
          const d = Math.abs(60 * fs / p - pk);
          if (d < bestD) { bestD = d; L = p; }
        }
      }
      const y0 = r[L - 1], y1 = r[L], y2 = r[L + 1];
      const den = y0 - 2 * y1 + y2;
      const lag = L + (den !== 0 ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0);
      const ac = 60 * fs / lag;
      this.acBpm = ac; this.confidence = r[L];
      // beat-interval estimate is a cross-check; a very periodic signal is trusted on its own
      const agree = pk === null || Math.abs(pk - ac) / ac < 0.15 || r[L] > 0.75;
      if (r[L] > 0.45 && agree && ac >= 40 && ac <= 200) {
        this.streak++;
        this.lastGoodN = this.n;
        if (this.bpm === null || Math.abs(ac - this.bpm) / this.bpm > 0.25 && this.streak < 3) this.bpm = ac;
        else this.bpm += 0.25 * (ac - this.bpm);   // ~several beats of smoothing (updates every 0.5 s)
        if (this.streak >= 4) this.confident = true;
      } else this._bad();
    }
    _bad() {
      this.streak = 0;
      if (this.n - this.lastGoodN > this.fs * 5) { this.confident = false; }
      if (this.n - this.lastGoodN > this.fs * 10) this.bpm = null;
    }
    value() { return this.confident && this.bpm ? this.bpm : null; }
    waveform(m) {
      const w = this.filt.latest(m);
      if (this.sign < 0) for (let i = 0; i < w.length; i++) w[i] = -w[i];
      return w;
    }
  }

  /* ---------- Calm score ---------- */
  function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : 0; }
  function mad(a, med) { return median(a.map((v) => Math.abs(v - med))); }

  class CalmEngine {
    constructor(opts) {
      opts = opts || {};
      this.calibSeconds = opts.calibSeconds || 40;
      this.reset();
    }
    reset() {
      this.calibT = 0; this.cA = []; this.cAB = []; this.baseline = null;
      this.fA = null; this.fAB = null; this.raw = null; this.score = null; this.z = 0; this.valid = false;
    }
    get calibrating() { return !this.baseline; }
    get calibProgress() { return this.baseline ? 1 : clamp(this.calibT / this.calibSeconds, 0, 1); }
    /* rel: relative band powers; valid: artifact-free frame; dt seconds since last frame */
    update(rel, valid, dt) {
      this.valid = valid;
      if (!valid || !rel) return this;
      const a = rel.alpha, ab = Math.log((rel.alpha + 1e-9) / (rel.beta + 1e-9));
      const k = 1 - Math.exp(-dt / 2);
      this.fA = this.fA === null ? a : this.fA + k * (a - this.fA);
      this.fAB = this.fAB === null ? ab : this.fAB + k * (ab - this.fAB);
      if (!this.baseline) {
        this.calibT += dt;
        if (this.calibT > 4) { this.cA.push(this.fA); this.cAB.push(this.fAB); }
        this.raw = 100 * clamp((this.fA - 0.06) / 0.34, 0, 1);  // provisional absolute estimate
        if (this.calibT >= this.calibSeconds && this.cA.length > 8) {
          const mA = median(this.cA), mAB = median(this.cAB);
          this.baseline = {
            mA, sA: Math.max(0.045, 1.4826 * mad(this.cA, mA)),
            mAB, sAB: Math.max(0.25, 1.4826 * mad(this.cAB, mAB)),
          };
          this.score = null;   // start scored time from the baseline-relative value, not the provisional estimate
        }
      }
      if (this.baseline) {
        const B = this.baseline;
        this.z = 0.6 * (this.fA - B.mA) / B.sA + 0.4 * (this.fAB - B.mAB) / B.sAB;
        this.raw = 100 / (1 + Math.exp(-(0.95 * this.z - 0.25)));
      }
      const ks = 1 - Math.exp(-dt / 3);
      this.score = this.score === null ? this.raw : this.score + ks * (this.raw - this.score);
      return this;
    }
  }

  /* Keeps the electrode set behind the averaged relative band powers stable. A channel that is
   * briefly unusable (blink artifact, a few seconds of poor contact) contributes its last clean
   * value for up to holdSec, so the average is not suddenly taken over a different set of
   * electrodes (temporal sites carry more alpha than forehead sites, which would bias the score). */
  class ChannelBlend {
    constructor(n, holdSec) { this.n = n; this.hold = holdSec || 5; this.reset(); }
    reset() { this.last = new Array(this.n).fill(null); this.age = new Array(this.n).fill(Infinity); }
    /* rels[i]: relative bands for channel i (or null); usable[i]: clean this frame. Returns {mean, fresh, used} */
    update(rels, usable, dt) {
      let fresh = 0, used = 0; const sum = {}, held = [];
      for (let i = 0; i < this.n; i++) {
        if (usable[i] && rels[i]) { this.last[i] = rels[i]; this.age[i] = 0; fresh++; }
        else this.age[i] += dt;
      }
      for (let i = 0; i < this.n; i++) {
        if (!this.last[i] || this.age[i] > this.hold) continue;
        used++; if (this.age[i] > 0) held.push(i);
        for (const k in this.last[i]) sum[k] = (sum[k] || 0) + this.last[i][k];
      }
      if (!fresh || !used) return { mean: null, fresh, used, held };
      for (const k in sum) sum[k] /= used;
      return { mean: sum, fresh, used, held };
    }
  }

  return { ChannelBlend, clamp, Ring, Biquad, EEGFilter, createFFT, SpectrumAnalyzer, BANDS, relativeBands, stats, robustStd, qualityLevel, HeartRateDetector, CalmEngine, median };
});

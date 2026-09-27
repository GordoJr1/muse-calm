/* Synthesised bird chorus (Web Audio only, no samples).
 * Frequency-swept sines with envelopes, species-like phrase patterns, stereo panning, light reverb. */
(function (root) {
  'use strict';
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  /* piecewise-linear frequency curve [[x0,f0],[x1,f1],...] with x in 0..1 */
  function curve(points, mul, n) {
    n = n || 48; const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1); let j = 0;
      while (j < points.length - 2 && x > points[j + 1][0]) j++;
      const [x0, f0] = points[j], [x1, f1] = points[j + 1];
      const u = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
      const s = u * u * (3 - 2 * u);                // smoothstep between knots
      out[i] = Math.max(60, (f0 + (f1 - f0) * s) * mul);
    }
    return out;
  }
  function envelope(n, attack) {
    const out = new Float32Array(n); attack = attack || 0.12;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      out[i] = x < attack ? Math.sin((x / attack) * Math.PI / 2) : Math.pow(Math.cos(((x - attack) / (1 - attack)) * Math.PI / 2), 1.6);
    }
    out[n - 1] = 0;
    return out;
  }

  const SPECIES = ['robin', 'chickadee', 'finch', 'cardinal', 'thrush', 'sparrow', 'warbler'];

  class BirdChorus {
    constructor() {
      this.ctx = null; this.volume = 0.6; this.muted = false;
      this.activity = 0; this.active = false; this.voices = []; this.songs = 0; this.onSong = null;
    }
    get ready() { return !!this.ctx && this.ctx.state === 'running'; }
    unlock() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this._build();
      }
      if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') { const pr = this.ctx.resume(); if (pr && pr.catch) pr.catch(() => {}); }   // Safari reports 'interrupted'
      // iOS 17+ / WebKit: 'playback' keeps sound on when the ring/silent switch is set to silent
      try { const n = root.navigator; if (n && n.audioSession && n.audioSession.type !== 'playback') n.audioSession.type = 'playback'; } catch (_) {}
      // iOS: play a silent buffer inside the gesture
      try { const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0); } catch (_) {}
      return true;
    }
    _build() {
      const c = this.ctx;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
      this.master.connect(comp); comp.connect(c.destination);
      this.mix = c.createGain();                       // everything birds go through here
      this.bus = c.createGain(); this.bus.gain.value = 0;     // chorus fade in/out
      this.preview = c.createGain(); this.preview.gain.value = 1;
      this.bus.connect(this.mix); this.preview.connect(this.mix);
      const dry = c.createGain(); dry.gain.value = 0.85;
      const verb = c.createConvolver(); verb.buffer = this._impulse(2.8);
      const wet = c.createGain(); wet.gain.value = 0.32;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;  // keep reverb airy
      this.mix.connect(dry); dry.connect(this.master);
      this.mix.connect(hp); hp.connect(verb); verb.connect(wet); wet.connect(this.master);
      this._applyVolume();
    }
    _impulse(secs) {
      const c = this.ctx, rate = c.sampleRate, len = Math.floor(rate * secs);
      const buf = c.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch); let lp = 0;
        const pre = Math.floor(rate * (0.012 + ch * 0.007));
        for (let i = pre; i < len; i++) {
          const x = (i - pre) / (len - pre);
          lp += 0.28 * ((Math.random() * 2 - 1) - lp);           // darker, foresty tail
          d[i] = lp * Math.pow(1 - x, 2.6) * (1 + 0.6 * Math.exp(-x * 40));
        }
      }
      return buf;
    }
    setVolume(v) { this.volume = v; this._applyVolume(); }
    setMuted(m) { this.muted = m; this._applyVolume(); }
    _applyVolume() {
      if (!this.ctx) return;
      const g = this.muted ? 0 : Math.pow(this.volume, 1.6) * 0.9;
      this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.06);
    }
    /* level 0..1 while calm; active=false fades the chorus out */
    setState(active, level) {
      this.activity = level || 0;
      if (!this.ctx) { this.active = active; return; }
      if (active !== this.active) {
        const now = this.ctx.currentTime;
        this.bus.gain.cancelScheduledValues(now);
        this.bus.gain.setValueAtTime(this.bus.gain.value, now);
        this.bus.gain.setTargetAtTime(active ? 1 : 0, now, active ? 0.9 : 1.1);
        if (active) this.voices.forEach((v) => (v.next = now + rand(0.2, 2.5)));
      }
      this.active = active;
    }
    _voice(i) {
      if (!this.voices[i]) {
        const used = this.voices.map((v) => v.species);
        const free = SPECIES.filter((s) => used.indexOf(s) < 0);
        const pan = [-0.55, 0.6, -0.2, 0.3, -0.85, 0.85, 0][i % 7] + rand(-0.1, 0.1);
        const c = this.ctx;
        const p = c.createStereoPanner ? c.createStereoPanner() : null;
        const g = c.createGain(); g.gain.value = rand(0.65, 1);
        if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(this.bus); } else g.connect(this.bus);
        this.voices[i] = { species: pick(free.length ? free : SPECIES), pitch: rand(0.92, 1.1), out: g, pan, next: c.currentTime + rand(0.3, 3) };
      }
      return this.voices[i];
    }
    /* call ~5x per second */
    tick() {
      if (!this.ready || !this.active) return;
      const now = this.ctx.currentTime, lvl = this.activity;
      const count = 1 + Math.round(lvl * 4);
      for (let i = 0; i < count; i++) {
        const v = this._voice(i);
        if (now >= v.next - 0.15) {
          const t = Math.max(now + 0.05, v.next);
          const dur = this.sing(v.species, v.out, t, v.pitch, 1);
          const gap = (7.5 - 5.8 * lvl) * rand(0.7, 1.45);
          v.next = t + dur + gap;
          this.songs++;
          if (this.onSong) this.onSong(v);
        }
      }
    }
    previewSong() {
      if (!this.unlock()) return;
      const sp = pick(SPECIES);
      const c = this.ctx; const p = c.createStereoPanner ? c.createStereoPanner() : null;
      const g = c.createGain(); g.gain.value = 1;
      if (p) { p.pan.value = rand(-0.5, 0.5); g.connect(p); p.connect(this.preview); } else g.connect(this.preview);
      const dur = this.sing(sp, g, c.currentTime + 0.08, rand(0.95, 1.08), 1);
      setTimeout(() => { try { g.disconnect(); if (p) p.disconnect(); } catch (_) {} }, (dur + 0.6) * 1000);
      return sp;
    }

    /* ---- primitive: one swept note ---- */
    note(dest, t, dur, points, mul, amp, opt) {
      opt = opt || {};
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      const fc = curve(points, mul);
      o.frequency.value = fc[0];
      o.frequency.setValueCurveAtTime(fc, t, dur);
      g.gain.value = 0;
      g.gain.setValueCurveAtTime(envelope(32, opt.attack).map((x) => x * amp), t, dur);
      o.connect(g); g.connect(dest);
      let h = null, hg = null, lfo = null;
      if (opt.harm) {          // a touch of 2nd harmonic for a less "electronic" timbre
        h = c.createOscillator(); hg = c.createGain(); h.type = 'sine';
        const f2 = fc.map((f) => Math.min(f * 2, 16000));
        h.frequency.value = f2[0]; h.frequency.setValueCurveAtTime(f2, t, dur);
        hg.gain.value = 0; hg.gain.setValueCurveAtTime(envelope(32, opt.attack).map((x) => x * amp * opt.harm), t, dur);
        h.connect(hg); hg.connect(dest); h.start(t); h.stop(t + dur + 0.02);
      }
      if (opt.vib) {           // trill/warble frequency modulation
        lfo = c.createOscillator(); const lg = c.createGain();
        lfo.frequency.value = opt.vib[0]; lg.gain.value = opt.vib[1] * mul;
        lfo.connect(lg); lg.connect(o.frequency); if (h) lg.connect(h.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.02);
      }
      o.start(t); o.stop(t + dur + 0.02);
      o.onended = () => { o.disconnect(); g.disconnect(); if (h) { h.disconnect(); hg.disconnect(); } if (lfo) lfo.disconnect(); };
    }

    /* ---- species-like songs; return duration in seconds ---- */
    sing(species, dest, t0, p, a) {
      const A = 0.5 * a; let t = t0;
      switch (species) {
        case 'robin': {        // cheerily, cheer-up: 3-6 caroled up-down notes
          const n = 3 + ((Math.random() * 4) | 0);
          const shapes = [[[0, 2300], [0.45, 3300], [1, 2600]], [[0, 3200], [0.5, 2450], [1, 2950]], [[0, 3500], [1, 2500]], [[0, 2500], [0.6, 3400], [1, 3100]]];
          for (let i = 0; i < n; i++) {
            const d = rand(0.13, 0.2);
            this.note(dest, t, d, pick(shapes), p * rand(0.93, 1.08), A * rand(0.75, 1), { harm: 0.08 });
            t += d + rand(0.06, 0.12);
          }
          break;
        }
        case 'chickadee': {    // fee-bee whistle
          this.note(dest, t, 0.36, [[0, 3950], [0.8, 3900], [1, 3830]], p, A * 0.8, { attack: 0.2 });
          t += 0.44;
          if (Math.random() < 0.4) {
            this.note(dest, t, 0.17, [[0, 3350], [1, 3300]], p, A * 0.7, { attack: 0.25 }); t += 0.21;
            this.note(dest, t, 0.2, [[0, 3320], [1, 3230]], p, A * 0.65, { attack: 0.2 }); t += 0.2;
          } else { this.note(dest, t, 0.42, [[0, 3360], [0.5, 3310], [1, 3230]], p, A * 0.72, { attack: 0.2, vib: [7, 12] }); t += 0.42; }
          break;
        }
        case 'finch': {        // rapid descending trill that speeds up slightly
          const n = 10 + ((Math.random() * 9) | 0);
          let iv = rand(0.065, 0.08); const base = rand(0.95, 1.1);
          for (let i = 0; i < n; i++) {
            const env = Math.sin(Math.PI * (i + 1) / (n + 1));
            this.note(dest, t, 0.038, [[0, 5200], [1, 3300]], p * base * (1 + 0.004 * i), A * (0.35 + 0.6 * env), { attack: 0.08 });
            t += iv; iv *= 0.985;
          }
          break;
        }
        case 'cardinal': {     // cheer cheer cheer + fast "purty" notes
          const n = 3 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n; i++) { this.note(dest, t, 0.22, [[0, 4300], [0.18, 4150], [1, 1900]], p, A * 0.9, { attack: 0.06, harm: 0.05 }); t += 0.33; }
          if (Math.random() < 0.7) {
            const m = 4 + ((Math.random() * 4) | 0);
            for (let i = 0; i < m; i++) { this.note(dest, t, 0.085, [[0, 2100], [0.5, 3300], [1, 2300]], p, A * 0.75, { attack: 0.2 }); t += 0.12; }
          }
          break;
        }
        case 'thrush': {       // ee-oh-lay flute phrase with a shimmering flourish
          const base = pick([[2000, 2550, 3250], [2250, 2900, 2450], [1900, 2400, 3050]]);
          base.forEach((f) => { this.note(dest, t, 0.2, [[0, f * 0.97], [0.3, f], [1, f * 0.99]], p, A * 0.85, { harm: 0.22, vib: [11, 18], attack: 0.18 }); t += 0.22; });
          const m = 5 + ((Math.random() * 4) | 0);
          for (let i = 0; i < m; i++) { this.note(dest, t, 0.028, [[0, i % 2 ? 4600 : 5500], [1, i % 2 ? 5300 : 4700]], p, A * 0.45, { attack: 0.1 }); t += 0.036; }
          t += 0.05;
          break;
        }
        case 'sparrow': {      // 2-3 clear intro notes then a buzzy trill
          const k = 2 + ((Math.random() * 2) | 0);
          for (let i = 0; i < k; i++) { this.note(dest, t, 0.16, [[0, 2900], [1, 2800]], p, A * 0.8, { attack: 0.15 }); t += 0.24; }
          this.note(dest, t, 0.55, [[0, 4200], [1, 3600]], p, A * 0.55, { vib: [48, 380], attack: 0.1 }); t += 0.62;
          this.note(dest, t, 0.09, [[0, 3100], [1, 2500]], p, A * 0.6); t += 0.12;
          this.note(dest, t, 0.09, [[0, 3000], [1, 2400]], p, A * 0.5); t += 0.1;
          break;
        }
        default: {             // warbler: bright up-chirps
          const n = 2 + ((Math.random() * 4) | 0);
          for (let i = 0; i < n; i++) { this.note(dest, t, 0.07, [[0, 2700], [1, 5600]], p * rand(0.95, 1.05), A * 0.7, { attack: 0.3 }); t += 0.1; }
          this.note(dest, t, 0.16, [[0, 5800], [0.5, 6300], [1, 4200]], p, A * 0.55, { attack: 0.2 }); t += 0.16;
        }
      }
      return t - t0;
    }
  }
  root.BirdChorus = BirdChorus;
})(typeof self !== 'undefined' ? self : this);

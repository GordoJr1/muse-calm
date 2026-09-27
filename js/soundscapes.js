/* Background soundscapes + singing-bowl chimes, synthesised with Web Audio (no audio files).
 * Scenes: ocean, beach, rainforest, rain, binaural (alpha/theta/delta), tone432, tone528.
 * Each scene = persistent loops + events scheduled ahead by schedule(from, to), so the same
 * code runs live (lookahead pump) and offline (OfflineAudioContext render for testing). */
(function (root) {
  'use strict';
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[(Math.random() * a.length) | 0];

  function shape(n, fn) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(i / (n - 1)); return a; }

  /* seamless looping noise buffers (tail crossfaded into the head) */
  function noiseBuffer(ctx, kind, secs) {
    const sr = ctx.sampleRate, N = Math.floor(sr * secs), F = Math.floor(sr * 0.5);
    const buf = ctx.createBuffer(2, N, sr);
    for (let ch = 0; ch < 2; ch++) {
      const a = new Float32Array(N + F);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (let i = 0; i < N + F; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'white') a[i] = w;
        else if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
        } else { last = (last + 0.02 * w) / 1.02; a[i] = last; }
      }
      const d = buf.getChannelData(ch);
      for (let i = 0; i < N; i++) d[i] = a[i];
      for (let i = 0; i < F; i++) { const x = (i / F) * Math.PI / 2; d[i] = a[N + i] * Math.cos(x) + a[i] * Math.sin(x); }   // equal-power seam
      let e = 0; for (let i = 0; i < N; i++) e += d[i] * d[i];
      const g = 0.25 / Math.sqrt(e / N);
      for (let i = 0; i < N; i++) d[i] *= g;
    }
    return buf;
  }
  function impulse(ctx, secs, damp) {
    const sr = ctx.sampleRate, len = Math.floor(sr * secs), buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let lp = 0; const pre = Math.floor(sr * (0.015 + 0.008 * ch));
      for (let i = pre; i < len; i++) { const x = (i - pre) / (len - pre); lp += damp * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.pow(1 - x, 3); }
    }
    return buf;
  }

  function release(nodes) { if (nodes) nodes.forEach((n) => { try { n.disconnect(); } catch (_) {} }); }
  /* per-scene helper: node bookkeeping, loops, slow random LFOs ("wander"), event streams */
  function Scene(eng, out) {
    const ctx = eng.ctx, persistent = [], wanders = [], streams = [];
    const S = {
      ctx, out, eng, dead: false,
      gain(v, dest) { const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; },
      filter(type, f, q, dest) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; if (dest) b.connect(dest); return b; },
      pan(p, dest) { const n = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (n.pan) n.pan.value = p; if (dest) n.connect(dest); return n; },
      loop(kind, dest, t) {
        const s = ctx.createBufferSource(); s.buffer = eng.noise[kind]; s.loop = true;
        s.connect(dest); s.start(t || ctx.currentTime, Math.random() * (s.buffer.duration - 1)); persistent.push(s); return s;
      },
      osc(type, f, dest, t) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); o.start(t || ctx.currentTime); persistent.push(o); return o; },
      wander(param, lo, hi, pmin, pmax) { param.value = (lo + hi) / 2; wanders.push({ param, lo, hi, pmin, pmax, next: ctx.currentTime }); },
      every(imin, imax, fn, first) { streams.push({ imin, imax, fn, next: ctx.currentTime + (first === undefined ? rand(0, imin) : first) }); },
      /* one-shot noise burst through a filter chain; returns its gain for envelope */
      /* extra: per-event nodes (panners, filters, sends) to release together with this event */
      burst(kind, t, dur, dest, extra) {
        const s = ctx.createBufferSource(); s.buffer = eng.noise[kind];
        const g = ctx.createGain(); g.gain.value = 0; s.connect(g); g.connect(dest);
        s.loop = true; s.start(t, Math.random() * (s.buffer.duration - 0.05)); s.stop(t + dur + 0.05);
        s.onended = () => { s.disconnect(); g.disconnect(); release(extra); };
        return g;
      },
      tone(type, t, dur, dest, extra) {
        const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = 0;
        o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.05);
        o.onended = () => { o.disconnect(); g.disconnect(); release(extra); };
        return { o, g };
      },
      schedule(from, to) {
        if (S.dead) return;
        for (const w of wanders) while (w.next < to) { const p = rand(w.pmin, w.pmax); w.param.setTargetAtTime(rand(w.lo, w.hi), Math.max(w.next, from), p / 3); w.next += p; }
        for (const st of streams) while (st.next < to) { if (st.next >= from - 0.05) st.fn(Math.max(st.next, from)); st.next += rand(st.imin, st.imax); }
      },
      stop() { S.dead = true; persistent.forEach((n) => { try { n.stop(); } catch (_) {} try { n.disconnect(); } catch (_) {} }); },
    };
    return S;
  }

  /* ---------------- scene recipes ---------------- */
  function wave(S, t, dest, o) {
    const D = rand(o.dmin, o.dmax), tc = rand(0.3, 0.42), amp = rand(0.55, 1) * o.level;
    const env = shape(64, (x) => (x < tc ? Math.pow(x / tc, 1.8) : Math.exp(-3.2 * (x - tc) / (1 - tc)) * Math.pow(1 - (x - tc) / (1 - tc), 0.6)));
    const p = S.pan(rand(-0.45, 0.45), dest);
    const lp = S.filter('lowpass', 200, 0.5, p);
    const g = S.burst('pink', t, D, lp, [lp]);
    g.gain.setValueCurveAtTime(env.map((v) => v * amp), t, D);
    const peak = rand(o.fmin, o.fmax);
    lp.frequency.setValueCurveAtTime(env.map((v) => 160 + peak * Math.pow(v, 1.3)), t, D);
    // foam / wash hiss after the crest
    const hp = S.filter('highpass', 1400, 0.5), lp2 = S.filter('lowpass', 5200, 0.4, p); hp.connect(lp2);
    const gw = S.burst('white', t, D, hp, [hp, lp2, p]);
    gw.gain.setValueCurveAtTime(shape(64, (x) => { const u = (x - tc + 0.06) / 0.5; return u <= 0 || u >= 1 ? 0 : Math.pow(Math.sin(Math.PI * Math.pow(u, 0.6)), 2); }).map((v) => v * amp * o.foam), t, D);
  }
  function bed(S, dest, cut, level) {
    const lp = S.filter('lowpass', cut, 0.6, dest), g = S.gain(level, lp); S.loop('brown', g);
    S.wander(g.gain, level * 0.6, level * 1.3, 8, 16);
  }
  function drip(S, t, dest, level) {       // water drop on a leaf / roof: tiny downward-pitched sine
    const f = rand(1600, 3600), d = rand(0.03, 0.06);
    const p = S.pan(rand(-0.8, 0.8), dest), { o, g } = S.tone('sine', t, d, p, [p]);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.62, t + d);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level * rand(0.4, 1), t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + d);
  }
  function grain(S, t, dest, level) {      // rain grain: short band-passed noise tick
    const p = S.pan(rand(-0.9, 0.9), dest), bp = S.filter('bandpass', rand(1800, 5500), rand(1.5, 4), p);
    const d = rand(0.006, 0.018), g = S.burst('white', t, d, bp, [bp, p]);
    g.gain.setValueAtTime(level * rand(0.3, 1), t); g.gain.exponentialRampToValueAtTime(0.0005, t + d);
  }
  function rainBody(S, dest, level, hp, lp) {
    const f2 = S.filter('lowpass', lp, 0.4, dest), f1 = S.filter('highpass', hp, 0.5, f2);
    const shelf = S.filter('highshelf', 3500, undefined); shelf.gain.value = -6; shelf.connect(f1);
    const g = S.gain(level, shelf); S.loop('pink', g);
    S.wander(g.gain, level * 0.75, level * 1.15, 12, 25);
  }
  function gull(S, t, dest) {
    const n = 2 + ((Math.random() * 3) | 0), base = rand(0.9, 1.15), p = S.pan(rand(-0.9, 0.9));
    const lp = S.filter('lowpass', 2600, 0.5, p), bp = S.filter('bandpass', 1500, 0.9, lp);
    p.connect(dest); const send = S.gain(0.8, S.eng.verbIn); p.connect(send);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const d = rand(0.28, 0.42), last = i === n - 1, { o, g } = S.tone('triangle', tt, d, bp, last ? [bp, lp, p, send] : null);
      o.frequency.setValueCurveAtTime(shape(24, (x) => base * (1050 + 650 * Math.sin(Math.PI * Math.min(1, x * 1.6)) - 250 * x)), tt, d);
      const vib = S.ctx.createOscillator(), vg = S.ctx.createGain(); vib.frequency.value = 22; vg.gain.value = 18; vib.connect(vg); vg.connect(o.frequency); vib.start(tt); vib.stop(tt + d); vib.onended = () => { vib.disconnect(); vg.disconnect(); };
      g.gain.setValueCurveAtTime(shape(24, (x) => Math.pow(Math.sin(Math.PI * x), 0.8) * 0.05), tt, d);
      tt += d + rand(0.12, 0.3);
    }
  }
  function cricket(S, t, dest, level, f, pan) {
    const p = S.pan(pan, dest);
    for (let k = 0; k < 3; k++) {
      const tt = t + k * 0.045, { o, g } = S.tone('sine', tt, 0.025, p, k === 2 ? [p] : null); o.frequency.value = f;
      g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(level, tt + 0.006); g.gain.linearRampToValueAtTime(0, tt + 0.025);
    }
  }
  function frog(S, t, dest) {
    const n = 2 + ((Math.random() * 4) | 0), f = rand(330, 520), p = S.pan(rand(-0.8, 0.8), dest), lp = S.filter('lowpass', 1400, 0.7, p);
    for (let i = 0; i < n; i++) {
      const tt = t + i * rand(0.45, 0.7), d = 0.16, { o, g } = S.tone('triangle', tt, d, lp, i === n - 1 ? [lp, p] : null);
      o.frequency.setValueCurveAtTime(shape(8, (x) => f * (1 + 0.12 * Math.sin(Math.PI * x))), tt, d);
      g.gain.setValueCurveAtTime(shape(48, (x) => Math.pow(Math.sin(Math.PI * x), 0.5) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * x)) * 0.035), tt, d);
    }
  }
  function forestBird(S, t, dest) {          // distant, reverberant, lower & slower than reward birds
    const p = S.pan(rand(-0.9, 0.9)), lp = S.filter('lowpass', 2200, 0.5, p);
    const send = S.gain(1.1, S.eng.verbIn); p.connect(dest); p.connect(send);
    const chain = [lp, p, send];
    if (Math.random() < 0.5) {               // dove-like "hoo HOOO hoo hoo"
      const f = rand(420, 560), pat = [[0.25, 1], [0.6, 1.05], [0.3, 0.97], [0.3, 0.95]]; let tt = t;
      pat.forEach(([d, m], i) => { const { o, g } = S.tone('sine', tt, d, lp, i === pat.length - 1 ? chain : null); o.frequency.setValueCurveAtTime(shape(12, (x) => f * m * (1 - 0.06 * x)), tt, d); g.gain.setValueCurveAtTime(shape(24, (x) => Math.pow(Math.sin(Math.PI * x), 1.2) * 0.07), tt, d); tt += d + (i === 0 ? 0.08 : 0.18); });
    } else {                                 // tinamou-like slow rising whistles
      const f = rand(900, 1200), n = 3 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) { const tt = t + i * 1.1, d = 0.7, { o, g } = S.tone('sine', tt, d, lp, i === n - 1 ? chain : null); o.frequency.setValueCurveAtTime(shape(12, (x) => f * (1 + 0.07 * i) * (1.05 - 0.12 * x)), tt, d); g.gain.setValueCurveAtTime(shape(24, (x) => Math.pow(Math.sin(Math.PI * x), 1.5) * 0.045), tt, d); }
    }
  }
  function pinkBed(S, dest) {
    const lp = S.filter('lowpass', 1600, 0.5, dest), g = S.gain(0, lp); S.loop('pink', g);
    S.bed = g; S.bedLevel = 0.14; if (S.eng.pinkBed) g.gain.value = S.bedLevel;
  }

  const SCENES = {
    ocean(S) {
      const o = S.out; bed(S, o, 320, 0.22);
      S.every(6.5, 11, (t) => wave(S, t, o, { dmin: 7, dmax: 10, fmin: 1300, fmax: 2400, level: 0.55, foam: 0.3 }), 0.1);
    },
    beach(S) {
      const o = S.out; bed(S, o, 260, 0.18);
      S.every(8.5, 14, (t) => wave(S, t, o, { dmin: 8, dmax: 12, fmin: 800, fmax: 1500, level: 0.42, foam: 0.18 }), 0.1);
      const wbp = S.filter('bandpass', 600, 0.8, o), wg = S.gain(0.06, wbp); S.loop('pink', wg);   // light wind
      S.wander(wbp.frequency, 380, 950, 5, 11); S.wander(wg.gain, 0.02, 0.1, 6, 14);
      S.every(18, 40, (t) => gull(S, t, o), 6);
    },
    rain(S) {
      const o = S.out; rainBody(S, o, 0.32, 380, 4800); bed(S, o, 220, 0.1);
      S.every(0.02, 0.07, (t) => grain(S, t, o, 0.05));
      S.every(0.5, 1.6, (t) => drip(S, t, o, 0.035));
    },
    rainforest(S) {
      const o = S.out; rainBody(S, o, 0.3, 300, 3400);
      S.every(0.15, 0.5, (t) => drip(S, t, o, 0.03));
      // cicada-like shimmer: narrow noise band, amplitude-pulsed, slowly swelling
      [[5200, 38, -0.4], [6600, 27, 0.5]].forEach(([f, am, pan]) => {
        const p = S.pan(pan, o), sw = S.gain(0.0, p), pulse = S.gain(0.5, sw), bp = S.filter('bandpass', f, 9, pulse);
        const n = S.gain(1, bp); S.loop('white', n);
        const lfo = S.osc('sine', am, S.gain(0.5, pulse.gain)); lfo.detune.value = 0;
        S.wander(sw.gain, 0.0, 0.16, 7, 16);
      });
      const cr = [[4300, -0.6], [4700, 0.55]];
      cr.forEach(([f, pan]) => S.every(0.85, 1.3, (t) => { if (Math.sin(t / 9 + f) > -0.2) cricket(S, t, o, 0.012, f, pan); }));
      S.every(6, 16, (t) => frog(S, t, o), 3);
      S.every(11, 24, (t) => forestBird(S, t, o), 5);
    },
    binaural(S, beat) {
      const o = S.out, merger = S.ctx.createChannelMerger(2), g = S.gain(1, o); merger.connect(g);
      const l = S.gain(0.11), r = S.gain(0.11); l.connect(merger, 0, 0); r.connect(merger, 0, 1);
      S.osc('sine', 200, l); S.osc('sine', 200 + beat, r);
      S.wander(g.gain, 0.85, 1.05, 10, 20);
      pinkBed(S, o);
    },
    tone(S, f) {
      const o = S.out, lp = S.filter('lowpass', 1800, 0.5, o), g = S.gain(1, lp);
      [[1, 0.075], [0.5, 0.06], [1.5, 0.018], [2, 0.012]].forEach(([m, a]) => { S.osc('sine', f * m, S.gain(a, g)); S.osc('sine', f * m + rand(0.06, 0.2), S.gain(a * 0.3, g)); });   // gentle, unsynchronised shimmer
      S.wander(g.gain, 0.75, 1.05, 8, 16);
      pinkBed(S, o);
    },
  };
  const DEFS = {
    ocean: (S) => SCENES.ocean(S), beach: (S) => SCENES.beach(S), rainforest: (S) => SCENES.rainforest(S), rain: (S) => SCENES.rain(S),
    alpha: (S) => SCENES.binaural(S, 10), theta: (S) => SCENES.binaural(S, 6), delta: (S) => SCENES.binaural(S, 2),
    tone432: (S) => SCENES.tone(S, 432), tone528: (S) => SCENES.tone(S, 528),
  };

  class Soundscapes {
    constructor() { this.ctx = null; this.volume = 0.5; this.chimeVolume = 0.6; this.muted = false; this.pinkBed = false; this.current = null; this.id = 'none'; this.old = []; }
    get playing() { return !!this.current; }
    init(ctx) {
      if (this.ctx) return;
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.3;
      comp.connect(ctx.destination);
      this.master = ctx.createGain(); this.master.connect(comp);
      this.out = ctx.createGain(); this.out.connect(this.master);
      const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 3.2, 0.2);
      this.verbIn = ctx.createGain(); const vo = ctx.createGain(); vo.gain.value = 0.5;
      this.verbIn.connect(verb); verb.connect(vo); vo.connect(this.master);
      // chimes: own level ("birds & bells" volume) and a long bowl reverb
      this.chimeMaster = ctx.createGain(); this.chimeMaster.connect(comp);
      this.chimeBus = ctx.createGain(); const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 4.5, 0.12);
      const cwet = ctx.createGain(); cwet.gain.value = 0.35;
      this.chimeBus.connect(this.chimeMaster); this.chimeBus.connect(cv); cv.connect(cwet); cwet.connect(this.chimeMaster);
      this.noise = { white: noiseBuffer(ctx, 'white', 6), pink: noiseBuffer(ctx, 'pink', 8), brown: noiseBuffer(ctx, 'brown', 8) };
      this._apply();
      if (typeof ctx.startRendering !== 'function') this.timer = setInterval(() => this.pump(), 250);
    }
    pump(horizon) {
      if (!this.ctx || (this.ctx.state !== 'running' && !horizon)) return;
      const to = horizon || this.ctx.currentTime + 1.5;
      const now = this.ctx.currentTime;
      [this.current].concat(this.old).forEach((sc) => { if (sc && !sc.dead && sc.schedTo < to) { sc.schedule(Math.max(sc.schedTo, now), to); sc.schedTo = to; } });
    }
    setVolume(v) { this.volume = v; this._apply(); }
    setChimeVolume(v) { this.chimeVolume = v; this._apply(); }
    setMuted(m) { this.muted = m; this._apply(); }
    _apply() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.muted ? 0 : Math.pow(this.volume, 1.5) * 1.2, t, 0.08);
      this.chimeMaster.gain.setTargetAtTime(this.muted ? 0 : Math.pow(this.chimeVolume, 1.2) * 1.1, t, 0.08);
    }
    setPinkBed(on) {
      this.pinkBed = on;
      if (this.current && this.current.bed) this.current.bed.gain.setTargetAtTime(on ? this.current.bedLevel : 0, this.ctx.currentTime, 0.6);
    }
    select(id, fade) {
      if (fade === undefined) fade = 3;
      if (!this.ctx) { this.id = id; return; }
      if (id === this.id && this.current) return;
      this._stopCurrent(fade);
      this.id = id;
      if (!DEFS[id]) return;
      const t = this.ctx.currentTime, g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + Math.max(0.05, fade)); g.connect(this.out);
      const S = Scene(this, g); DEFS[id](S);
      S.fader = g; S.schedTo = t;
      this.current = S;
      this.pump(this.ctx.state === 'running' ? undefined : t + 1.5);
    }
    _stopCurrent(fade) {
      const S = this.current; if (!S) return;
      this.current = null; this.old.push(S);
      const t = this.ctx.currentTime, g = S.fader.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + Math.max(0.05, fade));
      setTimeout(() => { S.stop(); try { S.fader.disconnect(); } catch (_) {} this.old = this.old.filter((x) => x !== S); }, (fade + 0.5) * 1000);
    }
    /* stop playback but remember the choice (e.g. after a session ends) */
    fadeOut(sec) { this._stopCurrent(sec); }

    /* ---- singing bowl ---- */
    bowl(t, f0, amp) {
      const c = this.ctx, parts = [[1, 1, 16], [2.71, 0.45, 9], [5.15, 0.22, 5.5], [8.43, 0.1, 3.2], [12.1, 0.04, 2]];
      amp *= 0.3;
      parts.forEach(([ratio, a, decay], i) => {
        [-1, 1].forEach((side) => {
          const o = c.createOscillator(), g = c.createGain(), f = f0 * ratio + side * rand(0.3, 0.9) * (i + 1) * 0.5;
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp * a * 0.5, t + 0.006 + i * 0.002);
          g.gain.setTargetAtTime(0, t + 0.01, decay / 4.5);
          o.connect(g); g.connect(this.chimeBus); o.start(t); o.stop(t + decay * 2.2);
          o.onended = () => { o.disconnect(); g.disconnect(); };
        });
      });
      // soft mallet contact
      const s = c.createBufferSource(); s.buffer = this.noise.pink; const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0 * 6; bp.Q.value = 1.2;
      const g = c.createGain(); g.gain.setValueAtTime(amp * 0.25, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      s.connect(bp); bp.connect(g); g.connect(this.chimeBus); s.start(t, 1); s.stop(t + 0.08); s.onended = () => { s.disconnect(); g.disconnect(); };
    }
    chime(kind, at) {
      if (!this.ctx) return 0;
      const t = (at || this.ctx.currentTime) + 0.05;
      if (kind === 'start') { this.bowl(t, 220, 0.5); return 4; }
      if (kind === 'interval') { this.bowl(t, 262, 0.3); return 3; }
      this.bowl(t, 220, 0.5); this.bowl(t + 3.2, 220, 0.42); this.bowl(t + 6.4, 196, 0.38);   // end: three strikes
      return 7;
    }
  }
  Soundscapes.SCENE_IDS = Object.keys(DEFS);
  root.Soundscapes = Soundscapes;
})(typeof self !== 'undefined' ? self : this);

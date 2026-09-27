/* Timed meditation sessions: timer with pause/resume and interval bells, per-session stats,
 * history + preferences + baseline persistence. Browser: window.Session, Node: module.exports. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.Session = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* All times in seconds on a caller-supplied monotonic clock. */
  class SessionTimer {
    constructor(durationSec, bellEveryMin) {
      this.duration = Math.max(1, durationSec);
      this.bellEvery = bellEveryMin > 0 ? bellEveryMin * 60 : 0;
      this.state = 'idle'; this.acc = 0; this.since = null; this.nextBell = this.bellEvery || Infinity;
    }
    start(now) { if (this.state !== 'idle') return; this.state = 'running'; this.since = now; }
    pause(now) { if (this.state !== 'running') return; this.acc += now - this.since; this.since = null; this.state = 'paused'; }
    resume(now) { if (this.state !== 'paused') return; this.since = now; this.state = 'running'; }
    end(now) { if (this.state === 'running') this.acc += now - this.since; this.since = null; this.acc = Math.min(this.acc, this.duration); this.state = 'done'; }
    elapsed(now) { return Math.min(this.duration, this.acc + (this.state === 'running' ? now - this.since : 0)); }
    remaining(now) { return Math.max(0, this.duration - this.elapsed(now)); }
    progress(now) { return this.elapsed(now) / this.duration; }
    /* returns events since last tick: 'bell' for each interval crossed (not at the very end), 'complete' */
    tick(now) {
      const ev = [];
      if (this.state !== 'running') return ev;
      const e = this.elapsed(now);
      while (e >= this.nextBell && this.nextBell < this.duration - 0.5) { ev.push('bell'); this.nextBell += this.bellEvery; }
      if (e >= this.duration) { this.end(now); ev.push('complete'); }
      return ev;
    }
  }

  /* Accumulates calm/HR stats. Time where scoring is paused (poor contact, artifacts,
   * calibration) is neither counted as calm nor as not-calm. */
  class SessionStats {
    constructor(threshold, seriesStep) {
      this.threshold = threshold; this.step = seriesStep || 5;
      this.active = 0; this.scoredT = 0; this.calmT = 0; this.streak = 0; this.longest = 0;
      this.excludedT = 0; this.calibT = 0; this.baselineDone = false;
      this.hrSum = 0; this.hrT = 0; this.hrMin = null; this.songs = 0; this.peak = null;
      this.series = []; this._acc = 0; this._scoreAcc = 0; this._scoreN = 0; this._cal = false;
    }
    /* s: {scoring, calibrating, excluded, score, bpm} */
    add(dt, s) {
      this.active += dt;
      if (s.calibrating) this.calibT += dt; else this.baselineDone = true;
      if (s.excluded) this.excludedT += dt;
      if (s.scoring && !s.calibrating && s.score !== null && s.score !== undefined) {
        this.scoredT += dt;
        if (s.score >= this.threshold) { this.calmT += dt; this.streak += dt; this.longest = Math.max(this.longest, this.streak); }
        else this.streak = 0;
        this.peak = this.peak === null ? s.score : Math.max(this.peak, s.score);
        this._scoreAcc += s.score * dt; this._scoreN += dt;
      }
      if (s.bpm) { this.hrSum += s.bpm * dt; this.hrT += dt; this.hrMin = this.hrMin === null ? s.bpm : Math.min(this.hrMin, s.bpm); }
      this._cal = this._cal || !!s.calibrating;
      this._acc += dt;
      while (this._acc >= this.step) {
        this._acc -= this.step;
        this.series.push({ v: this._scoreN > 0 ? +(this._scoreAcc / this._scoreN).toFixed(1) : null, cal: this._cal });
        this._scoreAcc = 0; this._scoreN = 0; this._cal = false;
      }
    }
    summary() {
      return {
        duration: Math.round(this.active), calmT: Math.round(this.calmT), scoredT: Math.round(this.scoredT),
        calmShare: this.scoredT > 0 ? this.calmT / this.scoredT : null, longest: Math.round(this.longest),
        avgHr: this.hrT > 3 ? Math.round(this.hrSum / this.hrT) : null, minHr: this.hrMin !== null && this.hrT > 3 ? Math.round(this.hrMin) : null,
        peak: this.peak !== null ? Math.round(this.peak) : null, songs: this.songs, excludedT: Math.round(this.excludedT),
        threshold: this.threshold, step: this.step, series: this.series.slice(),
        baselineT: Math.round(this.calibT), baselineDone: this.baselineDone,
      };
    }
  }

  function downsample(series, max) {
    if (series.length <= max) return series.map((p) => (p.v === null ? null : Math.round(p.v)));
    const out = [], k = series.length / max;
    for (let i = 0; i < max; i++) {
      const a = Math.floor(i * k), b = Math.floor((i + 1) * k); let s = 0, n = 0;
      for (let j = a; j < b; j++) if (series[j].v !== null) { s += series[j].v; n++; }
      out.push(n ? Math.round(s / n) : null);
    }
    return out;
  }

  /* ---- 40 s baseline at the start of every session ----
   * Decides whether an analysis frame may go into the baseline. Only clean data counts: progress
   * pauses while a sensor that has been feeding the average has lost contact (poor/off), while the
   * stream is stale, or while the head is moving. Sensors that never had contact this session
   * ("Start anyway") do not block it, and a sensor that stays lost for giveUpSec is no longer
   * waited for. A channel briefly unusable because of a blink keeps its last clean value
   * (ChannelBlend), so blinks do not stall the baseline. */
  class BaselineGuard {
    constructor(giveUpSec) { this.giveUp = giveUpSec || 30; this.reset(); }
    reset() { this.seen = [false, false, false, false]; this.everSeen = [false, false, false, false]; this.lostFor = [0, 0, 0, 0]; this.skipped = []; }
    /* track which sensors had clean data this session (call every frame, also after the baseline) */
    observe(usable) { for (let i = 0; i < 4; i++) if (usable[i]) { this.everSeen[i] = true; if (this.skipped.indexOf(i) < 0) this.seen[i] = true; } }
    /* o: {bl, usable, states, stale, motion}; returns {ok, reason: null|'contact'|'motion'|'nodata', sensors} */
    update(o, dt) {
      const states = o.states || [], usable = o.usable || [];
      this.observe(usable);
      const lost = [];
      for (let i = 0; i < 4; i++) {
        const bad = states[i] === 'poor' || states[i] === 'off';
        if (this.seen[i] && bad) {
          this.lostFor[i] += dt;
          if (this.lostFor[i] > this.giveUp) { this.seen[i] = false; this.skipped.push(i); } else lost.push(i);
        } else this.lostFor[i] = 0;
      }
      if (o.stale) return { ok: false, reason: 'nodata', sensors: [] };
      if (lost.length) return { ok: false, reason: 'contact', sensors: lost };
      if (!o.bl || !o.bl.mean) return { ok: false, reason: 'nodata', sensors: [] };
      if ((o.motion || 0) >= 30) return { ok: false, reason: 'motion', sensors: [] };
      return { ok: true, reason: null, sensors: [] };
    }
    /* contact states for the scoring-dropout monitor: sensors never in contact this session are ignored */
    maskStates(states) { return states.map((q, i) => (this.everSeen[i] ? q : 'good')); }
  }
  /* a session is worth saving once its baseline finished and it lasted at least 20 s */
  function saveable(sum) { return !!(sum && sum.baselineDone && sum.duration >= 20); }

  /* ---- compact per-session timeline ----
   * Samples are time-weighted averages over fixed buckets of active session time (default 2 s).
   * Flags per point: bit 0 = baseline phase, bit 1 = excluded (dropout / artifact / baseline paused). */
  const TL_BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  const TL_KEYS = ['d', 't', 'a', 'b', 'g'];
  class Timeline {
    constructor(step) { this.step = step || 2; this.pts = []; this._new(); }
    _new() { this.acc = 0; this.bw = 0; this.bs = [0, 0, 0, 0, 0]; this.cw = 0; this.cs = 0; this.hw = 0; this.hs = 0; this.baseT = 0; this.exT = 0; }
    /* s: {rel: {delta..gamma}|null, calm: number|null, hr: number|null, baseline: bool, excluded: bool} */
    add(dt, s) {
      if (!(dt > 0)) return;
      while (dt > 1e-9) {                           // split a sample that crosses a bucket edge, so every point spans exactly one step
        const part = Math.min(dt, this.step - this.acc);
        this.acc += part;
        if (s.rel) { this.bw += part; TL_BANDS.forEach((k, i) => { this.bs[i] += part * (+s.rel[k] || 0); }); }
        if (typeof s.calm === 'number' && Number.isFinite(s.calm)) { this.cw += part; this.cs += part * s.calm; }
        if (s.hr) { this.hw += part; this.hs += part * s.hr; }
        if (s.baseline) this.baseT += part;
        if (s.excluded) this.exT += part;
        if (this.acc >= this.step - 1e-9) this._flush();
        dt -= part;
      }
    }
    _flush() {
      if (this.acc <= 0) return;
      this.pts.push({
        rel: this.bw > 0 ? this.bs.map((v) => v / this.bw) : null,
        calm: this.cw > 0 ? this.cs / this.cw : null,
        hr: this.hw > 0 ? this.hs / this.hw : null,
        f: (this.baseT >= this.acc / 2 ? 1 : 0) | (this.exT >= this.acc / 2 ? 2 : 0),
      });
      this._new();
    }
    /* finish the partial bucket (only if it is at least a quarter step long) */
    finish() { if (this.acc >= this.step / 4) this._flush(); else this._new(); return this; }
    /* compact, JSON-friendly columns; merges k consecutive points so n <= maxPts */
    pack(maxPts) {
      maxPts = maxPts || 900;
      const src = this.pts, k = Math.max(1, Math.ceil(src.length / maxPts)), cols = { d: [], t: [], a: [], b: [], g: [], c: [], h: [], f: [] };
      for (let i = 0; i < src.length; i += k) {
        const grp = src.slice(i, i + k), rels = grp.filter((p) => p.rel), cal = grp.filter((p) => p.calm !== null), hrs = grp.filter((p) => p.hr !== null);
        TL_KEYS.forEach((key, j) => cols[key].push(rels.length ? Math.round(1000 * rels.reduce((s, p) => s + p.rel[j], 0) / rels.length) : null));
        cols.c.push(cal.length ? Math.round(cal.reduce((s, p) => s + p.calm, 0) / cal.length) : null);
        cols.h.push(hrs.length ? Math.round(hrs.reduce((s, p) => s + p.hr, 0) / hrs.length) : null);
        const nb = grp.filter((p) => p.f & 1).length, ne = grp.filter((p) => p.f & 2).length;
        cols.f.push((nb * 2 >= grp.length ? 1 : 0) | (ne * 2 >= grp.length ? 2 : 0));
      }
      return Object.assign({ v: 1, step: +(this.step * k).toFixed(3), n: cols.c.length }, cols);
    }
  }
  /* Validates + expands a packed timeline. Returns [{t, rel:{delta..}|null, calm, hr, baseline, excluded}] or null. */
  function unpackTimeline(tl) {
    if (!tl || typeof tl !== 'object' || tl.v !== 1) return null;
    const n = tl.n, step = +tl.step;
    if (!(n > 0) || n > 5000 || !(step > 0)) return null;
    const keys = TL_KEYS.concat(['c', 'h', 'f']);
    if (keys.some((k) => !Array.isArray(tl[k]) || tl[k].length !== n)) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const out = [];
    for (let i = 0; i < n; i++) {
      const b = TL_KEYS.map((k) => num(tl[k][i])), rel = b.every((v) => v !== null) ? {} : null;
      if (rel) TL_BANDS.forEach((k, j) => { rel[k] = b[j] / 1000; });
      const f = num(tl.f[i]) || 0, c = num(tl.c[i]), h = num(tl.h[i]);
      out.push({ t: i * step, rel, calm: c === null ? null : Math.max(0, Math.min(100, c)), hr: h, baseline: !!(f & 1), excluded: !!(f & 2) });
    }
    return out;
  }

  /* ---- persistence (storage injected so Node tests can use a Map) ---- */
  const KEY = 'muse-calm:v2:';
  const HIST_MAX = 50;
  function makeStore(storage, opts) {
    opts = opts || {};
    const TL_BUDGET = opts.tlBudget || 1200000, TL_MAX = opts.tlMax || 40;   // chars across all timelines, count
    const get = (k, d) => { try { const v = storage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } };
    const trySet = (k, v) => { try { storage.setItem(KEY + k, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch (_) { return false; } };
    const set = (k, v) => { trySet(k, v); };
    const del = (k) => { try { storage.removeItem(KEY + k); } catch (_) {} };
    const raw = (k) => { try { return storage.getItem(KEY + k); } catch (_) { return null; } };
    const tlKey = (id) => 'tl-' + id;
    const idOf = (e) => (e && e.id !== undefined ? String(e.id) : e && typeof e.date === 'number' ? String(e.date) : null);
    const history = () => { const h = get('history', []); return Array.isArray(h) ? h.filter((e) => e && typeof e === 'object') : []; };
    /* drop timelines oldest-first until count/size fit (reserve = chars about to be added); returns h */
    function prune(h, reserve, keepId) {
      let count = 0, total = reserve || 0;
      h.forEach((e) => { if (e.tl) { const r = raw(tlKey(idOf(e))); if (r === null) e.tl = false; else { count++; total += r.length; } } });
      for (let i = h.length - 1; i >= 0 && (total > TL_BUDGET || count + (reserve ? 1 : 0) > TL_MAX); i--) {
        const e = h[i]; if (!e.tl || idOf(e) === keepId) continue;
        const r = raw(tlKey(idOf(e))); total -= r ? r.length : 0; count--;
        del(tlKey(idOf(e))); e.tl = false; e.tlPruned = true;
      }
      return h;
    }
    function dropOldestTimeline(h, keepId) {
      for (let i = h.length - 1; i >= 0; i--) { const e = h[i]; if (e.tl && idOf(e) !== keepId) { del(tlKey(idOf(e))); e.tl = false; e.tlPruned = true; return true; } }
      return false;
    }
    function writeHistory(h, keepId) {
      while (!trySet('history', h)) {                                     // quota: free timeline space first, then trim history
        if (dropOldestTimeline(h, keepId)) continue;
        if (h.length > 10) { h.slice(10).forEach((e) => { if (e.tl) del(tlKey(idOf(e))); }); h.length = 10; continue; }
        return false;
      }
      return true;
    }
    return {
      prefs: (defaults) => Object.assign({}, defaults, get('prefs', {})),
      savePrefs: (p) => set('prefs', p),
      history,
      /* Save a finished session. The summary entry is written first (never lost to a big timeline);
       * the timeline is stored under its own key, with oldest-first pruning and QuotaExceeded handling. */
      addSession: (entry, timeline) => {
        const e = Object.assign({}, entry); e.id = idOf(e) || String(Date.now()); e.tl = false;
        let h = history().filter((x) => idOf(x) !== e.id);
        h.unshift(e);
        h.slice(HIST_MAX).forEach((x) => { if (x.tl) del(tlKey(idOf(x))); });
        h = h.slice(0, HIST_MAX);
        const ok = writeHistory(h, e.id);
        let tlSaved = false;
        if (ok && timeline) {
          const json = JSON.stringify(timeline);
          if (json.length <= TL_BUDGET) {
            prune(h, json.length, e.id);
            while (!(tlSaved = trySet(tlKey(e.id), json))) if (!dropOldestTimeline(h, e.id)) break;
          }
          e.tl = tlSaved;
          writeHistory(h, e.id);
        }
        return { saved: ok, timeline: tlSaved, id: e.id };
      },
      addHistory: (entry) => { let h = get('history', []); if (!Array.isArray(h)) h = []; h.unshift(entry); set('history', h.slice(0, HIST_MAX)); return h.slice(0, HIST_MAX); },
      session: (id) => history().find((e) => idOf(e) === String(id)) || null,
      timeline: (id) => { const e = history().find((x) => idOf(x) === String(id)); return e && e.tl ? get(tlKey(String(id)), null) : null; },
      deleteSession: (id) => { id = String(id); const h = history(); const e = h.find((x) => idOf(x) === id); del(tlKey(id)); if (!e) return false; set('history', h.filter((x) => x !== e)); return true; },
      clearHistory: () => { history().forEach((e) => del(tlKey(idOf(e)))); set('history', []); },
      timelineBytes: () => history().reduce((s, e) => { const r = e.tl ? raw(tlKey(idOf(e))) : null; return s + (r ? r.length : 0); }, 0),
      baseline: (kind) => get('baseline-' + kind, null),
      saveBaseline: (kind, b, now) => set('baseline-' + kind, Object.assign({}, b, { t: now })),
    };
  }
  /* Coerce stored preferences back to known values/ranges (older/newer versions, hand edits). */
  function sanitizePrefs(p, defaults, validScapes) {
    const out = Object.assign({}, defaults);
    const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
    out.duration = num(p.duration, 1, 180, defaults.duration);
    out.custom = !!p.custom;
    out.bells = [0, 1, 2, 5, 10].indexOf(Number(p.bells)) >= 0 ? Number(p.bells) : defaults.bells;
    out.soundscape = validScapes.indexOf(p.soundscape) >= 0 ? p.soundscape : defaults.soundscape;
    out.scapeVol = num(p.scapeVol, 0, 100, defaults.scapeVol);
    out.birdVol = num(p.birdVol, 0, 100, defaults.birdVol);
    out.threshold = num(p.threshold, 45, 90, defaults.threshold);
    out.pinkBed = !!p.pinkBed; out.muted = !!p.muted;
    return out;
  }
  function baselineFresh(b, nowMs, maxAgeMs) {
    return !!(b && typeof b.mA === 'number' && typeof b.t === 'number' && nowMs - b.t >= 0 && nowMs - b.t < (maxAgeMs || 3600e3));
  }

  return { SessionTimer, SessionStats, downsample, makeStore, baselineFresh, sanitizePrefs, BaselineGuard, saveable, Timeline, unpackTimeline, TL_BANDS };
});

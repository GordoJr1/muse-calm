/* Muse Calm v2.1: app state, analysis loop, fit gate, timed sessions, soundscapes, UI and rendering. */
(function () {
  'use strict';
  const P = window.MuseProtocol, D = window.DSP, C = window.Charts, K = window.Contact, SN = window.Session;
  const $ = (id) => document.getElementById(id);
  const clamp = D.clamp;
  const params = new URLSearchParams(location.search);
  /* hidden test hook: ?speed=N runs the demo clock N x faster (sessions, calibration, fit check) */
  const SPEED = Math.max(1, Math.min(30, +params.get('speed') || 1));
  /* virtual clock: runs SPEED x only while the demo streams, real time otherwise, and never jumps */
  let clkBase = 0, clkRef = performance.now(), clkRate = 1;
  const vnow = () => clkBase + (performance.now() - clkRef) * clkRate;
  function setClockRate(r) { const p = performance.now(); clkBase += (p - clkRef) * clkRate; clkRef = p; clkRate = r; }

  const CH_COLORS = ['#7dd3fc', '#a78bfa', '#f0abfc', '#5eead4'].map(C.hex);
  const BANDS = [
    { key: 'delta', sym: 'δ', name: 'Delta', hex: '#818cf8' },
    { key: 'theta', sym: 'θ', name: 'Theta', hex: '#60a5fa' },
    { key: 'alpha', sym: 'α', name: 'Alpha', hex: '#34d399' },
    { key: 'beta', sym: 'β', name: 'Beta', hex: '#fbbf24' },
    { key: 'gamma', sym: 'γ', name: 'Gamma', hex: '#f472b6' },
  ].map((b) => Object.assign(b, { color: C.hex(b.hex) }));
  const XYZ = ['#fb7185', '#86efac', '#7dd3fc'].map(C.hex);
  const EEG_VIEW = 256 * 5, IMU_VIEW = 52 * 10, HIST = 4 * 180, SPARK = 300;
  const CALIB_SECONDS = 40, FIT_HOLD = 5, TL_STEP = 2, TL_MAX_PTS = 900;
  const SCAPE_NAMES = { none: 'Off', ocean: 'Ocean waves', beach: 'Beach', rainforest: 'Rainforest', rain: 'Rain', alpha: 'Alpha 10 Hz · binaural', theta: 'Theta 6 Hz · binaural', delta: 'Delta 2 Hz · binaural', tone432: '432 Hz drone', tone528: '528 Hz drone' };

  /* ---------------- persistence ---------------- */
  let storage;
  try { storage = window.localStorage; storage.setItem('muse-calm:probe', '1'); storage.removeItem('muse-calm:probe'); }
  catch (_) { const m = new Map(); storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
  const store = SN.makeStore(storage);
  const PREF_DEFAULTS = { duration: 10, custom: false, bells: 0, soundscape: 'none', scapeVol: 50, birdVol: 60, threshold: 65, pinkBed: false, muted: false };
  const prefs = SN.sanitizePrefs(store.prefs(PREF_DEFAULTS), PREF_DEFAULTS, ['none'].concat(window.Soundscapes.SCENE_IDS));
  const savePrefs = () => store.savePrefs(prefs);

  const S = {};
  function resetData() {
    S.eegRaw = [0, 1, 2, 3].map(() => new D.Ring(1024));
    S.eegView = [0, 1, 2, 3].map(() => new D.Ring(EEG_VIEW));
    S.eegFilt = [0, 1, 2, 3].map(() => new D.EEGFilter(256));
    S.stds = [0, 0, 0, 0]; S.mains = [0, 0, 0, 0];
    S.gate = new K.ContactGate({ holdSec: FIT_HOLD }); S.drop = new K.DropoutMonitor({ poorSec: 3, recoverSec: 1 });
    S.contact = { states: ['off', 'off', 'off', 'off'], progress: 0, allGood: false }; S.dropped = []; S.dropActive = false;
    S.usable = 0; S.valid = false;
    S.blend = new D.ChannelBlend(4, 5); S.stale = false;
    S.relTarget = null; S.relHist = null; S.relShown = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    S.bandHist = {}; BANDS.forEach((b) => (S.bandHist[b.key] = new D.Ring(HIST)));
    S.calm = new D.CalmEngine({ calibSeconds: CALIB_SECONDS });
    S.calmHist = new D.Ring(SPARK); S.histTick = 0;
    S.hr = new D.HeartRateDetector(P.PPG_FS); S.hr.onBeat = (conf) => { if (conf) S.beat = 1; };
    S.ppgCount = 0; S.hasPPG = true;
    S.acc = [0, 1, 2].map(() => new D.Ring(IMU_VIEW)); S.gyr = [0, 1, 2].map(() => new D.Ring(IMU_VIEW));
    S.g = null; S.gRef = null; S.accN = 0; S.pitch = 0; S.roll = 0; S.motion = 0;
    S.eegRange = 50; S.scoreShown = null; S.beat = 0;
    S.birdsOn = false; S.aboveSince = null; S.belowSince = null; S.birdsSince = 0; S.birdLevel = 0;
    S.lastData = 0; S.lastAnalyze = vnow();
  }
  resetData();
  S.mode = 'idle'; S.threshold = prefs.threshold; S.battery = null; S.device = '';
  S.sess = null; S.lastSummary = null;

  const analyzer = new D.SpectrumAnalyzer(512, 256);
  const birds = new window.BirdChorus();
  const scapes = new window.Soundscapes();
  const sim = new window.MuseSimulator(onPacket, SPEED);
  const ble = new window.MuseBLE({ onPacket, onStatus, onControl });
  const streaming = () => S.mode === 'live' || S.mode === 'demo';
  const kind = () => (S.mode === 'demo' ? 'demo' : 'real');

  /* ---------------- data in ---------------- */
  function onPacket(kindName, idx, bytes) {
    S.lastData = vnow();
    if (kindName === 'eeg') {
      const s = P.parseEEG(bytes).samples;
      const raw = S.eegRaw[idx], view = S.eegView[idx], f = S.eegFilt[idx];
      for (let i = 0; i < s.length; i++) { raw.push(s[i]); view.push(f.process(s[i])); }
    } else if (kindName === 'ppg') {
      const s = P.parsePPG(bytes).samples;
      if (idx === 1) { for (let i = 0; i < s.length; i++) S.hr.push(s[i]); S.ppgCount += s.length; }
    } else if (kindName === 'accel') {
      P.parseAccel(bytes).samples.forEach((a) => {
        S.acc[0].push(a.x); S.acc[1].push(a.y); S.acc[2].push(a.z);
        const v = [a.x, a.y, a.z];
        if (!S.g) S.g = v; else for (let k = 0; k < 3; k++) S.g[k] += 0.08 * (v[k] - S.g[k]);
        if (++S.accN === 40 && !S.gRef) S.gRef = S.g.slice();
      });
    } else if (kindName === 'gyro') {
      P.parseGyro(bytes).samples.forEach((g) => {
        S.gyr[0].push(g.x); S.gyr[1].push(g.y); S.gyr[2].push(g.z);
        S.motion += 0.05 * (Math.hypot(g.x, g.y, g.z) - S.motion);
      });
    } else if (kindName === 'telemetry') {
      setBattery(P.parseTelemetry(bytes).battery);
    }
  }
  function onControl(j) {
    if (j && typeof j.bp === 'number' && S.battery === null) setBattery(j.bp);
    if (j && j.hn) S.device = j.hn;
  }
  function updateTilt() {
    if (!S.g || !S.gRef) return;
    const n = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const z = n(S.gRef), g = n(S.g);
    let x = [1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]];
    if (Math.hypot(x[0], x[1], x[2]) < 0.2) x = [-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]];
    x = n(x);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    S.pitch = -Math.asin(clamp(dot(g, x), -1, 1)) * 180 / Math.PI;
    S.roll = Math.asin(clamp(dot(g, y), -1, 1)) * 180 / Math.PI;
  }

  /* ---------------- analysis (4 Hz) ---------------- */
  function analyze() {
    const now = vnow();
    const dt = Math.min(1.5 * SPEED, (now - S.lastAnalyze) / 1000); S.lastAnalyze = now;
    if (!streaming()) { updateDom(); return; }
    const stale = now - S.lastData > 2500;

    const relSum = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }, anySum = Object.assign({}, relSum);
    let nUse = 0, nAny = 0, p98 = 0; const usable = [false, false, false, false];
    S.stale = stale;
    const ptps = [0, 0, 0, 0], rels = [null, null, null, null];
    for (let ch = 0; ch < 4; ch++) {
      const view = S.eegView[ch];
      if (stale || view.count < 256) { S.stds[ch] = 0; continue; }
      const w2 = view.latest(Math.min(512, view.count));
      S.stds[ch] = D.robustStd(w2);                 // robust to blinks
      const w1 = view.latest(256), abs = Array.from(w1, Math.abs).sort((a, b) => a - b);
      p98 = Math.max(p98, abs[Math.floor(abs.length * 0.98)]);
      ptps[ch] = D.stats(w2).ptp;
      if (S.eegRaw[ch].count >= 512) {
        analyzer.compute(S.eegRaw[ch].latest(512));
        const b = analyzer.bands();
        S.mains[ch] = b.mains / (b.total + 1e-12);
        rels[ch] = D.relativeBands(b);
      }
    }
    // contact: hysteresis + debounce per sensor, 5 s fit gate
    S.contact = S.gate.update(S.stds, S.mains, dt);
    const states = S.contact.states;
    const running = !!(S.sess && S.sess.timer.state === 'running');
    if (running) { const d = S.drop.update(S.sess.guard.maskStates(states), dt); S.dropped = d.dropped; S.dropActive = d.active; }
    else { S.drop.reset(); S.dropped = []; S.dropActive = false; }
    for (let ch = 0; ch < 4; ch++) {
      const r = rels[ch]; if (!r) continue;
      if (states[ch] !== 'off') { nAny++; for (const k in r) anySum[k] += r[k]; }
      if ((states[ch] === 'good' || states[ch] === 'fair') && ptps[ch] < 260) { nUse++; usable[ch] = true; for (const k in r) relSum[k] += r[k]; }
    }
    S.eegRange += (clamp(p98 * 1.25, 20, 400) - S.eegRange) * 0.2;
    S.usable = nUse;
    const rel = nUse ? scale(relSum, 1 / nUse) : nAny ? scale(anySum, 1 / nAny) : null;
    if (rel) S.relTarget = rel;
    // calm input: average over a stable electrode set (briefly unusable channels hold their last clean value)
    const bl = S.blend.update(rels, usable, dt);
    S.valid = !!bl.mean && S.motion < 30;
    // session: the first 40 s of clean data record a fresh baseline (progress pauses on contact loss / motion),
    // then calm scoring runs while contact is firm and the frame is clean
    const wasCal = S.calm.calibrating;
    let scoring = false, baseOk = false;
    S.basePause = null;
    if (running && wasCal) {
      const g = S.sess.guard.update({ bl, usable, states, stale, motion: S.motion }, dt);
      baseOk = g.ok; if (!g.ok) S.basePause = g;
      if (baseOk) S.calm.update(bl.mean, true, dt);
    } else if (running) {
      S.sess.guard.observe(usable);
      scoring = !S.dropActive && S.valid;
      if (scoring) S.calm.update(bl.mean, true, dt);
    } else if (!S.sess && !wasCal && S.valid) S.calm.update(bl.mean, true, dt);   // live preview with the last baseline
    if (running && wasCal && !S.calm.calibrating) { store.saveBaseline(kind(), S.calm.baseline, Date.now()); toast('Baseline recorded. Scoring starts now, just relax.'); flash('ok', 'Baseline recorded · scoring started'); }
    if (S.relTarget && S.eegRaw[0].count >= 512) {
      if (!S.relHist) S.relHist = Object.assign({}, S.relTarget);
      BANDS.forEach((b) => { S.relHist[b.key] += (1 - Math.exp(-dt / 1.5)) * (S.relTarget[b.key] - S.relHist[b.key]); S.bandHist[b.key].push(S.relHist[b.key]); });
    }
    if (++S.histTick % 4 === 0 && S.calm.score !== null && !S.calm.calibrating && (running || !S.sess)) S.calmHist.push(S.calm.score);
    updateTilt();
    birdLogic(now);
    if (S.sess) {
      const bpm = S.hr.value();
      const el = S.sess.timer.elapsed(now / 1000), sdt = Math.max(0, el - S.sess.lastEl); S.sess.lastEl = el;   // timer is the source of truth
      const calNow = S.calm.calibrating;
      if (sdt > 0) {
        S.sess.stats.add(sdt, { scoring, calibrating: calNow, excluded: running && !calNow && !scoring, score: S.calm.score, bpm });
        S.sess.tl.add(sdt, { rel: bl.mean, calm: !calNow && scoring ? S.calm.score : null, hr: bpm, baseline: calNow || (wasCal && !calNow), excluded: calNow ? !baseOk : !scoring });
      }
      S.sess.stats.threshold = S.threshold;
      S.sess.timer.tick(now / 1000).forEach((ev) => {
        if (ev === 'bell') scapes.chime('interval');
        if (ev === 'complete') finishSession(true);
      });
    }
    updateDom();
  }
  function scale(o, k) { const r = {}; for (const key in o) r[key] = o[key] * k; return r; }

  function birdLogic(now) {
    const running = S.sess && S.sess.timer.state === 'running';
    if (!running || S.calm.calibrating || S.calm.score === null) {
      S.aboveSince = S.belowSince = null; S.birdsOn = false; S.birdLevel = 0; birds.setState(false, 0); return;
    }
    if (S.dropActive) return;          // poor contact: freeze (neither reward nor penalise)
    const s = S.calm.score, thr = S.threshold;
    S.aboveSince = s >= thr ? (S.aboveSince || now) : null;
    S.belowSince = s < thr - 4 ? (S.belowSince || now) : null;
    if (!S.birdsOn && S.aboveSince && now - S.aboveSince >= 4000) { S.birdsOn = true; S.birdsSince = now; }
    if (S.birdsOn && S.belowSince && now - S.belowSince >= 2000) S.birdsOn = false;
    S.birdLevel = S.birdsOn ? 0.6 * clamp((s - thr) / (100 - thr), 0, 1) + 0.4 * clamp((now - S.birdsSince) / 120000, 0, 1) : 0;
    birds.setState(S.birdsOn, S.birdLevel);
  }

  /* ---------------- sessions ---------------- */
  let fadeTimer = null;
  function startSession(override) {
    if (!streaming() || S.sess) return;
    unlockAudio();
    clearTimeout(fadeTimer);
    const mins = clamp(Math.round(prefs.duration) || 10, 1, 180);
    const timer = new SN.SessionTimer(mins * 60, +prefs.bells || 0);
    const stats = new SN.SessionStats(S.threshold, mins <= 5 ? 3 : 5);
    S.calm.reset();                       // every session records a fresh 40 s baseline
    S.calmHist.clear(); S.drop.reset(); S.basePause = null;
    S.sess = { timer, stats, tl: new SN.Timeline(TL_STEP), guard: new SN.BaselineGuard(30), lastEl: 0, kind: kind(), started: Date.now(), planned: mins * 60, override: !!override };
    timer.start(vnow() / 1000);
    if (S.mode === 'demo') sim.markSession(true);
    if (prefs.soundscape !== 'none' && !scapes.playing) scapes.select(prefs.soundscape, 4);
    scapes.chime('start');
    updateDom();
  }
  function togglePause() {
    const s = S.sess; if (!s) return;
    const t = vnow() / 1000;
    if (s.timer.state === 'running') s.timer.pause(t);
    else if (s.timer.state === 'paused') { if (!streaming()) { toast('Reconnect the headband to resume.'); return; } s.timer.resume(t); }
    updateDom();
  }
  function finishSession(completed) {
    const s = S.sess; if (!s) return;
    if (s.timer.state !== 'done') s.timer.end(vnow() / 1000);
    const rest = s.timer.elapsed(0) - s.lastEl;
    if (rest > 0.01) {
      const cal = S.calm.calibrating, sc = !cal && !S.dropActive && S.valid;
      s.stats.add(rest, { scoring: sc, calibrating: cal, excluded: !cal && !sc, score: S.calm.score, bpm: S.hr.value() });
      s.tl.add(rest, { rel: null, calm: sc ? S.calm.score : null, hr: S.hr.value(), baseline: cal, excluded: cal ? !!S.basePause : !sc });
    }
    const sum = s.stats.summary();
    Object.assign(sum, { completed, planned: s.planned, kind: s.kind, date: s.started, override: s.override });
    S.sess = null; S.lastSummary = sum;
    S.birdsOn = false; birds.setState(false, 0);
    if (S.mode === 'demo') sim.endSession();
    S.gate.reset();
    const chimeLen = scapes.chime('end');
    if (scapes.playing) fadeTimer = setTimeout(() => scapes.fadeOut(10), (chimeLen - 0.5) * 1000);
    sum.saved = false;
    if (SN.saveable(sum)) {
      const tl = s.tl.finish().pack(TL_MAX_PTS);
      const r = store.addSession({ date: sum.date, kind: sum.kind, planned: sum.planned, duration: sum.duration, completed, calmT: sum.calmT, scoredT: sum.scoredT, calmShare: sum.calmShare, longest: sum.longest,
        avgHr: sum.avgHr, minHr: sum.minHr, songs: sum.songs, threshold: sum.threshold, baselineT: sum.baselineT, excludedT: sum.excludedT, override: sum.override, v: 2.1, series: SN.downsample(sum.series, 60) }, tl);
      sum.saved = r.saved; sum.tlSaved = r.timeline;
      if (!r.saved) toast('Could not save this session: browser storage is full.', true);
      else if (!r.timeline) toast('Session saved without its detailed timeline (storage is full).');
    }
    renderPast();
    showSummary(sum);
    updateDom();
  }
  function showSummary(sum) {
    const pct = sum.calmShare === null ? null : Math.round(sum.calmShare * 100);
    const early = !sum.baselineDone;
    setText('sumKind', (early ? 'Ended during baseline' : sum.completed ? 'Session complete' : 'Ended early') + (sum.kind === 'demo' ? ' · demo' : ''));
    setText('sumTitle', sum.completed && !early ? 'Beautifully done' : 'Nice pause for yourself');
    setText('sumDate', new Date(sum.date).toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }) + ' · ' + fmtMin(sum.planned) + ' session');
    setText('sumShare', pct === null ? '--' : pct + '%');
    setText('sumMsg', early ? 'This one ended before your 40 s baseline was finished, so there is no calm score and it was not saved. Every minute of stillness still counts.'
      : pct === null ? 'Too short to score calm, but every minute of stillness counts.'
      : pct >= 60 ? 'Deep, steady calm. The forest sang for you. Carry this quiet into the rest of your day.'
        : pct >= 30 ? 'A lovely session. You found your way back to calm again and again, and that is the practice.'
          : 'Every session trains the skill of returning. Thank you for showing up for yourself.');
    setText('sDur', fmt(sum.duration)); setText('sCalm', fmt(sum.calmT)); setText('sLong', fmt(sum.longest));
    setText('sHr', sum.avgHr ? sum.avgHr + ' bpm' : '--'); setText('sMinHr', sum.minHr ? sum.minHr + ' bpm' : '--'); setText('sBirds', sum.songs);
    setText('sumThr', 'birds above ' + sum.threshold);
    const notes = [];
    if (sum.baselineDone && sum.baselineT > 0) notes.push('The first ' + fmt(sum.baselineT) + ' recorded your baseline, so calm share covers the ' + fmt(sum.scoredT + sum.excludedT) + ' after it.');
    if (sum.excludedT >= 3) notes.push(fmt(sum.excludedT) + ' with loose contact or movement was left out of scoring (not counted against you).');
    if (sum.saved) notes.push('Saved to Past sessions; open it there to see the full brainwave history.');
    if (sum.override) notes.push('Started without a full fit check.');
    setText('sumNote', notes.join(' '));
    S.summaryShown = sum;
    $('summaryModal').hidden = false;
    flash('ok', early ? 'Session ended' : sum.completed ? 'Session complete' : 'Session ended', 10);
    C.observe($('sumChart')); C.observe($('sumRing'));
    setTimeout(() => $('sumDone').focus(), 50);
  }
  function renderPast() {
    const h = store.history(), ul = $('pastList');
    $('clearHist').hidden = !h.length;
    setText('pastSub', h.length ? h.length + ' saved on this device' : 'Saved on this device');
    if (!h.length) { ul.innerHTML = '<li class="empty muted small">Your finished sessions will appear here.</li>'; return; }
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    ul.innerHTML = h.slice(0, 12).map((e0) => {
      const e = { id: String(n(e0.id !== undefined ? +e0.id : e0.date) || 0), date: n(e0.date) || 0, kind: e0.kind === 'demo' ? 'demo' : 'real', planned: n(e0.planned) || 0, duration: n(e0.duration) || 0, completed: !!e0.completed,
        calmShare: n(e0.calmShare), avgHr: n(e0.avgHr) && Math.round(e0.avgHr), threshold: n(e0.threshold) || 65, series: Array.isArray(e0.series) ? e0.series.map(n) : [] };
      const d = new Date(e.date), pct = e.calmShare === null || e.calmShare === undefined ? '--' : Math.round(e.calmShare * 100) + '%';
      const pts = (e.series || []).map((v, i, a) => (v === null ? null : [(i / Math.max(1, a.length - 1)) * 108 + 1, 28 - (v / 100) * 26]));
      let path = '', pen = false;
      pts.forEach((p) => { if (!p) { pen = false; return; } path += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); pen = true; });
      const ty = (28 - ((e.threshold || 65) / 100) * 26).toFixed(1);
      const label = 'Open session from ' + d.toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return '<li class="row" tabindex="0" role="button" data-id="' + e.id + '" aria-label="' + label + '"><div class="when"><b>' + d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + (e.kind === 'demo' ? '<span class="tag">DEMO</span>' : '') + '</b><small>' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + fmtMin(e.planned) + (e.completed ? '' : ' · ended early') + '</small></div>'
        + '<div class="m"><b>' + fmt(e.duration) + '</b><small>duration</small></div>'
        + '<div class="m"><b class="accent">' + pct + '</b><small>calm</small></div>'
        + '<div class="m hr"><b>' + (e.avgHr ? e.avgHr : '--') + '</b><small>avg bpm</small></div>'
        + '<div class="mini"><svg viewBox="0 0 110 30" preserveAspectRatio="none"><line x1="0" x2="110" y1="' + ty + '" y2="' + ty + '" stroke="rgba(253,230,138,.35)" stroke-dasharray="2 3"/><path d="' + path + '" fill="none" stroke="#5eead4" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg></div><svg class="chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></li>';
    }).join('');
  }


  /* ---------------- past session detail ---------------- */
  const DT = { id: null, entry: null, pts: null, cursor: null, layout: null, ringAnim: 0, opener: null };
  function openDetail(id) {
    const e0 = store.session(id); if (!e0) { renderPast(); return; }
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const e = { date: n(e0.date) || 0, kind: e0.kind === 'demo' ? 'demo' : 'real', planned: n(e0.planned) || 0, duration: n(e0.duration) || 0, completed: !!e0.completed,
      calmT: n(e0.calmT), calmShare: n(e0.calmShare), longest: n(e0.longest), avgHr: n(e0.avgHr), minHr: n(e0.minHr), songs: n(e0.songs) || 0,
      threshold: clamp(n(e0.threshold) || 65, 0, 100), baselineT: n(e0.baselineT), excludedT: n(e0.excludedT), scoredT: n(e0.scoredT),
      series: Array.isArray(e0.series) ? e0.series.map(n) : [], v: n(e0.v), tl: !!e0.tl, pruned: !!e0.tlPruned };
    const pts = e.tl ? SN.unpackTimeline(store.timeline(id)) : null;
    DT.id = String(id); DT.entry = e; DT.pts = pts && pts.length ? pts : null; DT.cursor = null; DT.ringAnim = 0;
    DT.opener = document.activeElement;
    const d = new Date(e.date);
    setText('dtKind', (e.completed ? 'Completed session' : 'Ended early') + (e.kind === 'demo' ? ' · demo' : ''));
    setText('dtTitle', d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }));
    setText('dtSub', d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + fmtMin(e.planned) + ' session');
    setText('dtShare', e.calmShare === null ? '--' : Math.round(e.calmShare * 100) + '%');
    setText('dDur', fmt(e.duration)); setText('dCalm', e.calmT === null ? '--' : fmt(e.calmT)); setText('dLong', e.longest === null ? '--' : fmt(e.longest));
    setText('dHr', e.avgHr ? Math.round(e.avgHr) + ' bpm' : '--'); setText('dMinHr', e.minHr ? Math.round(e.minHr) + ' bpm' : '--'); setText('dBirds', e.songs);
    show('dtTimeline', !!DT.pts); show('dtOld', !DT.pts); $('dtTip').hidden = true;
    if (DT.pts) {
      const step = DT.pts.length > 1 ? DT.pts[1].t : TL_STEP;
      setText('dtRes', 'one point every ' + (step < 60 ? Math.round(step) + ' s' : (step / 60).toFixed(1) + ' min'));
      $('dtLegend').innerHTML = legendHtml(BANDS) + '<button type="button" class="lg" data-explain="calm"><i style="background:#5eead4"></i>Calm</button>'
        + (DT.pts.some((p) => p.hr) ? '<button type="button" class="lg" data-explain="hr"><i style="background:#fb7185"></i>Heart</button>' : '')
        + '<button type="button" class="lg" data-explain="baseline"><i class="sw-base"></i>Baseline</button><button type="button" class="lg" data-explain="excluded"><i class="sw-drop"></i>Left out</button>';
      window.Explain.prep($('dtLegend'));
    } else {
      setText('dtOldNote', e.pruned ? 'The detailed brainwave timeline of this session was removed to make room for newer sessions. Its summary and calm curve are kept.'
        : 'Detailed brainwave history starts with version 2.1. This session was saved before that, so only its summary and calm curve are available.');
      setText('dtThr', 'birds above ' + e.threshold);
      show('dtSeriesBox', e.series.some((v) => v !== null));
    }
    const notes = [];
    if (e.baselineT) notes.push('The first ' + fmt(e.baselineT) + ' recorded your baseline (not scored).');
    if (e.excludedT >= 3) notes.push(fmt(e.excludedT) + ' with loose contact or movement was left out of scoring.');
    setText('dtNote', notes.join(' '));
    $('detailModal').hidden = false;
    $('detailModal').querySelector('.sheet').scrollTop = 0;
    ['dtCanvas', 'dtRing', 'dtSeries'].forEach((id2) => C.observe($(id2)));
    setTimeout(() => $('dtDone').focus({ preventScroll: true }), 50);
  }
  function closeDetail() {
    if ($('detailModal').hidden) return;
    $('detailModal').hidden = true; window.Explain.close();
    DT.id = null; DT.pts = null; DT.cursor = null;
    const op = DT.opener; DT.opener = null;
    if (op && document.contains(op)) op.focus({ preventScroll: true });
  }
  function drawDetail() {
    const e = DT.entry; let c;
    if (DT.pts && (c = C.begin($('dtCanvas')))) {
      DT.layout = C.timeline(c, DT.pts, { bands: BANDS, threshold: e.threshold, cursor: DT.cursor, step: DT.pts.length > 1 ? DT.pts[1].t : TL_STEP });
    }
    if (!DT.pts && (c = C.begin($('dtSeries')))) C.sessionChart(c, e.series.map((v) => ({ v, cal: false })), e.threshold, [94, 234, 212]);
    if ((c = C.begin($('dtRing')))) {
      DT.ringAnim = Math.min(1, DT.ringAnim + 0.03);
      ring(c, e.calmShare || 0, 1 - Math.pow(1 - DT.ringAnim, 3));
    }
  }
  function setCursor(i) {
    if (!DT.pts) return;
    DT.cursor = i === null ? null : clamp(i, 0, DT.pts.length - 1);
    const tip = $('dtTip');
    if (DT.cursor === null) { tip.hidden = true; return; }
    const p = DT.pts[DT.cursor], L = DT.layout;
    const pct = (v) => Math.round(v * 100) + '%';
    const phaseTxt = p.baseline ? (p.excluded ? 'baseline · paused' : 'baseline') : p.excluded ? 'left out' : 'scored';
    tip.innerHTML = '<div class="tt-h"><b>' + fmt(p.t) + '</b><span class="ph ' + (p.baseline ? 'base' : p.excluded ? 'drop' : '') + '">' + phaseTxt + '</span></div>'
      + '<div class="tt-row"><span>Calm</span><b>' + (p.calm === null ? '--' : Math.round(p.calm)) + '</b></div>'
      + '<div class="tt-row"><span>Heart</span><b>' + (p.hr ? Math.round(p.hr) + ' bpm' : '--') + '</b></div>'
      + '<div class="tt-bands">' + BANDS.map((b) => '<span><i style="background:' + b.hex + '"></i>' + b.sym + ' ' + (p.rel ? pct(p.rel[b.key]) : '--') + '</span>').join('') + '</div>';
    tip.hidden = false;
    if (L) {
      const wrap = $('dtWrap').getBoundingClientRect(), x = L.x(DT.cursor), tw = tip.offsetWidth;
      let left = x + 14; if (left + tw > wrap.width - 4) left = x - tw - 14;
      tip.style.left = Math.max(4, left) + 'px';
    }
  }
  (function wireDetail() {
    const cvd = $('dtCanvas');
    const at = (ev) => { const r = cvd.getBoundingClientRect(); return DT.layout ? DT.layout.idxAt(ev.clientX - r.left) : null; };
    cvd.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse' || ev.buttons) setCursor(at(ev)); });
    cvd.addEventListener('pointerdown', (ev) => setCursor(at(ev)));
    cvd.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') setCursor(null); });
    cvd.addEventListener('keydown', (ev) => {
      if (!DT.pts) return;
      const n = DT.pts.length, big = Math.max(1, Math.round(n / 20)), c0 = DT.cursor === null ? -1 : DT.cursor;
      const k = { ArrowRight: c0 < 0 ? 0 : c0 + 1, ArrowLeft: c0 < 0 ? n - 1 : c0 - 1, PageUp: c0 + big, PageDown: c0 - big, Home: 0, End: n - 1 }[ev.key];
      if (k !== undefined) { ev.preventDefault(); setCursor(k); }
    });
    cvd.addEventListener('blur', () => setCursor(null));
    $('pastList').addEventListener('click', (ev) => { const li = ev.target.closest('li.row[data-id]'); if (li) openDetail(li.dataset.id); });
    $('pastList').addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('li.row[data-id]')) { ev.preventDefault(); openDetail(ev.target.dataset.id); } });
    $('dtDone').addEventListener('click', closeDetail);
    $('dtClose').addEventListener('click', closeDetail);
    $('detailModal').addEventListener('click', (ev) => { if (ev.target === $('detailModal')) closeDetail(); });
    $('dtDelete').addEventListener('click', () => {
      if (!DT.id || !confirm('Delete this session and its brainwave history from this device?')) return;
      store.deleteSession(DT.id); DT.opener = null; closeDetail(); renderPast(); toast('Session deleted.');
    });
  })();
  function ring(c, p, e) {
    const { ctx, w, h } = c, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 7;
    ctx.lineCap = 'round'; ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (p > 0) {
      const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#a7f3d0'); g.addColorStop(1, '#38bdf8');
      ctx.save(); ctx.shadowColor = 'rgba(94,234,212,.7)'; ctx.shadowBlur = 14; ctx.strokeStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p * e); ctx.stroke(); ctx.restore();
    }
  }

  /* ---------------- UI ---------------- */
  const fmt = (sec) => { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; };
  const fmtMin = (sec) => Math.round(sec / 60) + ' min';
  const setText = (id, v) => { const e = $(id); if (e && e.textContent !== String(v)) e.textContent = v; };
  const show = (id, on) => { const e = $(id); if (e && e.hidden === !!on) e.hidden = !on; };
  function setBattery(pct) {
    S.battery = clamp(pct, 0, 100);
    $('batteryPill').hidden = false;
    setText('batteryText', Math.round(S.battery) + '%');
    $('batteryFill').setAttribute('width', (13 * S.battery / 100).toFixed(1));
    $('batteryPill').classList.toggle('low', S.battery < 20);
  }
  let toastTimer = null;
  function toast(msg, err) {
    const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), err ? 7000 : 4000);
  }
  function phase() { return S.sess ? 'session' : streaming() ? 'setup' : 'offline'; }

  function setMode(mode, info) {
    S.mode = mode;
    setClockRate(mode === 'demo' ? SPEED : 1);
    const pill = $('statusPill');
    pill.className = 'pill status ' + ({ live: 'live', demo: 'demo', connecting: 'busy', reconnecting: 'busy', lost: 'error', error: 'error' }[mode] || 'idle');
    const name = (info && info.name) || S.device || 'Muse';
    setText('statusText', {
      idle: 'Not connected', connecting: 'Connecting…', live: 'Streaming · ' + name, demo: 'Demo mode' + (SPEED > 1 ? ' ×' + SPEED : ''),
      reconnecting: 'Reconnecting…' + (info && info.attempt ? ' (' + info.attempt + '/3)' : ''), lost: 'Connection lost', error: 'Not connected',
    }[mode] || mode);
    const live = mode === 'live', demo = mode === 'demo', busy = mode === 'connecting' || mode === 'reconnecting';
    $('connectBtn').hidden = live || demo || mode === 'lost' || mode === 'reconnecting';
    $('connectBtn').disabled = busy;
    $('reconnectBtn').hidden = mode !== 'lost';
    $('demoBtn').hidden = live || demo || busy || mode === 'lost';
    $('leaveBtn').hidden = !(live || demo || mode === 'lost' || mode === 'reconnecting');
    $('leaveBtn').textContent = demo ? 'Stop demo' : 'Disconnect';
    $('simDropBtn').hidden = !demo;
    if (live || demo) requestWakeLock(); else releaseWakeLock();
    if (!(live || demo)) {
      S.birdsOn = false; birds.setState(false, 0);
      if (S.sess && S.sess.timer.state === 'running') { S.sess.timer.pause(vnow() / 1000); toast('Headband disconnected. Session paused.'); }
    }
    updateDom();
  }

  function calmLabel() {
    const s = S.calm.score, thr = S.threshold, ph = phase();
    if (ph === 'offline') return S.lastSummary ? 'Until next time' : 'Ready when you are';
    if (S.eegRaw[0].count < 512) return 'Listening…';
    if (ph === 'session' && S.sess.timer.state === 'paused') return 'Paused';
    if (ph === 'session' && S.calm.calibrating) return S.basePause ? 'Baseline paused' : 'Recording baseline';
    if (S.dropActive) return 'Scoring paused';
    if (ph === 'setup' && (S.calm.calibrating || s === null)) return S.contact.progress >= 1 ? 'Ready' : 'Check fit';
    if (!S.usable) return 'Check headband fit';
    if (S.motion >= 30) return 'Hold still…';
    if (S.calm.calibrating) return 'Calibrating';
    if (s >= Math.max(85, thr + 15)) return 'Deep calm';
    if (s >= thr) return 'Calm';
    if (s >= 45) return 'Relaxing';
    if (s >= 30) return 'Settling';
    return 'Busy mind';
  }
  function hintText() {
    const m = S.mode, ph = phase();
    if (m === 'connecting') return 'Pick your <b>Muse</b> in the browser dialog. Keep it switched on and close by.';
    if (m === 'reconnecting') return 'The headband dropped out. Reconnecting…';
    if (m === 'lost') return 'Connection lost. Make sure the Muse is on, then press <b>Reconnect</b>.';
    if (ph === 'offline') {
      if (!window.MuseBLE.supported()) return 'This browser has no Web Bluetooth. The demo works here; for the headband use <b>Chrome</b> or <b>Edge</b> (Windows, Mac, Android) or <b>Bluefy</b> on iPhone.';
      return 'Switch on your Muse, put it on, then press <b>Connect Muse</b>. Or try the demo.';
    }
    if (ph === 'setup') return S.contact.progress >= 1 ? 'Firm contact on all four sensors. Choose a length and begin when ready.' : '';
    if (S.sess.timer.state === 'paused') return 'Paused. Take your time and resume when you are ready.';
    if (S.calm.calibrating) return '';
    if (S.dropActive) return 'Calm scoring is paused until contact returns. It will not count against you.';
    if (S.birdsOn) return 'Lovely. Stay with it. The forest is waking up around you.';
    if (S.calm.score >= S.threshold) return 'Almost there. The birds arrive after a few calm seconds.';
    return 'Soften your gaze, relax your jaw and shoulders, and let each breath out be slow.';
  }

  function updateDom() {
    const ph = phase(), live = streaming();
    const hero = $('hero'); if (hero.dataset.phase !== ph) hero.dataset.phase = ph;
    const lbl = calmLabel();
    setText('calmLabel', lbl);
    const hint = hintText();
    if ($('hint').innerHTML !== hint) $('hint').innerHTML = hint;
    show('hint', !!hint);
    show('connectActions', ph === 'offline' || S.mode === 'lost' || S.mode === 'reconnecting');
    show('setupBox', ph === 'setup');
    show('timerBox', ph === 'session');
    show('fitGate', ph === 'setup');
    // fit check (setup) + stack fit card
    const states = live ? S.contact.states : ['off', 'off', 'off', 'off'];
    const qW = { good: 100, fair: 62, poor: 28, off: 4 };
    const items = $('sigList').children, tiles = $('fitGrid').children;
    const bad = [];
    for (let i = 0; i < 4; i++) {
      const q = states[i];
      const li = items[i];
      if (li.dataset.q !== q) li.dataset.q = q;
      li.querySelector('i').style.width = qW[q] + '%';
      const v = li.querySelector('.val'), txt = q === 'off' ? '--' : Math.round(S.stds[i]) + ' µV';
      if (v.textContent !== txt) v.textContent = txt;
      $('s' + i).setAttribute('class', 'sensor ' + (q === 'off' ? '' : q));
      if (q !== 'good') bad.push(P.EEG_NAMES[i]);
      const tile = tiles[i]; if (tile.dataset.q !== q) tile.dataset.q = q;
      const h = live && S.eegRaw[i].count > 0 ? K.hint(i, q, S.mains[i]) : 'Waiting for signal';
      const he = tile.querySelector('.ft-hint'); if (he.textContent !== h) he.textContent = h;
      const sh = li.querySelector('.sh'); if (sh && sh.textContent !== h) sh.textContent = h;   // desktop: fit hints in the Headband fit card
    }
    setText('fitSummary', !live || S.eegRaw[0].count < 256 ? 'No signal' : !bad.length ? 'Great contact' : bad.length === 4 ? 'Adjust headband' : 'Adjust ' + bad.join(', '));
    if (ph === 'setup') {
      const p = S.contact.progress, ready = p >= 1;
      $('fitBar').style.width = (p * 100).toFixed(1) + '%';
      $('fitGrid').parentElement.classList.toggle('passed', ready);
      setText('fitCount', ready ? '✓ Ready' : (p * FIT_HOLD).toFixed(1) + ' / ' + FIT_HOLD + ' s');
      setText('fitCheckSub', ready ? 'Firm contact on all four sensors' : bad.length ? 'Waiting on ' + bad.join(', ') + ' · all four need firm contact for 5 s' : 'Hold still… all four sensors look good');
      // desktop: the same fit check, shown in the Headband fit card
      $('fitBar2').style.width = $('fitBar').style.width;
      $('fitGate').classList.toggle('passed', ready);
      setText('fitCount2', $('fitCount').textContent); setText('fitCheckSub2', $('fitCheckSub').textContent);
      $('startBtn').disabled = !ready;
    }
    // session timer
    if (ph === 'session') {
      const t = S.sess.timer, now = vnow() / 1000, paused = t.state === 'paused';
      setText('timerTime', fmt(Math.ceil(t.remaining(now))));
      const cal = S.calm.calibrating;
      setText('timerSub', (paused ? 'paused' : 'remaining') + ' · ' + fmtMin(t.duration) + ' session' + (cal ? ' · baseline first' : ''));
      show('baseBox', cal);
      if (cal) {
        const left = Math.max(0, Math.ceil(CALIB_SECONDS * (1 - S.calm.calibProgress))), bp = S.basePause;
        $('baseBar').style.width = (S.calm.calibProgress * 100).toFixed(1) + '%';
        $('baseBarWrap').setAttribute('aria-valuenow', String(CALIB_SECONDS - left));
        $('baseBox').classList.toggle('held', !!bp || paused);
        const who = bp && bp.sensors && bp.sensors.length ? bp.sensors.map((i) => K.SENSORS[i].where + ' (' + K.SENSORS[i].name + ')').join(' and ') : '';
        setText('baseText', paused ? 'Baseline paused with the session'
          : !bp ? 'Recording your baseline… relax, eyes closed' + (S.sess.guard.skipped.length ? ' (continuing without ' + S.sess.guard.skipped.map((i) => K.SENSORS[i].name).join(', ') + ')' : '')
            : bp.reason === 'contact' ? 'Baseline paused: ' + (who ? who + ' lost contact' : 'a sensor lost contact') + '. Only clean data is used.'
              : bp.reason === 'motion' ? 'Baseline paused while you move. Settle and it continues.'
                : 'Baseline paused: waiting for clean data from the headband.');
        setText('baseLeft', left + ' s left');
      }
      $('timerBox').classList.toggle('paused', paused);
      $('pauseBtn').querySelector('span').textContent = paused ? 'Resume' : 'Pause';
      $('pauseIcon').setAttribute('d', paused ? 'M8 5.5v13l10.5-6.5z' : 'M8 5.5v13M16 5.5v13');
      $('pauseIcon').setAttribute('fill', paused ? 'currentColor' : 'none');
    }
    // dropout banner
    show('dropBanner', ph === 'session' && S.dropActive && !S.calm.calibrating);
    if (S.dropActive) {
      const names = S.dropped.map((i) => K.SENSORS[i].where.replace(/^./, (c) => c.toUpperCase()) + ' (' + K.SENSORS[i].name + ')');
      setText('dropText', S.stale ? 'No data from the headband right now. Calm scoring paused, not penalised.'
        : names.join(' and ') + (names.length > 1 ? ' lost contact' : ' sensor lost contact') + '. Calm scoring paused, not penalised.');
    }
    // heart
    const bpm = live ? S.hr.value() : null;
    setText('bpm', bpm ? Math.round(bpm) : '--');
    $('heartIcon').classList.toggle('idle', !bpm);
    setText('bpmSub', !live ? 'Waiting for pulse' : !S.hasPPG ? 'No PPG on this model' : S.ppgCount < 64 * 3 ? 'Reading pulse…' : bpm ? 'Steady pulse' : 'Finding rhythm…');
    // live session card
    const src = S.sess ? S.sess.stats.summary() : S.lastSummary;
    setText('sessionState', S.sess ? (S.sess.timer.state === 'paused' ? 'Paused' : S.calm.calibrating ? 'Live · recording baseline' : 'Live') : S.lastSummary ? 'Last session' : 'Not started');
    setText('stTime', fmt(src ? src.duration : 0)); setText('stCalm', fmt(src ? src.calmT : 0));
    setText('stPct', src && src.calmShare !== null ? Math.round(src.calmShare * 100) + '%' : '--');
    setText('stHr', src && src.avgHr ? src.avgHr + ' bpm' : '--');
    setText('stLong', fmt(src ? src.longest : 0)); setText('stBirds', src ? src.songs : 0);
    // motion
    setText('pitchVal', live && S.gRef ? Math.round(S.pitch) + '°' : '--');
    setText('rollVal', live && S.gRef ? Math.round(S.roll) + '°' : '--');
    setText('motionState', !live || !S.g ? '--' : S.motion < 4 ? 'Still' : S.motion < 14 ? 'Gentle movement' : 'Moving');
    setText('eegScale', '±' + Math.round(S.eegRange) + ' µV');
    // chips
    $('birdChip').hidden = !S.birdsOn;
    if (S.birdsOn) { const n = 1 + Math.round(S.birdLevel * 4); const bt = n === 1 ? 'A bird is singing' : n + ' birds singing'; setText('birdText', bt); $('birdChip').title = bt; $('birdChip').setAttribute('aria-label', bt); }
    $('soundChip').hidden = !((S.birdsOn || S.sess) && !birds.ready);
    $('recalBtn').disabled = !(S.sess && S.sess.timer.state === 'running');
    setText('heroSub', ph === 'session' ? (S.calm.calibrating ? 'Recording your 40 s baseline' : 'Relative alpha vs your baseline') : ph === 'setup' ? 'Fit check, then a timed session' : 'Relative alpha, adapted to you');
    updateScapeUi();
    updateAlerts(ph);
  }
  /* phone tabs: while another tab is open, a slim strip mirrors the session (time left, calm, baseline) and any
     alert that matters (contact lost, baseline done, session complete); the Session tab carries a badge until seen */
  var tabs = window.MuseTabs || null;   // var: updateDom may run before this line during start-up
  function flash(kind, text, secs) {
    S.flash = { kind, text, until: Date.now() + (secs || 8) * 1000 };
    if (tabs && tabs.tabbed() && tabs.get() !== 'session') S.unseen = kind;
    updateAlerts(phase());
  }
  function updateAlerts(ph) {
    if (!tabs) return;
    const away = tabs.tabbed() && tabs.get() !== 'session';
    let kind = '', text = '';
    if (ph === 'session') {
      const tm = S.sess.timer, left = fmt(Math.ceil(tm.remaining(vnow() / 1000))), bp = S.basePause;
      if (tm.state === 'paused') { kind = 'idle'; text = 'Session paused · ' + left + ' left'; }
      else if (S.dropActive && !S.calm.calibrating) { kind = 'warn'; text = (S.stale ? 'No data from the headband' : S.dropped.map((i) => K.SENSORS[i].name).join(' + ') + ' lost contact') + ' · scoring paused'; }
      else if (S.calm.calibrating && bp) { kind = 'warn'; text = 'Baseline paused · ' + (bp.reason === 'contact' ? 'a sensor lost contact' : bp.reason === 'motion' ? 'hold still' : 'waiting for clean data'); }
      else if (S.calm.calibrating) { kind = 'base'; text = 'Recording baseline · ' + Math.max(0, Math.ceil(CALIB_SECONDS * (1 - S.calm.calibProgress))) + ' s left'; }
      else { kind = 'live'; text = 'Calm ' + (S.scoreShown === null ? '--' : Math.round(S.scoreShown)) + ' · ' + left + ' left'; }
    }
    if (S.flash && Date.now() < S.flash.until && kind !== 'warn') { kind = S.flash.kind; text = S.flash.text; }
    const strip = $('alertStrip');
    strip.hidden = !(away && text);
    if (!strip.hidden) { strip.dataset.kind = kind; setText('alertText', text); }
    const badge = kind === 'warn' ? 'warn' : S.unseen || '';
    $('tabBadge').hidden = !(away && badge);
    if (badge) $('tabBadge').dataset.kind = badge;
  }
  /* desktop: less-used calm controls live in a small "More" popover */
  (function () {
    const hero = $('hero'), btn = $('moreBtn');
    if (!btn) return;
    const set = (on) => { hero.classList.toggle('more-open', on); btn.setAttribute('aria-expanded', on ? 'true' : 'false'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); set(!hero.classList.contains('more-open')); });
    document.addEventListener('click', (e) => { if (hero.classList.contains('more-open') && !e.target.closest('#heroFoot') && !e.target.closest('#moreBtn')) set(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hero.classList.contains('more-open')) { set(false); btn.focus(); } });
  })();
  if (tabs) {
    tabs.onChange((t) => { if (t === 'session') S.unseen = null; updateAlerts(phase()); });
    $('alertStrip').addEventListener('click', () => tabs.set('session'));
  }
  function updateScapeUi() {
    const id = prefs.soundscape, playing = scapes.playing;
    document.querySelectorAll('#scapeTiles button, #freqTiles button').forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle('on', on); b.classList.toggle('stopped', on && !playing && id !== 'none');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    setText('scapeState', id === 'none' ? 'Off' : (playing ? 'Playing · ' : 'Paused · ') + SCAPE_NAMES[id]);
    $('scapePlay').classList.toggle('playing', playing);
    $('scapePlayIcon').setAttribute('d', playing ? 'M8.5 5.5v13M15.5 5.5v13' : 'M8 5.5v13l10.5-6.5z');
    $('scapePlayIcon').setAttribute('stroke', playing ? 'currentColor' : 'none');
    $('scapePlayIcon').setAttribute('stroke-width', '2.6');
    $('scapePlayIcon').setAttribute('stroke-linecap', 'round');
  }

  /* ---------------- rendering (rAF) ---------------- */
  const cv = {};
  ['orbCanvas', 'calmSpark', 'eegCanvas', 'barsCanvas', 'histCanvas', 'ppgCanvas', 'tiltCanvas', 'imuCanvas'].forEach((id) => { cv[id] = $(id); C.observe(cv[id]); });
  const waveState = {};
  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0.016); lastTs = ts;
    const t = ts / 1000, live = streaming(), ph = phase();
    const k = 1 - Math.exp(-dt * 5);
    if (S.relTarget) BANDS.forEach((b) => (S.relShown[b.key] += k * (S.relTarget[b.key] - S.relShown[b.key])));
    const cal = S.calm.calibrating;
    const score = live && !cal && S.calm.score !== null ? S.calm.score : null;
    if (score === null) S.scoreShown = null; else S.scoreShown = S.scoreShown === null ? score : S.scoreShown + (1 - Math.exp(-dt * 3)) * (score - S.scoreShown);
    S.beat *= Math.exp(-dt * 6);
    let big = '—', unit = false;
    if (ph === 'session' && cal && S.eegRaw[0].count >= 512) { big = Math.ceil(CALIB_SECONDS * (1 - S.calm.calibProgress)) + ''; unit = true; }
    else if (S.scoreShown !== null) big = Math.round(S.scoreShown) + '';
    setText('calmScore', big);
    $('calmScore').classList.toggle('empty', big === '—');
    $('calmUnit').hidden = !unit;
    $('heartIcon').style.transform = 'scale(' + (1 + 0.2 * S.beat).toFixed(3) + ')';
    const sessRing = S.sess ? { progress: S.sess.timer.progress(vnow() / 1000), paused: S.sess.timer.state === 'paused' } : null;
    if (ph === 'session' && S.sess.timer.state === 'running') setText('timerTime', fmt(Math.ceil(S.sess.timer.remaining(vnow() / 1000))));

    let c;
    if ((c = C.begin(cv.orbCanvas))) C.orb(c, { score: S.scoreShown, calibrating: cal && ph === 'session', calibProgress: S.calm.calibProgress, threshold: S.threshold, time: t, beat: S.beat, birds: S.birdsOn ? 1 + Math.round(S.birdLevel * 4) : 0, active: live && ph === 'session', session: sessRing });
    { const n = S.calmHist.count; setText('sparkRange', n < 60 ? (n ? 'last ' + n + ' s' : 'during sessions') : 'last ' + Math.min(5, Math.ceil(n / 60)) + ' min'); }
    if ((c = C.begin(cv.calmSpark))) C.spark(c, S.calmHist.latest(SPARK), S.threshold, C.calmColor(S.scoreShown === null ? 60 : S.scoreShown));
    if ((c = C.begin(cv.eegCanvas))) C.traces(c, [0, 1, 2, 3].map((i) => ({ data: S.eegView[i].latest(EEG_VIEW), color: CH_COLORS[i], label: P.EEG_NAMES[i], range: S.eegRange })), EEG_VIEW);
    if ((c = C.begin(cv.barsCanvas))) C.bars(c, BANDS.map((b) => ({ sym: b.sym, name: b.name, value: S.relShown[b.key], color: b.color })), 1 / 0.6);
    if ((c = C.begin(cv.histCanvas))) {
      const n = S.bandHist.alpha.count, cap = clamp(n, 120, HIST), span = cap / 4;
      C.history(c, BANDS.map((b) => ({ data: S.bandHist[b.key].latest(HIST), color: b.color, width: b.key === 'alpha' ? 2.4 : 1.3, fill: b.key === 'alpha' })), cap, 0.6,
        [span >= 60 ? (span / 60).toFixed(span % 60 ? 1 : 0) + ' min ago' : Math.round(span) + ' s ago', 'now']);
    }
    if ((c = C.begin(cv.ppgCanvas))) { if (S.ppgCount > 64) C.wave(c, S.hr.waveform(64 * 6), [251, 113, 133], waveState); }
    if ((c = C.begin(cv.tiltCanvas))) C.horizon(c, live ? S.pitch : 0, live ? S.roll : 0);
    if ((c = C.begin(cv.imuCanvas))) {
      const gyrMax = Math.max(20, ...S.gyr.map((r) => { let m = 0; const d = r.latest(IMU_VIEW); for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); return m; }));
      let accMax = 0.03;
      const accC = S.acc.map((r) => { const d = r.latest(IMU_VIEW); let m = 0; for (let i = 0; i < d.length; i++) m += d[i]; m /= d.length || 1; for (let i = 0; i < d.length; i++) { d[i] -= m; accMax = Math.max(accMax, Math.abs(d[i])); } return d; });
      C.traces(c, [
        { data: S.acc[0].latest(2), multi: accC.map((d, i) => ({ data: d, color: XYZ[i] })), color: [200, 220, 235], label: 'Accel', sub: (c.w < 260 ? '' : 'x y z around rest · ') + '±' + accMax.toFixed(2) + ' g', range: accMax * 1.1, width: 1.2 },
        { data: S.gyr[0].latest(2), multi: S.gyr.map((r, i) => ({ data: r.latest(IMU_VIEW), color: XYZ[i] })), color: [200, 220, 235], label: 'Gyro', sub: '±' + Math.round(gyrMax) + ' °/s', range: gyrMax * 1.1, width: 1.2 },
      ], IMU_VIEW);
    }
    if (!$('summaryModal').hidden && S.summaryShown) drawSummary(S.summaryShown, t);
    if (!$('detailModal').hidden && DT.entry) drawDetail();
    requestAnimationFrame(frame);
  }
  function drawSummary(sum, t) {
    let c;
    if ((c = C.begin($('sumChart')))) C.sessionChart(c, sum.series, sum.threshold, [94, 234, 212]);
    if ((c = C.begin($('sumRing')))) {
      S.ringAnim = Math.min(1, (S.ringAnim || 0) + 0.02);
      ring(c, sum.calmShare || 0, 1 - Math.pow(1 - S.ringAnim, 3));
    }
  }

  /* ---------------- audio ---------------- */
  function unlockAudio() {
    // no audio before the first real tap/click/key (avoids the browser's autoplay warning; iOS needs the gesture anyway)
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    if (ua && !ua.hasBeenActive) return;
    if (birds.unlock()) {
      scapes.init(birds.ctx);
      birds.setVolume(prefs.birdVol / 100); scapes.setChimeVolume(prefs.birdVol / 100); scapes.setVolume(prefs.scapeVol / 100);
      birds.setMuted(prefs.muted); scapes.setMuted(prefs.muted); scapes.setPinkBed(prefs.pinkBed);
      if (birds.ctx.state !== 'running' && birds.ctx.state !== 'closed') birds.ctx.resume().catch(() => {});
    }
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, () => { unlockAudio(); }, { capture: true, passive: true }));
  birds.onSong = () => { if (S.sess && !S.dropActive) S.sess.stats.songs++; spawnBird(); };
  const birdSvg = '<svg viewBox="0 0 26 16"><path d="M1 9 Q7 1 13 8 Q19 1 25 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function spawnBird() {
    const layer = $('birdLayer');
    if (layer.children.length > 5 || document.hidden) return;
    const el = document.createElement('div'); el.className = 'fly'; el.innerHTML = birdSvg;
    const side = Math.random() < 0.5 ? -1 : 1;
    el.style.left = (50 + side * (22 + Math.random() * 14)) + '%';
    el.style.top = (30 + Math.random() * 40) + '%';
    el.style.setProperty('--dx', (side * (50 + Math.random() * 70)) + 'px');
    el.style.setProperty('--dy', (-50 - Math.random() * 70) + 'px');
    if (side < 0) el.querySelector('svg').style.transform = 'scaleX(-1)';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 5600);
  }
  setInterval(() => birds.tick(), 180);

  /* ---------------- connection ---------------- */
  function startFresh() {
    sim.stop(); resetData(); S.battery = null; $('batteryPill').hidden = true; waveState.lo = waveState.hi = undefined;
  }
  async function connect() {
    unlockAudio();
    if (!window.MuseBLE.supported()) {
      toast(window.isSecureContext === false
        ? 'Web Bluetooth needs a secure page (https:// or http://localhost). Open the app from the local server.'
        : 'This browser has no Web Bluetooth. Use Chrome or Edge on Windows/Mac/Android, or the Bluefy browser on iPhone.', true);
      return;
    }
    startFresh();
    setMode('connecting');
    try {
      await ble.requestAndConnect();
    } catch (e) {
      console.warn(e);
      if (e && e.name === 'NotFoundError') { setMode('idle'); toast('No headband chosen. Make sure the Muse is switched on (lights sweeping) and try again.'); }
      else if (e && e.name === 'SecurityError') { setMode('error'); toast('Bluetooth permission was blocked. Allow Bluetooth for this site and try again.', true); }
      else { setMode('error'); toast('Could not connect: ' + ((e && e.message) || e) + '. Is the Muse on, and not connected to another app or phone?', true); }
    }
  }
  let reconnecting = false;
  async function autoReconnect() {
    if (reconnecting) return; reconnecting = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      setMode('reconnecting', { attempt });
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      if (ble.userDisconnect) break;
      try { await ble.connect(); reconnecting = false; toast(S.sess ? 'Reconnected. Press Resume to continue your session.' : 'Reconnected. Welcome back.'); return; }
      catch (e) { console.warn('reconnect failed', e); }
    }
    reconnecting = false;
    if (!ble.userDisconnect) setMode('lost');
  }
  function onStatus(state, info) {
    if (state === 'connecting') { if (S.mode !== 'reconnecting') setMode('connecting', info); }
    else if (state === 'streaming') { S.hasPPG = info.ppg !== false; S.device = info.name || S.device; setMode('live', info); }
    else if (state === 'stalled') toast('Data paused. Restarting the stream…');
    else if (state === 'lost') { if (!reconnecting) autoReconnect(); }
    else if (state === 'disconnected') setMode('idle');
  }
  async function leave() {
    if (S.sess) finishSession(false);
    if (S.mode === 'demo') { sim.stop(); setMode('idle'); return; }
    await ble.disconnect(); setMode('idle');
  }

  /* ---------------- controls ---------------- */
  $('connectBtn').addEventListener('click', connect);
  $('reconnectBtn').addEventListener('click', async () => {
    unlockAudio();
    try { if (ble.device) { setMode('reconnecting'); await ble.connect(); } else await connect(); }
    catch (e) { setMode('lost'); toast('Still can\u2019t reach the headband. Switch it off and on, then try again.', true); }
  });
  $('leaveBtn').addEventListener('click', leave);
  $('demoBtn').addEventListener('click', () => { unlockAudio(); startFresh(); S.device = 'Demo'; sim.start(); setMode('demo'); });
  $('startBtn').addEventListener('click', () => startSession(false));
  $('startAnyway').addEventListener('click', () => { if (S.contact.progress < 1) toast('Starting without a full fit check. Loose sensors are left out of scoring.'); startSession(S.contact.progress < 1); });
  $('pauseBtn').addEventListener('click', togglePause);
  $('endBtn').addEventListener('click', () => finishSession(false));
  $('sumDone').addEventListener('click', () => { $('summaryModal').hidden = true; S.ringAnim = 0; });
  $('summaryModal').addEventListener('click', (e) => { if (e.target === $('summaryModal')) { $('summaryModal').hidden = true; S.ringAnim = 0; } });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('detailModal').hidden) closeDetail();
    else if (!$('summaryModal').hidden) { $('summaryModal').hidden = true; S.ringAnim = 0; }
  });
  $('clearHist').addEventListener('click', () => { if (confirm('Clear all saved sessions (and their brainwave history) on this device?')) { store.clearHistory(); renderPast(); } });
  $('recalBtn').addEventListener('click', () => { if (!S.sess) return; S.calm.reset(); S.sess.guard.skipped = []; S.birdsOn = false; S.calmHist.clear(); toast('Recalibrating your baseline for ' + CALIB_SECONDS + ' seconds.'); });
  $('previewBtn').addEventListener('click', () => { unlockAudio(); birds.previewSong(); spawnBird(); });
  $('simDropBtn').addEventListener('click', () => { const ch = (Math.random() * 4) | 0; sim.dropSensor(ch, 6); toast('Demo: ' + K.SENSORS[ch].where + ' sensor (' + K.SENSORS[ch].name + ') slips for 6 s.'); });
  $('recenterBtn').addEventListener('click', () => { if (S.g) S.gRef = S.g.slice(); });

  // durations
  const durBtns = Array.from(document.querySelectorAll('#durSeg button')), custom = $('durCustom');
  function paintDur() {
    const preset = !prefs.custom && durBtns.some((b) => +b.dataset.min === prefs.duration);
    durBtns.forEach((b) => b.classList.toggle('on', preset && +b.dataset.min === prefs.duration));
    custom.classList.toggle('on', !preset);
    if (!preset && document.activeElement !== custom) custom.value = prefs.duration;
    if (preset && document.activeElement !== custom) custom.value = '';
  }
  durBtns.forEach((b) => b.addEventListener('click', () => { prefs.duration = +b.dataset.min; prefs.custom = false; savePrefs(); paintDur(); }));
  custom.addEventListener('input', () => { const v = Math.round(+custom.value); if (v >= 1 && v <= 180) { prefs.duration = v; prefs.custom = true; savePrefs(); paintDur(); } });
  custom.addEventListener('blur', paintDur);
  $('bellSel').value = String(prefs.bells);
  $('bellSel').addEventListener('change', () => { prefs.bells = +$('bellSel').value; savePrefs(); });

  // soundscapes
  document.querySelectorAll('#scapeTiles button, #freqTiles button').forEach((b) => b.addEventListener('click', () => {
    unlockAudio(); clearTimeout(fadeTimer);
    prefs.soundscape = b.dataset.id; savePrefs();
    scapes.select(prefs.soundscape, 3);
    updateScapeUi();
  }));
  $('scapePlay').addEventListener('click', () => {
    unlockAudio(); clearTimeout(fadeTimer);
    if (scapes.playing) scapes.fadeOut(1.5);
    else if (prefs.soundscape === 'none') toast('Pick a soundscape to play.');
    else scapes.select(prefs.soundscape, 2);
    updateScapeUi();
  });
  $('pinkChk').checked = prefs.pinkBed;
  $('pinkChk').addEventListener('change', () => { prefs.pinkBed = $('pinkChk').checked; savePrefs(); scapes.setPinkBed(prefs.pinkBed); });

  // volumes, threshold, mute
  const paintRange = (el) => el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%');
  const vol = $('volume'), svol = $('scapeVol'), thr = $('threshold');
  vol.value = prefs.birdVol; svol.value = prefs.scapeVol; thr.value = prefs.threshold; setText('thresholdVal', prefs.threshold);
  vol.addEventListener('input', () => { prefs.birdVol = +vol.value; birds.setVolume(vol.value / 100); scapes.setChimeVolume(vol.value / 100); paintRange(vol); if (+vol.value > 0 && prefs.muted) toggleMute(false); savePrefs(); });
  svol.addEventListener('input', () => { prefs.scapeVol = +svol.value; scapes.setVolume(svol.value / 100); paintRange(svol); savePrefs(); });
  thr.addEventListener('input', () => { S.threshold = prefs.threshold = +thr.value; setText('thresholdVal', thr.value); paintRange(thr); savePrefs(); });
  [vol, svol, thr].forEach(paintRange);
  function toggleMute(force) {
    const m = typeof force === 'boolean' ? force : !prefs.muted;
    prefs.muted = m; savePrefs();
    birds.setMuted(m); scapes.setMuted(m);
    $('muteBtn').classList.toggle('muted', m);
    $('iconSound').hidden = m; $('iconMuted').hidden = !m;
  }
  $('muteBtn').addEventListener('click', () => toggleMute());
  toggleMute(prefs.muted);
  const legendHtml = (bands) => bands.map((b) => '<button type="button" class="lg" data-explain="' + b.key + '"><i style="background:' + b.hex + '"></i>' + b.name + '</button>').join('');
  $('legend').innerHTML = legendHtml(BANDS);
  window.Explain.prep($('legend'));
  paintDur();

  /* keep the screen awake during a session (phones) */
  let wakeLock = null;
  async function requestWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); } } catch (_) {} }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && streaming()) requestWakeLock(); });

  setInterval(analyze, 250);
  setMode('idle');
  renderPast();
  requestAnimationFrame(frame);
  /* desktop: movable / resizable tiles (js/layout.js); popovers close while editing, sessions keep running */
  const layout = window.MuseLayout ? window.MuseLayout.init({ storage, onEdit: (on) => {
    if (!on) return;
    $('hero').classList.remove('more-open'); $('moreBtn').setAttribute('aria-expanded', 'false'); window.Explain.close();
  } }) : null;
  if (params.has('demo')) $('demoBtn').click();
  window.__museCalm = { S, birds, scapes, sim, ble, store, prefs, SPEED, vnow, startSession, finishSession, openDetail, closeDetail, DT, renderPast, layout };   // for debugging / tests
})();

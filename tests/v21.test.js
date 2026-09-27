// v2.1: 40 s baseline in every session, per-session timeline (recording / downsampling / pruning), old-session compatibility
const assert = require('assert');
const D = require('../js/dsp.js'), Sn = require('../js/session.js'), K = require('../js/contact.js');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ok -', m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* Mirrors the session branch of app.js analyze(): blend -> baseline guard / scoring -> stats + timeline. */
function runSession(opt) {
  const dt = 0.25, dur = opt.dur, timer = new Sn.SessionTimer(dur, 0), stats = new Sn.SessionStats(60, 5);
  const calm = new D.CalmEngine({ calibSeconds: 40 }), blend = new D.ChannelBlend(4, 5), guard = new Sn.BaselineGuard(30);
  const drop = new K.DropoutMonitor({ poorSec: 3, recoverSec: 1 }), tl = new Sn.Timeline(2);
  const trace = { doneAt: null, prog: {}, pausedReasons: new Set() };
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  timer.start(0);
  for (let t = 0; t < dur - 1e-9 && (opt.endAt === undefined || t < opt.endAt - 1e-9); t += dt) {
    const e = opt.frame ? opt.frame(t) : {}, lost = e.lost || [], blink = e.blink || [], dead = opt.dead || [];
    const aboveBase = t > 60 ? 0.08 : 0;
    const rels = [0, 1, 2, 3].map((i) => (dead.includes(i) || lost.includes(i) ? null : { delta: 0.3, theta: 0.2, alpha: 0.22 + aboveBase + 0.01 * rnd(), beta: 0.18, gamma: 0.1 }));
    const usable = [0, 1, 2, 3].map((i) => !!rels[i] && !blink.includes(i));
    const states = [0, 1, 2, 3].map((i) => (dead.includes(i) || lost.includes(i) ? 'poor' : 'good'));
    const d = drop.update(guard.maskStates(states), dt), bl = blend.update(rels, usable, dt);
    const valid = !!bl.mean && !(e.motion > 0), wasCal = calm.calibrating;
    let scoring = false, baseOk = false;
    if (wasCal) { const g = guard.update({ bl, usable, states, stale: !!e.stale, motion: e.motion || 0 }, dt); baseOk = g.ok; if (!g.ok) trace.pausedReasons.add(g.reason); if (baseOk) calm.update(bl.mean, true, dt); }
    else { guard.observe(usable); scoring = !d.active && valid; if (scoring) calm.update(bl.mean, true, dt); }
    const calNow = calm.calibrating;
    if (wasCal && !calNow) trace.doneAt = t + dt;
    stats.add(dt, { scoring, calibrating: calNow, excluded: !calNow && !scoring, score: calm.score, bpm: 62 });
    tl.add(dt, { rel: bl.mean, calm: !calNow && scoring ? calm.score : null, hr: 62, baseline: calNow || (wasCal && !calNow), excluded: calNow ? !baseOk : !scoring });
    trace.prog[t.toFixed(2)] = calm.calibProgress;
  }
  return { sum: stats.summary(), tl, calm, trace, guard };
}

console.log('40 s baseline at the start of every session');
{ ok(new D.CalmEngine().calibSeconds === 40, 'default calibration is 40 s');
  const r = runSession({ dur: 600 });
  ok(near(r.trace.doneAt, 40, 0.3), `clean 10-min session: baseline done at ${r.trace.doneAt} s`);
  ok(r.sum.duration === 600 && near(r.sum.baselineT, 40, 1) && near(r.sum.scoredT, 560, 1), `baseline counts inside the 10 min (${r.sum.baselineT} s baseline + ${r.sum.scoredT} s scored = 9:20)`);
  ok(r.sum.calmShare !== null && near(r.sum.calmShare, r.sum.calmT / r.sum.scoredT, 0.005) && r.sum.calmT <= r.sum.scoredT, 'calm share uses scored time only (baseline excluded)');
  ok(r.sum.baselineDone === true && Sn.saveable(r.sum), 'finished baseline -> session is saveable');
  const series = r.sum.series; ok(series.slice(0, 8).every((p) => p.cal && p.v === null), 'no score / calm time during the baseline (summary chart shows it as baseline)');
}
{ const r = runSession({ dur: 300, frame: (t) => ({ lost: t >= 10 && t < 20 ? [1] : [] }) });
  ok(near(r.trace.doneAt, 50, 0.3), `AF7 contact lost 10-20 s: baseline pauses and finishes at ${r.trace.doneAt} s (not 40)`);
  ok(r.trace.prog['12.00'] === r.trace.prog['19.75'] && r.trace.prog['12.00'] > 0, 'baseline progress frozen during the whole loss, also after the 5 s channel hold expires');
  ok(r.trace.pausedReasons.has('contact'), 'pause reason reported as contact (UI names the sensor)');
  const pts = r.tl.finish().pts; ok(pts.slice(5, 10).every((p) => p.f === 3) && pts.slice(0, 5).every((p) => p.f === 1), 'timeline marks 10-20 s as baseline + excluded');
}
{ const r = runSession({ dur: 300, frame: (t) => ({ blink: Math.floor(t) % 5 === 0 ? [1, 2] : [] }) });
  ok(near(r.trace.doneAt, 40, 0.3), `frequent blinks do not stall the baseline (done at ${r.trace.doneAt} s)`);
}
{ const r = runSession({ dur: 300, frame: (t) => ({ motion: t >= 5 && t < 8 ? 40 : 0 }) });
  ok(near(r.trace.doneAt, 43, 0.3) && r.trace.pausedReasons.has('motion'), `head movement pauses the baseline (done at ${r.trace.doneAt} s)`);
}
{ const r = runSession({ dur: 300, frame: (t) => ({ lost: t >= 10 ? [0] : [] }) });
  ok(near(r.trace.doneAt, 70, 0.5) && r.guard.skipped.includes(0), `sensor lost for good at 10 s: waits 30 s, then continues without it (done at ${r.trace.doneAt} s)`);
}
{ const r = runSession({ dur: 300, dead: [3] });
  ok(near(r.trace.doneAt, 40, 0.3) && r.sum.scoredT > 250, `"Start anyway" with a sensor that never had contact: baseline + scoring still run (${r.sum.scoredT} s scored)`);
}
{ const r = runSession({ dur: 60 });
  ok(near(r.trace.doneAt, 40, 0.3) && near(r.sum.scoredT, 20, 1) && Sn.saveable(r.sum), '1-min session: 40 s baseline + 20 s scored, saved');
  const e = runSession({ dur: 600, endAt: 30 });
  ok(e.sum.baselineDone === false && e.sum.calmShare === null && e.sum.calmT === 0 && !Sn.saveable(e.sum), 'ended during baseline: no calm stats and not saved');
  const lost = runSession({ dur: 60, frame: (t) => ({ lost: t >= 5 && t < 40 ? [2] : [] }) });
  ok(!lost.sum.baselineDone && lost.sum.calmShare === null && !Sn.saveable(lost.sum), 'short session whose baseline never finished (contact loss): handled like ending during baseline');
}

console.log('Timeline recording and downsampling');
{ const r = runSession({ dur: 600 }), packed = r.tl.finish().pack(900);
  ok(packed.v === 1 && packed.n === 300 && packed.step === 2, `10-min session: ${packed.n} points every ${packed.step} s`);
  const u = Sn.unpackTimeline(packed);
  ok(u.length === 300 && u[0].baseline && !u[0].excluded && u[0].calm === null && !u[25].baseline && u[25].calm !== null && u[25].hr === 62, 'unpacked points carry phase, calm, heart rate');
  ok(near(u[100].rel.alpha, 0.30, 0.01) && near(u[5].rel.alpha, 0.22, 0.01) && near(Object.values(u[5].rel).reduce((a, b) => a + b, 0), 1.0, 0.01), 'relative band powers survive the per-mille encoding');
  ok(near(u[299].t, 598, 1e-9), 'time axis in active session seconds');
}
{ const tl = new Sn.Timeline(2); let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 180 * 60; t += 0.25) tl.add(0.25, { rel: { delta: rnd() * 0.4, theta: rnd() * 0.3, alpha: rnd() * 0.4, beta: rnd() * 0.3, gamma: rnd() * 0.2 }, calm: t < 40 ? null : 30 + rnd() * 70, hr: 55 + rnd() * 30, baseline: t < 40, excluded: Math.floor(t / 60) % 17 === 3 });
  const p = tl.finish().pack(900), json = JSON.stringify(p);
  ok(tl.pts.length === 5400 && p.n === 900 && p.step === 12, `180-min session: 5400 raw points -> ${p.n} points every ${p.step} s`);
  ok(json.length < 40000, `180-min timeline is ${(json.length / 1024).toFixed(1)} KB (target well under 100 KB)`);
  const u = Sn.unpackTimeline(p);
  ok(u[0].baseline && u[2].baseline && !u[3].baseline, 'baseline flag survives downsampling (40 s = the first 3 points at 12 s; majority rule per point)');
  ok(u.filter((x) => x.excluded).length === 55, 'dropout stretches survive downsampling (11 one-minute gaps -> 55 points)');
  const tl2 = new Sn.Timeline(2); for (let t = 0; t < 100; t += 0.5) tl2.add(0.5, { rel: null, calm: null, hr: null, baseline: false, excluded: true });
  const u2 = Sn.unpackTimeline(tl2.finish().pack());
  ok(u2.every((x) => x.rel === null && x.calm === null && x.hr === null && x.excluded), 'frames without clean data become gaps (null), not zeros');
}
{ const good = new Sn.Timeline(2); for (let i = 0; i < 40; i++) good.add(0.5, { rel: { delta: .2, theta: .2, alpha: .2, beta: .2, gamma: .2 }, calm: 50, hr: 60 }); const p = good.finish().pack();
  const bad = [null, 7, { v: 2 }, Object.assign({}, p, { c: p.c.slice(1) }), Object.assign({}, p, { n: 1e6 }), Object.assign({}, p, { step: -2 }), Object.assign({}, p, { a: 'xx' })];
  ok(bad.every((b) => Sn.unpackTimeline(b) === null) && Sn.unpackTimeline(p).length === 10, 'malformed / tampered timelines are rejected (no crash)');
  const odd = JSON.parse(JSON.stringify(p)); odd.c[0] = 'x'; odd.c[1] = 900; odd.a[2] = null;
  const uo = Sn.unpackTimeline(odd); ok(uo[0].calm === null && uo[1].calm === 100 && uo[2].rel === null, 'bad values inside a timeline are coerced (null / clamped)');
}

{ const tl = new Sn.Timeline(2);                                // irregular / coarse frames (throttled tab, x6 demo): exact 2 s points
  for (let t = 0; t < 120 - 1e-9; t += 1.5) tl.add(1.5, { rel: null, calm: t < 60 ? 20 : 80, hr: null, baseline: false, excluded: false });
  const u = Sn.unpackTimeline(tl.finish().pack());
  ok(u.length === 60 && u[29].calm === 20 && u[30].calm === 80, `samples crossing a bucket edge are split: 120 s in 1.5 s frames -> ${u.length} points, change lands at 60 s`);
  const j = new Sn.Timeline(2); let seed = 3, tot = 0; while (tot < 600) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const d = 0.2 + 0.1 * seed / 0x7fffffff; j.add(d, { rel: null, calm: 50 }); tot += d; }
  ok(Math.abs(j.finish().pts.length - tot / 2) <= 1, `jittered 0.2-0.3 s frames: ${j.pts.length} points for ${tot.toFixed(1)} s`);
}

console.log('Storage: timelines, pruning, quota, old sessions');
function mockStorage(limit) {
  const m = new Map(); let used = 0;
  return { m, get used() { return used; }, getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => { if (m.has(k)) { used -= m.get(k).length; m.delete(k); } },
    setItem(k, v) { v = String(v); const nu = used - (m.has(k) ? m.get(k).length : 0) + v.length; if (limit && nu > limit) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } used = nu; m.set(k, v); } };
}
const mkTl = (mins) => { const tl = new Sn.Timeline(2); for (let t = 0; t < mins * 60; t += 1) tl.add(1, { rel: { delta: .21, theta: .19, alpha: .3, beta: .2, gamma: .1 }, calm: t < 40 ? null : 55, hr: 61, baseline: t < 40 }); return tl.finish().pack(900); };
const entry = (date, extra) => Object.assign({ date, kind: 'real', planned: 600, duration: 600, completed: true, calmT: 300, calmShare: 0.53, longest: 90, avgHr: 61, minHr: 57, songs: 4, threshold: 65, v: 2.1, series: [50, 60, null, 70] }, extra);
{ const st = mockStorage(), s = Sn.makeStore(st);
  const r = s.addSession(entry(1000), mkTl(10));
  ok(r.saved && r.timeline && r.id === '1000', 'session + timeline saved');
  const h = s.history(); ok(h.length === 1 && h[0].tl === true && h[0].id === '1000' && s.timeline('1000').n === 300, 'history entry references its timeline; timeline loads by id');
  ok(st.getItem('muse-calm:v2:tl-1000').length < 12000, 'timeline stored under its own key (history list stays small)');
  s.deleteSession('1000'); ok(s.history().length === 0 && st.getItem('muse-calm:v2:tl-1000') === null, 'per-session delete removes the entry and its timeline');
}
{ const st = mockStorage(), s = Sn.makeStore(st, { tlMax: 3 });
  for (let i = 1; i <= 5; i++) s.addSession(entry(i * 1000), mkTl(5));
  const h = s.history();
  ok(h.length === 5 && h.slice(0, 3).every((e) => e.tl) && h.slice(3).every((e) => !e.tl && e.tlPruned), 'count cap: oldest timelines pruned first, all 5 summaries kept');
  ok(st.getItem('muse-calm:v2:tl-1000') === null && st.getItem('muse-calm:v2:tl-2000') === null && s.timeline('5000') !== null, 'pruned timeline keys are really removed');
  s.clearHistory(); ok(s.history().length === 0 && [...st.m.keys()].every((k) => !k.includes(':tl-')), 'Clear removes every timeline too');
}
{ const st = mockStorage(), one = JSON.stringify(mkTl(60)).length, s = Sn.makeStore(st, { tlBudget: one * 2.5 });
  for (let i = 1; i <= 4; i++) s.addSession(entry(i * 1000), mkTl(60));
  ok(s.timelineBytes() <= one * 2.5 && s.history().filter((e) => e.tl).length === 2, `size budget: timelines kept under the cap (${s.timelineBytes()} chars)`);
}
{ const st = mockStorage(60000), s = Sn.makeStore(st);          // tiny quota: ~3 timelines fit
  let threw = false, results = [];
  try { for (let i = 1; i <= 8; i++) results.push(s.addSession(entry(i * 1000), mkTl(180))); } catch (e) { threw = true; }
  const h = s.history();
  ok(!threw && results.every((r) => r.saved) && h.length === 8, 'QuotaExceeded: no exception, every summary saved');
  ok(h[0].tl && s.timeline('8000') !== null && h.some((e) => e.tlPruned), 'QuotaExceeded: older timelines make room for the newest');
  ok(st.used <= 60000, 'storage stays within quota');
}
{ const st = mockStorage(3000), s = Sn.makeStore(st);           // quota smaller than one timeline
  const r = s.addSession(entry(1000), mkTl(180));
  ok(r.saved && !r.timeline && s.history()[0].tl === false && s.history()[0].calmShare === 0.53, 'timeline that cannot fit is skipped; the summary survives');
}
{ const st = mockStorage(), s = Sn.makeStore(st);
  for (let i = 1; i <= 52; i++) s.addSession(entry(i * 1000), mkTl(1));
  ok(s.history().length === 50 && st.getItem('muse-calm:v2:tl-1000') === null && st.getItem('muse-calm:v2:tl-2000') === null && s.timeline('52000') !== null, '50-session history cap also deletes the evicted timelines');
}
{ const st = mockStorage(), s = Sn.makeStore(st);
  const old = { date: 500, kind: 'real', planned: 600, duration: 600, completed: true, calmT: 200, calmShare: 0.4, longest: 60, avgHr: 64, minHr: 60, songs: 2, threshold: 65, series: [40, 50, 60] };   // v2.0.x entry: no id, no timeline
  st.setItem('muse-calm:v2:history', JSON.stringify([old]));
  ok(s.session('500') !== null && s.session('500').calmShare === 0.4 && s.timeline('500') === null, 'v2.0 session (no id, no timeline) opens by date with its stats; timeline is null');
  s.addSession(entry(2000), mkTl(5));
  const h = s.history(); ok(h.length === 2 && h[1].date === 500 && h[1].series.length === 3 && !h[1].tl, 'adding new sessions keeps old entries intact');
  s.deleteSession('500'); ok(s.history().length === 1 && s.history()[0].id === '2000', 'old sessions can be deleted individually');
  const legacy = Sn.makeStore(st); legacy.addHistory({ date: 9, duration: 30 });
  ok(Sn.makeStore(st).history().length === 2, 'legacy addHistory still works');
}
console.log(`\n${pass} v2.1 tests passed`);

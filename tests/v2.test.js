const assert = require('assert');
const C = require('../js/contact.js');
const Sn = require('../js/session.js');
const D = require('../js/dsp.js');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ok -', m); };
const near = (a, b, e) => Math.abs(a - b) <= e;

console.log('Contact metric');
{ // robust std ignores a blink that plain std does not
  const fs = 256, x = [];
  let seed = 3; const g = () => { let u = 0; for (let i = 0; i < 12; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; u += seed / 0x7fffffff; } return u - 6; };
  for (let i = 0; i < 512; i++) { const t = i / fs; x.push(10 * g() + (t > 0.8 && t < 1.15 ? 140 * Math.sin(Math.PI * (t - 0.8) / 0.35) ** 2 : 0)); }
  const plain = D.stats(x).std, rob = D.robustStd(x);
  ok(plain > 30 && rob < 14, `blink: plain std ${plain.toFixed(1)} uV (would flip to fair) vs robust ${rob.toFixed(1)} uV (stays good)`);
}
ok(C.classify(20, 0.5, 'off') === 'good' && C.classify(30, 0.5, 'off') === 'fair' && C.classify(30, 0.5, 'good') === 'good', 'hysteresis: 30 uV cannot enter good but can stay good');
ok(C.classify(60, 0, 'fair') === 'fair' && C.classify(60, 0, 'poor') === 'poor' && C.classify(80, 0, 'fair') === 'poor', 'hysteresis: poor enters >70, leaves only <50');
ok(C.classify(10, 8, 'good') === 'poor' && C.classify(10, 2, 'off') === 'fair' && C.classify(0, 0, 'good') === 'off', 'mains noise and flat line classification');
{ const s = new C.SensorContact(); let t = 0;
  for (; t < 0.7; t += 0.25) s.update(15, 0, 0.25);
  const early = s.state; for (; t < 1.0; t += 0.25) s.update(15, 0, 0.25);
  ok(early === 'off' && s.state === 'good', 'debounce: good only after ~1 s of good readings');
  // single-tick spikes (flicker) must not change state
  for (let k = 0; k < 20; k++) s.update(k % 3 === 0 ? 95 : 15, 0, 0.25);
  ok(s.state === 'good', 'isolated poor spikes (1 in 3 ticks) do not flip a good sensor');
  // values hovering around the good threshold do not flicker
  const seen = new Set(); for (let k = 0; k < 40; k++) seen.add(s.update(k % 2 ? 24 : 31, 0, 0.25));
  ok(seen.size === 1 && s.state === 'good', 'values oscillating 24/31 uV around the 25 uV entry threshold stay good (no flicker)');
  for (let k = 0; k < 6; k++) s.update(120, 0, 0.25);
  ok(s.state === 'poor', 'sustained 120 uV -> poor within ~1.5 s'); }

console.log('Fit gate');
{ const g = new C.ContactGate({ holdSec: 5 }); let r, t = 0;
  const run = (stds, secs) => { for (let k = 0; k < secs * 4; k++) { r = g.update(stds, [0, 0, 0, 0], 0.25); t += 0.25; } };
  run([12, 12, 12, 90], 3); ok(!r.passed && r.states[3] === 'poor', 'gate closed while TP10 is poor');
  run([12, 12, 12, 12], 4); ok(!r.passed && r.progress > 0.4 && r.progress < 0.8, `gate progressing after sensors settle (progress ${(r.progress * 100).toFixed(0)}%)`);
  run([12, 12, 45, 12], 1.5); ok(!r.passed && r.progress === 0, 'AF8 dropping to fair resets the 5 s hold');
  run([12, 12, 12, 12], 5.5); ok(!r.passed, 'needs debounce + full 5 s again');
  run([12, 12, 12, 12], 1); ok(r.passed, 'passes after all four good continuously for 5 s');
  ok(C.hint(0, 'poor', 0).includes('left ear') && C.hint(2, 'poor', 0).includes('right forehead') && C.hint(3, 'fair', 0).includes('right ear'), 'per-sensor hints name the right sensor'); }

console.log('Dropout monitor');
{ const m = new C.DropoutMonitor({ poorSec: 3, recoverSec: 1 }); let r;
  const run = (st, secs) => { for (let k = 0; k < secs * 4; k++) r = m.update(st, 0.25); };
  run(['good', 'good', 'poor', 'good'], 2.5); ok(!r.active, 'poor for 2.5 s: no banner yet');
  run(['good', 'good', 'poor', 'good'], 1); ok(r.active && r.dropped[0] === 2, 'poor > 3 s: AF8 flagged, scoring paused');
  run(['good', 'good', 'fair', 'good'], 0.5); ok(r.active, 'stays flagged until recovered for 1 s');
  run(['good', 'good', 'good', 'good'], 1); ok(!r.active, 'clears after recovery'); }

console.log('Session timer');
{ const tm = new Sn.SessionTimer(600, 0); tm.start(100);
  ok(near(tm.remaining(160), 540, 1e-9), 'remaining counts down');
  tm.pause(200); ok(tm.elapsed(500) === 100 && tm.state === 'paused', 'paused time does not count');
  tm.resume(500); ok(tm.elapsed(550) === 150, 'resume continues from paused elapsed');
  ok(tm.tick(900).length === 0 && tm.tick(1000.1).includes('complete') && tm.state === 'done' && tm.elapsed(2000) === 600, 'completes exactly at duration (pause excluded)'); }
{ const tm = new Sn.SessionTimer(600, 2); tm.start(0); const bells = [];
  for (let t = 0; t <= 601; t += 0.5) tm.tick(t).forEach((e) => bells.push([e, t]));
  const b = bells.filter((x) => x[0] === 'bell').map((x) => x[1]);
  ok(JSON.stringify(b) === JSON.stringify([120, 240, 360, 480]) && bells[bells.length - 1][0] === 'complete', 'interval bells every 2 min (none at the end), then complete'); }
{ const tm = new Sn.SessionTimer(300, 0); tm.start(0); tm.end(95); ok(tm.state === 'done' && tm.elapsed(1e9) === 95, 'end early keeps elapsed'); }

console.log('Session stats');
{ const st = new Sn.SessionStats(65, 5);
  for (let i = 0; i < 45; i++) st.add(1, { scoring: true, calibrating: true, score: 50, bpm: 70 });
  for (let i = 0; i < 60; i++) st.add(1, { scoring: true, score: i < 40 ? 80 : 50, bpm: 64 });
  for (let i = 0; i < 10; i++) st.add(1, { scoring: false, excluded: true, score: 30, bpm: 63 });
  for (let i = 0; i < 20; i++) st.add(1, { scoring: true, score: 70, bpm: 62 });
  const s = st.summary();
  ok(s.duration === 135 && s.calmT === 60 && s.scoredT === 80, `calm time 60 s of 80 scored s (calibration + 10 s poor contact excluded)`);
  ok(near(s.calmShare, 0.75, 1e-9) && s.longest === 40, 'calm share 75%, longest streak 40 s');
  ok(s.minHr === 62 && s.avgHr === Math.round((70 * 45 + 64 * 60 + 63 * 10 + 62 * 20) / 135), `avg HR ${s.avgHr}, min HR ${s.minHr}`);
  ok(s.series.length === 27 && s.series[0].cal && s.series[0].v === null && s.series[10].v === 80, 'series every 5 s, calibration flagged');
  const ds = Sn.downsample(s.series, 10); ok(ds.length === 10, 'downsample for storage'); }
{ // excluded time must not break a calm streak
  const st = new Sn.SessionStats(65, 5);
  for (let i = 0; i < 20; i++) st.add(1, { scoring: true, score: 80 });
  for (let i = 0; i < 8; i++) st.add(1, { scoring: false, excluded: true, score: 20 });
  for (let i = 0; i < 20; i++) st.add(1, { scoring: true, score: 80 });
  ok(st.summary().longest === 40, 'poor-contact gap pauses (does not reset) the calm streak'); }

console.log('Persistence');
{ const mem = new Map(); const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const st = Sn.makeStore(storage);
  st.savePrefs({ duration: 15, soundscape: 'ocean' });
  const p = st.prefs({ duration: 10, soundscape: 'none', threshold: 65 });
  ok(p.duration === 15 && p.soundscape === 'ocean' && p.threshold === 65, 'prefs round trip with defaults');
  for (let i = 0; i < 55; i++) st.addHistory({ i });
  ok(st.history().length === 50 && st.history()[0].i === 54, 'history newest first, capped at 50');
  st.saveBaseline('real', { mA: 0.2, sA: 0.05, mAB: 0, sAB: 0.3 }, 1000);
  ok(Sn.baselineFresh(st.baseline('real'), 1000 + 59 * 60e3) && !Sn.baselineFresh(st.baseline('real'), 1000 + 61 * 60e3) && !Sn.baselineFresh(st.baseline('demo'), 2000), 'baseline reused only within the last hour');
  storage.setItem('muse-calm:v2:prefs', '{broken'); ok(st.prefs({ a: 1 }).a === 1, 'corrupt storage falls back to defaults'); }
console.log(`\n${pass} checks passed`);

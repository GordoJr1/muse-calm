// Regression tests for bugs found in the v2.0.1 logic review
const assert = require('assert');
const D = require('../js/dsp.js'), Sn = require('../js/session.js');
global.self = global; global.MuseProtocol = require('../js/muse-protocol.js'); require('../js/muse-ble.js');
let pass = 0; const ok = (c, m) => { assert(c, m); pass++; console.log('  ok -', m); };
const rel = (a, b) => ({ delta: .3, theta: .2, alpha: a, beta: b, gamma: .05 });
const T = rel(0.30, 0.12), F = rel(0.18, 0.16);

console.log('Stable electrode set (blink bias)');
{ const b = new D.ChannelBlend(4, 5);
  const all = b.update([T, F, F, T], [true, true, true, true], 0.25).mean.alpha;
  const blink = b.update([T, F, F, T], [true, false, false, true], 0.25);   // forehead channels rejected this frame
  ok(Math.abs(all - 0.24) < 1e-9 && Math.abs(blink.mean.alpha - 0.24) < 1e-9 && blink.fresh === 2, `blink frame keeps the 4-channel mean (${blink.mean.alpha.toFixed(3)}), not temporal-only 0.300`);
  let r; for (let t = 0; t < 6; t += 0.25) r = b.update([T, null, null, T], [true, false, false, true], 0.25);
  ok(Math.abs(r.mean.alpha - 0.30) < 1e-9 && r.used === 2, 'after >5 s the missing channels are dropped from the mean (dropout monitor pauses scoring before then)');
  const none = b.update([null, null, null, null], [false, false, false, false], 0.25);
  ok(none.mean === null && none.fresh === 0, 'no fresh channel -> no calm input (frame invalid)');
  const dead = new D.ChannelBlend(4, 5); let m;
  for (let t = 0; t < 10; t += 0.25) m = dead.update([T, F, null, T], [true, true, false, true], 0.25);
  ok(Math.abs(m.mean.alpha - (0.3 + 0.18 + 0.3) / 3) < 1e-9 && m.used === 3, 'a never-usable sensor (Start anyway) is consistently left out');
  const c = new D.CalmEngine({ calibSeconds: 45 }), b2 = new D.ChannelBlend(4, 5);
  for (let t = 0; t < 70; t += 0.25) c.update(b2.update([T, F, F, T], [true, true, true, true], 0.25).mean, true, 0.25);
  const before = c.score;
  for (let t = 0; t < 2; t += 0.25) c.update(b2.update([T, F, F, T], [true, false, false, true], 0.25).mean, true, 0.25);
  ok(Math.abs(c.score - before) < 0.5, `calm score unchanged by a blink (${before.toFixed(1)} -> ${c.score.toFixed(1)}; was +7 before the fix)`);
}
console.log('Calm score starts from the baseline-relative value');
{ const c = new D.CalmEngine({ calibSeconds: 45 });
  while (c.calibrating) c.update(rel(0.29, 0.12), true, 0.25);
  ok(Math.abs(c.score - 100 / (1 + Math.exp(0.25))) < 0.01, `first scored value ${c.score.toFixed(1)} = z-based raw (was provisional 65.7)`);
}
console.log('Storage robustness');
{ const m = new Map(); const st = Sn.makeStore({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) });
  for (const bad of ['{}', '5', 'null', '"x"', '[1,null,{"a":1}]']) {
    m.set('muse-calm:v2:history', bad);
    const h = st.history(); ok(Array.isArray(h) && h.every((e) => e && typeof e === 'object'), `history ${bad} -> array of ${h.length} entries`);
  }
  m.set('muse-calm:v2:history', '{}'); st.addHistory({ a: 1 }); ok(st.history().length === 1, 'saving a session works after a corrupt history value');
  const DEF = { duration: 10, custom: false, bells: 0, soundscape: 'none', scapeVol: 50, birdVol: 60, threshold: 65, pinkBed: false, muted: false };
  const p = Sn.sanitizePrefs({ duration: '999', bells: 3, soundscape: 'forest', scapeVol: -5, birdVol: 'loud', threshold: 20, pinkBed: 1 }, DEF, ['none', 'ocean', 'rain']);
  ok(p.duration === 180 && p.bells === 0 && p.soundscape === 'none' && p.scapeVol === 0 && p.birdVol === 60 && p.threshold === 45 && p.pinkBed === true, 'bad prefs are clamped / reset to defaults');
  const q = Sn.sanitizePrefs({ duration: 25, custom: true, bells: 5, soundscape: 'rain', scapeVol: 30, birdVol: 70, threshold: 72 }, DEF, ['none', 'ocean', 'rain']);
  ok(q.duration === 25 && q.custom && q.bells === 5 && q.soundscape === 'rain' && q.threshold === 72, 'valid prefs survive unchanged');
}
console.log('Control-channel JSON reassembly');
{ const got = [], b = new global.MuseBLE({ onControl: (j) => got.push(j) });
  const frag = (s) => { const a = [s.length]; for (const ch of s) a.push(ch.charCodeAt(0)); return Uint8Array.from(a); };
  b._control(frag('{"hn":"Muse-A6')); b._control(frag('{"rc":0,"bp":77}')); b._control(frag('{"rc":0}'));
  ok(got.length === 2 && got[0].bp === 77, 'a stale partial fragment no longer swallows the next reply (battery 77 delivered)');
  const g2 = [], b2 = new global.MuseBLE({ onControl: (j) => g2.push(j) });
  ['{"ap":"hea', 'dset","sp":"Mu', 'se-A653","bp":8', '1}'].forEach((s) => b2._control(frag(s)));
  ok(g2.length === 1 && g2[0].bp === 81 && g2[0].sp === 'Muse-A653', 'reply split over 4 notifications is reassembled once');
}
console.log('Session timer: bells vs pause and end (control)');
{ const tm = new Sn.SessionTimer(600, 5); tm.start(0); const ev = [];
  tm.tick(100); tm.pause(100); for (let s = 100; s < 500; s += 0.25) ev.push(...tm.tick(s)); tm.resume(500);
  for (let s = 500; s <= 1101; s += 0.25) ev.push(...tm.tick(s).map((e) => e + '@' + s));
  ok(JSON.stringify(ev) === JSON.stringify(['bell@700', 'complete@1000']), 'one bell at 5:00 of active time, none during the 400 s pause, none at the end');
}
console.log(`\n${pass} checks passed`);

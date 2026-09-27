/* Electrode contact assessment with hysteresis + debounce, the pre-session fit gate,
 * and the in-session dropout monitor. Browser: window.Contact, Node: module.exports. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.Contact = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Thresholds on the robust (MAD-based) std of the 1-40 Hz signal over 2 s, in uV,
   * and on the 48-62 Hz mains share of 1-44 Hz power. Entering a better state needs a
   * stricter value than staying in it (hysteresis). */
  const T = {
    flat: 0.4,
    goodEnter: 25, goodStay: 34,
    poorEnter: 70, poorStay: 50,
    mainsGoodEnter: 1.5, mainsGoodStay: 2.5,
    mainsPoorEnter: 6, mainsPoorStay: 4,
  };
  /* how long a new level must persist before the displayed state changes (s) */
  const DWELL = { good: 1.0, fair: 0.75, poor: 1.0, off: 0.5 };

  function classify(std, mains, current) {
    if (!(std > T.flat)) return 'off';
    mains = mains || 0;
    const poorStd = current === 'poor' ? T.poorStay : T.poorEnter;
    const poorMains = current === 'poor' ? T.mainsPoorStay : T.mainsPoorEnter;
    if (std > poorStd || mains > poorMains) return 'poor';
    const goodStd = current === 'good' ? T.goodStay : T.goodEnter;
    const goodMains = current === 'good' ? T.mainsGoodStay : T.mainsGoodEnter;
    if (std < goodStd && mains < goodMains) return 'good';
    return 'fair';
  }

  class SensorContact {
    constructor() { this.reset(); }
    reset() { this.state = 'off'; this.cand = null; this.candT = 0; this.raw = 'off'; }
    update(std, mains, dt) {
      const raw = classify(std, mains, this.state);
      this.raw = raw;
      if (raw === this.state) { this.cand = null; this.candT = 0; return this.state; }
      if (raw !== this.cand) { this.cand = raw; this.candT = 0; }
      this.candT += dt;
      if (this.candT >= DWELL[raw]) { this.state = raw; this.cand = null; this.candT = 0; }
      return this.state;
    }
  }

  const SENSORS = [
    { name: 'TP9', where: 'left ear', kind: 'ear', side: 'left' },
    { name: 'AF7', where: 'left forehead', kind: 'forehead', side: 'left' },
    { name: 'AF8', where: 'right forehead', kind: 'forehead', side: 'right' },
    { name: 'TP10', where: 'right ear', kind: 'ear', side: 'right' },
  ];
  function hint(i, state, mains) {
    const s = SENSORS[i];
    if (state === 'good') return 'Firm contact';
    if (state === 'off') return s.kind === 'ear' ? 'No signal: seat the ' + s.side + ' ear sensor behind your ear' : 'No signal: rest the band flat on your forehead';
    if ((mains || 0) > T.mainsGoodStay) return s.kind === 'ear' ? 'Electrical noise: press the ' + s.side + ' ear sensor onto skin' : 'Electrical noise: wipe the ' + s.side + ' forehead sensor and skin';
    if (s.kind === 'ear') return state === 'poor' ? 'Push the ' + s.side + ' ear sensor closer, tuck hair away' : 'Almost: nudge the ' + s.side + ' ear sensor snug';
    return state === 'poor' ? 'Wipe the ' + s.side + ' forehead sensor, move hair away' : 'Almost: settle the band lower on your forehead';
  }

  /* All four sensors must hold 'good' continuously for holdSec before passing. */
  class ContactGate {
    constructor(opts) { opts = opts || {}; this.holdSec = opts.holdSec || 5; this.sensors = [0, 1, 2, 3].map(() => new SensorContact()); this.reset(); }
    reset() { this.sensors.forEach((s) => s.reset()); this.goodFor = 0; this.passed = false; }
    update(stds, mains, dt) {
      const states = this.sensors.map((s, i) => s.update(stds[i], mains ? mains[i] : 0, dt));
      const allGood = states.every((x) => x === 'good');
      this.goodFor = allGood ? this.goodFor + dt : 0;
      if (this.goodFor >= this.holdSec) this.passed = true;
      return { states, allGood, progress: Math.min(1, this.goodFor / this.holdSec), passed: this.passed };
    }
    get states() { return this.sensors.map((s) => s.state); }
  }

  /* During a session: a sensor that stays poor/off for > poorSec is flagged; the flag
   * clears once it has been out of poor/off for recoverSec. Scoring pauses while flagged. */
  class DropoutMonitor {
    constructor(opts) { opts = opts || {}; this.poorSec = opts.poorSec || 3; this.recoverSec = opts.recoverSec || 1; this.reset(); }
    reset() { this.bad = [0, 0, 0, 0]; this.okT = [0, 0, 0, 0]; this.flag = [false, false, false, false]; }
    update(states, dt) {
      for (let i = 0; i < 4; i++) {
        const bad = states[i] === 'poor' || states[i] === 'off';
        if (bad) { this.bad[i] += dt; this.okT[i] = 0; if (this.bad[i] > this.poorSec) this.flag[i] = true; }
        else { this.bad[i] = 0; this.okT[i] += dt; if (this.flag[i] && this.okT[i] >= this.recoverSec) this.flag[i] = false; }
      }
      const dropped = [];
      this.flag.forEach((f, i) => { if (f) dropped.push(i); });
      return { dropped, active: dropped.length > 0 };
    }
  }

  return { T, DWELL, classify, SensorContact, ContactGate, DropoutMonitor, SENSORS, hint };
});

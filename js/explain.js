/* Plain-language explanation popovers for brainwave bands, EEG channels and the calm score.
 * Any element with data-explain="<key>" becomes a trigger: hover (mouse), tap (touch), or
 * keyboard focus / Enter / Space. One popover at a time; Escape or a tap elsewhere closes it. */
(function () {
  'use strict';
  const T = {
    delta: {
      sym: 'δ', name: 'Delta', range: '1–4 Hz', color: '#818cf8',
      what: 'Slow waves best known from deep sleep. On a forehead-and-ear headband, awake delta is also easily inflated by blinks, eye movements and head motion.',
      rise: 'A rise usually points to drowsiness, or simply to movement, rather than deeper calm.',
    },
    theta: {
      sym: 'θ', name: 'Theta', range: '4–8 Hz', color: '#60a5fa',
      what: 'Linked to drowsiness, the drift toward sleep, daydreaming and inward, absorbed attention.',
      rise: 'A gentle rise is common in deep, relaxed practice. A large rise can also mean you are getting sleepy.',
    },
    alpha: {
      sym: 'α', name: 'Alpha', range: '8–13 Hz', color: '#34d399',
      what: 'The classic rhythm of relaxed wakefulness. It tends to grow when you close your eyes and settle, and to fade when you open them or think hard.',
      rise: 'A rise typically means you are relaxing while staying awake. The calm score leans on this band.',
    },
    beta: {
      sym: 'β', name: 'Beta', range: '13–30 Hz', color: '#fbbf24',
      what: 'Linked to active thinking, focus and alertness; when high, often to a busy mind or tension. Frowning and jaw clenching add muscle noise here.',
      rise: 'A rise often goes with thinking, planning or tensing. A gentle fall usually goes with settling.',
    },
    gamma: {
      sym: 'γ', name: 'Gamma', range: '30–44 Hz', color: '#f472b6',
      what: 'Fast activity. At the forehead and ears, most of what a consumer headband picks up here is muscle activity from the jaw, brow and eyes, not brain signal.',
      rise: 'A rise most often means tensing or moving. Softening your face and jaw usually brings it down.',
    },
    TP9: { name: 'TP9 · left ear', color: '#7dd3fc', what: 'Rests on the skin just above and behind your left ear (temporo-parietal). The ear sensors usually show alpha more clearly than the forehead ones.', tip: 'Poor contact? Tuck it snugly against the skin, clear of hair.' },
    AF7: { name: 'AF7 · left forehead', color: '#a78bfa', what: 'Sits on the forehead above your left eyebrow (anterior-frontal). Blinks and eye movements show up here as large, slow swings.', tip: 'Poor contact? Wipe the sensor and your skin, and move hair aside.' },
    AF8: { name: 'AF8 · right forehead', color: '#f0abfc', what: 'Sits on the forehead above your right eyebrow (anterior-frontal). Blinks and eye movements show up here as large, slow swings.', tip: 'Poor contact? Wipe the sensor and your skin, and move hair aside.' },
    TP10: { name: 'TP10 · right ear', color: '#5eead4', what: 'Rests on the skin just above and behind your right ear (temporo-parietal). The ear sensors usually show alpha more clearly than the forehead ones.', tip: 'Poor contact? Tuck it snugly against the skin, clear of hair.' },
    calm: {
      name: 'Calm score', range: '0–100, relative to you', color: '#5eead4',
      what: 'The first 40 s of each session record your baseline: your usual share of alpha and your alpha-to-beta balance. After that, the score compares the last few seconds with that baseline. Around 45 means “like your baseline”; higher means relatively more alpha and less beta than when you started.',
      rise: 'Moments with loose sensors or movement are skipped, not counted against you. It is a relaxation indicator, not a medical measurement.',
    },
    hr: { name: 'Heart rate', range: 'beats per minute', color: '#fb7185', what: 'Estimated from the optical pulse sensor on your forehead (PPG). A slow, gentle decline over a session is common as the body settles.' },
    baseline: { name: 'Baseline', range: 'first 40 s', color: '#a0c8ff', what: 'Clean data from the start of the session that everything afterwards is compared with. It is not scored, and it pauses whenever a sensor loses contact.' },
    excluded: { name: 'Left out', color: '#fb7185', what: 'Stretches with loose contact, missing data or movement (or a paused baseline). They are neither calm nor not-calm, so they never count against you.' },
  };
  const BAND_NOTE = 'Relative power: this band’s share of the 1–44 Hz total, averaged over the sensors with good contact.';

  let pop = null, cur = null, pinned = false, hoverT = 0, leaveT = 0, lastPointer = 'mouse';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function html(key) {
    const e = T[key]; if (!e) return '';
    const band = ['delta', 'theta', 'alpha', 'beta', 'gamma'].indexOf(key) >= 0;
    let h = '<div class="xp-head"><span class="xp-dot" style="--c:' + e.color + '">' + (e.sym ? esc(e.sym) : '') + '</span><div><b>' + esc(e.name) + '</b>' + (e.range ? '<small>' + esc(e.range) + '</small>' : '') + '</div></div>';
    h += '<p>' + esc(e.what) + '</p>';
    if (e.rise) h += '<p class="xp-rise">' + (band ? '<span>During meditation</span>' : '') + esc(e.rise) + '</p>';
    if (e.tip) h += '<p class="xp-tip">' + esc(e.tip) + '</p>';
    if (band) h += '<p class="xp-foot">' + esc(BAND_NOTE) + '</p>';
    return h;
  }
  function ensure() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'explainPop'; pop.className = 'xp'; pop.setAttribute('role', 'tooltip'); pop.hidden = true;
    pop.innerHTML = '<div class="xp-body"></div><i class="xp-arrow" aria-hidden="true"></i>';
    pop.addEventListener('pointerenter', () => clearTimeout(leaveT));
    pop.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse' && !pinned) leaveT = setTimeout(close, 180); });
    document.body.appendChild(pop);
    return pop;
  }
  function place() {
    if (!cur || !pop || pop.hidden) return;
    const r = cur.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || (r.width === 0 && r.height === 0)) { close(); return; }
    const vw = document.documentElement.clientWidth, vh = innerHeight, m = 10;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const cx = r.left + r.width / 2;
    let above = r.top - ph - 12 >= m || r.bottom + ph + 12 > vh - m;
    if (above && r.top - ph - 12 < m && r.bottom + ph + 12 <= vh - m) above = false;
    let top = above ? r.top - ph - 12 : r.bottom + 12;
    top = Math.max(m, Math.min(vh - ph - m, top));
    const left = Math.max(m, Math.min(vw - pw - m, cx - pw / 2));
    pop.style.left = Math.round(left) + 'px'; pop.style.top = Math.round(top) + 'px';
    pop.dataset.side = above ? 'top' : 'bottom';
    pop.querySelector('.xp-arrow').style.left = Math.round(Math.max(14, Math.min(pw - 14, cx - left))) + 'px';
  }
  function open(el, pin) {
    const key = el.getAttribute('data-explain'); if (!T[key]) return;
    clearTimeout(leaveT); clearTimeout(hoverT);
    ensure();
    if (cur && cur !== el) cur.setAttribute('aria-expanded', 'false'), cur.removeAttribute('aria-describedby');
    cur = el; pinned = !!pin;
    pop.querySelector('.xp-body').innerHTML = html(key);
    pop.dataset.key = key;
    pop.hidden = false;
    el.setAttribute('aria-expanded', 'true'); el.setAttribute('aria-describedby', 'explainPop');
    place();
    requestAnimationFrame(() => { place(); if (pop) pop.classList.add('show'); });
  }
  function close() {
    clearTimeout(hoverT); clearTimeout(leaveT);
    if (cur) { cur.setAttribute('aria-expanded', 'false'); cur.removeAttribute('aria-describedby'); }
    cur = null; pinned = false;
    if (pop) { pop.classList.remove('show'); pop.hidden = true; }
  }
  const trig = (t) => (t && t.closest ? t.closest('[data-explain]') : null);
  function prep(root) {
    (root || document).querySelectorAll('[data-explain]').forEach((el) => {
      if (!el.hasAttribute('tabindex') && el.tagName !== 'BUTTON') el.setAttribute('tabindex', '0');
      if (el.tagName !== 'BUTTON') el.setAttribute('role', 'button');
      el.setAttribute('aria-expanded', el === cur ? 'true' : 'false');
      el.setAttribute('aria-haspopup', 'true');
      if (!el.hasAttribute('aria-label')) { const e = T[el.getAttribute('data-explain')]; if (e) el.setAttribute('aria-label', (el.textContent.trim() || e.name) + ': what it means'); }
    });
  }

  document.addEventListener('pointerdown', (ev) => {
    lastPointer = ev.pointerType || 'mouse';
    if (pop && !pop.hidden && !pop.contains(ev.target) && !trig(ev.target)) close();
  }, true);
  document.addEventListener('pointerover', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const el = trig(ev.target); if (!el) return;
    clearTimeout(leaveT);
    if (cur === el) return;
    if (pinned && cur) return;                       // a clicked popover stays until closed
    clearTimeout(hoverT); hoverT = setTimeout(() => open(el, false), cur ? 0 : 140);
  });
  document.addEventListener('pointerout', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const el = trig(ev.target); if (!el) return;
    if (el.contains(ev.relatedTarget)) return;
    clearTimeout(hoverT);
    if (cur === el && !pinned) leaveT = setTimeout(close, 180);
  });
  document.addEventListener('click', (ev) => {
    const el = trig(ev.target); if (!el) return;
    ev.preventDefault();
    if (cur === el && (pinned || lastPointer !== 'mouse')) close();
    else open(el, true);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && cur) { const el = cur; close(); el.focus(); ev.stopPropagation(); return; }
    const el = trig(ev.target);
    if (el && el === ev.target && (ev.key === 'Enter' || ev.key === ' ') && el.tagName !== 'BUTTON') { ev.preventDefault(); cur === el ? close() : open(el, true); }
  }, true);
  document.addEventListener('focusin', (ev) => {
    const el = trig(ev.target);
    if (el && el === ev.target && el.matches(':focus-visible') && cur !== el) open(el, false);
  });
  document.addEventListener('focusout', (ev) => {
    const el = trig(ev.target);
    if (el && el === cur && !pinned && !(pop && pop.contains(ev.relatedTarget))) close();
  });
  window.addEventListener('resize', () => place());
  document.addEventListener('scroll', () => place(), true);

  window.Explain = { TEXT: T, open, close, prep, html, get current() { return cur; } };
  if (document.readyState !== 'loading') prep(); else document.addEventListener('DOMContentLoaded', () => prep());
})();

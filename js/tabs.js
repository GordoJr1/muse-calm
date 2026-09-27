/* Phone layout (< 700 px wide): four tabs in a bottom bar (Session · Brain · Body · History).
 * Pure presentation: switching tabs only toggles which cards are displayed (CSS keyed on body[data-tab]),
 * so audio, scoring and data collection never stop. Hidden canvases report a 0x0 size to the chart
 * ResizeObserver and are skipped by the render loop; they redraw from the live buffers as soon as shown.
 * The last tab is remembered. On wider screens the attribute is inert (desktop one-page / tablet layouts). */
(function (root) {
  'use strict';
  const KEY = 'muse-calm:v2:tab';
  const TABS = ['session', 'brain', 'body', 'history'];
  const mq = root.matchMedia ? root.matchMedia('(max-width: 699.98px)') : { matches: false, addEventListener() {} };
  const bar = document.getElementById('tabbar');
  const btns = Array.from(bar.querySelectorAll('[data-tab]'));
  let cur = 'session';
  try { const s = localStorage.getItem(KEY); if (TABS.includes(s)) cur = s; } catch (e) { /* storage blocked */ }
  const listeners = [];

  function set(t, opts) {
    if (!TABS.includes(t)) return;
    const changed = t !== cur;
    cur = t;
    document.body.dataset.tab = t;
    btns.forEach((b) => {
      const on = b.dataset.tab === t;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    const grid = document.getElementById('grid');
    if (changed && grid) grid.scrollTop = 0;
    try { localStorage.setItem(KEY, t); } catch (e) { /* ignore */ }
    if (opts && opts.focus) { const b = btns.find((x) => x.dataset.tab === t); if (b) b.focus(); }
    if (changed) listeners.forEach((f) => f(t));
  }
  btns.forEach((b) => b.addEventListener('click', () => set(b.dataset.tab)));
  bar.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(cur);
    let n = null;
    if (e.key === 'ArrowRight') n = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') n = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === 'Home') n = TABS[0];
    else if (e.key === 'End') n = TABS[TABS.length - 1];
    if (n) { e.preventDefault(); set(n, { focus: true }); }
  });
  set(cur);
  root.MuseTabs = {
    get: () => cur,
    set,
    tabbed: () => mq.matches,
    onChange: (f) => listeners.push(f),
  };
})(window);

/* Customizable desktop layout (v2.4): tiles on a snapping dashboard grid.
 * Default = the v2.3 one-screen layout (CSS columns). "Customize layout" measures that layout into grid units
 * (48 columns = fractions of the width, 8 px rows); tiles are then dragged by their title bar and resized from the
 * corner. Tiles never overlap: the ones in the way are pushed down, then everything floats up (vertical compaction).
 * The layout is saved in localStorage ("muse-calm:v2:layout", schema-versioned); bad or old data falls back to the default.
 * The pure functions (collision, compaction, validation, serialization) are exported for the Node unit tests. */
(function (root) {
  'use strict';
  const L = {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const COLS = 48, ROW = 8, SCHEMA = 1, GAP = 12;
  const KEY = 'muse-calm:v2:layout';
  // minimum tile size in px: height -> rows; width -> columns at the current window width (see minsFor)
  const TILES = [
    { id: 'hero', sel: '.card.hero', name: 'Calm', minW: 330, minH: 320 },   // tall enough for setup (Start, bell, duration)
    { id: 'fit', sel: '.card.fit', name: 'Headband fit', minW: 250, minH: 230 },   // room for the fit check shown in setup
    { id: 'past', sel: '.card.past', name: 'Past sessions', minW: 250, minH: 110 },
    { id: 'eeg', sel: '.card.eeg', name: 'Raw EEG', minW: 280, minH: 200 },
    { id: 'bands', sel: '.card.bands', name: 'Brainwaves', minW: 150, minH: 180 },
    { id: 'history', sel: '.card.history', name: 'Brainwave history', minW: 220, minH: 180 },
    { id: 'heart', sel: '.card.heart', name: 'Heart', minW: 190, minH: 140 },
    { id: 'motion', sel: '.card.motion', name: 'Head motion', minW: 220, minH: 170 },
    { id: 'session', sel: '.card.session', name: 'Session', minW: 250, minH: 150 },
    { id: 'scape', sel: '.card.scape', name: 'Soundscape', minW: 300, minH: 230 },
  ];
  // tiles whose content stretches (charts, lists); used to absorb rounding when fitting the default to the window
  const FLEX = ['past', 'eeg', 'bands', 'history', 'heart', 'motion'];
  const MIN_COLS = 2;   // floor used to validate saved layouts (they may come from a wider window)
  const minRows = (t) => Math.ceil((t.minH + GAP) / ROW);
  const MINS = {};
  TILES.forEach((t) => { MINS[t.id] = { w: MIN_COLS, h: minRows(t) }; });
  // minimum sizes in grid units for a given column pitch (px per column incl. gap)
  function minsFor(pitch, gap) {
    const m = {};
    TILES.forEach((t) => { m[t.id] = { w: clamp(Math.ceil((t.minW + (gap == null ? GAP : gap)) / pitch), MIN_COLS, COLS), h: minRows(t) }; });
    return m;
  }
  const IDS = TILES.map((t) => t.id);
  const MAX_H = 400, MAX_ROWS = 4000;   // one tile <= 3200 px; ten stacked tiles always stay under MAX_ROWS

  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
  const overlap = (a, b) => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const clone = (items) => items.map((i) => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h }));
  const bottom = (items) => items.reduce((m, i) => Math.max(m, i.y + i.h), 0);
  const anyOverlap = (items) => { for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (overlap(items[i], items[j])) return [items[i].id, items[j].id]; return null; };

  /* vertical compaction: every tile floats up as far as it can (top-to-bottom order kept); `fixedId` stays put
   * (the tile being dragged), the others flow around it. Also resolves any remaining overlap by pushing down. */
  function compact(items, fixedId) {
    const src = clone(items).sort((a, b) => a.y - b.y || a.x - b.x);
    const fixed = fixedId ? src.find((i) => i.id === fixedId) : null;
    const placed = fixed ? [fixed] : [];
    for (const it of src) {
      if (it === fixed) continue;
      while (it.y > 0 && !placed.some((p) => overlap(Object.assign({}, it, { y: it.y - 1 }), p))) it.y--;
      let hit;
      while ((hit = placed.filter((p) => overlap(it, p))).length) it.y = Math.max.apply(null, hit.map((p) => p.y + p.h));
      placed.push(it);
    }
    const order = new Map(items.map((i, k) => [i.id, k]));
    return placed.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  // push the tiles overlapping `m` out of its way: above it when there's room and it moved down, else below (cascading)
  function resolve(items, m, movingDown, depth) {
    if (depth > 60) return;
    const hits = items.filter((c) => overlap(c, m)).sort((a, b) => a.y - b.y);
    for (const c of hits) {
      if (!overlap(c, m)) continue;
      if (movingDown && m.y - c.h >= 0) {
        const cand = { id: c.id, x: c.x, y: m.y - c.h, w: c.w, h: c.h };
        if (!items.some((o) => o !== c && overlap(cand, o))) { c.y = cand.y; continue; }
      }
      c.y = m.y + m.h;
      resolve(items, c, false, depth + 1);
    }
  }
  function move(items, id, x, y, cols) {
    cols = cols || COLS;
    const out = clone(items), m = out.find((i) => i.id === id);
    if (!m) return out;
    const down = y > m.y;
    m.x = clamp(Math.round(x), 0, cols - m.w); m.y = clamp(Math.round(y), 0, MAX_ROWS - m.h);
    resolve(out, m, down, 0);
    return compact(out, id);
  }
  function resize(items, id, w, h, cols, mins) {
    cols = cols || COLS; mins = mins || MINS;
    const out = clone(items), m = out.find((i) => i.id === id);
    if (!m) return out;
    const mn = mins[id] || { w: 1, h: 1 };
    m.w = clamp(Math.round(w), mn.w, cols - m.x); m.h = clamp(Math.round(h), mn.h, MAX_H);
    resolve(out, m, false, 0);
    return compact(out, id);
  }

  /* keyboard up/down: jump past the neighbouring tile in that direction (so it swaps instead of floating back) */
  function nudgeY(items, it, dir) {
    const col = items.filter((o) => o.id !== it.id && o.x < it.x + it.w && it.x < o.x + o.w);
    if (dir > 0) { const n = col.filter((o) => o.y >= it.y + it.h).sort((a, b) => a.y - b.y)[0]; return n ? n.y + n.h - it.h : it.y + 4; }
    const n = col.filter((o) => o.y + o.h <= it.y).sort((a, b) => b.y - a.y)[0];
    return n ? n.y : Math.max(0, it.y - 4);
  }

  /* measured card rectangles (px, relative to the grid's content box) -> grid items that fit `maxRows` */
  function fromRects(rects, o) {
    const cols = o.cols || COLS, row = o.row || ROW, gap = o.gap == null ? GAP : o.gap, mins = o.mins || MINS, flex = o.flex || FLEX;
    const px = {}; rects.forEach((r) => { px[r.id] = r; });
    let items = rects.map((r) => {
      const mn = mins[r.id] || { w: 1, h: 1 };
      const x = clamp(Math.round(r.left / o.pitch), 0, cols - mn.w);
      const w = clamp(Math.round((r.left + r.width + gap) / o.pitch) - x, mn.w, cols - x);
      const y = Math.max(0, Math.round(r.top / row));
      const h = Math.max(mn.h, Math.ceil((r.height + gap) / row - 0.01));
      return { id: r.id, x, y, w, h };
    });
    // snapping / minimum widths can make side-by-side tiles overlap: start each tile after its left neighbour
    const vert = (a, b) => { const p = px[a.id], q = px[b.id]; return p.top < q.top + q.height - 4 && q.top < p.top + p.height - 4; };
    for (let pass = 0; pass < 3; pass++) {
      const byX = items.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      for (const t of byX) for (const l of byX) {
        if (l === t || l.x >= t.x || !vert(l, t) || l.x + l.w <= t.x) continue;
        const right = t.x + t.w, mn = (mins[t.id] || { w: 1 }).w;
        t.x = l.x + l.w; t.w = Math.max(mn, right - t.x);
        if (t.x + t.w > cols) { t.w = Math.max(1, cols - t.x); if (t.w < mn) { t.x = Math.max(0, cols - mn); t.w = mn; } }
      }
    }
    items = compact(items);
    if (o.maxRows) {
      for (let guard = 0; guard < 400 && bottom(items) > o.maxRows; guard++) {
        let changed = false;
        for (const t of items.filter((i) => i.y + i.h > o.maxRows)) {
          const c = items.filter((c) => flex.includes(c.id) && c.h > (mins[c.id] || { h: 1 }).h && c.x < t.x + t.w && t.x < c.x + c.w && c.y <= t.y)
            .sort((a, b) => b.h - a.h)[0];
          if (c) { c.h--; changed = true; }
        }
        if (!changed) break;
        items = compact(items);
      }
    }
    return items;
  }

  /* validation: schema version, grid size, every tile exactly once, integer geometry inside the grid,
   * at least the minimum size, no overlaps. Returns clean items or null (-> use the default). */
  function validate(obj, o) {
    o = o || {};
    const cols = o.cols || COLS, mins = o.mins || MINS, ids = o.ids || IDS;
    if (!obj || typeof obj !== 'object' || obj.v !== SCHEMA || obj.cols !== cols || !Array.isArray(obj.items)) return null;
    if (obj.items.length !== ids.length) return null;
    const seen = new Set(), out = [];
    for (const it of obj.items) {
      if (!it || typeof it !== 'object' || !ids.includes(it.id) || seen.has(it.id)) return null;
      const { x, y, w, h } = it;
      if (![x, y, w, h].every(isInt)) return null;
      const mn = mins[it.id] || { w: 1, h: 1 };
      if (x < 0 || y < 0 || w < mn.w || h < mn.h || h > MAX_H || x + w > cols || y + h > MAX_ROWS) return null;
      seen.add(it.id); out.push({ id: it.id, x, y, w, h });
    }
    return anyOverlap(out) ? null : out;
  }
  const serialize = (items) => JSON.stringify({ v: SCHEMA, cols: COLS, row: ROW, items: clone(items) });
  function parse(str, o) { try { return validate(JSON.parse(str), o); } catch (_) { return null; } }

  Object.assign(L, { COLS, ROW, SCHEMA, KEY, MAX_H, MAX_ROWS, TILES, MINS, MIN_COLS, minsFor, FLEX, IDS, overlap, anyOverlap, clone, bottom, compact, move, resize, nudgeY, fromRects, validate, serialize, parse });

  /* ---------------- DOM: desktop editing ---------------- */
  L.init = function (opts) {
    opts = opts || {};
    const doc = root.document, body = doc.body, grid = doc.getElementById('grid');
    const store = opts.storage || root.localStorage;
    const btn = doc.getElementById('layoutBtn'), bar = doc.getElementById('editBar');
    const mq = root.matchMedia('(min-width: 1000px)');
    const cards = {};
    let items = null, editing = false, dirty = false, saved = false, drag = null;

    const ph = doc.createElement('div'); ph.className = 'tile-ph'; ph.setAttribute('aria-hidden', 'true'); grid.appendChild(ph);
    TILES.forEach((t) => {
      const el = grid.querySelector(t.sel); if (!el) return;
      el.dataset.tile = t.id; cards[t.id] = el;
      const ui = doc.createElement('div'); ui.className = 'tile-ui';
      ui.innerHTML = '<div class="tile-bar" role="button" tabindex="0" aria-roledescription="movable tile" aria-label="' + t.name + ' tile: drag to move. Arrow keys move, Shift + arrow keys resize.">'
        + '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + '<span>' + t.name + '</span></div>'
        + '<div class="tile-grip" title="Drag to resize" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M14 6L6 14M14 10l-4 4M14 2L2 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div>';
      el.appendChild(ui);
      const tb = ui.firstChild, grip = ui.lastChild;
      tb.addEventListener('pointerdown', (e) => startDrag(e, t.id, 'move', tb));
      grip.addEventListener('pointerdown', (e) => startDrag(e, t.id, 'resize', grip));
      tb.addEventListener('keydown', (e) => keyNudge(e, t.id));
    });

    function apply() {
      if (items) {
        body.classList.add('lay-grid');
        items.forEach((i) => { const el = cards[i.id]; if (!el) return; el.style.setProperty('--gc', (i.x + 1) + ' / span ' + i.w); el.style.setProperty('--gr', (i.y + 1) + ' / span ' + i.h); });
      } else {
        body.classList.remove('lay-grid');
        Object.values(cards).forEach((el) => { el.style.removeProperty('--gc'); el.style.removeProperty('--gr'); });
      }
    }
    function geom() {
      const r = grid.getBoundingClientRect(), cs = root.getComputedStyle(grid);
      const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0, pt = parseFloat(cs.paddingTop) || 0;
      const gap = parseFloat(cs.columnGap) || GAP, W = grid.clientWidth - pl - pr, pitch = (W + gap) / COLS;
      return { left: r.left + pl, top: r.top + pt, W, gap, pitch };
    }
    function measure() {
      const g = geom();
      const rects = TILES.filter((t) => cards[t.id]).map((t) => { const b = cards[t.id].getBoundingClientRect(); return { id: t.id, left: b.left - g.left, top: b.top - g.top, width: b.width, height: b.height }; });
      return fromRects(rects, { pitch: g.pitch, row: ROW, gap: g.gap, mins: minsFor(g.pitch, g.gap), maxRows: Math.floor((root.innerHeight - g.top) / ROW) });
    }
    function gridVars() { const g = geom(); grid.style.setProperty('--pitch', (2 * g.pitch) + 'px'); grid.style.setProperty('--colw', Math.max(1, 2 * g.pitch - g.gap) + 'px'); }   // guides every 2 columns
    function load() {
      let raw = null; try { raw = store.getItem(KEY); } catch (_) {}
      if (raw == null) return null;
      const it = parse(raw);
      if (!it) { try { store.removeItem(KEY); } catch (_) {} }
      return it;
    }
    function save() { if (!items) return; try { store.setItem(KEY, serialize(items)); saved = true; } catch (_) {} }
    function setInert(on) { Object.values(cards).forEach((el) => Array.from(el.children).forEach((c) => { if (!c.classList.contains('tile-ui')) c.inert = on; })); }

    function enter() {
      if (editing || !mq.matches) return;
      if (opts.onEdit) opts.onEdit(true);
      if (!items) { items = measure(); apply(); }
      editing = true; dirty = false;
      body.classList.add('editing'); setInert(true); gridVars();
      bar.hidden = false; btn.setAttribute('aria-pressed', 'true');
      const first = grid.querySelector('.tile-bar'); if (first) first.focus({ preventScroll: true });
    }
    function exit() {
      if (!editing) return;
      endDrag();
      editing = false;
      body.classList.remove('editing'); setInert(false);
      bar.hidden = true; btn.setAttribute('aria-pressed', 'false');
      if (dirty) save();
      else if (!saved) { items = null; apply(); }
      dirty = false;
      if (opts.onEdit) opts.onEdit(false);
      btn.focus({ preventScroll: true });
    }
    function reset() {
      try { store.removeItem(KEY); } catch (_) {}
      saved = false; dirty = false; items = null; apply();
      if (editing) { items = measure(); apply(); gridVars(); }
    }

    function startDrag(e, id, mode, handle) {
      if (!editing || e.button !== 0 || !items) return;
      e.preventDefault(); e.stopPropagation();
      const it = items.find((i) => i.id === id), g = geom();
      drag = { id, mode, handle, pid: e.pointerId, grabX: e.clientX - (g.left + it.x * g.pitch), grabY: e.clientY - (g.top + it.y * ROW),
        // resize: distance from the pointer to the tile's bottom-right corner, so the corner doesn't jump to the pointer
        offX: (g.left + (it.x + it.w) * g.pitch - g.gap) - e.clientX, offY: (g.top + (it.y + it.h) * ROW - g.gap) - e.clientY };
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      cards[id].classList.add(mode === 'move' ? 'dragging' : 'resizing');
      if (mode === 'move') { ph.style.setProperty('--gc', (it.x + 1) + ' / span ' + it.w); ph.style.setProperty('--gr', (it.y + 1) + ' / span ' + it.h); ph.classList.add('on'); }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    }
    function onMove(e) {
      if (!drag || e.pointerId !== drag.pid) return;
      const g = geom(), id = drag.id;
      let it = items.find((i) => i.id === id);
      if (drag.mode === 'move') {
        const px = e.clientX - drag.grabX - g.left, py = e.clientY - drag.grabY - g.top;
        const x = clamp(Math.round(px / g.pitch), 0, COLS - it.w), y = clamp(Math.round(py / ROW), 0, MAX_ROWS - it.h);
        if (x !== it.x || y !== it.y) { items = move(items, id, x, y); apply(); dirty = true; it = items.find((i) => i.id === id); }
        cards[id].style.translate = Math.round(px - it.x * g.pitch) + 'px ' + Math.round(py - it.y * ROW) + 'px';
        ph.style.setProperty('--gc', (it.x + 1) + ' / span ' + it.w); ph.style.setProperty('--gr', (it.y + 1) + ' / span ' + it.h);
      } else {
        const mn = minsFor(g.pitch, g.gap)[id];
        const w = clamp(Math.round((e.clientX + drag.offX - (g.left + it.x * g.pitch) + g.gap) / g.pitch), mn.w, COLS - it.x);
        const h = clamp(Math.round((e.clientY + drag.offY - (g.top + it.y * ROW) + g.gap) / ROW), mn.h, MAX_H);
        if (w !== it.w || h !== it.h) { items = resize(items, id, w, h, COLS, minsFor(g.pitch, g.gap)); apply(); dirty = true; }
      }
      // keep the pointer in view when dragging past the bottom of the window
      if (e.clientY > root.innerHeight - 30) root.scrollBy(0, 14); else if (e.clientY < 30 && root.scrollY > 0) root.scrollBy(0, -14);
    }
    function onUp(e) { if (drag && e.pointerId === drag.pid) endDrag(); }
    function endDrag() {
      if (!drag) return;
      const d = drag; drag = null;
      d.handle.removeEventListener('pointermove', onMove); d.handle.removeEventListener('pointerup', onUp); d.handle.removeEventListener('pointercancel', onUp);
      try { d.handle.releasePointerCapture(d.pid); } catch (_) {}
      const el = cards[d.id]; el.classList.remove('dragging', 'resizing'); el.style.translate = '';
      ph.classList.remove('on');
      items = compact(items); apply();
      if (dirty) save();
    }
    function keyNudge(e, id) {
      if (!editing || !items) return;
      const k = e.key, dx = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0, dy = k === 'ArrowDown' ? 4 : k === 'ArrowUp' ? -4 : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      const it = items.find((i) => i.id === id);
      if (e.shiftKey) { const g = geom(); items = resize(items, id, it.w + dx, it.h + dy, COLS, minsFor(g.pitch, g.gap)); }
      else if (dy) items = move(items, id, it.x, nudgeY(items, it, dy));
      else items = move(items, id, it.x + dx, it.y);
      items = compact(items); apply(); dirty = true; save();
      const el = cards[id]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    btn.addEventListener('click', () => (editing ? exit() : enter()));
    doc.getElementById('layoutDone').addEventListener('click', exit);
    doc.getElementById('layoutReset').addEventListener('click', reset);
    doc.addEventListener('keydown', (e) => { if (editing && e.key === 'Escape' && !drag) { e.preventDefault(); exit(); } });
    const onMq = () => { if (!mq.matches && editing) exit(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    root.addEventListener('resize', () => { if (editing) gridVars(); });

    items = load(); saved = !!items; apply();
    return {
      get items() { return items ? clone(items) : null; },
      get editing() { return editing; },
      enter, exit, reset,
      set(next) { const v = validate({ v: SCHEMA, cols: COLS, items: next }); if (!v) return false; items = v; apply(); dirty = true; if (!editing) save(); return true; },
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  root.MuseLayout = L;
})(typeof self !== 'undefined' ? self : this);

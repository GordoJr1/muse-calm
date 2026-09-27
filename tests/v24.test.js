/* v2.4 customizable layout: serialization, validation, collision handling, compaction (js/layout.js) */
const assert = require('assert');
const L = require('../js/layout.js');
let n = 0; const t = (name, fn) => { fn(); n++; };
const C = L.COLS;
// a layout like the measured v2.3 default at 1376x1010
const DEF = [
  { id: 'hero', x: 0, y: 0, w: 15, h: 42 }, { id: 'fit', x: 0, y: 42, w: 15, h: 31 }, { id: 'past', x: 0, y: 73, w: 15, h: 45 },
  { id: 'eeg', x: 15, y: 0, w: 18, h: 64 }, { id: 'bands', x: 15, y: 64, w: 7, h: 53 }, { id: 'history', x: 22, y: 64, w: 11, h: 53 },
  { id: 'heart', x: 33, y: 0, w: 15, h: 30 }, { id: 'motion', x: 33, y: 30, w: 15, h: 32 }, { id: 'session', x: 33, y: 62, w: 15, h: 22 }, { id: 'scape', x: 33, y: 84, w: 15, h: 34 },
];
const ok = (items) => { assert.strictEqual(L.anyOverlap(items), null, 'no overlap ' + JSON.stringify(L.anyOverlap(items))); items.forEach((i) => { assert(i.x >= 0 && i.y >= 0 && i.x + i.w <= C, 'inside grid ' + i.id); }); assert.strictEqual(items.length, 10); };
const get = (items, id) => items.find((i) => i.id === id);

t('constants: 48 columns, 8 px rows, schema 1, key under muse-calm:v2:', () => {
  assert.strictEqual(C, 48); assert.strictEqual(L.ROW, 8); assert.strictEqual(L.SCHEMA, 1); assert.strictEqual(L.KEY, 'muse-calm:v2:layout');
  assert.deepStrictEqual(L.IDS, ['hero', 'fit', 'past', 'eeg', 'bands', 'history', 'heart', 'motion', 'session', 'scape']);
});
t('overlap: edges touching do not overlap; shared area does', () => {
  const a = { id: 'a', x: 0, y: 0, w: 4, h: 4 };
  assert(!L.overlap(a, { id: 'b', x: 4, y: 0, w: 2, h: 2 })); assert(!L.overlap(a, { id: 'b', x: 0, y: 4, w: 2, h: 2 }));
  assert(L.overlap(a, { id: 'b', x: 3, y: 3, w: 2, h: 2 })); assert(!L.overlap(a, a));
});
t('serialize -> parse round trip keeps the layout', () => {
  const s = L.serialize(DEF), o = JSON.parse(s);
  assert.strictEqual(o.v, 1); assert.strictEqual(o.cols, 48); assert.strictEqual(o.row, 8);
  assert.deepStrictEqual(L.parse(s), DEF);
});
t('serialize drops extra properties', () => {
  const s = L.serialize(DEF.map((i) => Object.assign({ junk: 1 }, i)));
  assert(!s.includes('junk'));
});
t('validate rejects bad or old data (falls back to the default)', () => {
  const good = JSON.parse(L.serialize(DEF));
  const bad = [
    null, 42, 'x', {}, [], Object.assign({}, good, { v: 0 }), Object.assign({}, good, { v: 2 }), Object.assign({}, good, { cols: 24 }),
    Object.assign({}, good, { items: good.items.slice(1) }),                                             // missing tile
    Object.assign({}, good, { items: good.items.concat([good.items[0]]) }),                              // extra tile
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 1 ? Object.assign({}, i, { id: 'hero' }) : i)) }),   // duplicate
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { id: 'nope' }) : i)) }),   // unknown
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { x: 1.5 }) : i)) }),       // non-integer
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { x: '0' }) : i)) }),       // string
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { x: -1 }) : i)) }),        // negative
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 6 ? Object.assign({}, i, { w: 16 }) : i)) }),        // past the right edge
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { h: 5 }) : i)) }),         // below min height
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 0 ? Object.assign({}, i, { w: 1 }) : i)) }),         // below min width
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 1 ? Object.assign({}, i, { y: 30 }) : i)) }),        // overlaps hero
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 1 ? Object.assign({}, i, { y: 5000 }) : i)) }),      // absurdly far down
    Object.assign({}, good, { items: good.items.map((i, k) => (k === 2 ? Object.assign({}, i, { y: 200, h: 401 }) : i)) }),  // taller than one tile may be
  ];
  bad.forEach((b, k) => assert.strictEqual(L.validate(b), null, 'case ' + k));
  assert.strictEqual(L.parse('{not json'), null); assert.strictEqual(L.parse(''), null); assert.strictEqual(L.parse('null'), null);
  assert.deepStrictEqual(L.validate(good), DEF);
});
t('a layout saved on a wide window stays valid on a narrow one (column floor, not px)', () => {
  const narrow = DEF.map((i) => (i.id === 'bands' ? Object.assign({}, i, { w: L.MIN_COLS }) : i)).map((i) => (i.id === 'history' ? Object.assign({}, i, { x: 17, w: 16 }) : i));
  assert.deepStrictEqual(L.validate({ v: 1, cols: 48, items: narrow }), narrow);
});
t('minsFor converts px minimums to columns at the current width', () => {
  const m1376 = L.minsFor((1336 + 12) / 48, 12), m2752 = L.minsFor((2696 + 16) / 48, 16);
  assert.strictEqual(m1376.hero.w, 13); assert.strictEqual(m2752.hero.w, 7);
  assert(m1376.bands.w <= 7, 'default bands width stays valid'); assert.strictEqual(m1376.hero.h, L.MINS.hero.h);
});
t('compact floats tiles up and removes gaps, keeping order', () => {
  const gappy = DEF.map((i) => Object.assign({}, i, { y: i.y + 20 }));
  const c = L.compact(gappy); ok(c);
  assert.deepStrictEqual(c.map((i) => i.id), DEF.map((i) => i.id));
  assert.deepStrictEqual(c, DEF);
});
t('compact resolves overlaps by pushing down', () => {
  const o = DEF.map((i) => (i.id === 'fit' ? Object.assign({}, i, { y: 10 }) : i));
  const c = L.compact(o); ok(c); assert.strictEqual(get(c, 'fit').y, 42);
});
t('move: soundscape to the top of the left column pushes the others down, nothing overlaps', () => {
  const m = L.move(DEF, 'scape', 0, 0); ok(m);
  assert.deepStrictEqual([get(m, 'scape').x, get(m, 'scape').y], [0, 0]);
  assert.strictEqual(get(m, 'hero').y, get(m, 'scape').h);
  assert.strictEqual(get(m, 'session').y, 30 + 32, 'right column closes the gap');
});
t('move down past a neighbour swaps them', () => {
  const m = L.compact(L.move(DEF, 'hero', 0, 50)); ok(m);
  assert(get(m, 'fit').y < get(m, 'hero').y, 'fit now above hero'); assert.strictEqual(get(m, 'fit').y, 0);
});
t('move clamps into the grid', () => {
  const m = L.move(DEF, 'heart', 99, -5); ok(m);
  assert.strictEqual(get(m, 'heart').x, C - get(m, 'heart').w); assert.strictEqual(get(m, 'heart').y, 0);
});
t('resize grows a tile and pushes the ones below; respects minimums and the right edge', () => {
  const r = L.resize(DEF, 'eeg', 18, 80); ok(r);
  assert.strictEqual(get(r, 'eeg').h, 80); assert.strictEqual(get(r, 'bands').y, 80);
  const tiny = L.resize(DEF, 'eeg', 1, 1, C, L.minsFor(28, 12)); ok(tiny);
  assert.strictEqual(get(tiny, 'eeg').w, L.minsFor(28, 12).eeg.w); assert.strictEqual(get(tiny, 'eeg').h, L.MINS.eeg.h);
  const wide = L.resize(DEF, 'eeg', 99, 64); ok(wide); assert.strictEqual(get(wide, 'eeg').x + get(wide, 'eeg').w, C);
});
t('move/resize never mutate the input', () => {
  const copy = JSON.stringify(DEF); L.move(DEF, 'scape', 0, 0); L.resize(DEF, 'eeg', 30, 90); L.compact(DEF);
  assert.strictEqual(JSON.stringify(DEF), copy);
});
t('fuzz: 3000 random moves/resizes keep the layout valid and overlap-free', () => {
  let s = 12345; const rnd = (k) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % k; };
  let items = L.clone(DEF);
  for (let i = 0; i < 3000; i++) {
    const id = L.IDS[rnd(10)], it = get(items, id);
    items = rnd(2) ? L.move(items, id, rnd(C), rnd(160)) : L.resize(items, id, it.w + rnd(9) - 4, it.h + rnd(17) - 8);
    if (i % 7 === 0) items = L.compact(items);
    ok(items);
    if (!L.validate(JSON.parse(L.serialize(items)))) { console.log(JSON.stringify(items), L.bottom(items)); assert.fail('still valid after step ' + i); }
  }
});
t('fromRects: measured v2.3 columns -> grid items that match the default and fit the window', () => {
  const pitch = (1336 + 12) / 48;
  const rects = [
    { id: 'hero', left: 0, top: 0, width: 414, height: 315 }, { id: 'fit', left: 0, top: 327, width: 414, height: 230 }, { id: 'past', left: 0, top: 569, width: 414, height: 364 },
    { id: 'eeg', left: 426, top: 0, width: 524, height: 515 }, { id: 'bands', left: 426, top: 527, width: 205, height: 406 }, { id: 'history', left: 643, top: 527, width: 307, height: 406 },
    { id: 'heart', left: 962, top: 0, width: 374, height: 223 }, { id: 'motion', left: 962, top: 235, width: 374, height: 256 }, { id: 'session', left: 962, top: 503, width: 374, height: 164 }, { id: 'scape', left: 962, top: 679, width: 374, height: 254 },
  ];
  const maxRows = Math.floor(946 / 8);
  const it = L.fromRects(rects, { pitch, gap: 12, mins: L.minsFor(pitch, 12), maxRows }); ok(it);
  assert(L.bottom(it) <= maxRows, 'fits: ' + L.bottom(it) + ' <= ' + maxRows);
  rects.forEach((r) => { const i = get(it, r.id); assert(Math.abs(i.x * pitch - r.left) <= pitch / 2 + 1, r.id + ' x'); assert(Math.abs(i.y * 8 - r.top) <= 24, r.id + ' y ' + i.y * 8 + ' vs ' + r.top); });
  // side-by-side tiles stay side by side
  assert.strictEqual(get(it, 'bands').y, get(it, 'history').y); assert.strictEqual(get(it, 'bands').x + get(it, 'bands').w, get(it, 'history').x);
});
t('fromRects: a minimum width wider than the measured tile shifts the neighbour instead of stacking it', () => {
  const pitch = 20;
  const rects = [{ id: 'hero', left: 0, top: 0, width: 200, height: 300 }, { id: 'eeg', left: 212, top: 0, width: 600, height: 300 }];
  const mins = { hero: { w: 17, h: 10 }, eeg: { w: 5, h: 10 } };
  const it = L.fromRects(rects, { pitch, gap: 12, cols: 48, mins, flex: [] });
  assert.strictEqual(get(it, 'eeg').y, 0); assert.strictEqual(get(it, 'eeg').x, 17); assert.strictEqual(L.anyOverlap(it), null);
});
t('nudgeY: keyboard up/down jumps past the neighbour (so it swaps)', () => {
  const hero = get(DEF, 'hero');
  assert.strictEqual(L.nudgeY(DEF, hero, 1), 42 + 31 - 42);
  const m = L.compact(L.move(DEF, 'hero', 0, L.nudgeY(DEF, hero, 1))); ok(m);
  assert.strictEqual(get(m, 'fit').y, 0); assert.strictEqual(get(m, 'hero').y, 31);
  const fit = get(m, 'fit'), heroAfter = get(m, 'hero');
  assert.strictEqual(L.nudgeY(m, heroAfter, -1), fit.y);
});
console.log(n + ' v2.4 layout tests passed');

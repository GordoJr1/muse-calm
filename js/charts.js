/* Canvas renderers: traces, band bars, history, pulse wave, artificial horizon, calm orb. */
(function (root) {
  'use strict';
  const C = {};
  const sizes = new WeakMap();
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((es) => es.forEach((e) => sizes.set(e.target, { w: e.contentRect.width, h: e.contentRect.height })))
    : null;
  C.observe = (cv) => { if (ro) ro.observe(cv); const r = cv.getBoundingClientRect(); sizes.set(cv, { w: r.width, h: r.height }); };
  C.begin = (cv) => {
    let s = sizes.get(cv);
    if (!ro) { const r = cv.getBoundingClientRect(); s = { w: r.width, h: r.height }; }
    if (!s || s.w < 2 || s.h < 2) return null;
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    const W = Math.round(s.w * dpr), H = Math.round(s.h * dpr);
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.w, s.h);
    return { ctx, w: s.w, h: s.h };
  };
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  C.rgba = rgba; C.mix = mix;
  C.hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const FONT = 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

  /* polyline with min/max decimation when there are more samples than pixels */
  function path(ctx, d, x0, step, yf) {
    const n = d.length;
    ctx.beginPath();
    if (step >= 0.8) {
      for (let k = 0; k < n; k++) { const x = x0 + k * step, y = yf(d[k]); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      return;
    }
    const per = 1 / step; let first = true;
    for (let px = 0; px * per < n; px++) {
      const a = Math.floor(px * per), b = Math.min(n, Math.floor((px + 1) * per));
      let mn = Infinity, mx = -Infinity;
      for (let k = a; k < b; k++) { if (d[k] < mn) mn = d[k]; if (d[k] > mx) mx = d[k]; }
      if (mn === Infinity) continue;
      const x = x0 + a * step;
      if (first) { ctx.moveTo(x, yf(mn)); first = false; } else ctx.lineTo(x, yf(mn));
      if (mx !== mn) ctx.lineTo(x, yf(mx));
    }
  }
  function glowStroke(ctx, color, width) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(color, 0.16); ctx.lineWidth = width * 4; ctx.stroke();
    ctx.strokeStyle = rgba(color, 0.95); ctx.lineWidth = width; ctx.stroke();
  }

  /* stacked lanes of scrolling traces */
  C.traces = (c, lanes, cap) => {
    const { ctx, w, h } = c, n = lanes.length, lh = h / n;
    lanes.forEach((L, i) => {
      const yc = lh * i + lh / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(0, yc); ctx.lineTo(w, yc); ctx.stroke(); ctx.setLineDash([]);
      if (i > 0) { ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.beginPath(); ctx.moveTo(0, lh * i); ctx.lineTo(w, lh * i); ctx.stroke(); }
      const d = L.data;
      if (d && d.length > 1) {
        const lines = L.multi || [{ data: d, color: L.color }];
        lines.forEach((ln) => {
          const step = w / ((L.cap || cap) - 1), x0 = w - (ln.data.length - 1) * step;
          const sc = (lh * 0.44) / L.range, off = L.offset || 0;
          path(ctx, ln.data, x0, step, (v) => yc - clamp((v - off) * sc, -lh / 2 + 2, lh / 2 - 2));
          glowStroke(ctx, ln.color, L.width || 1.3);
        });
      }
      if (L.label) {
        ctx.font = '650 11px ' + FONT; ctx.textBaseline = 'middle';
        const lw1 = ctx.measureText(L.label).width;
        ctx.font = '500 10px ' + FONT;
        const lw2 = L.sub ? ctx.measureText(L.sub).width + 10 : 0;
        roundRect(ctx, 6, lh * i + 5, lw1 + lw2 + 16, 18, 9);
        ctx.fillStyle = 'rgba(8,16,36,0.78)'; ctx.fill();
        ctx.font = '650 11px ' + FONT; ctx.fillStyle = rgba(L.color, 1); ctx.fillText(L.label, 14, lh * i + 14.5);
        if (L.sub) { ctx.font = '500 10px ' + FONT; ctx.fillStyle = 'rgba(200,220,235,0.6)'; ctx.fillText(L.sub, 14 + lw1 + 10, lh * i + 14.5); }
      }
    });
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  C.roundRect = roundRect;

  /* animated band bars; items [{sym, name, value 0..1, color [r,g,b]}] */
  C.bars = (c, items, hscale) => {
    hscale = hscale || 1;
    const { ctx, w, h } = c, n = items.length;
    const top = 26, bottom = 42, colW = w / n, bw = Math.min(46, colW * 0.52), H = h - top - bottom;
    items.forEach((it, i) => {
      const x = colW * i + (colW - bw) / 2, v = clamp(it.value, 0, 1), bh = Math.max(bw * 0.5, H * clamp(v * hscale, 0, 1));
      roundRect(ctx, x, top, bw, H, bw / 2); ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fill();
      const y = top + H - bh;
      const g = ctx.createLinearGradient(0, y, 0, top + H);
      g.addColorStop(0, rgba(mix(it.color, [255, 255, 255], 0.25), 1)); g.addColorStop(1, rgba(it.color, 0.25));
      ctx.save(); ctx.shadowColor = rgba(it.color, 0.55); ctx.shadowBlur = 18;
      roundRect(ctx, x, y, bw, bh, bw / 2); ctx.fillStyle = g; ctx.fill(); ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = '600 12px ' + FONT; ctx.fillStyle = 'rgba(232,241,245,0.9)';
      ctx.fillText(Math.round(v * 100) + '%', x + bw / 2, y - 8);
      const named = colW >= 42;                      // narrow panels: symbols only (the popovers name each band)
      ctx.font = '600 17px ' + FONT; ctx.fillStyle = rgba(it.color, 1);
      ctx.fillText(it.sym, x + bw / 2, named ? h - 22 : h - 14);
      if (named) { ctx.font = '500 10.5px ' + FONT; ctx.fillStyle = 'rgba(190,210,225,0.6)'; ctx.fillText(it.name, x + bw / 2, h - 6); }
    });
    ctx.textAlign = 'left';
  };

  /* history lines (values 0..max), right-aligned in time */
  C.history = (c, series, cap, max, labels) => {
    const { ctx, w, h } = c, padB = 18, H = h - padB;
    ctx.font = '500 10px ' + FONT; ctx.fillStyle = 'rgba(190,210,225,0.4)'; ctx.textBaseline = 'middle';
    for (let k = 1; k <= 3; k++) {
      const y = H - (H * k) / 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(Math.round((max * k / 4) * 100) + '%', 4, y - 7);
    }
    if (labels) { ctx.textAlign = 'right'; ctx.fillText(labels[1], w - 2, h - 7); ctx.textAlign = 'left'; ctx.fillText(labels[0], 2, h - 7); }
    const step = w / (cap - 1);
    series.forEach((s) => {
      const d = s.data; if (!d || d.length < 2) return;
      const x0 = w - (d.length - 1) * step, yf = (v) => H - clamp(v / max, 0, 1) * (H - 4) - 2;
      ctx.beginPath();
      ctx.moveTo(x0, yf(d[0]));
      for (let k = 1; k < d.length - 1; k++) {
        const xm = x0 + (k + 0.5) * step, ym = (yf(d[k]) + yf(d[k + 1])) / 2;
        ctx.quadraticCurveTo(x0 + k * step, yf(d[k]), xm, ym);
      }
      ctx.lineTo(x0 + (d.length - 1) * step, yf(d[d.length - 1]));
      if (s.fill) {
        ctx.save(); ctx.lineTo(w, H); ctx.lineTo(x0, H); ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, rgba(s.color, 0.32)); g.addColorStop(1, rgba(s.color, 0));
        ctx.fillStyle = g; ctx.fill(); ctx.restore();
        ctx.beginPath(); ctx.moveTo(x0, yf(d[0]));
        for (let k = 1; k < d.length - 1; k++) ctx.quadraticCurveTo(x0 + k * step, yf(d[k]), x0 + (k + 0.5) * step, (yf(d[k]) + yf(d[k + 1])) / 2);
        ctx.lineTo(x0 + (d.length - 1) * step, yf(d[d.length - 1]));
      }
      glowStroke(ctx, s.color, s.width || 1.4);
    });
  };

  /* pulse waveform with fill and live dot */
  C.wave = (c, d, color, st) => {
    const { ctx, w, h } = c;
    if (!d || d.length < 2) return;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < d.length; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
    const span = Math.max(mx - mn, 1e-6);
    st.lo = st.lo === undefined ? mn : st.lo + (mn - st.lo) * 0.06;
    st.hi = st.hi === undefined ? mx : st.hi + (mx - st.hi) * 0.06;
    const lo = Math.min(st.lo, mn + span * 0.1), hi = Math.max(st.hi, mx - span * 0.1), rng = Math.max(hi - lo, 1e-6);
    const step = w / (d.length - 1), yf = (v) => h - 8 - ((v - lo) / rng) * (h - 20);
    path(ctx, d, 0, step, yf);
    ctx.save(); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, rgba(color, 0.28)); g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
    path(ctx, d, 0, step, yf); glowStroke(ctx, color, 2);
    const ex = w - 1, ey = yf(d[d.length - 1]);
    const rg = ctx.createRadialGradient(ex, ey, 0, ex, ey, 12); rg.addColorStop(0, rgba(color, 0.9)); rg.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(ex, ey, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2); ctx.fill();
  };

  /* artificial horizon for head tilt (degrees, relative to the neutral pose) */
  C.horizon = (c, pitch, roll) => {
    const { ctx, w, h } = c, cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 4;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-roll * Math.PI / 180);
    const off = clamp(pitch, -40, 40) * R / 40;
    const sky = ctx.createLinearGradient(0, -R * 2, 0, off); sky.addColorStop(0, '#0b1438'); sky.addColorStop(1, '#27477e');
    ctx.fillStyle = sky; ctx.fillRect(-R * 2, -R * 3, R * 4, R * 3 + off);
    const gr = ctx.createLinearGradient(0, off, 0, R * 2); gr.addColorStop(0, '#17695f'); gr.addColorStop(1, '#0a2b2c');
    ctx.fillStyle = gr; ctx.fillRect(-R * 2, off, R * 4, R * 3);
    ctx.strokeStyle = 'rgba(180,255,240,0.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-R * 2, off); ctx.lineTo(R * 2, off); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
    for (const p of [-20, -10, 10, 20]) {
      const y = off - p * R / 40, lw = Math.abs(p) === 10 ? R * 0.28 : R * 0.45;
      ctx.beginPath(); ctx.moveTo(-lw / 2, y); ctx.lineTo(lw / 2, y); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    for (let a = -60; a <= 60; a += 30) {
      const t = (a - 90) * Math.PI / 180;
      ctx.strokeStyle = a === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R); ctx.lineTo(cx + Math.cos(t) * (R - 7), cy + Math.sin(t) * (R - 7)); ctx.stroke();
    }
    ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - R * 0.42, cy); ctx.lineTo(cx - R * 0.14, cy); ctx.lineTo(cx - R * 0.07, cy + R * 0.08);
    ctx.moveTo(cx + R * 0.42, cy); ctx.lineTo(cx + R * 0.14, cy); ctx.lineTo(cx + R * 0.07, cy + R * 0.08); ctx.stroke();
    ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
  };

  /* sparkline 0..100 with threshold */
  C.spark = (c, d, threshold, color) => {
    const { ctx, w, h } = c;
    const yt = h - (threshold / 100) * h;
    ctx.strokeStyle = 'rgba(253,230,138,0.35)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yt); ctx.lineTo(w, yt); ctx.stroke(); ctx.setLineDash([]);
    if (!d || d.length < 2) return;
    const step = w / (Math.max(d.length, 30) - 1), x0 = w - (d.length - 1) * step, yf = (v) => h - 2 - (v / 100) * (h - 4);
    path(ctx, d, x0, step, yf);
    ctx.save(); ctx.lineTo(w, h); ctx.lineTo(x0, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, rgba(color, 0.35)); g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g; ctx.fill(); ctx.restore();
    path(ctx, d, x0, step, yf); glowStroke(ctx, color, 1.6);
  };

  /* ---- Calm orb (hero) ---- */
  const STOPS = [[0, [139, 128, 249]], [35, [96, 165, 250]], [55, [34, 211, 200]], [75, [52, 211, 153]], [100, [120, 235, 170]]];
  C.calmColor = (s) => {
    if (s === null || s === undefined) return [110, 130, 180];
    for (let i = 1; i < STOPS.length; i++) if (s <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
      return mix(ca, cb, (s - a) / (b - a));
    }
    return STOPS[STOPS.length - 1][1];
  };
  let sprite = null;
  function glowSprite() {
    if (sprite) return sprite;
    sprite = document.createElement('canvas'); sprite.width = sprite.height = 64;
    const g = sprite.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,250,220,1)'); rg.addColorStop(0.18, 'rgba(255,240,180,0.85)'); rg.addColorStop(0.45, 'rgba(190,255,210,0.22)'); rg.addColorStop(1, 'rgba(190,255,210,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    return sprite;
  }
  const flies = Array.from({ length: 64 }, (_, i) => ({ a: Math.random() * 6.283, s: (0.04 + Math.random() * 0.1) * (i % 2 ? 1 : -1), r: Math.random(), f: 0.3 + Math.random(), p: Math.random() * 6.283, z: 0.5 + Math.random(), v: 0 }));

  C.orb = (c, s) => {
    const { ctx, w, h } = c, cx = w / 2, cy = h / 2, R = Math.min(w, h) * (s.session ? 0.31 : 0.33), t = s.time;
    const hasScore = s.score !== null && s.score !== undefined;
    const col = C.calmColor(hasScore ? s.score : null), dim = !hasScore;
    const breath = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / 10);
    const r = R * (0.83 + 0.075 * breath + 0.018 * (s.beat || 0));
    // aura
    const outer = Math.min(w, h) / 2;
    let g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, outer);
    g.addColorStop(0, rgba(col, dim ? 0.2 : 0.4)); g.addColorStop(0.45, rgba(col, dim ? 0.06 : 0.12)); g.addColorStop(0.8, rgba(col, dim ? 0.015 : 0.03)); g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // tick ring
    const RR = R * 1.2;
    for (let i = 0; i < 100; i += 2) {
      const a = -Math.PI / 2 + (i / 100) * Math.PI * 2, major = i % 10 === 0;
      const r1 = RR + R * 0.07, r2 = r1 + (major ? R * 0.05 : R * 0.025);
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)'; ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.stroke();
    }
    const lw = Math.max(5, R * 0.045);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, RR, 0, Math.PI * 2); ctx.stroke();
    const a0 = -Math.PI / 2;
    if (s.calibrating && s.active) {
      ctx.save(); ctx.setLineDash([2, lw * 1.2]); ctx.strokeStyle = 'rgba(220,235,255,0.65)'; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(cx, cy, RR, a0, a0 + Math.PI * 2 * Math.max(0.002, s.calibProgress)); ctx.stroke(); ctx.restore();
    } else if (hasScore) {
      const a1 = a0 + Math.PI * 2 * clamp(s.score, 0.5, 100) / 100;
      let stroke;
      if (ctx.createConicGradient) {
        stroke = ctx.createConicGradient(a0, cx, cy);
        stroke.addColorStop(0, rgba(C.calmColor(0), 1)); stroke.addColorStop(0.5, rgba(C.calmColor(55), 1)); stroke.addColorStop(1, rgba(C.calmColor(100), 1));
      } else stroke = rgba(col, 1);
      ctx.save(); ctx.shadowColor = rgba(col, 0.8); ctx.shadowBlur = 18; ctx.strokeStyle = stroke; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(cx, cy, RR, a0, a1); ctx.stroke(); ctx.restore();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + Math.cos(a1) * RR, cy + Math.sin(a1) * RR, lw * 0.42, 0, Math.PI * 2); ctx.fill();
    }
    if (s.session) {                 // meditation countdown ring (depletes clockwise from the top)
      const RS = R * 1.5, lw2 = Math.max(2.5, R * 0.02), p = clamp(s.session.progress, 0, 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = lw2; ctx.beginPath(); ctx.arc(cx, cy, RS, 0, Math.PI * 2); ctx.stroke();
      if (p < 1) {
        const b0 = a0 + Math.PI * 2 * p, b1 = a0 + Math.PI * 2;
        ctx.save(); if (s.session.paused) ctx.setLineDash([3, 6]);
        ctx.shadowColor = 'rgba(253,230,138,0.7)'; ctx.shadowBlur = s.session.paused ? 0 : 12;
        const gg = ctx.createLinearGradient(cx - RS, cy - RS, cx + RS, cy + RS); gg.addColorStop(0, 'rgba(253,230,138,0.95)'); gg.addColorStop(1, 'rgba(251,207,232,0.85)');
        ctx.strokeStyle = gg; ctx.lineWidth = lw2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, cy, RS, b0, b1); ctx.stroke(); ctx.restore();
        const hx = cx + Math.cos(b0) * RS, hy = cy + Math.sin(b0) * RS, hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10);
        hg.addColorStop(0, 'rgba(255,248,220,1)'); hg.addColorStop(1, 'rgba(253,230,138,0)');
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hx, hy, 10, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (s.threshold && s.active) {   // bird threshold marker
      const at = a0 + Math.PI * 2 * s.threshold / 100, rx = cx + Math.cos(at) * (RR - lw * 1.6), ry = cy + Math.sin(at) * (RR - lw * 1.6);
      ctx.fillStyle = 'rgba(253,230,138,0.9)'; ctx.beginPath(); ctx.arc(rx, ry, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    // orb body
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.42, r * 0.04, cx, cy, r * 1.05);
    const deep = [4, 22, 48];
    g.addColorStop(0, rgba(mix(col, [255, 255, 255], 0.55), 1)); g.addColorStop(0.28, rgba(mix(col, [255, 255, 255], 0.1), 1));
    g.addColorStop(0.62, rgba(mix(col, deep, 0.3), 1)); g.addColorStop(1, rgba(mix(col, deep, 0.72), 1));
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'lighter';
    const tints = [mix(col, [120, 200, 255], 0.5), mix(col, [255, 225, 150], hasScore && s.score > 70 ? 0.6 : 0.2), mix(col, [170, 140, 255], 0.45)];
    for (let i = 0; i < 3; i++) {
      const an = t * (0.11 + 0.05 * i) + i * 2.1, bx = cx + Math.cos(an) * r * 0.42, by = cy + Math.sin(an * 1.3) * r * 0.36;
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, r * 0.75);
      bg.addColorStop(0, rgba(tints[i], dim ? 0.1 : 0.22)); bg.addColorStop(1, rgba(tints[i], 0));
      ctx.fillStyle = bg; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.55, 0, cx - r * 0.3, cy - r * 0.55, r * 0.6);
    g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    ctx.strokeStyle = rgba(mix(col, [255, 255, 255], 0.6), 0.35); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    // fireflies: more when calmer and while birds sing
    const sp = glowSprite();
    const want = hasScore && !s.calibrating ? Math.round(clamp((s.score - 40) / 60, 0, 1) * 34 + (s.birds || 0) * 5) : (s.active ? 4 : 6);
    flies.forEach((f, i) => {
      f.v += ((i < want ? 1 : 0) - f.v) * 0.02;
      if (f.v < 0.01) return;
      const an = f.a + t * f.s, rad = R * (1.02 + f.r * 0.85) + Math.sin(t * f.f + f.p) * R * 0.06;
      const x = cx + Math.cos(an) * rad, y = cy + Math.sin(an) * rad * 0.92 + Math.sin(t * 0.7 + f.p) * 6;
      const tw = 0.45 + 0.55 * Math.pow(0.5 + 0.5 * Math.sin(t * (1.6 + f.f) + f.p * 3), 2);
      const sz = 10 + 12 * f.z;
      ctx.globalAlpha = f.v * tw * (dim ? 0.45 : 0.9);
      ctx.drawImage(sp, x - sz / 2, y - sz / 2, sz, sz);
    });
    ctx.globalAlpha = 1;
  };

  /* calm over a whole session: gaps where scoring paused, calibration shaded */
  C.sessionChart = (c, series, threshold, color) => {
    const { ctx, w, h } = c, padL = 26, padB = 16, W = w - padL, H = h - padB - 4;
    ctx.font = '500 10px ' + FONT; ctx.fillStyle = 'rgba(190,210,225,0.45)'; ctx.textBaseline = 'middle';
    [0, 50, 100].forEach((v) => { const y = 4 + H - (v / 100) * H; ctx.fillText(String(v), 2, y); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke(); });
    const n = series.length; if (n < 2) return;
    const step = W / (n - 1), X = (i) => padL + i * step, Y = (v) => 4 + H - clamp(v, 0, 100) / 100 * H;
    // calibration band
    let a = -1;
    for (let i = 0; i <= n; i++) {
      const cal = i < n && series[i].cal;
      if (cal && a < 0) a = i;
      if (!cal && a >= 0) {
        ctx.fillStyle = 'rgba(160,200,255,0.06)'; ctx.fillRect(X(a), 4, Math.max(2, X(i - 1) - X(a) + step * 0.5), H);
        ctx.fillStyle = 'rgba(190,210,235,0.5)'; ctx.fillText('baseline', X(a) + 6, 12); a = -1;
      }
    }
    const yt = Y(threshold);
    ctx.strokeStyle = 'rgba(253,230,138,0.45)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(padL, yt); ctx.lineTo(w, yt); ctx.stroke(); ctx.setLineDash([]);
    // segments of valid values
    const segs = []; let cur = [];
    series.forEach((p, i) => { if (p.v === null || p.v === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push([X(i), Y(p.v)]); });
    if (cur.length) segs.push(cur);
    segs.forEach((sg) => {
      if (sg.length === 1) sg.push([sg[0][0] + 1, sg[0][1]]);
      const line = () => { ctx.beginPath(); ctx.moveTo(sg[0][0], sg[0][1]); for (let k = 1; k < sg.length; k++) { const [x0, y0] = sg[k - 1], [x1, y1] = sg[k]; ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2); } ctx.lineTo(sg[sg.length - 1][0], sg[sg.length - 1][1]); };
      line(); ctx.save(); ctx.lineTo(sg[sg.length - 1][0], 4 + H); ctx.lineTo(sg[0][0], 4 + H); ctx.closePath();
      const g = ctx.createLinearGradient(0, 4, 0, 4 + H); g.addColorStop(0, rgba(color, 0.4)); g.addColorStop(1, rgba(color, 0)); ctx.fillStyle = g; ctx.fill(); ctx.restore();
      line(); glowStroke(ctx, color, 2);
    });
  };

  /* past-session timeline: bands (multi-line), calm score (with threshold), heart rate, on one time axis.
   * pts: [{t, rel, calm, hr, baseline, excluded}]; o: {bands:[{key,color}], threshold, cursor, step}.
   * Returns layout {padL, W, x(i), idxAt(px), panels} for pointer mapping. */
  C.timeline = (c, pts, o) => {
    const { ctx, w, h } = c, n = pts.length, padL = 34, padR = 8, padB = 18, padT = 8, gap = 12;
    const W = w - padL - padR, avail = h - padB - padT - gap * 2;
    const hasHr = pts.some((p) => p.hr);
    const hb = Math.round(avail * (hasHr ? 0.44 : 0.56)), hc = Math.round(avail * (hasHr ? 0.33 : 0.44)), hh = hasHr ? avail - hb - hc : 0;
    const P = [{ y: padT, h: hb, key: 'bands' }, { y: padT + hb + gap, h: hc, key: 'calm' }];
    if (hasHr) P.push({ y: padT + hb + hc + gap * 2, h: hh, key: 'hr' });
    const span = Math.max(1, (n - 1)), step = o.step || 2;
    const x = (i) => padL + (n <= 1 ? W / 2 : (i / span) * W);
    const idxAt = (px) => clamp(Math.round(((px - padL) / W) * span), 0, n - 1);
    ctx.font = '500 10px ' + FONT; ctx.textBaseline = 'middle';
    // shaded phases (all panels)
    const shade = (test, fill, label) => {
      let a = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && test(pts[i]);
        if (on && a < 0) a = i;
        if (!on && a >= 0) {
          const x0 = Math.max(padL, x(a) - (W / span) / 2), x1 = Math.min(padL + W, x(i - 1) + (W / span) / 2);
          P.forEach((p) => { ctx.fillStyle = fill; ctx.fillRect(x0, p.y, Math.max(1.5, x1 - x0), p.h); });
          if (label && x1 - x0 > 46) { ctx.fillStyle = 'rgba(190,210,235,0.55)'; ctx.fillText(label, x0 + 5, P[0].y + 9); }
          a = -1;
        }
      }
    };
    shade((p) => p.baseline, 'rgba(160,200,255,0.07)', 'baseline');
    shade((p) => p.excluded, 'rgba(251,113,133,0.10)', null);
    // panel frames + axis labels
    const grid = (p, vals, fmt, lo, hi) => {
      vals.forEach((v) => { const y = p.y + p.h - ((v - lo) / (hi - lo)) * p.h; ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke(); ctx.fillStyle = 'rgba(190,210,225,0.42)'; ctx.textAlign = 'right'; ctx.fillText(fmt(v), padL - 6, y); });
      ctx.textAlign = 'left';
    };
    const line = (p, get, lo, hi, color, width, fill) => {
      const Y = (v) => p.y + p.h - clamp((v - lo) / (hi - lo), 0, 1) * p.h;
      let segs = [], cur = [];
      for (let i = 0; i < n; i++) { const v = get(pts[i]); if (v === null || v === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), Y(v)]); }
      if (cur.length) segs.push(cur);
      segs.forEach((sg) => {
        if (sg.length === 1) sg.push([sg[0][0] + 1.5, sg[0][1]]);
        const draw = () => { ctx.beginPath(); ctx.moveTo(sg[0][0], sg[0][1]); for (let k = 1; k < sg.length; k++) { const [x0, y0] = sg[k - 1], [x1, y1] = sg[k]; ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2); } ctx.lineTo(sg[sg.length - 1][0], sg[sg.length - 1][1]); };
        if (fill) { draw(); ctx.lineTo(sg[sg.length - 1][0], p.y + p.h); ctx.lineTo(sg[0][0], p.y + p.h); ctx.closePath(); const g = ctx.createLinearGradient(0, p.y, 0, p.y + p.h); g.addColorStop(0, rgba(color, 0.3)); g.addColorStop(1, rgba(color, 0)); ctx.fillStyle = g; ctx.fill(); }
        draw(); glowStroke(ctx, color, width);
      });
      return Y;
    };
    // bands
    let bmax = 0.3; pts.forEach((p) => { if (p.rel) for (const k in p.rel) bmax = Math.max(bmax, p.rel[k]); });
    bmax = Math.min(1, Math.ceil(bmax * 10) / 10);
    const pb = P[0]; grid(pb, [0, bmax / 2, bmax], (v) => Math.round(v * 100) + '%', 0, bmax);
    o.bands.forEach((b) => { if (b.key !== 'alpha') line(pb, (p) => (p.rel ? p.rel[b.key] : null), 0, bmax, b.color, 1.3); });
    const ba = o.bands.find((b) => b.key === 'alpha'); if (ba) line(pb, (p) => (p.rel ? p.rel.alpha : null), 0, bmax, ba.color, 2.3, true);
    // calm
    const pc = P[1]; grid(pc, [0, 50, 100], String, 0, 100);
    const yt = pc.y + pc.h - (o.threshold / 100) * pc.h;
    ctx.strokeStyle = 'rgba(253,230,138,0.5)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(padL, yt); ctx.lineTo(padL + W, yt); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(253,230,138,0.6)'; ctx.textAlign = 'right'; ctx.fillText('birds ' + o.threshold, padL + W - 2, yt - 8); ctx.textAlign = 'left';
    line(pc, (p) => p.calm, 0, 100, [94, 234, 212], 2, true);
    // heart
    let hlo = 0, hhi = 0;
    if (hasHr) {
      const hv = pts.map((p) => p.hr).filter((v) => v); hlo = Math.floor((Math.min(...hv) - 4) / 5) * 5; hhi = Math.ceil((Math.max(...hv) + 4) / 5) * 5; if (hhi - hlo < 15) hhi = hlo + 15;
      grid(P[2], [hlo, hhi], String, hlo, hhi);
      line(P[2], (p) => p.hr || null, hlo, hhi, [251, 113, 133], 1.6);
    }
    // panel captions
    ctx.fillStyle = 'rgba(210,225,238,0.55)'; ctx.font = '600 9.5px ' + FONT; ctx.textAlign = 'right';
    ctx.fillText('BRAINWAVES', padL + W - 2, pb.y + 9); ctx.fillText('CALM', padL + W - 2, pc.y + 9); if (hasHr) ctx.fillText('HEART · BPM', padL + W - 2, P[2].y + 9);
    ctx.textAlign = 'left'; ctx.font = '500 10px ' + FONT;
    // time axis
    const total = (n - 1) * step, ticks = total <= 180 ? 30 : total <= 600 ? 60 : total <= 1800 ? 300 : total <= 5400 ? 600 : 1800;
    ctx.fillStyle = 'rgba(190,210,225,0.42)'; ctx.textAlign = 'center';
    const fmt = (s) => { s = Math.round(s); const m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; };
    for (let t = 0; t <= total + 0.01; t += ticks) { const xx = padL + (total ? t / total : 0) * W; if (xx > padL + W - 14 && t > 0) continue; ctx.fillText(fmt(t), clamp(xx, padL + 12, padL + W - 12), h - 8); }
    ctx.textAlign = 'right'; ctx.fillText(fmt(total), padL + W, h - 8); ctx.textAlign = 'left';
    // cursor
    if (o.cursor !== null && o.cursor !== undefined && n) {
      const i = clamp(o.cursor, 0, n - 1), xx = x(i), p = pts[i];
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h - padB); ctx.stroke();
      const dot = (y, col) => { ctx.beginPath(); ctx.arc(xx, y, 3.2, 0, Math.PI * 2); ctx.fillStyle = rgba(col, 1); ctx.fill(); ctx.strokeStyle = 'rgba(8,18,32,0.9)'; ctx.lineWidth = 1.5; ctx.stroke(); };
      if (p.rel) o.bands.forEach((b) => dot(pb.y + pb.h - clamp(p.rel[b.key] / bmax, 0, 1) * pb.h, b.color));
      if (p.calm !== null) dot(pc.y + pc.h - clamp(p.calm / 100, 0, 1) * pc.h, [94, 234, 212]);
      if (hasHr && p.hr) dot(P[2].y + P[2].h - clamp((p.hr - hlo) / (hhi - hlo), 0, 1) * P[2].h, [251, 113, 133]);
    }
    return { padL, W, x, idxAt, panels: P };
  };
  root.Charts = C;
})(typeof self !== 'undefined' ? self : this);

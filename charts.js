// Hand-drawn SVG charts for the page. Data come from generated JSON only.
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Spread label positions so they do not overlap (min gap in px), keeping order. */
function spread(ys, gap, lo, hi) {
  const idx = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = Array(ys.length);
  let prev = -Infinity;
  for (const [y, i] of idx) { const v = Math.max(y, prev + gap); out[i] = v; prev = v; }
  const over = Math.max(0, prev - hi);
  if (over) for (let i = 0; i < out.length; i++) out[i] = Math.max(lo, out[i] - over);
  return out;
}

/**
 * On-time curve: x fleet, y share on time. series: [{key, name, colour, main, pts:[{x, y, lo, hi}]}].
 * Main series get a band and a thick line; the others a thin line. Labels sit at the line ends.
 */
export function curve(el, { title, series, xs, xLabel, xFmt, target, targetLabel }) {
  const W = 420, H = 300, L = 40, R = 118, T = 30, B = 40;
  const yLo = 0.5, yHi = 1.0;
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (v) => L + (W - L - R) * (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0));
  const Y = (v) => T + (H - T - B) * (1 - (Math.max(yLo, Math.min(yHi, v)) - yLo) / (yHi - yLo));
  const ink2 = css("--ink-2"), line = css("--line"), ink = css("--ink");
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
  s += `<text x="${L}" y="16" font-size="13" font-weight="600" fill="${ink}">${esc(title)}</text>`;
  for (const v of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    s += `<line x1="${L}" x2="${W - R + 8}" y1="${Y(v)}" y2="${Y(v)}" stroke="${line}"/>`;
    s += `<text x="${L - 8}" y="${Y(v) + 4}" font-size="10.5" text-anchor="end" fill="${ink2}">${Math.round(v * 100)}</text>`;
  }
  for (const v of xs) s += `<text x="${X(v)}" y="${H - B + 18}" font-size="10.5" text-anchor="middle" fill="${ink2}">${esc(xFmt(v))}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="${ink2}">${esc(xLabel)}</text>`;
  if (target) {
    s += `<line x1="${L}" x2="${W - R + 8}" y1="${Y(target)}" y2="${Y(target)}" stroke="${ink2}" stroke-dasharray="5 4"/>`;
    s += `<text x="${L + 4}" y="${Y(target) - 5}" font-size="10.5" fill="${ink2}">${esc(targetLabel)}</text>`;
  }
  const ordered = [...series.filter((q) => !q.main), ...series.filter((q) => q.main)];
  for (const q of ordered) {
    const pts = q.pts.filter((p) => p.y !== undefined);
    if (!pts.length) continue;
    if (q.main && pts.length > 1) {
      const up = pts.map((p) => `${X(p.x)},${Y(p.hi)}`).join(" "), dn = [...pts].reverse().map((p) => `${X(p.x)},${Y(p.lo)}`).join(" ");
      s += `<polygon points="${up} ${dn}" fill="${q.colour}" opacity=".16"/>`;
    }
    s += `<polyline points="${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}" fill="none" stroke="${q.colour}" stroke-width="${q.main ? 2.6 : 1.3}" opacity="${q.main ? 1 : 0.75}" stroke-linejoin="round"/>`;
    for (const p of pts) s += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${q.main ? 3.4 : 2.2}" fill="${q.colour}"><title>${esc(q.name)}: ${(p.y * 100).toFixed(1)} % [${(p.lo * 100).toFixed(1)}, ${(p.hi * 100).toFixed(1)}]</title></circle>`;
  }
  const ends = series.map((q) => { const p = q.pts[q.pts.length - 1]; return p ? Y(p.y) : null; });
  const ok = series.map((q, i) => [q, ends[i]]).filter(([, y]) => y !== null);
  const ly = spread(ok.map(([, y]) => y), 13, T, H - B);
  ok.forEach(([q, y], i) => {
    s += `<line x1="${W - R + 2}" x2="${W - R + 10}" y1="${y}" y2="${ly[i]}" stroke="${q.colour}" opacity=".6"/>`;
    s += `<text x="${W - R + 13}" y="${ly[i] + 3.5}" font-size="11" fill="${q.main ? ink : ink2}" font-weight="${q.main ? 600 : 400}">${esc(q.name)}</text>`;
  });
  el.innerHTML = s + "</svg>";
}

/**
 * Small-multiple strips: one row per group (layout), one dot per method on a shared axis.
 * rows: [{group, items:[{key, name, colour, value, main}]}]
 */
export function strips(el, { rows, log = false, unit, ref, refLabel, axisLabel }) {
  const W = 760, rowH = 34, L = 90, R = 24, T = 28, B = 34;
  const H = T + rows.length * rowH + B;
  const vals = rows.flatMap((r) => r.items.map((i) => i.value)).filter((v) => v > 0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (log) { lo = 10 ** Math.floor(Math.log10(lo)); hi = 10 ** Math.ceil(Math.log10(hi)); } else { lo = 0; hi = hi * 1.06; }
  const X = (v) => L + (W - L - R) * (log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo));
  const ink2 = css("--ink-2"), line = css("--line"), ink = css("--ink");
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(axisLabel)}">`;
  const ticks = log ? [...Array(Math.round(Math.log10(hi / lo)) + 1).keys()].map((i) => lo * 10 ** i)
    : [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(hi * f / 10) * 10);
  for (const t of ticks) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${T - 6}" y2="${H - B}" stroke="${line}"/>`;
    const lab = log ? (t >= 1 ? `${t}` : t >= 0.001 ? `${t * 1000} m` : `${t * 1e6} µ`) : `${t}`;
    s += `<text x="${X(t)}" y="${H - B + 16}" font-size="10.5" text-anchor="middle" fill="${ink2}">${lab}${unit}</text>`;
  }
  s += `<text x="${(L + W - R) / 2}" y="${H - 4}" font-size="11" text-anchor="middle" fill="${ink2}">${esc(axisLabel)}</text>`;
  if (ref) {
    s += `<line x1="${X(ref)}" x2="${X(ref)}" y1="${T - 10}" y2="${H - B}" stroke="${ink2}" stroke-dasharray="5 4"/>`;
    s += `<text x="${X(ref) + 5}" y="${T - 12}" font-size="10.5" fill="${ink2}">${esc(refLabel)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = T + i * rowH + rowH / 2;
    s += `<text x="${L - 12}" y="${y + 4}" font-size="12" text-anchor="end" fill="${ink}">${esc(r.group)}</text>`;
    s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${line}" stroke-width="6" stroke-linecap="round" opacity=".55"/>`;
    for (const it of [...r.items].sort((a, b) => a.main - b.main)) {
      if (!(it.value > 0)) continue;
      s += `<circle cx="${X(it.value)}" cy="${y}" r="${it.main ? 6.5 : 4.5}" fill="${it.colour}" stroke="${css("--bg")}" stroke-width="1.5"><title>${esc(it.name)}, ${esc(r.group)}: ${it.value < 1 ? it.value.toPrecision(3) : it.value.toFixed(0)} ${unit.trim() || ""}</title></circle>`;
    }
  });
  el.innerHTML = s + "</svg>";
}

/** Inline key for strips: coloured dots with names. */
export function key(items) {
  return `<div class="legend">${items.map(([name, colour]) => `<span><i style="background:${colour}"></i>${esc(name)}</span>`).join("")}</div>`;
}

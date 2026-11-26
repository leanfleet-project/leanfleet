// Interactive diagram of the student network (factory_dispatch/learn/model.py,
// DispatchPolicy). Sizes are read from the page constants (paper/constants.tex).
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function initArch(svg, inspector, playBtn, k) {
  const h = k.hidden, B = (id, x, y, w, title, dims, text, group) => ({ id, x, y, w, h: 54, title, dims, text, group });
  const blocks = [
    B("road", 20, 60, 170, "Road graph", "cells · roads · occupancy", `One node per road cell, edges along the roads. Node features include how busy each cell is in the next ${k.occa}, ${k.occb} and ${k.occc} s, and whether it is blocked.`, "in"),
    B("agvs", 20, 180, 170, "AGVs", "position · plan · trays", "Each AGV with its position on the road graph, its remaining stops and its load.", "in"),
    B("orders", 20, 300, 170, "Orders", "pick-up · drop · deadline", `Waiting orders, and planned orders due within the next ${k.lookahead} s, with priority, size and slack to the deadline.`, "in"),
    B("mp", 240, 60, 190, `Message passing × ${k.roadlayers}`, `hidden ${h} · residual · LayerNorm`, `Each road cell gathers messages from its neighbours along the roads, ${k.roadlayers} times, so it knows about traffic a few cells away.`, "enc"),
    B("tok", 240, 180, 190, "Tokens", "AGV · order · global", "An AGV token adds the embedding of the road cell it stands on; an order token adds the embeddings of its pick-up and drop cells. One global token describes the shift.", "enc"),
    B("tf", 480, 180, 190, `Transformer × ${k.tflayers}`, `${k.heads} heads · hidden ${h}`, `Every AGV and order attends to all the others, so a score can depend on the whole fleet and the whole queue.`, "enc"),
    B("pair", 720, 120, 220, "Pair score", `(order, AGV) · ${k.knearest} nearest AGVs`, `For each waiting order and each of the ${k.knearest} AGVs nearest to its pick-up, a score for inserting the order into that AGV's plan.`, "out"),
    B("defer", 720, 240, 220, "Not now", "pooled fleet + queue", "One score for waiting: computed from the global token and the mean AGV and order tokens.", "out"),
    B("dec", 720, 345, 220, "Decision", `wait if share ≥ ${k.deferprob}`, `A softmax over all pairs and not now. The student waits if not now takes at least ${k.deferprob} of the probability, otherwise it takes the best pair; orders past their deadline go to their cheapest insertion.`, "out"),
  ];
  const wires = [["road", "mp"], ["mp", "tok"], ["agvs", "tok"], ["orders", "tok"], ["tok", "tf"], ["tf", "pair"], ["tf", "defer"], ["pair", "dec"], ["defer", "dec"]];
  const by = Object.fromEntries(blocks.map((b) => [b.id, b]));
  const port = (b, side) => side === "r" ? [b.x + b.w, b.y + b.h / 2] : side === "l" ? [b.x, b.y + b.h / 2] : side === "b" ? [b.x + b.w / 2, b.y + b.h] : [b.x + b.w / 2, b.y];
  function path(a, b) {
    const A = by[a], Bb = by[b];
    if (a === "mp" && b === "tok") { const [x1, y1] = port(A, "b"), [x2, y2] = port(Bb, "t"); return `M${x1},${y1} L${x2},${y2}`; }
    if (a === "pair" || a === "defer") { const [x1, y1] = port(A, "b"), [x2, y2] = port(Bb, "t"); if (a === "pair") { const r = A.x + A.w, ya = A.y + A.h / 2, yb = Bb.y + Bb.h / 2; return `M${r},${ya} L${r + 12},${ya} L${r + 12},${yb} L${r + 2},${yb}`; } return `M${x1},${y1} L${x2},${y2}`; }
    const [x1, y1] = port(A, "r"), [x2, y2] = port(Bb, "l"), mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const groups = [["in", "Input", 10, 30, 190, 340], ["enc", "Encoder", 230, 30, 450, 220], ["out", "Heads", 710, 90, 246, 320]];
  let s = `<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${css("--rule")}"/></marker></defs>`;
  for (const [, name, x, y, w, hh] of groups) s += `<g class="group"><rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="4"/><text class="group-label" x="${x + 10}" y="${y + 16}">${name}</text></g>`;
  for (const [a, b] of wires) s += `<path class="wire" id="w-${a}-${b}" d="${path(a, b)}" marker-end="url(#ah)"/>`;
  for (const b of blocks) s += `<g class="blk" data-id="${b.id}" tabindex="0" role="button" aria-label="${b.title}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"/><text class="t" x="${b.x + 12}" y="${b.y + 22}">${b.title}</text><text class="d" x="${b.x + 12}" y="${b.y + 40}">${b.dims}</text></g>`;
  s += `<g id="pulses"></g>`;
  svg.innerHTML = s;
  // Keep every label inside its box: measure the rendered text, shrink it if needed.
  const fitText = () => svg.querySelectorAll(".blk").forEach((g) => {
    const w = +g.querySelector("rect").getAttribute("width") - 22;
    for (const t of g.querySelectorAll("text")) {
      let size = parseFloat(getComputedStyle(t).fontSize);
      while (t.getComputedTextLength() > w && size > 8) { size -= 0.5; t.style.fontSize = `${size}px`; }
    }
  });
  fitText();
  document.fonts?.ready.then(fitText);

  function show(id) {
    const b = by[id];
    svg.querySelectorAll(".blk").forEach((g) => g.classList.toggle("on", g.dataset.id === id));
    svg.querySelectorAll(".wire").forEach((w) => w.classList.toggle("on", w.id.split("-").slice(1).includes(id)));
    inspector.innerHTML = `<h4>${b.title}</h4><p>${b.text}</p><p class="dims">${b.dims}</p>`;
  }
  svg.querySelectorAll(".blk").forEach((g) => {
    g.addEventListener("click", () => { stop(); show(g.dataset.id); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stop(); show(g.dataset.id); } });
  });

  // Forward pass: dots run along the wires stage by stage, the inspector follows.
  const order = ["road", "agvs", "orders", "mp", "tok", "tf", "pair", "defer", "dec"];
  let timer = null, step = 0, raf = null;
  const pulses = svg.querySelector("#pulses");
  function stop() { clearInterval(timer); timer = null; cancelAnimationFrame(raf); pulses.innerHTML = ""; playBtn.setAttribute("aria-pressed", "false"); }
  function run(id) {
    show(id);
    const ws = wires.filter(([a]) => a === id).map(([a, b]) => svg.querySelector(`#w-${a}-${b}`));
    const t0 = performance.now();
    cancelAnimationFrame(raf);
    const anim = () => {
      const u = Math.min(1, (performance.now() - t0) / 1100), e = u * u * (3 - 2 * u);
      pulses.innerHTML = ws.map((w) => { const p = w.getPointAtLength(e * w.getTotalLength()); return `<circle class="pulse" cx="${p.x}" cy="${p.y}" r="4.5"/>`; }).join("");
      if (u < 1) raf = requestAnimationFrame(anim);
    };
    anim();
  }
  playBtn.addEventListener("click", () => {
    if (timer) { stop(); return; }
    playBtn.setAttribute("aria-pressed", "true");
    step = 0; run(order[step]);
    timer = setInterval(() => { step = (step + 1) % order.length; run(order[step]); }, 1700);
  });
  show("tf");
}

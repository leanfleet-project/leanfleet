// Live session UI: starts the worker on demand (the page stays light until then).
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PRIO = { 1: "--s-lns", 2: "--s-gnn", 3: "--s-nearest" };
let LAYOUTS = {};  // reference fleets from data/constants.json (problem statement section 3)

let worker = null, layout = null, frame = null, playing = false, speed = 4, busy = false;
// 3D replay (MuJoCo WASM worker + three.js view), loaded on first Start with 3D on.
let replay = null, view = null, clock3d = 0, ticks2d = 0, use3d = false;
const LEAD = 40;  // plan ticks the 2D run may lead the 3D replay by
const RATE = { 2: 40, 4: 90, 15: 300 };  // control periods (0.05 s physics) per second

function status(t) { $("live-status").textContent = t; }

function draw() {
  const cv = $("live-canvas");
  if (!layout) return;
  const fr = frame ?? { waiting: [], agvs: [], blocked: [], now: 0, delivered: 0, late: 0, added: [] };
  const box = cv.parentElement, dpr = Math.min(2, devicePixelRatio || 1);
  const pad = 2 * parseFloat(getComputedStyle(box).paddingLeft || 0);
  const fit = Math.min((box.clientWidth - pad) / layout.width, (box.clientHeight - pad) / layout.height);
  if (!(fit > 0)) return;
  cv.style.width = `${Math.floor(fit * layout.width)}px`; cv.style.height = `${Math.floor(fit * layout.height)}px`;
  const s = fit * dpr;  // pixels per cell
  cv.width = Math.round(layout.width * s); cv.height = Math.round(layout.height * s);
  const g = cv.getContext("2d");
  const X = (c) => (c + 0.5) * s, Y = (r) => (r + 0.5) * s;
  g.fillStyle = css("--surface"); g.fillRect(0, 0, cv.width, cv.height);
  const fill = { "0": css("--ink-2"), "2": css("--line"), "3": "rgba(244,114,48,.12)", "4": "rgba(244,114,48,.12)" };
  (layout.grid ?? []).forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const f = fill[row[c]];
      if (!f) continue;
      let e = c; while (e + 1 < row.length && row[e + 1] === row[c]) e++;
      g.fillStyle = f; g.globalAlpha = row[c] === "0" ? 0.5 : 1;
      g.fillRect(c * s, r * s, (e - c + 1) * s + 0.5, s + 0.5); c = e;
    }
  });
  g.globalAlpha = 1;
  // Roads as rounded strokes between neighbouring road cells.
  const road = new Set(layout.roads.map(([r, c]) => r * 10000 + c));
  g.strokeStyle = css("--bg"); g.lineCap = "round"; g.lineWidth = Math.max(2, 0.8 * s);
  g.beginPath();
  for (const [r, c] of layout.roads) {
    if (road.has(r * 10000 + c + 1)) { g.moveTo(X(c), Y(r)); g.lineTo(X(c + 1), Y(r)); }
    if (road.has((r + 1) * 10000 + c)) { g.moveTo(X(c), Y(r)); g.lineTo(X(c), Y(r + 1)); }
  }
  g.stroke();
  g.fillStyle = css("--ink-2");
  for (const [r, c] of fr.blocked) g.fillRect(c * s, r * s, s, s);
  const font = Math.max(10, 1.6 * s);
  g.font = `600 ${font}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const [, [r, c]] of Object.entries(layout.stores)) {
    g.fillStyle = css("--s-teacher"); g.beginPath(); g.roundRect(X(c) - 1.4 * s, Y(r) - 1.4 * s, 2.8 * s, 2.8 * s, 0.6 * s); g.fill();
  }
  g.fillStyle = css("--accent");
  for (const [, [r, c]] of Object.entries(layout.stations)) { g.beginPath(); g.arc(X(c), Y(r), Math.max(2, 0.45 * s), 0, 7); g.fill(); }
  // Waiting orders: one badge per pick-up station, coloured by its most urgent order.
  const at = new Map();
  for (const o of fr.waiting) {
    const key = o.pickup.join(","), b = at.get(key) ?? { cell: o.pickup, n: 0, prio: 3 };
    b.n++; b.prio = Math.min(b.prio, o.priority); at.set(key, b);
  }
  for (const b of at.values()) {
    const x = X(b.cell[1]), y = Y(b.cell[0]) - 1.6 * s, R = Math.max(7, 1.2 * s);
    g.fillStyle = css(PRIO[b.prio]); g.beginPath(); g.roundRect(x - R, y - 0.75 * R, 2 * R, 1.5 * R, 0.75 * R); g.fill();
    g.fillStyle = "#fff"; g.font = `700 ${Math.max(9, 1.2 * s)}px system-ui, sans-serif`; g.fillText(String(b.n), x, y + 0.5);
  }
  fr.agvs.forEach((a, i) => {
    const red = a.held.includes(1), x = X(a.cell[1]), y = Y(a.cell[0]), R = Math.max(6, 1.5 * s);
    g.fillStyle = css("--bg"); g.beginPath(); g.arc(x, y, R + Math.max(1.5, 0.3 * s), 0, 7); g.fill();
    g.fillStyle = red ? css(PRIO[1]) : css("--s-student"); g.beginPath(); g.arc(x, y, R, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.font = `700 ${Math.max(9, 1.5 * s)}px system-ui, sans-serif`; g.fillText(String(i), x, y + 0.5);
  });
  if (frame) $("live-stats").textContent =
    `2D plan  t ${fr.now} s · delivered ${fr.delivered} (late ${fr.late}) · waiting ${fr.waiting.length}` +
    ` (red ${fr.waiting.filter((o) => o.priority === 1).length}) · your orders ${fr.added.length}`;
}

function tick() {
  if (!playing || busy || !worker) return;
  if (use3d && replay && ticks2d - clock3d > LEAD) return;  // let the 3D replay catch up
  busy = true;
  worker.postMessage({ type: "advance", seconds: speed });
}

function start() {
  if (!worker) {
    status("Loading Python and the simulator (about 20 MB, once)…");
    worker = new Worker("live/worker.js");
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "ready" && !playing) status("Ready.");
      if (m.type === "error") { status("Error: " + m.msg); busy = false; playing = false; }
      if (m.type === "layout") setLayout(m.info);
      if (m.type === "frame") {
        frame = m.frame; busy = false; draw();
        if (m.ticks?.length) { ticks2d += m.ticks.length; if (use3d && replay) replay.postMessage({ type: "ticks", rows: m.ticks }); }
        if (use3d && view) view.overlay(frame);
        if (m.finished) { playing = false; status(`Shift finished: red on time ${m.summary.red_on_time.toFixed(2)}, all on time ${m.summary.on_time.toFixed(2)}, J ${m.summary.J.toFixed(0)}.`); }
      }
      if (m.type === "added") status(`Order ${m.id} added: ${m.order.priority === 1 ? "red" : m.order.priority === 2 ? "yellow" : "green"}, deadline in ${m.order.deadline - m.order.arrival} s.`);
    };
  }
  const lay = $("live-layout").value;
  const agvs = Math.max(1, Math.round(LAYOUTS[lay] * (+$("live-fleet").value) / 100));
  ticks2d = 0; clock3d = 0;
  use3d = $("live-3d").checked;
  stageMode();
  if (use3d) start3d(lay, agvs);
  worker.postMessage({ type: "start", args: { layout: lay, seed: +$("live-seed").value, agvs,
    shift: 3600, dispatcher: $("live-disp").value } });
  status(`Running ${$("live-disp").selectedOptions[0].text} on ${lay} with ${agvs} AGVs…`);
  playing = true; busy = true;
}

function setLayout(info) {
  layout = info;
  $("live-inset").style.aspectRatio = `${info.width} / ${info.height}`;
  for (const id of ["live-from", "live-to"]) {
    $(id).innerHTML = Object.keys(layout.stations).sort().map((k) => `<option>${k}</option>`).join("");
  }
  $("live-to").selectedIndex = Math.min(3, $("live-to").options.length - 1);
  draw();
}

function fleetSize(lay) { return Math.max(1, Math.round(LAYOUTS[lay] * (+$("live-fleet").value) / 100)); }

function stageMode() {
  const st = $("live-stage");
  st.classList.toggle("no3d", !$("live-3d").checked);
  requestAnimationFrame(draw);
}

/** Before Start: the layout in 2D (from the exported scene) and in 3D (MuJoCo, robots not yet placed). */
async function preview() {
  if (playing) return;
  const lay = $("live-layout").value;
  const meta = await fetch(`scene/${lay}.json`, { cache: "no-cache" }).then((r) => r.json()).catch(() => null);
  if (meta?.map) { frame = null; setLayout(meta.map); }
  $("live-stats").textContent = `${lay} · ${fleetSize(lay)} AGVs · press Start to run the shift`;
  stageMode();
  if ($("live-3d").checked) start3d(lay, fleetSize(lay));
}

async function start3d(lay, agvs) {
  if (!view) {
    const { View3D } = await import("./view3d.js");
    view = new View3D($("live-3d-canvas"));
  }
  if (!replay) {
    replay = new Worker(new URL("./replay_worker.js", import.meta.url), { type: "module" });
    replay.onmessage = ({ data: m }) => {
      if (m.type === "static") { view.build(m); replay.loaded = true; $("live-3d-stats").textContent = "3D replay · MuJoCo ready"; }
      if (m.type === "error") $("live-3d-stats").textContent = "3D error: " + m.msg;
      if (m.type === "frame") {
        view.update(m); clock3d = m.clock;
        $("live-3d-stats").textContent =
          `3D replay  plan t ${m.planNow} s · physics ${m.time.toFixed(0)} s · AGV contacts ${m.contacts}` +
          ` · wall ${m.wall} · zones overlapping ${m.overlap.toFixed(1)} s` +
          (m.minCentre === null ? "" : ` · closest ${m.minCentre.toFixed(2)} m`) + (m.stalled ? " · stalled" : "");
      }
    };
  }
  if (!replay.loaded) $("live-3d-stats").textContent = "Loading MuJoCo (WebAssembly, about 7 MB, once)…";
  replay.postMessage({ type: "init", layout: lay, n: agvs });
  replay.postMessage({ type: "rate", periods: RATE[speed] ?? 90 });
}

export function initLive(consts) {
  LAYOUTS = { map1a: consts?.refmapone, map2a: consts?.refmaptwo, map3a: consts?.refmapthree };
  $("live-fleet").min = consts?.fleetlo ?? $("live-fleet").min;
  $("live-start").onclick = start;
  $("live-pause").onclick = () => { playing = !playing; $("live-pause").textContent = playing ? "Pause" : "Play"; };
  for (const b of document.querySelectorAll("[data-speed]")) b.onclick = () => {
    speed = +b.dataset.speed; replay?.postMessage({ type: "rate", periods: RATE[speed] ?? 90 }); };
  for (const b of document.querySelectorAll("[data-cam]")) b.onclick = () => view?.preset(b.dataset.cam, +$("live-follow").value);
  $("live-zones").onchange = () => { if (view) view.showZones = $("live-zones").checked; };
  $("live-fleet").oninput = () => { $("live-fleet-out").textContent = `${$("live-fleet").value} %`; };
  $("live-add").onclick = () => worker && worker.postMessage({ type: "add", order: {
    pickup: $("live-from").value, dropoff: $("live-to").value,
    priority: +$("live-prio").value, size: +$("live-size").value } });
  setInterval(tick, 120);
  window.addEventListener("resize", draw);
  $("live-swap").onclick = () => { $("live-stage").classList.toggle("flipped"); };
  new ResizeObserver(() => draw()).observe($("live-inset"));  // redraw the 2D map whenever its box changes size
  for (const id of ["live-layout", "live-fleet", "live-3d"]) $(id).addEventListener("change", () => { if (!playing) preview(); else stageMode(); });
  // Load the preview when the section comes near (MuJoCo is about 7 MB, so not at page load).
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); preview(); } }, { rootMargin: "400px" });
  io.observe($("live"));
}

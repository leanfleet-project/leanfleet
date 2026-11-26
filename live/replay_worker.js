// 3D replay worker: MuJoCo WASM drives the live 2D plan with the paper's replay rules
// (replay.js). Open-loop: the 3D side never changes a decision.
// In:  {type:"init", layout, n} · {type:"ticks", rows:[{now, cells, trays}]} · {type:"rate", periods}
// Out: {type:"static", geoms, consts} · {type:"frame", ...} · {type:"error", msg}
import load from "../vendor/mujoco/mujoco_wasm.js";
import { ReplayFleet } from "./replay.js";

let M = null, model = null, data = null, fleet = null, consts = null;
let placed = false, rate = 80, acc = 0, dyn = [], cargo = [], trays = [], nowOf = [];
let overlap = 0, minCentre = Infinity;

async function init(layout, n, given = null) {
  M ??= await load();
  const [xml, meta] = given ? [given.xml, { consts: given.consts }] : await Promise.all([
    fetch(`../scene/${layout}_${n}.xml`, { cache: "no-cache" }).then((r) => { if (!r.ok) throw Error("scene missing"); return r.text(); }),
    fetch(`../scene/${layout}.json`, { cache: "no-cache" }).then((r) => r.json())]);
  data?.delete(); model?.delete();
  M.FS.writeFile("/scene.xml", xml);
  model = M.MjModel.mj_loadXML("/scene.xml");
  data = new M.MjData(model);
  consts = meta.consts;
  fleet = new ReplayFleet(M, model, data, consts, n);
  placed = false; acc = 0; trays = []; nowOf = []; overlap = 0; minCentre = Infinity;
  M.mj_forward(model, data);
  const geoms = [];
  dyn = [];
  for (let g = 0; g < model.ngeom; g++) {
    if (model.geom_group[g] > 2) continue;
    const body = model.geom_bodyid[g];
    if (body !== 0) dyn.push(g);
    geoms.push({ id: g, type: model.geom_type[g], dyn: body !== 0,
      name: M.mj_id2name(model, M.mjtObj.mjOBJ_GEOM.value, g) ?? "",
      size: Array.from(model.geom_size.subarray(3 * g, 3 * g + 3)),
      pos: Array.from(data.geom_xpos.subarray(3 * g, 3 * g + 3)),
      mat: Array.from(data.geom_xmat.subarray(9 * g, 9 * g + 9)),
      rgba: Array.from(model.geom_rgba.subarray(4 * g, 4 * g + 4)) });
  }
  cargo = fleet.cargo.flat();
  postMessage({ type: "static", geoms, consts, n });
}

function frame() {
  const xpos = new Float32Array(3 * dyn.length), xmat = new Float32Array(9 * dyn.length);
  const gx = data.geom_xpos, gm = data.geom_xmat;
  dyn.forEach((g, i) => { xpos.set(gx.subarray(3 * g, 3 * g + 3), 3 * i); xmat.set(gm.subarray(9 * g, 9 * g + 9), 9 * i); });
  const rgba = new Float32Array(4 * cargo.length), mr = model.geom_rgba;
  cargo.forEach((g, i) => rgba.set(mr.subarray(4 * g, 4 * g + 4), 4 * i));
  const poses = [...Array(fleet.n).keys()].map((a) => fleet.pose(a));
  postMessage({ type: "frame", dyn, xpos, xmat, cargo, rgba, poses,
    clock: fleet.clock, planNow: nowOf[fleet.clock] ?? 0, ticks: fleet.ticks, time: fleet.time,
    contacts: fleet.robotContacts, wall: fleet.wallContacts, stalled: fleet.stalled,
    overlap, minCentre: Number.isFinite(minCentre) ? minCentre : null,
    trays: trays[fleet.clock] ?? [] }, [xpos.buffer, xmat.buffer, rgba.buffer]);
}

function loop() {
  if (!fleet || !placed) return;
  acc += rate * 0.04;
  let k = 0;
  const dt = consts.phys_dt * consts.control_steps;
  while (acc >= 1 && k < 40) {
    if (fleet.clock + 1 >= fleet.ticks || fleet.stalled) { acc = 0; break; }  // wait for the plan
    const before = fleet.clock;
    fleet.control();
    acc -= 1; k++;
    const n = fleet.n, p = [...Array(n).keys()].map((a) => fleet.pose(a));
    let gap = Infinity;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) gap = Math.min(gap, Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]));
    minCentre = Math.min(minCentre, gap);
    overlap += dt * (gap < 2 * consts.safety_radius);
    if (fleet.clock !== before) for (let a = 0; a < n; a++) fleet.setCargo(a, trays[fleet.clock]?.[a] ?? []);
  }
  frame();
}
setInterval(loop, 40);

let chain = Promise.resolve();  // handle messages in order (init is async)
onmessage = ({ data: m }) => { chain = chain.then(() => handle(m)); };
async function handle(m) {
  try {
    if (m.type === "init") await init(m.layout, m.n, m.xml ? m : null);
    else if (m.type === "ticks" && fleet) {
      for (const r of m.rows) { fleet.extend(r.cells); trays.push(r.trays); nowOf.push(r.now); }
      if (!placed && fleet.ticks >= 2) { fleet.place(); placed = true; frame(); }
    } else if (m.type === "rate") rate = m.periods;
  } catch (e) { postMessage({ type: "error", msg: String(e?.message ?? e) }); }
}

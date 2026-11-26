// 3D replay of the 2D plan with MuJoCo physics: a port of PhysicalFleet in
// mjlab_mir/scripts/play_gnn.py (same rules: plan order per cell, free_limit look-ahead,
// CELL_CLEAR, hold behind, logical clock). Open-loop: nothing here feeds back into the
// 2D decisions. Every constant comes from the exported scene JSON (`consts`), written by
// mjlab_mir/scripts/export_page_scene.py from the Python module.
// Checked against Python by mjlab_mir/scripts/check_page_replay.py.

const TAU = 2 * Math.PI;

function wrapToPi(x) {  // as mjlab's wrap_to_pi: (x + pi) mod 2pi - pi, with +pi kept
  const r = (((x + Math.PI) % TAU) + TAU) % TAU;
  return r === 0 && x > 0 ? Math.PI : r - Math.PI;
}

/** (v, w) toward waypoints[0]; port of mjlab_mir.mdp.fleet.drive_command for one AGV. */
export function driveCommand(x, y, yaw, wps, cfg) {
  const legs = [[wps[0][0] - x, wps[0][1] - y]];
  for (let k = 1; k < wps.length; k++) legs.push([wps[k][0] - wps[k - 1][0], wps[k][1] - wps[k - 1][1]]);
  const len = legs.map(([a, b]) => Math.hypot(a, b));
  const err = wrapToPi(Math.atan2(legs[0][1], legs[0][0]) - yaw);
  const unit = legs.map(([a, b], k) => [a / Math.max(len[k], 1e-6), b / Math.max(len[k], 1e-6)]);
  let run = len[0], keep = true;
  for (let k = 1; k < legs.length; k++) {
    keep = keep && unit[k][0] * unit[k - 1][0] + unit[k][1] * unit[k - 1][1] > Math.cos(0.1) && len[k] > 1e-6;
    if (keep) run += len[k];
  }
  let v = Math.max(Math.min(Math.sqrt(2 * cfg.max_a * run), cfg.max_v), cfg.min_v);
  if (Math.abs(err) > cfg.rotate_threshold) v = 0;
  const w = Math.max(-cfg.max_w, Math.min(cfg.max_w, cfg.k_w * err));
  return [v, w];
}

const same = (p, q) => p[0] === q[0] && p[1] === q[1];

export class ReplayFleet {
  /**
   * M: MuJoCo WASM module; model/data: the compiled scene; consts: exported constants;
   * n: number of AGVs. Feed plan ticks with extend(), then place() once, then control().
   */
  constructor(M, model, data, consts, n) {
    Object.assign(this, { M, model, data, c: consts, n });
    const jnt = (name) => M.mj_name2id(model, M.mjtObj.mjOBJ_JOINT.value, name);
    const geom = (name) => M.mj_name2id(model, M.mjtObj.mjOBJ_GEOM.value, name);
    this.qadr = [], this.wheelDof = [], this.chassis = new Map();
    for (let i = 0; i < n; i++) {
      this.qadr.push(model.jnt_qposadr[jnt(`r${i}_root`)]);
      this.wheelDof.push(["left", "right"].map((w) => model.jnt_dofadr[jnt(`r${i}_${w}_wheel_joint`)]));
      this.chassis.set(geom(`r${i}_chassis`), i);
    }
    this.cargo = [...Array(n).keys()].map((i) =>
      [...Array(consts.slot_capacity).keys()].map((k) => geom(`r${i}_cargo_${k}`)));
    this.tracks = [...Array(n)].map(() => []);
    this.paths = [...Array(n)].map(() => []);
    this.tickIndex = [...Array(n)].map(() => []);
    this.entry = [...Array(n)].map(() => new Map());
    this.closed = new Map();          // cell key -> [[enter, leave, agv]] of finished stays
    this.open = Array(n).fill(0);     // enter tick of each AGV's current stay
    this.idx = Array(n).fill(0);
    this.clock = 0; this.sinceTick = 0; this.time = 0;
    this.cmd = [...Array(n)].map(() => [0, 0]);
    this.target = [...Array(n)].map(() => [0, 0]);
    this.robotContacts = 0; this.wallContacts = 0; this.stalled = false;
  }

  world([r, c]) {
    const { cell, width, height } = this.c;
    return [(c + 0.5 - width / 2) * cell, (height / 2 - r - 0.5) * cell];
  }

  /** Append one plan tick: cells[a] = [row, col] of AGV a. */
  extend(cells) {
    for (let a = 0; a < this.n; a++) {
      const tr = this.tracks[a], cell = cells[a], t = tr.length;
      if (t > 0 && !same(tr[t - 1], cell)) {
        const key = tr[t - 1].join(",");
        if (!this.closed.has(key)) this.closed.set(key, []);
        this.closed.get(key).push([this.open[a], t, a]);
        this.open[a] = t;
      }
      const path = this.paths[a];
      if (!path.length || !same(path[path.length - 1].cell, cell)) path.push({ cell, xy: this.world(cell) });
      const k = path.length - 1;
      this.tickIndex[a].push(k);
      if (!this.entry[a].has(k)) this.entry[a].set(k, t);
      tr.push(cell);
    }
  }

  get ticks() { return this.tracks[0].length; }

  /** Put each MiR on its first cell, facing its first move (as headings(track)[0]). */
  place() {
    const d = this.data;
    for (let a = 0; a < this.n; a++) {
      const tr = this.tracks[a];
      let yaw = 0;
      if (tr.length > 1 && !same(tr[0], tr[1])) yaw = Math.atan2(tr[0][0] - tr[1][0], tr[1][1] - tr[0][1]);
      const [x, y] = this.paths[a][0].xy, q = this.qadr[a];
      d.qpos.set([x, y, this.c.wheel_radius + 0.002, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], q);
    }
    this.M.mj_forward(this.model, d);
  }

  pose(a) {
    const q = this.data.qpos, i = this.qadr[a];
    const yaw = Math.atan2(2 * (q[i + 3] * q[i + 6] + q[i + 4] * q[i + 5]), 1 - 2 * (q[i + 5] ** 2 + q[i + 6] ** 2));
    return [q[i], q[i + 1], yaw];
  }

  tickIdx(a, tick) { const ix = this.tickIndex[a]; return ix[Math.min(tick, ix.length - 1)]; }

  blocked(a, k, poses) {
    const t = this.entry[a].get(k);
    if (k === 0 || t === undefined) return false;
    const cell = this.tracks[a][t];
    let best = null;
    for (const o of this.closed.get(cell.join(",")) ?? []) {
      if (o[2] === a || o[1] > t) continue;
      if (!best || o[0] > best[0] || (o[0] === best[0] && (o[1] > best[1] || (o[1] === best[1] && o[2] > best[2])))) best = o;
    }
    if (!best) return false;
    const [cx, cy] = this.world(cell), p = poses[best[2]];
    return Math.hypot(p[0] - cx, p[1] - cy) < this.c.cell_clear * this.c.cell;
  }

  freeLimit(a, limit, poses) {
    for (let k = this.idx[a]; k <= limit; k++) if (this.blocked(a, k, poses)) return Math.max(this.idx[a], k - 1);
    return limit;
  }

  targets() {
    const c = this.c, n = this.n;
    const poses = [...Array(n).keys()].map((a) => this.pose(a));
    for (let a = 0; a < n; a++) {
      const path = this.paths[a];
      const limit = this.freeLimit(a, this.tickIdx(a, this.clock + 1), poses);
      const [x, y, yaw] = poses[a];
      while (this.idx[a] < limit) {
        const cur = path[this.idx[a]].xy, prev = path[Math.max(this.idx[a] - 1, 0)].xy;
        const dx = cur[0] - x, dy = cur[1] - y;
        if (Math.hypot(dx, dy) < 0.05 || (this.idx[a] > 0 && dx * (cur[0] - prev[0]) + dy * (cur[1] - prev[1]) <= 0)) this.idx[a]++;
        else break;
      }
      const ahead = [0, 1, 2].map((k) => path[Math.min(this.idx[a] + k, limit)].xy);
      let [v, w] = driveCommand(x, y, yaw, ahead, c.drive);
      if (Math.hypot(ahead[0][0] - x, ahead[0][1] - y) < 0.05 && this.idx[a] >= limit) { v = 0; w = 0; }
      if (this.blocked(a, this.idx[a], poses)) v = 0;
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        const gx = poses[b][0] - x, gy = poses[b][1] - y, dist = Math.hypot(gx, gy);
        if (dist < c.min_gap * c.cell && gx * Math.cos(yaw) + gy * Math.sin(yaw) > 0.7 * dist) v = 0;
      }
      this.target[a] = [v, w];
    }
  }

  /** One control period of physics; moves the logical clock when all have arrived. */
  control() {
    const { M, model, data: d, c } = this;
    this.targets();
    const half = 0.5 * c.track_width, maxStep = [c.drive.max_a * c.phys_dt, 2.0 * c.phys_dt];
    const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    for (let s = 0; s < c.control_steps; s++) {
      const qfrc = d.qfrc_applied, qvel = d.qvel;
      for (let a = 0; a < this.n; a++) {
        for (let j = 0; j < 2; j++) this.cmd[a][j] += clip(this.target[a][j] - this.cmd[a][j], -maxStep[j], maxStep[j]);
        const [v, w] = this.cmd[a], [left, right] = this.wheelDof[a];
        for (const [dof, want] of [[left, (v - w * half) / c.wheel_radius], [right, (v + w * half) / c.wheel_radius]])
          qfrc[dof] = clip(c.kv * (want - qvel[dof]), -c.max_torque, c.max_torque);
      }
      M.mj_step(model, d);
    }
    let hitRobot = false, hitWall = false;
    const con = d.contact;
    for (let i = 0; i < d.ncon; i++) {
      const k = con.get(i), g1 = k.geom1, g2 = k.geom2;
      const a = this.chassis.get(g1), b = this.chassis.get(g2);
      if (a !== undefined && b !== undefined) hitRobot = true;
      else if ((a !== undefined || b !== undefined) && g1 !== 0 && g2 !== 0) {
        if (model.geom_bodyid[a !== undefined ? g2 : g1] === 0) hitWall = true;
      }
      k.delete?.();
    }
    con.delete?.();
    this.robotContacts += hitRobot; this.wallContacts += hitWall;
    const dt = c.phys_dt * c.control_steps;
    this.time += dt; this.sinceTick += dt;
    let arrived = true;
    for (let a = 0; a < this.n && arrived; a++) {
      const k = this.tickIdx(a, this.clock);
      if (this.idx[a] > k) continue;
      const p = this.pose(a), q = this.paths[a][k].xy;
      arrived = Math.hypot(q[0] - p[0], q[1] - p[1]) < c.clock_tol;
    }
    if (arrived && this.sinceTick >= 1.0) { this.clock++; this.sinceTick = 0; }
    else if (this.sinceTick > c.stall_sec) this.stalled = true;
  }

  /** Cargo colours on the trays (priorities of trays in use, as trays_on_board). */
  setCargo(a, prios) {
    const rgba = this.model.geom_rgba;
    this.cargo[a].forEach((g, k) => rgba.set(k < prios.length ? this.c.prio_rgba[prios[k]] : [1, 1, 1, 0], g * 4));
  }
}

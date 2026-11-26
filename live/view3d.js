// three.js view of the MuJoCo replay. Geometry and sizes come from the MuJoCo model
// (nothing is resized or hidden); only colours and materials are styled for the page.
// Waiting orders and road blocks come from the 2D frame and are drawn only.
import * as THREE from "three";
import { OrbitControls } from "../vendor/three/examples/jsm/controls/OrbitControls.js";

import { css, theme, matrix, label, addWorld, lights, renderer } from "./style3d.js";

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = renderer(canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 16 / 10, 0.1, 3000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.addEventListener("start", () => { this.track = false; });  // the visitor took the camera
    this.meshes = new Map(); this.zones = []; this.labels = []; this.extras = [];
    this.marks = new THREE.Group(); this.scene.add(this.marks);
    this.follow = -1; this.showZones = true; this.t0 = performance.now();
    const tick = () => { this.render(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  clear() {
    for (const o of [...this.meshes.values(), ...this.zones.flat(), ...this.labels, ...this.extras]) {
      this.scene.remove(o); o.geometry?.dispose(); o.material?.dispose();
    }
    this.meshes.clear(); this.zones = []; this.labels = []; this.extras = [];
  }

  build({ geoms, consts, n }) {
    this.clear();
    const th = this.th = theme();
    this.c = consts;
    this.poses = null;
    const W = consts.width * consts.cell, H = consts.height * consts.cell;
    this.extent = [W, H];
    this.scene.background = new THREE.Color(th.bg);
    this.scene.fog = new THREE.Fog(th.bg, 1.2 * Math.max(W, H), 3 * Math.max(W, H));
    if (this.light) for (const l of Object.values(this.light)) this.scene.remove(l);
    this.light = lights(this.scene, this.extent);
    this.worldGroup = new THREE.Group(); this.scene.add(this.worldGroup); this.extras.push(this.worldGroup);
    this.meshes = addWorld(this.worldGroup, geoms.filter((g) => !g.dyn), consts, th);
    for (const g of geoms.filter((g) => g.dyn)) {  // robots: meshes moved by the worker's frames
      const sub = addWorld(this.scene, [g], consts, th);
      for (const [, m] of sub) { this.meshes.set(g.id, m); this.extras.push(m); m.userData.show = m.visible; m.visible = false; }
    }  // robots stay hidden until the worker has placed them on their first cells
    // Safety zone of each MiR (radius from the replay constants): soft fill and a ring.
    for (let a = 0; a < n; a++) {
      const r = consts.safety_radius;
      const fill = new THREE.Mesh(new THREE.CircleGeometry(r, 48),
        new THREE.MeshBasicMaterial({ color: css("--s-student"), transparent: true, opacity: 0.16, depthWrite: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.94 * r, r, 64),
        new THREE.MeshBasicMaterial({ color: css("--s-student"), transparent: true, opacity: 0.9, depthWrite: false }));
      fill.position.z = 0.02; ring.position.z = 0.021;
      fill.visible = ring.visible = false;
      this.scene.add(fill, ring); this.zones.push([fill, ring]);
      const tag = label(String(a), css("--s-student"));
      tag.visible = false;
      this.scene.add(tag); this.labels.push(tag);
    }
    this.preset("overview");
  }

  update(f) {
    if (!this.poses) for (const g of f.dyn) { const m = this.meshes.get(g); if (m) m.visible = m.userData.show; }
    f.dyn.forEach((g, i) => {
      const m = this.meshes.get(g);
      if (m) m.matrix.copy(matrix(f.xpos.subarray(3 * i, 3 * i + 3), f.xmat.subarray(9 * i, 9 * i + 9)));
    });
    f.cargo.forEach((g, i) => {
      const m = this.meshes.get(g);
      if (!m) return;
      const r = f.rgba.subarray(4 * i, 4 * i + 4);
      m.visible = r[3] > 0;
      if (m.visible) m.material.color.setRGB(r[0], r[1], r[2], THREE.SRGBColorSpace);
    });
    const red = css("--s-lns"), blue = css("--s-student");
    const first = !this.poses;
    f.poses.forEach(([x, y], a) => {
      const z = this.zones[a];
      if (!z) return;
      const colour = (f.trays[a] ?? []).includes(1) ? red : blue;
      for (const m of z) { m.position.x = x; m.position.y = y; m.visible = this.showZones; m.material.color.set(colour); }
      this.labels[a].position.set(x, y, 2.0); this.labels[a].visible = true;
    });
    this.poses = f.poses;
    if (first) this.preset("overview");  // centre on the fleet once it is placed
  }

  world([r, c]) { const k = this.c; return [(c + 0.5 - k.width / 2) * k.cell, (k.height / 2 - r - 0.5) * k.cell]; }

  /** Waiting orders (a floating tag over the pick-up, stacked) and blocked cells: drawn only. */
  overlay(frame) {
    if (!this.c) return;
    for (const m of this.marks.children) { m.geometry?.dispose(); m.material?.dispose(); }
    this.marks.clear();
    const prio = { 1: css("--s-lns"), 2: css("--s-gnn"), 3: css("--s-nearest") };
    const stack = new Map();
    for (const o of frame.waiting) {
      const key = o.pickup.join(","), k = stack.get(key) ?? 0;
      stack.set(key, k + 1);
      if (k >= 5) continue;  // the 2D view shows the full count
      const [x, y] = this.world(o.pickup);
      const tag = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.35, 4, 12).rotateZ(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: prio[o.priority], emissive: prio[o.priority], emissiveIntensity: 0.35, roughness: 0.4 }));
      tag.position.set(x, y, 2.6 + 0.55 * k);
      tag.userData.base = tag.position.z;
      this.marks.add(tag);
      if (k === 0) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.4, 6).rotateX(Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: prio[o.priority], transparent: true, opacity: 0.5 }));
        pole.position.set(x, y, 1.2);
        this.marks.add(pole);
      }
    }
    for (const cell of frame.blocked) {
      const [x, y] = this.world(cell), s = 0.8 * this.c.cell;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(s, 0.12, 0.12), new THREE.MeshStandardMaterial({ color: "#f2b705" }));
      bar.position.set(x, y, 0.9);
      const base = new THREE.Mesh(new THREE.BoxGeometry(s, s, 0.04), new THREE.MeshStandardMaterial({ color: "#2b2b2b" }));
      base.position.set(x, y, 0.03);
      this.marks.add(bar, base);
    }
  }

  preset(name, agv = 0) {
    const [w, h] = this.extent ?? [40, 30];
    const big = Math.max(w, h);
    this.follow = name === "follow" ? agv : -1;
    this.track = name === "overview";
    if (name === "top") { this.camera.position.set(0, -0.01, 1.25 * big); this.controls.target.set(0, 0, 0); }
    if (name === "overview") {
      // A close three-quarter view around the fleet (the whole layout is the "top" preset).
      const p = this.poses ?? [];
      const tx = p.length ? p.reduce((s, q) => s + q[0], 0) / p.length : 0;
      const ty = p.length ? p.reduce((s, q) => s + q[1], 0) / p.length : 0;
      const span = p.length ? Math.min(big, 26) : 0.7 * big;  // before Start: the whole layout
      this.controls.target.set(tx, ty, 0);
      this.camera.position.set(tx + 0.25 * span, ty - 0.85 * span, 0.62 * span);
    }
    this.controls.update();
  }

  render() {
    const cv = this.canvas, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.floor(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    if (this.follow >= 0 && this.poses?.[this.follow]) {
      const [x, y, yaw] = this.poses[this.follow];
      this.controls.target.lerp(new THREE.Vector3(x, y, 0.4), 0.15);
      this.camera.position.lerp(new THREE.Vector3(x - 6 * Math.cos(yaw), y - 6 * Math.sin(yaw), 3.6), 0.05);
    }
    if (this.track && this.poses?.length) {  // overview keeps the fleet in frame
      const p = this.poses, cx = p.reduce((s, q) => s + q[0], 0) / p.length, cy = p.reduce((s, q) => s + q[1], 0) / p.length;
      const d = new THREE.Vector3(cx, cy, 0).sub(this.controls.target).multiplyScalar(0.03);
      this.controls.target.add(d); this.camera.position.add(d);
    }
    const t = (performance.now() - this.t0) / 1000;
    for (const m of this.marks.children) if (m.userData.base) m.position.z = m.userData.base + 0.08 * Math.sin(2 * t + m.position.x);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

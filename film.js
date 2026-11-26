// Cinematic opening: a recorded 3D replay (data/film.json, written by
// mjlab_mir/scripts/export_page_film.py from a real MuJoCo run) played back with
// three.js. Scrolling moves the camera between chapters; the film itself keeps playing.
// Nothing is simulated here, and every number in the HUD is read from the recording.
import * as THREE from "three";
import { css, theme, matrix, label, addWorld, lights, renderer, geometry, material, kind, CASTS } from "./live/style3d.js";

const smooth = (x) => x * x * (3 - 2 * x);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export async function initFilm(root) {
  const film = await fetch("data/film.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const canvas = root.querySelector("canvas");
  const steps = [...root.querySelectorAll(".chapter")];
  const bar = root.querySelector(".chapter-bar");
  if (!film) { root.classList.add("no-film"); return; }

  const th = theme();
  const r = renderer(canvas);
  const scene = new THREE.Scene();
  const k = film.consts, W = k.width * k.cell, H = k.height * k.cell;
  scene.background = new THREE.Color(th.bg);
  scene.fog = new THREE.Fog(th.bg, 0.9 * Math.max(W, H), 2.2 * Math.max(W, H));
  lights(scene, [W, H]);
  addWorld(scene, film.world, k, th);

  // One group per MiR from the robot template (local geoms), placed at the recorded pose.
  const robots = [], cargo = [], zones = [], tags = [];
  for (let a = 0; a < film.n; a++) {
    const grp = new THREE.Group(), boxes = [];
    for (const g of film.robot) {
      const kd = kind("r0_" + g.name), geo = geometry(g.type, g.size);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, material(kd, th, g.rgba));
      m.matrixAutoUpdate = false; m.matrix.copy(matrix(g.pos, g.mat));
      m.castShadow = CASTS.includes(kd);
      m.visible = kd === "cargo" ? false : g.rgba[3] > 0;
      if (kd === "cargo") boxes[+g.name.split("_")[1]] = m;
      grp.add(m);
    }
    const fill = new THREE.Mesh(new THREE.CircleGeometry(k.safety_radius, 48),
      new THREE.MeshBasicMaterial({ color: css("--s-student"), transparent: true, opacity: 0.16, depthWrite: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.94 * k.safety_radius, k.safety_radius, 64),
      new THREE.MeshBasicMaterial({ color: css("--s-student"), transparent: true, opacity: 0.9, depthWrite: false }));
    fill.position.z = 0.02; ring.position.z = 0.021;
    const tag = label(String(a), css("--s-student"));
    tag.position.z = 2.0; tag.material.opacity = 0;
    grp.add(fill, ring, tag);
    scene.add(grp);
    robots.push(grp); cargo.push(boxes); zones.push([fill, ring]); tags.push(tag);
  }
  const prioColour = { 1: css("--s-lns"), 2: css("--s-gnn"), 3: css("--s-nearest") };
  const world = ([row, col]) => [(col + 0.5 - k.width / 2) * k.cell, (k.height / 2 - row - 0.5) * k.cell];
  const marks = new THREE.Group(); scene.add(marks);
  const tagGeo = new THREE.CapsuleGeometry(0.22, 0.35, 4, 12).rotateZ(Math.PI / 2);
  const tagMat = Object.fromEntries(Object.entries(prioColour).map(([p, c]) =>
    [p, new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, roughness: 0.4 })]));

  // Which AGV carries red cargo most often: the chase camera follows it.
  const redTicks = Array(film.n).fill(0);
  for (const t of film.ticks) t.trays.forEach((tr, a) => { if (tr.includes(1)) redTicks[a]++; });
  const hero = redTicks.indexOf(Math.max(...redTicks));
  // Where orders wait most: the mid shot looks there.
  const busy = new Map();
  for (const t of film.ticks) for (const [row, col] of t.pending) busy.set(`${row},${col}`, (busy.get(`${row},${col}`) ?? 0) + 1);
  const [bx, by] = world([...busy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [k.height / 2, k.width / 2]);

  // Playback: physics time of the recording, looped, at the stated speed.
  const T = film.frames[film.frames.length - 1].t, speed = film.playback;
  // Start a little before the followed AGV first carries a red order, so the "Red" chapter shows one.
  const firstRed = film.ticks.findIndex((t) => t.trays[hero]?.includes(1));
  const startT = Math.max(0, (film.frames.find((f) => f.tick >= firstRed)?.t ?? 0) - 15);
  const t0 = performance.now() - startT / speed * 1000;
  let pose = film.frames[0].poses, tick = film.frames[0].tick, lastTick = -1;

  function sample(t) {
    const fr = film.frames;
    let lo = 0, hi = fr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (fr[mid].t <= t ? (lo = mid) : (hi = mid)); }
    const a = fr[lo], b = fr[hi], u = clamp((t - a.t) / Math.max(1e-6, b.t - a.t));
    tick = a.tick;
    return a.poses.map((p, i) => {
      const q = b.poses[i];
      let dy = q[2] - p[2]; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      return [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1]), p[2] + u * dy];
    });
  }

  function applyTick(i) {
    const t = film.ticks[Math.min(i, film.ticks.length - 1)];
    t.trays.forEach((tr, a) => {
      cargo[a].forEach((m, s) => { if (!m) return; m.visible = s < tr.length; if (m.visible) m.material.color.set(prioColour[tr[s]]); });
      const red = tr.includes(1);
      for (const z of zones[a]) z.material.color.set(red ? prioColour[1] : css("--s-student"));
    });
    marks.clear();
    const stack = new Map();
    for (const [row, col, p] of t.pending) {
      const key = `${row},${col}`, s = stack.get(key) ?? 0;
      stack.set(key, s + 1);
      if (s >= 5) continue;
      const [x, y] = world([row, col]);
      const m = new THREE.Mesh(tagGeo, tagMat[p]);
      m.position.set(x, y, 2.6 + 0.55 * s); m.userData.base = m.position.z;
      marks.add(m);
    }
    hud(t);
  }

  const $ = (sel) => root.querySelector(sel);
  function hud(t) {
    const counts = [1, 2, 3].map((p) => t.pending.filter((q) => q[2] === p).length);
    $("[data-hud=time]").textContent = `${t.now} s`;
    $("[data-hud=red]").textContent = counts[0];
    $("[data-hud=yellow]").textContent = counts[1];
    $("[data-hud=green]").textContent = counts[2];
    $("[data-hud=carrying]").textContent = t.trays.filter((tr) => tr.includes(1)).length;
    $("[data-hud=delivered]").textContent = `${t.on_time} / ${t.late}`;
  }
  $("[data-hud=fleet]").textContent = film.n;
  $("[data-hud=layout]").textContent = film.layout;
  $("[data-hud=seed]").textContent = film.seed;
  $("[data-hud=speed]").textContent = `${film.playback}×`;
  $("[data-hud=contacts]").textContent = film.contacts;
  root.querySelectorAll("[data-film=n]").forEach((e) => { e.textContent = film.n; });

  // Camera per chapter: [target, offset from target]; follow shots move with the AGV.
  const big = Math.max(W, H);
  const shots = [
    () => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.18 * big, -0.62 * big, 0.42 * big)],
    () => [new THREE.Vector3(bx, by, 0), new THREE.Vector3(10, -26, 18)],
    () => { const [x, y, yaw] = pose[hero]; return [new THREE.Vector3(x, y, 0.5), new THREE.Vector3(-10 * Math.cos(yaw) + 3, -10 * Math.sin(yaw) - 3, 9)]; },
    () => { const [x, y] = pose[hero]; return [new THREE.Vector3(x, y, 0.2), new THREE.Vector3(3.2, -4.2, 3.0)]; },
    () => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.001, -0.05 * big, 0.95 * big)],
  ];
  const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 4000);
  camera.up.set(0, 0, 1);
  const camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  let first = true;

  function progress() {
    const rect = root.getBoundingClientRect(), span = rect.height - innerHeight;
    return clamp(-rect.top / Math.max(1, span)) * (steps.length - 1);
  }

  let prevNow = performance.now();
  function frame() {
    const now = performance.now(), dt = Math.min(0.25, (now - prevNow) / 1000);
    prevNow = now;
    const t = ((now - t0) / 1000 * speed) % T;
    pose = sample(t);
    if (tick !== lastTick) { applyTick(tick); lastTick = tick; }
    pose.forEach(([x, y, yaw], a) => { robots[a].position.set(x, y, 0); robots[a].rotation.z = yaw; });
    for (const m of marks.children) m.position.z = m.userData.base + 0.08 * Math.sin(2 * now / 1000 + m.position.x);

    const p = progress(), i = Math.min(Math.floor(p), shots.length - 2), u = smooth(clamp(p - i));
    const [ta, oa] = shots[i](), [tb, ob] = shots[i + 1]();
    const tgt = ta.lerp(tb, u), pos = tgt.clone().add(oa.lerp(ob, u));
    if (first) { camTgt.copy(tgt); camPos.copy(pos); first = false; }
    const damp = 1 - Math.exp(-5 * dt);                // time-based damping: smooth at any frame rate
    camTgt.lerp(tgt, damp); camPos.lerp(pos, damp);
    camera.position.copy(camPos); camera.lookAt(camTgt);
    const near = clamp(1 - Math.abs(p - 2.5) * 1.2);
    tags.forEach((tg) => { tg.material.opacity = near; });

    steps.forEach((s, j) => {
      const o = clamp(1 - Math.abs(p - j) * 2.4);
      s.style.opacity = o; s.style.transform = `translateY(${(p - j) * -24}px)`;
      s.style.visibility = o > 0.01 ? "visible" : "hidden";
    });
    root.style.setProperty("--film-dim", String(clamp(p - (steps.length - 2)) * 0.55));
    bar.querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-current", String(Math.round(p) === j)));
    bar.style.setProperty("--film-progress", String(p / (steps.length - 1)));

    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * r.getPixelRatio())) { r.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    r.render(scene, camera);
    requestAnimationFrame(frame);
  }
  bar.querySelectorAll("button").forEach((b, j) => {
    b.onclick = () => {
      const span = root.offsetHeight - innerHeight;
      scrollTo({ top: root.offsetTop + span * j / (steps.length - 1), behavior: "smooth" });
    };
  });
  requestAnimationFrame(frame);
}

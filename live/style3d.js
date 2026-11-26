// Shared three.js helpers for the page's 3D views (opening film and live replay):
// MuJoCo geom -> three.js geometry, page palette by geom name, materials, AGV tags.
// Sizes always come from the MuJoCo model; only colours and materials are styled.
import * as THREE from "three";

export const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const dark = () => document.documentElement.dataset.theme !== "day";

/** Page palette for the factory, by geom name (see mjlab_mir/src/mjlab_mir/factory_scene.py). */
export function theme() {
  // A light studio factory under either page theme (as in opt2vla): the 3D reads best light.
  return {
    bg: "#c9cfd2", floor: "#e6e4df", grid: "#d6d3cc",
    machine: "#f7f6f2", edge: "#aaa69d", wall: "#cfccc4",
    road: "#8e98a6", lane: "#e0796d", zone: "#cfe5e8",
    station: "#1f6fd1", store: "#d9621f",
    body: "#f4f5f6", trim: "#5b616b", wheel: "#202226",
  };
}

export function geometry(type, s) {
  if (type === 6) return new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
  if (type === 2) return new THREE.SphereGeometry(s[0], 20, 14);
  if (type === 5 || type === 3) {
    const g = type === 5 ? new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 32)
      : new THREE.CapsuleGeometry(s[0], 2 * s[1], 6, 16);
    return g.rotateX(Math.PI / 2);  // MuJoCo cylinders run along z
  }
  if (type === 4) return new THREE.SphereGeometry(1, 16, 12).scale(s[0], s[1], s[2]);
  return null;
}

export const matrix = (p, m) => new THREE.Matrix4().set(m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1], m[6], m[7], m[8], p[2], 0, 0, 0, 1);

export function kind(name) {
  if (/^r\d+_/.test(name)) {
    const part = name.replace(/^r\d+_/, "");
    if (/^cargo_/.test(part)) return "cargo";
    if (/^tray_/.test(part)) return "tray";
    if (/^post_/.test(part)) return "post";
    if (/wheel|caster/.test(part)) return "wheel";
    if (/stripe/.test(part)) return "stripe";
    return "body";
  }
  for (const k of ["machine", "wall", "road", "tsm", "zone", "station", "store", "floor"]) if (name.startsWith(k)) return k;
  return "other";
}

export function label(text, colour) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = colour; g.beginPath(); g.arc(64, 64, 54, 0, 7); g.fill();
  g.fillStyle = "#fff"; g.font = "bold 64px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(0.7, 0.7, 1);
  s.renderOrder = 10;
  return s;
}


/** Material for a geom of the given kind in the page palette. */
export function material(k, th, rgba) {
  const mat = (colour, extra = {}) => new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, metalness: 0, ...extra });
  if (k === "floor") return mat(th.floor);
  if (k === "machine") return mat(th.machine, { roughness: 0.6 });
  if (k === "wall") return mat(th.wall);
  if (k === "road") return mat(th.road);
  if (k === "tsm") return mat(th.lane);
  if (k === "zone") return mat(th.zone);
  if (k === "station") return mat(th.station, { emissive: th.station, emissiveIntensity: 0.25 });
  if (k === "store") return mat(th.store, { emissive: th.store, emissiveIntensity: 0.25 });
  if (k === "body") return mat(th.body, { roughness: 0.45 });
  if (k === "stripe") return mat(th.trim);
  if (k === "wheel") return mat(th.wheel);
  if (k === "post") return mat(th.trim, { metalness: 0.4, roughness: 0.4 });
  if (k === "tray") return new THREE.MeshPhysicalMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.35, roughness: 0.2 });
  if (k === "cargo") return mat("#ffffff", { roughness: 0.6 });
  return mat(new THREE.Color(rgba[0], rgba[1], rgba[2]));
}

export const CASTS = ["machine", "wall", "body", "post", "cargo", "wheel"];
export const RECEIVES = ["floor", "zone", "road", "tsm", "machine", "body"];

/** Floor texture: one faint line per 2D cell. */
export function gridTexture(k, th) {
  const c = document.createElement("canvas"), px = 64;
  c.width = c.height = px;
  const g = c.getContext("2d");
  g.fillStyle = th.floor; g.fillRect(0, 0, px, px);
  g.strokeStyle = th.grid; g.lineWidth = 1; g.strokeRect(0, 0, px, px);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(k.width, k.height);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** World geoms as meshes (+ outlines for machines and walls) added to `group`. */
export function addWorld(group, geoms, consts, th) {
  const out = new Map();
  for (const g of geoms) {
    const k = kind(g.name);
    if (g.type === 0 && k !== "floor") continue;
    let geo = geometry(g.type, g.size), m = material(k, th, g.rgba);
    if (k === "floor") { geo = new THREE.PlaneGeometry(2 * g.size[0], 2 * g.size[1]); m.map = gridTexture(consts, th); }
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, m);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix(g.pos, g.mat));
    mesh.visible = k === "cargo" ? false : g.rgba[3] > 0;
    mesh.castShadow = CASTS.includes(k); mesh.receiveShadow = RECEIVES.includes(k);
    group.add(mesh);
    out.set(g.id ?? g.name, mesh);
    if (k === "machine" || k === "wall") {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: th.edge }));
      e.matrixAutoUpdate = false; e.matrix.copy(mesh.matrix);
      group.add(e);
    }
  }
  return out;
}

/** Studio lighting: hemisphere fill and a low sun with soft shadows over the layout. */
export function lights(scene, extent) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.6);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0005;
  const S = 0.6 * Math.max(...extent);
  Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 4 * S });
  sun.position.set(-0.55 * S, -0.35 * S, 0.8 * S);
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(hemi, sun, sun.target);
  return { hemi, sun };
}

export function renderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setPixelRatio(Math.min(2, devicePixelRatio));
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  return r;
}

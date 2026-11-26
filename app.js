// LeanFleet project page. All values come from generated JSON (paper sources only).
import { curve, strips, key } from "./charts.js";
import { initArch } from "./arch.js";
import { initFilm } from "./film.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const get = async (u) => { try { const r = await fetch(u); return r.ok ? r.json() : null; } catch { return null; } };
const METHODS = [
  ["student", "LeanFleet", "--s-student", true], ["teacher", "Rollout teacher", "--s-teacher", true],
  ["reserve1@L", "Reserve-1", "--s-reserve"], ["gnn_v6", "IL+RL GNN", "--s-gnn"],
  ["alnsdc200h120@L", "LNS", "--s-lns"], ["nearest@L", "Nearest", "--s-nearest"]];
const DEV = { student: "student", teacher: "teacher", "reserve1@L": "reserve1", gnn_v6: "gnn_v6", "alnsdc200h120@L": "alns", "nearest@L": "nearest" };
const LAYOUTS = ["map1a", "map2a", "map3a", "g22x3x6", "g30x4x6"];

const [ontime, pickup, dtime, numbers, consts] = await Promise.all([
  get("data/ontime.json"), get("data/pickup_tail.json"), get("data/decision_time.json"),
  get("data/numbers.json").then((n) => n ?? get("../paper/generated/numbers.json")), get("data/constants.json")]);
const k = consts ?? {};
document.querySelectorAll("[data-const]").forEach((el) => {
  const v = k[el.dataset.const];
  if (v !== undefined) el.textContent = el.dataset.format === "int" ? Number(v).toLocaleString("en-US") : v;
});

// theme
document.querySelectorAll("[data-theme-set]").forEach((b) => b.onclick = () => {
  document.documentElement.dataset.theme = b.dataset.themeSet;
  try { localStorage.setItem("leanfleet-theme", b.dataset.themeSet); } catch {}
  location.reload();  // 3D scenes and charts read the palette when built
});

// tabs (method pipeline)
document.querySelectorAll("[data-tabs]").forEach((bar) => bar.querySelectorAll("button").forEach((b) => b.onclick = () => {
  bar.querySelectorAll("button").forEach((c) => c.setAttribute("aria-selected", String(c === b)));
  document.querySelectorAll(`[data-pane^="${bar.dataset.tabs}:"]`).forEach((p) => { p.hidden = p.dataset.pane !== `${bar.dataset.tabs}:${b.dataset.tab}`; });
}));

// table of contents follows the reading position; top bar turns solid after the film
const links = [...document.querySelectorAll(".toc a")];
const film = document.getElementById("film");
addEventListener("scroll", () => {
  document.body.classList.toggle("past-film", film.getBoundingClientRect().bottom < 80);
  let cur = links[0];
  for (const a of links) { const s = document.querySelector(a.getAttribute("href")); if (s && s.getBoundingClientRect().top < innerHeight * 0.35) cur = a; }
  links.forEach((a) => a.toggleAttribute("aria-current", a === cur) || (a === cur && a.setAttribute("aria-current", "location")));
}, { passive: true });

// on-time curves
const REF = { map1a: k.refmapone, map2a: k.refmaptwo, map3a: k.refmapthree };
let layout = "map3a";
function drawCurves() {
  const c = ontime?.curves?.[layout] ?? {};
  const isMap = REF[layout] !== undefined;
  const xs = [...new Set(Object.values(c).flatMap((p) => p.map((q) => q.share)))].sort((a, b) => a - b);
  const fx = (v) => (isMap ? String(Math.round(v * REF[layout])) : `${Math.round(v * 100)} %`);
  for (const [id, field, title, target] of [["curve-red", "red", "Red orders on time (%)", k.redmain], ["curve-all", "all", "All orders on time (%)", k.allontime]]) {
    const series = METHODS.filter(([m]) => c[m]).map(([m, name, v, main]) => ({ key: m, name, colour: css(v), main: !!main,
      pts: c[m].map((p) => ({ x: p.share, y: p[field], lo: p[`${field}_lo`], hi: p[`${field}_hi`] })) }));
    curve(document.getElementById(id), { title, series, xs, xFmt: fx, xLabel: isMap ? "AGVs" : "fleet / reference",
      target: target / 100, targetLabel: `target ${target} %` });
  }
}
const tabs = document.getElementById("layout-tabs");
for (const lay of LAYOUTS) {
  const b = document.createElement("button");
  b.textContent = lay; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(lay === layout));
  b.onclick = () => { layout = lay; tabs.querySelectorAll("button").forEach((c) => c.setAttribute("aria-selected", String(c === b))); drawCurves(); };
  tabs.append(b);
}
drawCurves();

// minimum fleet table: best value per column in bold, our row tinted
const mf = numbers?.mf ?? {};
const rows = [...METHODS.slice(0, 4), ["reserve2@L", "Reserve-2", "--s-reserve"], ["reserve3@L", "Reserve-3", "--s-reserve"], ["reserve4@L", "Reserve-4", "--s-reserve"], ...METHODS.slice(4)].filter(([m]) => mf[m]);
const best = Object.fromEntries(LAYOUTS.map((l) => [l, Math.min(...rows.map(([m]) => mf[m]?.[l]?.["95"]).filter((v) => v !== null && v !== undefined))]));
const f = (v) => (v === null || v === undefined ? "–" : String(v));
let t = `<tr><th>Method</th>${LAYOUTS.map((l) => `<th>${l}</th>`).join("")}</tr>`;
for (const [m, name, v] of rows) {
  t += `<tr class="${m === "student" ? "ours" : ""}"><td><span class="key" style="background:${css(v)}"></span>${name}</td>` +
    LAYOUTS.map((l) => { const a = mf[m]?.[l]?.["95"]; return `<td class="${a === best[l] ? "best" : ""}">${f(a)} / ${f(mf[m]?.[l]?.["90"])}</td>`; }).join("") + "</tr>";
}
document.getElementById("minfleet").innerHTML = t;

// development-seed strips
function stripRows(data) {
  return LAYOUTS.filter((l) => data?.values?.some((d) => d.layout === l)).map((l) => ({ group: l,
    items: METHODS.map(([m, name, v, main]) => ({ name, colour: css(v), main: !!main, value: data.values.find((d) => d.layout === l && d.method === DEV[m])?.value })) }));
}
const legend = key(METHODS.map(([, n, v]) => [n, css(v)]));
const pk = document.getElementById("pickup"), dt = document.getElementById("dtime");
if (pickup) { strips(pk, { rows: stripRows(pickup), unit: " s", axisLabel: "slowest red pick-up wait (s), tight fleet" }); pk.insertAdjacentHTML("afterbegin", legend); }
if (dtime) { strips(dt, { rows: stripRows(dtime), log: true, unit: "s", ref: 1, refLabel: "1 s", axisLabel: "p99 decision time (s, log scale)" }); dt.insertAdjacentHTML("afterbegin", legend); }

// architecture, film, live session
initArch(document.getElementById("arch-svg"), document.getElementById("arch-inspector"), document.querySelector("[data-arch-play]"), k);
initFilm(film);
import("./live/live.js").then((m) => m.initLive(consts));
document.getElementById("copy-bib").onclick = () => navigator.clipboard?.writeText(document.getElementById("bib").textContent);

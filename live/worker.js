// Live session worker: the paper's simulator (Python) in Pyodide, the student as numpy.
// Messages in: {type:"start", args}, {type:"advance", seconds}, {type:"add", order}.
// Messages out: {type:"ready"}, {type:"layout", info}, {type:"frame", frame}, {type:"error", msg}.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");

let py = null, sent = 0;  // ticks already sent to the page (3D view)
async function boot() {
  py = await loadPyodide();
  await py.loadPackage(["numpy", "scipy"]);
  const zip = await (await fetch("../py/dispatch.zip", { cache: "no-cache" })).arrayBuffer();
  py.FS.writeFile("/tmp/dispatch.zip", new Uint8Array(zip));
  const npz = await fetch("../models/student.npz");
  if (npz.ok) py.FS.writeFile("/home/pyodide/student.npz", new Uint8Array(await npz.arrayBuffer()));
  py.runPython(`
import sys, json, zipfile
zipfile.ZipFile('/tmp/dispatch.zip').extractall('/home/pyodide/src')
sys.path.insert(0, '/home/pyodide/src')
from factory_dispatch.page_api import Session
S = None
`);
  postMessage({ type: "ready" });
}
const ready = boot().catch((e) => postMessage({ type: "error", msg: String(e) }));

function call(code) { return JSON.parse(py.runPython(code)); }
function ticks() { const t = call(`json.dumps(S.ticks_since(${sent}))`); sent += t.length; return t; }

onmessage = async (ev) => {
  await ready;
  const m = ev.data;
  try {
    if (m.type === "start") {
      py.globals.set("ARGS", JSON.stringify(m.args));
      py.runPython(`
a = json.loads(ARGS)
if a.get("dispatcher") == "student": a["student"] = "/home/pyodide/student.npz"
S = Session(**a)
`);
      postMessage({ type: "layout", info: call("json.dumps(S.layout_info())") });
      sent = 0;
      postMessage({ type: "frame", frame: call("json.dumps(S.frame())"), finished: false, ticks: ticks() });
    } else if (m.type === "advance") {
      py.globals.set("SEC", m.seconds);
      py.runPython("S.advance(int(SEC))");
      const finished = py.runPython("S.finished");
      postMessage({ type: "frame", frame: call("json.dumps(S.frame())"), finished, ticks: ticks(),
                    summary: finished ? call("json.dumps(S.summary())") : null });
    } else if (m.type === "add") {
      py.globals.set("ORD", JSON.stringify(m.order));
      const id = py.runPython("o = json.loads(ORD); S.add_order(o['pickup'], o['dropoff'], int(o['priority']), int(o['size']))");
      postMessage({ type: "added", id, order: call(`json.dumps(S.order(${id}))`) });
    }
  } catch (e) { postMessage({ type: "error", msg: String(e).slice(-600) }); }
};

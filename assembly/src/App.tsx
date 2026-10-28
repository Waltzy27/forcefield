import { useEffect, useMemo, useRef, useState, ReactNode } from "react";
import * as THREE from "three";
import {
  Part, Force, Support, Mate, Region, Results, Vec, Units, UNIT_SCALE, MATERIALS, ElementKind, SupportKind, MateKind,
  uid, unit, sub, len, rotMatrix, mv, toWorld, si, fmt, SolveInput,
} from "./model";
import { parseOBJ, parseSTL, bbox, adjacency, floodSelect, fitCylinder, meshVolume } from "./geometry";
import { Viewer, Field, PickHit } from "./viewer";
import type { PackedMesh } from "./worker";

const CLASSIC_URL = "../";
const COLORS = ["#8b9bb4", "#c9a66b", "#7fb3a5", "#b48bb0", "#a3b86c", "#c98b7a"];
const ELEMENTS: { id: ElementKind; label: string; desc: string }[] = [
  { id: "hex8i", label: "Solid Hex8 (enhanced)", desc: "8-node brick with incompatible bending modes. Best general choice; accurate in bending." },
  { id: "hex8", label: "Solid Hex8 (standard)", desc: "Plain trilinear brick. Stiff in bending on coarse meshes." },
  { id: "tet10", label: "Solid Tet10", desc: "10-node quadratic tetrahedra. Accurate, more unknowns per element." },
  { id: "tet4", label: "Solid Tet4", desc: "4-node linear tetrahedra. Simple but over-stiff; needs a fine mesh." },
  { id: "shell", label: "Shell (solid-shell)", desc: "Thin walls: enhanced bricks with one layer through the thinnest direction." },
  { id: "beam", label: "Beam (3D frame)", desc: "Euler–Bernoulli frame along the long axis; bending, torsion, axial." },
  { id: "truss", label: "Truss / link", desc: "Single 2-node axial bar between the part's ends. Carries tension/compression only." },
];
const SUPPORTS: { id: SupportKind; label: string; desc: string }[] = [
  { id: "fixed", label: "Fixed", desc: "All translations (and beam rotations) held at zero." },
  { id: "pinned", label: "Pinned (ball joint)", desc: "Region centre cannot translate; the region may rotate about it." },
  { id: "roller", label: "Roller / frictionless", desc: "Only the face-normal direction is held; slides freely in-plane." },
  { id: "symmetry", label: "Symmetry plane", desc: "Normal displacement and in-plane rotations held, modelling a mirrored half." },
  { id: "spring", label: "Spring / elastic", desc: "Elastic foundation with the given total stiffness in X, Y and Z." },
  { id: "bearing", label: "Bearing (cylindrical)", desc: "Pick a hole or shaft: radial and axial held, rotation about the axis free." },
  { id: "prescribed", label: "Prescribed displacement", desc: "Region is moved by the given displacement vector." },
];
const MATES: { id: MateKind; label: string; desc: string }[] = [
  { id: "bonded", label: "Bonded (glued/welded)", desc: "Faces move together in every direction." },
  { id: "planar", label: "Planar (coincident)", desc: "Faces stay touching and parallel; they can slide in-plane. Add more mates to stop sliding." },
  { id: "concentric", label: "Concentric", desc: "Shaft stays centred in hole; may rotate and slide along the axis." },
  { id: "hinge", label: "Hinge (concentric + axial)", desc: "Shaft stays centred and cannot slide; rotation about the axis is free." },
];
type Tab = { k: "part"; id: string } | { k: "mates" } | { k: "loads" } | { k: "results" } | { k: "about" };
type PickTarget = { kind: "support" | "mateA" | "mateB" | "force" | "refine"; id: string; part?: string; scope: Region["scope"] };

export default function App() {
  const [parts, setParts] = useState<Part[]>([]);
  const [forces, setForces] = useState<Force[]>([]);
  const [supports, setSupports] = useState<Support[]>([]);
  const [mates, setMates] = useState<Mate[]>([]);
  const [gravity, setGravity] = useState(false);
  const [tab, setTab] = useState<Tab>({ k: "about" });
  const [lu, setLu] = useState<Units>("mm");
  const [importUnits, setImportUnits] = useState<Units>("mm");
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [hover, setHover] = useState<Region | null>(null);
  const [res, setRes] = useState<Results | null>(null);
  const [mesh, setMesh] = useState<PackedMesh | null>(null);
  const [busy, setBusy] = useState<{ msg: string; frac: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<Field>("model");
  const [scaleMul, setScaleMul] = useState(1);
  const [trueScale, setTrueScale] = useState(false);
  const [ghost, setGhost] = useState(true);
  const [showMesh, setShowMesh] = useState(false);
  const [tol, setTol] = useState(1e-7);
  const [toast, setToast] = useState<string | null>(null);
  const viewEl = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const worker = useRef<Worker | null>(null);
  const adjCache = useRef(new Map<string, number[][]>());
  const S = UNIT_SCALE[lu];

  useEffect(() => { viewer.current = new Viewer(viewEl.current!); (window as any).ffViewer = viewer.current; return () => viewer.current?.dispose(); }, []);
  // geometry/transform changes rebuild viewer meshes
  const geomKey = parts.map((p) => `${p.id}:${p.tris.length}:${p.tris[0]}:${p.offset}:${p.rotation}:${p.color}:${p.visible}`).join("|");
  const firstFit = useRef(0);
  useEffect(() => {
    viewer.current?.setParts(parts);
    if (parts.length !== firstFit.current) { viewer.current?.fit(); firstFit.current = parts.length; }
  }, [geomKey]); // eslint-disable-line
  // invalidate results when the model changes
  const modelKey = JSON.stringify({ g: geomKey, m: parts.map((p) => [p.material, p.element, p.size, p.refinements, p.autoRefine, p.beamAxis, p.section]), forces, supports, mates, gravity });
  const lastKey = useRef(modelKey);
  useEffect(() => { if (lastKey.current !== modelKey) { lastKey.current = modelKey; if (res || mesh) { setRes(null); setMesh(null); setField((f) => (f === "model" ? f : "model")); } } }, [modelKey]); // eslint-disable-line

  const autoScale = useMemo(() => {
    if (!res || res.maxDisp === 0) return 0;
    const b = viewer.current?.modelSize(); const size = b && !b.isEmpty() ? b.getSize(new THREE.Vector3()).length() : 1;
    return (0.08 * size) / res.maxDisp;
  }, [res]);
  const scale = res ? (trueScale ? 1 : autoScale) * scaleMul : 0;
  const range = useMemo<[number, number]>(() => {
    if (!res) return [0, 1];
    const v = field === "stress" ? res.nodeStress : field === "strain" ? res.nodeStrain : res.nodeDisp;
    let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 1];
  }, [res, field]);
  useEffect(() => { viewer.current?.applyResults(parts, mesh, res, field, field === "model" && !res ? 0 : scale, ghost, range); }, [geomKey, mesh, res, field, scale, ghost, range]); // eslint-disable-line
  useEffect(() => { viewer.current?.setMeshLines(mesh?.lines ?? null, showMesh || field === "mesh"); }, [mesh, showMesh, field]);
  useEffect(() => { viewer.current?.setOverlay(parts, forces.filter((f) => parts.some((p) => p.id === f.part)), supports, mates, hover, tab.k === "part", !(res && ["stress", "strain", "disp"].includes(field))); }, [geomKey, forces, supports, mates, hover, tab, parts, res, field]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  // ---------- picking ----------
  useEffect(() => {
    const v = viewer.current; if (!v) return;
    v.picking = !!pick;
    v.renderer.domElement.style.cursor = pick ? "crosshair" : "";
    v.onPick = (h: PickHit) => {
      if (!pick) return;
      if (pick.part && pick.part !== h.part) { setToast(`Pick on ${parts.find((p) => p.id === pick.part)?.name}.`); return; }
      const part = parts.find((p) => p.id === h.part)!;
      if (pick.kind === "force") { setForces((fs) => fs.map((f) => (f.id === pick.id ? { ...f, part: h.part, point: h.pointWorld.map((x) => +x.toPrecision(7)) as Vec } : f))); setPick(null); return; }
      if (pick.kind === "refine") { setParts((ps) => ps.map((p) => (p.id === h.part ? { ...p, refinements: p.refinements.map((z) => (z.id === pick.id ? { ...z, center: h.pointWorld } : z)) } : p))); setPick(null); return; }
      let nb = adjCache.current.get(part.id + part.tris.length);
      if (!nb) { nb = adjacency(part.tris).nb; adjCache.current.set(part.id + part.tris.length, nb); }
      const r: Region = { part: h.part, point: h.pointLocal, normal: h.normalLocal, scope: pick.scope, radius: 0 };
      if (pick.scope === "face") r.tris = floodSelect(part.tris, nb, h.tri, "planar");
      if (pick.scope === "cylinder") {
        r.tris = floodSelect(part.tris, nb, h.tri, "smooth");
        const c = fitCylinder(part.tris, r.tris);
        if (!(c.radius > 0) || r.tris.length < 6) { setToast("That surface doesn't look cylindrical. Pick the inside of a hole or a shaft."); return; }
        r.axis = c.axis; r.center = c.center; r.cylR = c.radius;
      }
      if (pick.scope === "patch") r.radius = part.size * 1.5;
      if (pick.kind === "support") setSupports((ss) => ss.map((s) => (s.id === pick.id ? { ...s, region: { ...r, radius: s.region.part === r.part && s.region.radius ? s.region.radius : r.radius } } : s)));
      else setMates((ms) => ms.map((m) => (m.id === pick.id ? { ...m, [pick.kind === "mateA" ? "a" : "b"]: r } : m)));
      setPick(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setPick(null); };
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [pick, parts]);

  // ---------- import ----------
  const fileIn = useRef<HTMLInputElement>(null);
  const projIn = useRef<HTMLInputElement>(null);
  async function importFiles(files: FileList | null) {
    if (!files) return;
    const added: Part[] = [];
    for (const f of Array.from(files)) {
      try {
        const ext = f.name.toLowerCase().split(".").pop();
        let raw: Float32Array;
        if (ext === "obj") raw = parseOBJ(await f.text());
        else if (ext === "stl") raw = parseSTL(await f.arrayBuffer());
        else throw new Error("Only .obj and .stl files are supported.");
        const k = UNIT_SCALE[importUnits];
        const tris = raw.map((v) => v * k);
        const b = bbox(tris); const maxd = Math.max(...b.size);
        const { openFraction } = adjacency(tris);
        const idx = parts.length + added.length;
        const p: Part = {
          id: uid(), name: f.name.replace(/\.(obj|stl)$/i, ""), file: f.name, units: importUnits, tris, raw,
          material: { ...MATERIALS[0] }, offset: [0, 0, 0], rotation: [0, 0, 0], element: "hex8i", size: niceSize(maxd / 16), autoRefine: true, refinements: [],
          beamAxis: "auto", section: null, color: COLORS[idx % COLORS.length], visible: true, notes: "",
        };
        added.push(p);
        if (openFraction > 0.01) setToast(`${f.name}: ${(openFraction * 100).toFixed(0)}% of edges are open. Solid meshing needs a closed (watertight) model.`);
        else if (Math.abs(meshVolume(tris)) === 0) setToast(`${f.name}: zero volume.`);
      } catch (e) { setError(`${f.name}: ${(e as Error).message}`); }
    }
    if (added.length) { setParts((ps) => [...ps, ...added]); setTab({ k: "part", id: added[0].id }); setError(null); }
  }
  function loadSample() {
    const beam = boxTris([0, 0, 0], [0.3, 0.03, 0.02]);
    const bracket = boxTris([-0.04, -0.02, -0.05], [0, 0.05, 0.07]);
    const mk = (name: string, tris: Float32Array, i: number, el: ElementKind, size: number): Part => ({ id: uid(), name, file: `${name}.stl`, units: "m", tris, raw: tris, material: { ...MATERIALS[i ? 1 : 0] }, offset: [0, 0, 0], rotation: [0, 0, 0], element: el, size, autoRefine: true, refinements: [], beamAxis: "auto", section: null, color: COLORS[i], visible: true, notes: "" });
    const wall = mk("Bracket", bracket, 0, "hex8i", 0.01), arm = mk("Arm", beam, 1, "hex8i", 0.01);
    const faceOf = (p: Part, ax: number, v: number) => { const nb = adjacency(p.tris).nb; let seed = 0; for (let i = 0; i < p.tris.length / 9; i++) if ([0, 1, 2].every((q) => Math.abs(p.tris[i * 9 + q * 3 + ax] - v) < 1e-9)) { seed = i; break; } return floodSelect(p.tris, nb, seed, "planar"); };
    setParts([wall, arm]);
    setSupports([{ id: uid(), name: "Wall mount", kind: "fixed", region: { part: wall.id, point: [-0.04, 0.015, 0.01], normal: [-1, 0, 0], scope: "face", radius: 0, tris: faceOf(wall, 0, -0.04) }, stiffness: 1e6, disp: [0, 0, 0] }]);
    setMates([{ id: uid(), name: "Arm to bracket", kind: "bonded", a: { part: wall.id, point: [0, 0.015, 0.01], normal: [1, 0, 0], scope: "face", radius: 0, tris: faceOf(wall, 0, 0) }, b: { part: arm.id, point: [0, 0.015, 0.01], normal: [-1, 0, 0], scope: "face", radius: 0, tris: faceOf(arm, 0, 0) } }]);
    setForces([{ id: uid(), name: "Tip load", part: arm.id, point: [0.3, 0.015, 0.02], dir: [0, 0, -1], magnitude: 500, radius: 0.012 }, { id: uid(), name: "Side load", part: arm.id, point: [0.3, 0.03, 0.01], dir: [0, -1, 0], magnitude: 150, radius: 0.012 }]);
    setTab({ k: "loads" }); setError(null);
  }

  // ---------- solve ----------
  function input(): SolveInput { return { parts: parts.filter((p) => p.visible), forces: forces.filter((f) => parts.find((p) => p.id === f.part)?.visible), supports: supports.filter((s) => parts.find((p) => p.id === s.region.part)?.visible), mates: mates.filter((m) => [m.a.part, m.b.part].every((id) => parts.find((p) => p.id === id)?.visible)), gravity, tol, maxIter: 40000 }; }
  function run(type: "mesh" | "solve") {
    setError(null);
    if (type === "solve") {
      const bad = mates.find((m) => !m.a.part || !m.b.part); if (bad) { setError(`${bad.name}: pick both faces first.`); return; }
      const nos = supports.find((s) => !s.region.part); if (nos) { setError(`${nos.name}: pick where it acts.`); return; }
      const nof = forces.find((f) => !f.part); if (nof) { setError(`${nof.name}: pick or choose the part it acts on.`); return; }
    }
    worker.current?.terminate();
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setBusy({ msg: type === "mesh" ? "Meshing" : "Preparing", frac: 0 });
    w.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === "progress") setBusy({ msg: d.msg, frac: d.frac });
      else {
        setBusy(null); w.terminate(); worker.current = null;
        if (d.type === "error") { setError(d.message); return; }
        lastKey.current = modelKey;
        setMesh(d.mesh);
        if (d.type === "mesh") { setRes(null); setShowMesh(true); setField("mesh"); setToast(`Mesh: ${d.mesh.elementCount.toLocaleString()} elements, ${d.mesh.nodeCount.toLocaleString()} nodes.`); }
        else { setRes(d.res); setField("stress"); setTab({ k: "results" }); }
      }
    };
    w.onerror = (e) => { setBusy(null); setError(`Solver crashed: ${e.message || "out of memory?"} Try a larger element size.`); };
    w.postMessage({ type, input: input() });
  }
  function cancel() { worker.current?.terminate(); worker.current = null; setBusy(null); setToast("Cancelled."); }

  // ---------- align mate ----------
  function alignMate(m: Mate) {
    const pa = parts.find((p) => p.id === m.a.part), pb = parts.find((p) => p.id === m.b.part);
    if (!pa || !pb) return;
    const Ra = rotMatrix(pa.rotation), Rb = rotMatrix(pb.rotation);
    const cyl = m.a.axis && m.b.axis;
    const va = unit(mv(Ra, cyl ? m.a.axis! : m.a.normal)), vb = unit(mv(Rb, cyl ? m.b.axis! : m.b.normal));
    const target = cyl ? (va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2] >= 0 ? va : (va.map((x) => -x) as Vec)) : (va.map((x) => -x) as Vec);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...vb), new THREE.Vector3(...target));
    const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(pb.rotation.map((d) => (d * Math.PI) / 180) as Vec), "XYZ"));
    const e = new THREE.Euler().setFromQuaternion(q.multiply(qb), "XYZ");
    const rot = [e.x, e.y, e.z].map((r) => +((r * 180) / Math.PI).toFixed(6)) as Vec;
    const Rn = rotMatrix(rot);
    const ptA = toWorld(pa, cyl ? m.a.center! : m.a.point);
    const lb = cyl ? m.b.center! : m.b.point;
    const offset = sub(ptA, mv(Rn, lb));
    setParts((ps) => ps.map((p) => (p.id === pb.id ? { ...p, rotation: rot, offset } : p)));
    setToast(`Moved ${pb.name} so the mated ${cyl ? "axes" : "faces"} line up.`);
  }

  // ---------- export ----------
  function download(name: string, data: string | Blob, type = "application/json") {
    const b = typeof data === "string" ? new Blob([data], { type }) : data;
    const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportProject() {
    const proj = { app: "ForceField", version: 2, lu, gravity, parts: parts.map((p) => ({ ...p, tris: undefined, raw: Array.from(p.raw) })), forces, supports, mates };
    download("forcefield-project.json", JSON.stringify(proj));
  }
  async function importProject(f: File | undefined) {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.version !== 2) throw new Error("Not a ForceField V2 project.");
      const ps: Part[] = j.parts.map((p: any) => { const raw = new Float32Array(p.raw); return { ...p, raw, tris: raw.map((v) => v * UNIT_SCALE[p.units as Units]) }; });
      setParts(ps); setForces(j.forces); setSupports(j.supports); setMates(j.mates); setGravity(!!j.gravity); setLu(j.lu ?? "mm"); setTab(ps[0] ? { k: "part", id: ps[0].id } : { k: "about" }); setError(null);
    } catch (e) { setError(`Project: ${(e as Error).message}`); }
  }
  function exportCSV() {
    if (!res || !mesh) return;
    const names = new Map(parts.map((p) => [p.id, p.name]));
    const rows = ["node,part,x_m,y_m,z_m,ux_m,uy_m,uz_m,u_mag_m,von_mises_Pa,equiv_strain"];
    for (let i = 0; i < mesh.nodeCount; i++) rows.push([i, `"${names.get(mesh.nodePart[i])}"`, mesh.nodePos[i * 3], mesh.nodePos[i * 3 + 1], mesh.nodePos[i * 3 + 2], res.u[i * 3], res.u[i * 3 + 1], res.u[i * 3 + 2], res.nodeDisp[i], res.nodeStress[i], res.nodeStrain[i]].join(","));
    download("forcefield-results.csv", rows.join("\n"), "text/csv");
  }

  // ---------- helpers for children ----------
  const upPart = (id: string, patch: Partial<Part>) => setParts((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  function removePart(id: string) {
    setParts((ps) => ps.filter((p) => p.id !== id));
    setForces((fs) => fs.map((f) => (f.part === id ? { ...f, part: "" } : f)));
    setSupports((ss) => ss.filter((s) => s.region.part !== id));
    setMates((ms) => ms.filter((m) => m.a.part !== id && m.b.part !== id));
    setTab({ k: "about" });
  }
  function setUnits(p: Part, u: Units) {
    const tris = p.raw.map((v) => v * UNIT_SCALE[u]);
    const k = UNIT_SCALE[u] / UNIT_SCALE[p.units];
    upPart(p.id, { units: u, tris, size: p.size * k });
    setSupports((ss) => ss.filter((s) => s.region.part !== p.id));
    setMates((ms) => ms.filter((m) => m.a.part !== p.id && m.b.part !== p.id));
    setToast(`Rescaled ${p.name}. Its supports and mates were cleared because the geometry changed.`);
  }
  const ctx: Ctx = { parts, S, lu, setPick, pick, setHover };
  const activePart = tab.k === "part" ? parts.find((p) => p.id === tab.id) : undefined;
  const resultsReady = !!res;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><Logo /> ForceField <small>V2 · assembly</small></div>
        <a className="btn sm hide-sm" href={CLASSIC_URL} title="Original single-part version">Classic V1</a>
        <div className="spacer" />
        <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><span className="hide-sm">Display units</span>
          <select value={lu} onChange={(e) => setLu(e.target.value as Units)} style={{ width: 64 }} aria-label="Display length units">{(["mm", "cm", "m", "in"] as Units[]).map((u) => <option key={u}>{u}</option>)}</select>
        </label>
        <button className="btn" onClick={() => run("mesh")} disabled={!parts.length || !!busy}>Preview mesh</button>
        <button className="btn primary" onClick={() => run("solve")} disabled={!parts.length || !!busy}>Run analysis</button>
      </header>
      <div className="main">
        <aside className="side">
          <nav className="tabs" role="tablist">
            <button className={`tab ${tab.k === "about" ? "on" : ""}`} onClick={() => setTab({ k: "about" })}>Project</button>
            {parts.map((p) => (
              <button key={p.id} className={`tab ${tab.k === "part" && tab.id === p.id ? "on" : ""}`} onClick={() => setTab({ k: "part", id: p.id })} title={p.file}>
                <span className="dot" style={{ background: p.color }} />{p.name.length > 14 ? p.name.slice(0, 13) + "…" : p.name}
              </button>
            ))}
            <button className={`tab ${tab.k === "mates" ? "on" : ""}`} onClick={() => setTab({ k: "mates" })}>Mates <span className="badge">{mates.length}</span></button>
            <button className={`tab ${tab.k === "loads" ? "on" : ""}`} onClick={() => setTab({ k: "loads" })}>Loads &amp; BCs</button>
            <button className={`tab ${tab.k === "results" ? "on" : ""}`} onClick={() => setTab({ k: "results" })}>Results{resultsReady && <span className="dot" style={{ background: "var(--ok)", borderRadius: 8 }} />}</button>
          </nav>
          <div className="panel">
            {error && <div className="msg e"><b>Can't run yet.</b> {error}</div>}
            {tab.k === "about" && (
              <>
                <div className="card">
                  <h3>Import parts</h3>
                  <div className="row">
                    <label className="f" style={{ width: 110 }}><span>File units</span>
                      <select value={importUnits} onChange={(e) => setImportUnits(e.target.value as Units)}>{(["mm", "cm", "m", "in"] as Units[]).map((u) => <option key={u}>{u}</option>)}</select>
                    </label>
                    <button className="btn primary" style={{ alignSelf: "flex-end" }} onClick={() => fileIn.current?.click()}>Import OBJ / STL…</button>
                    <input ref={fileIn} type="file" accept=".obj,.stl" multiple hidden onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
                  </div>
                  <p className="hint">OBJ and STL (ASCII or binary) files carry no units, so choose what the numbers mean before importing. Import several files to build an assembly; each part gets its own tab.</p>
                  {!parts.length && <button className="btn" onClick={loadSample}>Load sample bracket assembly</button>}
                </div>
                <div className="card">
                  <h3>Assembly</h3>
                  {parts.length ? <table className="t"><thead><tr><th>Part</th><th>Material</th><th>Element</th></tr></thead><tbody>{parts.map((p) => <tr key={p.id} onClick={() => setTab({ k: "part", id: p.id })} style={{ cursor: "pointer" }}><td><span className="dot" style={{ display: "inline-block", width: 8, height: 8, background: p.color, marginRight: 6 }} />{p.name}</td><td>{p.material.name}</td><td>{ELEMENTS.find((e) => e.id === p.element)?.label.split(" (")[0]}</td></tr>)}</tbody></table> : <p className="hint">No parts yet.</p>}
                  <label className="chk"><input type="checkbox" checked={gravity} onChange={(e) => setGravity(e.target.checked)} /> Include self-weight (gravity along −Z)</label>
                  <label className="f"><span>Solver tolerance (relative residual)</span>
                    <select value={tol} onChange={(e) => setTol(+e.target.value)}><option value={1e-5}>1e-5 (fast preview)</option><option value={1e-7}>1e-7 (default)</option><option value={1e-9}>1e-9 (tight)</option></select>
                  </label>
                  <div className="row">
                    <button className="btn sm" onClick={exportProject} disabled={!parts.length}>Save project (.json)</button>
                    <button className="btn sm" onClick={() => projIn.current?.click()}>Open project…</button>
                    <input ref={projIn} type="file" accept=".json" hidden onChange={(e) => { importProject(e.target.files?.[0]); e.target.value = ""; }} />
                  </div>
                </div>
                <div className="card">
                  <h3>Workflow</h3>
                  <ol className="hint" style={{ margin: 0, paddingLeft: 16 }}>
                    <li>Import parts and set units, material and element type in each part's tab.</li>
                    <li>Mates tab: pick a face (or hole) on each of two parts, choose the mate type, press Align.</li>
                    <li>Loads &amp; supports: add up to 3 point forces at XYZ and any number of supports.</li>
                    <li>Preview mesh, then Run analysis. Stress travels through parts only via mates.</li>
                  </ol>
                  <p className="hint">Linear static analysis, small displacements, linear-elastic isotropic materials. Mates are bonded (bilateral) and do not separate. Notes about heat are for reference only; thermal effects are not computed.</p>
                </div>
              </>
            )}
            {activePart && <PartTab key={activePart.id} p={activePart} ctx={ctx} up={(x) => upPart(activePart.id, x)} remove={() => removePart(activePart.id)} setUnits={(u) => setUnits(activePart, u)} meshInfo={mesh?.perPart[activePart.id]} />}
            {tab.k === "mates" && <MatesTab mates={mates} setMates={setMates} ctx={ctx} align={alignMate} />}
            {tab.k === "loads" && <LoadsTab forces={forces} setForces={setForces} supports={supports} setSupports={setSupports} ctx={ctx} />}
            {tab.k === "results" && <ResultsTab res={res} parts={parts} exportCSV={exportCSV} snapshot={() => viewer.current && download("forcefield-view.png", dataURLtoBlob(viewer.current.snapshot()))} mesh={mesh} />}
          </div>
        </aside>
        <section className="viewport">
          <div className="canvas" ref={viewEl} data-testid="viewport" />
          <div className="vbar">
            <div className="seg" role="group" aria-label="Display">
              {(["model", "mesh", "stress", "strain", "disp"] as Field[]).map((f) => (
                <button key={f} className={field === f ? "on" : ""} disabled={(f === "mesh" && !mesh) || (["stress", "strain", "disp"].includes(f) && !res)} onClick={() => setField(f)}>
                  {{ model: "Model", mesh: "Mesh", stress: "Von Mises", strain: "Strain", disp: "Displacement" }[f]}
                </button>
              ))}
            </div>
            <div className="seg hide-sm" role="group" aria-label="Views">
              <button onClick={() => viewer.current?.fit()}>Fit</button>
              <button onClick={() => viewer.current?.view([0, -1, 0])}>Front</button>
              <button onClick={() => viewer.current?.view([0, 0, 1])}>Top</button>
              <button onClick={() => viewer.current?.view([1, 0, 0])}>Right</button>
              <button onClick={() => viewer.current?.view([1, -1.3, 0.8])}>Iso</button>
            </div>
            {mesh && <label className="seg chk" style={{ padding: "4px 8px" }}><input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} />Mesh lines</label>}
          </div>
          {pick && <div className="banner">Click the model to pick {pick.kind === "force" ? "the force point" : pick.kind === "refine" ? "the refinement centre" : pick.scope === "face" ? "a flat face" : pick.scope === "cylinder" ? "a hole or shaft surface" : "a point"}{pick.part ? ` on ${parts.find((p) => p.id === pick.part)?.name}` : ""}. <button className="btn sm" onClick={() => setPick(null)}>Cancel (Esc)</button></div>}
          {toast && <div className="banner" style={{ top: "auto", bottom: 70, background: "var(--card2)", border: "1px solid var(--border)", color: "var(--fg)" }}>{toast}</div>}
          {!parts.length && <div className="empty"><div className="floating"><b>Import a part to begin</b><span>OBJ or STL. Import several files to analyse an assembly.</span><div className="row" style={{ justifyContent: "center" }}><button className="btn primary" onClick={() => fileIn.current?.click()}>Import OBJ / STL…</button><button className="btn" onClick={loadSample}>Try sample assembly</button></div><span className="hint">Files are processed locally in your browser. Nothing is uploaded.</span></div></div>}
          {res && ["stress", "strain", "disp"].includes(field) && (
            <div className="legend floating">
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}><b>{{ stress: "Von Mises stress", strain: "Equivalent strain", disp: "Displacement" }[field as "stress"]}</b></div>
              <div className="bar" />
              <div className="ticks">{[0, 0.25, 0.5, 0.75, 1].map((t) => <span key={t}>{fmtField(field, range[0] + t * (range[1] - range[0]), lu)}</span>)}</div>
            </div>
          )}
          {res && field !== "model" && (
            <div className="deform floating">
              <div className="row" style={{ justifyContent: "space-between" }}><b>Deformed shape</b><span className="hint">{fmt(scale, "×", 3)}</span></div>
              <input type="range" min={0} max={3} step={0.05} value={scaleMul} onChange={(e) => setScaleMul(+e.target.value)} aria-label="Deformation scale" />
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label className="chk"><input type="checkbox" checked={trueScale} onChange={(e) => setTrueScale(e.target.checked)} />True scale</label>
                <label className="chk"><input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />Undeformed</label>
              </div>
            </div>
          )}
          {busy && <div className="busy"><div className="floating"><b>{busy.msg}</b><div className="progress"><div style={{ width: `${Math.round(busy.frac * 100)}%` }} /></div><div className="row" style={{ justifyContent: "flex-end" }}><button className="btn sm" onClick={cancel}>Cancel</button></div></div></div>}
        </section>
      </div>
    </div>
  );
}

interface Ctx { parts: Part[]; S: number; lu: Units; pick: PickTarget | null; setPick: (p: PickTarget | null) => void; setHover: (r: Region | null) => void }

function fmtField(f: Field, v: number, lu: Units) {
  if (f === "stress") return si(v, "Pa");
  if (f === "strain") return v.toExponential(2);
  return fmt(v / UNIT_SCALE[lu], lu, 3);
}
function niceSize(x: number) { const p = 10 ** Math.floor(Math.log10(x)); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p; }
function dataURLtoBlob(u: string) { const [h, b] = u.split(","); const bin = atob(b); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: h.split(":")[1].split(";")[0] }); }
function boxTris(lo: Vec, hi: Vec) {
  const [a, b, c] = lo, [d, e, f] = hi;
  const v = [[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const out: number[] = []; for (const [i, j, k, l] of q) for (const t of [[i, j, k], [i, k, l]]) for (const n of t) out.push(...v[n]);
  return new Float32Array(out);
}
function Logo() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="hsl(217 91% 60%)" strokeWidth="2" aria-label="ForceField"><path d="M3 20h18" /><path d="M5 20V9l7-5 7 5v11" /><path d="M12 4v16" strokeDasharray="2 2" /><path d="M8 12l4 3 4-3" /></svg>; }

// ---------- inputs ----------
function Num({ label, value, onChange, step, min, suffix, title }: { label: ReactNode; value: number; onChange: (v: number) => void; step?: number; min?: number; suffix?: string; title?: string }) {
  const [txt, setTxt] = useState(String(+value.toPrecision(8)));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setTxt(String(+value.toPrecision(8))); } }, [value]);
  return (
    <label className="f" title={title}><span>{label}{suffix ? ` (${suffix})` : ""}</span>
      <input type="number" value={txt} step={step ?? "any"} min={min} onChange={(e) => { setTxt(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v)) { last.current = v; onChange(v); } }} />
    </label>
  );
}
function VecIn({ label, v, onChange, scale = 1, suffix }: { label: string; v: Vec; onChange: (v: Vec) => void; scale?: number; suffix?: string }) {
  return (
    <div><div className="hint" style={{ marginBottom: 3 }}>{label}{suffix ? ` (${suffix})` : ""}</div>
      <div className="grid3">{[0, 1, 2].map((k) => <Num key={k} label={"XYZ"[k]} value={v[k] / scale} onChange={(x) => { const n = [...v] as Vec; n[k] = x * scale; onChange(n); }} />)}</div>
    </div>
  );
}

// ---------- part tab ----------
function PartTab({ p, ctx, up, remove, setUnits, meshInfo }: { p: Part; ctx: Ctx; up: (x: Partial<Part>) => void; remove: () => void; setUnits: (u: Units) => void; meshInfo?: { elements: number; kind: string; h?: number } }) {
  const b = bbox(p.tris); const { S, lu } = ctx;
  const vol = Math.abs(meshVolume(p.tris));
  const isLine = p.element === "beam" || p.element === "truss";
  const estCells = isLine ? 0 : Math.round(vol / p.size ** 3);
  const mat = p.material; const preset = MATERIALS.find((m) => m.name === mat.name);
  const setMat = (patch: Partial<typeof mat>) => up({ material: { ...mat, ...patch, name: patch.name ?? "Custom" } });
  const el = ELEMENTS.find((e) => e.id === p.element)!;
  return (
    <>
      <div className="card">
        <h3><span className="dot" style={{ width: 10, height: 10, background: p.color, display: "inline-block", borderRadius: 2 }} /><span className="grow">Part</span><span className="badge">{p.file}</span></h3>
        <div className="grid2">
          <label className="f"><span>Name</span><input type="text" value={p.name} onChange={(e) => up({ name: e.target.value })} /></label>
          <label className="f"><span>File units</span><select value={p.units} onChange={(e) => setUnits(e.target.value as Units)}>{(["mm", "cm", "m", "in"] as Units[]).map((u) => <option key={u}>{u}</option>)}</select></label>
        </div>
        <div className="hint">Size {b.size.map((x) => fmt(x / S, "", 4)).join(" × ")} {lu} · volume {fmt(vol / S ** 3, `${lu}³`, 4)} · mass {fmt(vol * mat.density, "kg", 3)} · {(p.tris.length / 9).toLocaleString()} triangles</div>
        <div className="row"><label className="chk"><input type="checkbox" checked={p.visible} onChange={(e) => up({ visible: e.target.checked })} />Include in analysis</label><div className="spacer" /><button className="btn sm danger" onClick={remove}>Remove part</button></div>
      </div>
      <div className="card">
        <h3>Material</h3>
        <label className="f"><span>Preset</span>
          <select value={preset ? preset.name : "Custom"} onChange={(e) => { const m = MATERIALS.find((x) => x.name === e.target.value); if (m) up({ material: { ...m } }); }}>
            {MATERIALS.map((m) => <option key={m.name}>{m.name}</option>)}<option>Custom</option>
          </select>
        </label>
        <div className="grid2">
          <Num label="Young's modulus E" suffix="GPa" value={mat.E / 1e9} onChange={(v) => setMat({ E: v * 1e9 })} />
          <Num label="Poisson's ratio ν" value={mat.nu} step={0.01} onChange={(v) => setMat({ nu: v })} />
          <Num label="Yield strength" suffix="MPa" value={mat.yield / 1e6} onChange={(v) => setMat({ yield: v * 1e6 })} />
          <Num label="Tensile strength" suffix="MPa" value={mat.uts / 1e6} onChange={(v) => setMat({ uts: v * 1e6 })} />
          <Num label="Density" suffix="kg/m³" value={mat.density} onChange={(v) => setMat({ density: v })} />
        </div>
        {(mat.E <= 0 || mat.nu <= -1 || mat.nu >= 0.5) && <div className="err">E must be positive and ν between −1 and 0.5.</div>}
      </div>
      <div className="card">
        <h3>Position in assembly</h3>
        <VecIn label="Offset" suffix={lu} v={p.offset} scale={S} onChange={(v) => up({ offset: v })} />
        <VecIn label="Rotation (XYZ Euler)" suffix="deg" v={p.rotation} onChange={(v) => up({ rotation: v })} />
        <div className="row"><button className="btn sm" onClick={() => up({ offset: [0, 0, 0], rotation: [0, 0, 0] })}>Reset to file position</button></div>
        <p className="hint">Mates do not move parts on their own; use Align in the Mates tab or type an offset here so mated faces touch.</p>
      </div>
      <div className="card">
        <h3>Element &amp; mesh</h3>
        <label className="f"><span>Element type</span>
          <select value={p.element} onChange={(e) => up({ element: e.target.value as ElementKind })}>{ELEMENTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select>
        </label>
        <p className="hint">{el.desc}</p>
        <div className="grid2">
          <Num label={isLine ? "Element length" : "Base element size"} suffix={lu} value={p.size / S} onChange={(v) => v > 0 && up({ size: v * S })} />
          <div className="hint" style={{ alignSelf: "end" }}>{isLine ? `${p.element === "truss" ? 1 : Math.max(4, Math.round(Math.max(...b.size) / p.size))} elements` : `≈ ${estCells.toLocaleString()} cells before refinement`}{meshInfo ? ` · meshed: ${meshInfo.elements.toLocaleString()}` : ""}</div>
        </div>
        {!isLine && estCells > 150000 && <div className="warn">Large mesh. Solving may take minutes and a lot of memory.</div>}
        {isLine && (
          <>
            <label className="f"><span>Beam axis (part-local)</span><select value={String(p.beamAxis)} onChange={(e) => up({ beamAxis: e.target.value === "auto" ? "auto" : (+e.target.value as 0 | 1 | 2) })}><option value="auto">Auto (longest)</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option></select></label>
            <label className="chk"><input type="checkbox" checked={!!p.section} onChange={(e) => up({ section: e.target.checked ? { A: 1e-4, Iy: 1e-9, Iz: 1e-9, J: 2e-9 } : null })} />Enter section properties manually</label>
            {p.section ? (
              <div className="grid2">
                <Num label="Area A" suffix={`${lu}²`} value={p.section.A / S ** 2} onChange={(v) => up({ section: { ...p.section!, A: v * S ** 2 } })} />
                <Num label="Torsion J" suffix={`${lu}⁴`} value={p.section.J / S ** 4} onChange={(v) => up({ section: { ...p.section!, J: v * S ** 4 } })} />
                <Num label="Iy" suffix={`${lu}⁴`} value={p.section.Iy / S ** 4} onChange={(v) => up({ section: { ...p.section!, Iy: v * S ** 4 } })} />
                <Num label="Iz" suffix={`${lu}⁴`} value={p.section.Iz / S ** 4} onChange={(v) => up({ section: { ...p.section!, Iz: v * S ** 4 } })} />
              </div>
            ) : <p className="hint">Section estimated from the bounding box, scaled so the area matches the part's real volume ÷ length.</p>}
          </>
        )}
        {!isLine && (
          <>
            <label className="chk"><input type="checkbox" checked={p.autoRefine} onChange={(e) => up({ autoRefine: e.target.checked })} />Auto-refine near loads, supports, mates and inside corners (2× finer)</label>
            <div className="row"><b className="grow" style={{ flex: 1 }}>Refinement zones</b><button className="btn sm" onClick={() => { const c = bbox(p.tris).center; up({ refinements: [...p.refinements, { id: uid(), center: toWorld(p, c), radius: p.size * 3, factor: 3 }] }); }}>+ Zone</button></div>
            {p.refinements.map((z, i) => (
              <div className="item" key={z.id}>
                <div className="hd"><b style={{ flex: 1 }}>Zone {i + 1}</b><button className={`btn sm ${ctx.pick?.id === z.id ? "on" : ""}`} onClick={() => ctx.setPick({ kind: "refine", id: z.id, part: p.id, scope: "patch" })}>Pick centre</button><button className="btn sm danger" onClick={() => up({ refinements: p.refinements.filter((q) => q.id !== z.id) })}>✕</button></div>
                <VecIn label="Centre (world)" suffix={lu} v={z.center} scale={S} onChange={(v) => up({ refinements: p.refinements.map((q) => (q.id === z.id ? { ...q, center: v } : q)) })} />
                <div className="grid2">
                  <Num label="Radius" suffix={lu} value={z.radius / S} onChange={(v) => up({ refinements: p.refinements.map((q) => (q.id === z.id ? { ...q, radius: v * S } : q)) })} />
                  <Num label="Elements per base cell" value={z.factor} step={1} min={1} onChange={(v) => up({ refinements: p.refinements.map((q) => (q.id === z.id ? { ...q, factor: Math.max(1, Math.min(8, Math.round(v))) } : q)) })} />
                </div>
              </div>
            ))}
            <p className="hint">Zones split the mesh grid lines that pass through them, so elements are small near stress raisers and large elsewhere. Elements stay conforming, with no hanging nodes.</p>
          </>
        )}
      </div>
      <div className="card">
        <h3>Notes</h3>
        <textarea value={p.notes} placeholder="e.g. heat applied: 120 °C on top face during test (reference only; not used in the analysis)" onChange={(e) => up({ notes: e.target.value })} />
      </div>
    </>
  );
}

// ---------- region picker ----------
function RegionPick({ r, target, ctx, scopes, label }: { r: Region; target: Omit<PickTarget, "scope">; ctx: Ctx; scopes: Region["scope"][]; label?: string }) {
  const part = ctx.parts.find((p) => p.id === r.part);
  const [scope, setScope] = useState<Region["scope"]>(r.part ? r.scope : scopes[0]);
  const active = ctx.pick?.id === target.id && ctx.pick.kind === target.kind;
  const desc = !part ? "Not picked yet" : r.scope === "face" ? `Face on ${part.name} · ${r.tris?.length} triangles` : r.scope === "cylinder" ? `Cylinder on ${part.name} · Ø ${fmt((2 * (r.cylR ?? 0)) / ctx.S, ctx.lu, 4)}` : `Point on ${part.name}`;
  return (
    <div onMouseEnter={() => part && ctx.setHover(r)} onMouseLeave={() => ctx.setHover(null)}>
      {label && <div className="hint" style={{ marginBottom: 3 }}>{label}</div>}
      <div className="row">
        <div className="seg">{scopes.map((s) => <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>{{ face: "Face", cylinder: "Hole/shaft", patch: "Point" }[s]}</button>)}</div>
        <button className={`btn sm ${active ? "on" : ""}`} onClick={() => ctx.setPick(active ? null : { ...target, scope })}>{active ? "Picking…" : part ? "Re-pick" : "Pick"}</button>
      </div>
      <div className={`hint ${part ? "" : "warn"}`} style={{ marginTop: 3 }}>{desc}</div>
    </div>
  );
}

// ---------- mates ----------
function MatesTab({ mates, setMates, ctx, align }: { mates: Mate[]; setMates: (f: (m: Mate[]) => Mate[]) => void; ctx: Ctx; align: (m: Mate) => void }) {
  const empty = (): Region => ({ part: "", point: [0, 0, 0], normal: [0, 0, 1], scope: "face", radius: 0 });
  const up = (id: string, patch: Partial<Mate>) => setMates((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  return (
    <>
      <div className="card">
        <h3><span className="grow">Mates</span><button className="btn sm" disabled={ctx.parts.length < 2} onClick={() => setMates((ms) => [...ms, { id: uid(), name: `Mate ${ms.length + 1}`, kind: "bonded", a: empty(), b: empty() }])}>+ Add mate</button></h3>
        {ctx.parts.length < 2 && <p className="hint">Import at least two parts to mate them.</p>}
        <p className="hint">Loads pass between parts only through mates. Each mate ties the touching region of side B to side A.</p>
        {mates.length > 0 && <table className="t"><thead><tr><th>Mate</th><th>Type</th><th>A</th><th>B</th></tr></thead><tbody>{mates.map((m) => <tr key={m.id}><td>{m.name}</td><td>{MATES.find((x) => x.id === m.kind)?.label.split(" (")[0]}</td><td>{ctx.parts.find((p) => p.id === m.a.part)?.name ?? "—"}</td><td>{ctx.parts.find((p) => p.id === m.b.part)?.name ?? "—"}</td></tr>)}</tbody></table>}
      </div>
      {mates.map((m) => {
        const kind = MATES.find((x) => x.id === m.kind)!;
        const cylNeeded = m.kind === "concentric" || m.kind === "hinge";
        const scopes: Region["scope"][] = cylNeeded ? ["cylinder"] : ["face", "patch"];
        const sameKind = m.a.part && m.b.part && (cylNeeded ? m.a.scope === "cylinder" && m.b.scope === "cylinder" : m.a.scope !== "cylinder" && m.b.scope !== "cylinder");
        return (
          <div className="item" key={m.id}>
            <div className="hd"><input type="text" value={m.name} onChange={(e) => up(m.id, { name: e.target.value })} aria-label="Mate name" /><button className="btn sm danger" onClick={() => setMates((ms) => ms.filter((x) => x.id !== m.id))}>✕</button></div>
            <label className="f"><span>Type</span><select value={m.kind} onChange={(e) => up(m.id, { kind: e.target.value as MateKind })}>{MATES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
            <p className="hint">{kind.desc}</p>
            <RegionPick key={`a${m.kind}`} r={m.a} target={{ kind: "mateA", id: m.id }} ctx={ctx} scopes={scopes} label="Side A (stays put)" />
            <RegionPick key={`b${m.kind}`} r={m.b} target={{ kind: "mateB", id: m.id }} ctx={ctx} scopes={scopes} label="Side B (moves when aligned)" />
            {m.a.part && m.a.part === m.b.part && <div className="err">Both sides are on the same part.</div>}
            {m.a.part && m.b.part && !sameKind && <div className="warn">{cylNeeded ? "Concentric and hinge mates need a hole/shaft pick on both sides." : "Re-pick both sides as faces for this mate type."}</div>}
            <div className="row"><button className="btn sm" disabled={!m.a.part || !m.b.part || m.a.part === m.b.part} onClick={() => align(m)}>Align B to A</button></div>
          </div>
        );
      })}
    </>
  );
}

// ---------- loads & supports ----------
function LoadsTab({ forces, setForces, supports, setSupports, ctx }: { forces: Force[]; setForces: (f: (x: Force[]) => Force[]) => void; supports: Support[]; setSupports: (f: (x: Support[]) => Support[]) => void; ctx: Ctx }) {
  const { S, lu, parts } = ctx;
  const upF = (id: string, patch: Partial<Force>) => setForces((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const upS = (id: string, patch: Partial<Support>) => setSupports((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const total = forces.reduce((a, f) => { const u = unit(f.dir); return [a[0] + u[0] * f.magnitude, a[1] + u[1] * f.magnitude, a[2] + u[2] * f.magnitude] as Vec; }, [0, 0, 0] as Vec);
  return (
    <>
      <div className="card">
        <h3><span className="grow">Forces ({forces.length}/3)</span><button className="btn sm" disabled={forces.length >= 3 || !parts.length} onClick={() => setForces((fs) => [...fs, { id: uid(), name: `F${fs.length + 1}`, part: parts[0]?.id ?? "", point: parts[0] ? toWorld(parts[0], bbox(parts[0].tris).max) : [0, 0, 0], dir: [0, 0, -1], magnitude: 100, radius: (parts[0]?.size ?? 0.01) }])}>+ Force</button></h3>
        {forces.length > 0 && <div className="hint">Resultant: {total.map((x) => fmt(x, "", 4)).join(", ")} N (|F| = {fmt(len(total), "N", 4)})</div>}
        {forces.map((f, i) => (
          <div className="item" key={f.id}>
            <div className="hd"><span className="dot" style={{ width: 8, height: 8, borderRadius: 2, background: ["#ff6b4a", "#ffb02e", "#e26bff"][i % 3] }} /><input type="text" value={f.name} onChange={(e) => upF(f.id, { name: e.target.value })} aria-label="Force name" /><button className="btn sm danger" onClick={() => setForces((fs) => fs.filter((x) => x.id !== f.id))}>✕</button></div>
            <div className="grid2">
              <label className="f"><span>Acts on part</span><select value={f.part} onChange={(e) => upF(f.id, { part: e.target.value })}><option value="">— choose —</option>{parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <button className={`btn sm ${ctx.pick?.id === f.id ? "on" : ""}`} style={{ alignSelf: "end" }} onClick={() => ctx.setPick(ctx.pick?.id === f.id ? null : { kind: "force", id: f.id, scope: "patch" })}>{ctx.pick?.id === f.id ? "Picking…" : "Pick point on model"}</button>
            </div>
            <VecIn label="Application point [X, Y, Z]" suffix={lu} v={f.point} scale={S} onChange={(v) => upF(f.id, { point: v })} />
            <VecIn label="Direction (normalised automatically)" v={f.dir} onChange={(v) => upF(f.id, { dir: v })} />
            {len(f.dir) === 0 && <div className="err">Direction cannot be zero.</div>}
            <div className="grid2">
              <Num label="Magnitude" suffix="N" value={f.magnitude} onChange={(v) => upF(f.id, { magnitude: v })} />
              <Num label="Spread radius" suffix={lu} value={f.radius / S} min={0} onChange={(v) => upF(f.id, { radius: Math.max(0, v * S) })} title="Force is shared by surface nodes within this radius. 0 = nearest nodes only (a true point load)." />
            </div>
          </div>
        ))}
        {!forces.length && <p className="hint">Up to three point forces, each at an [X, Y, Z] point with its own direction.</p>}
      </div>
      <div className="card">
        <h3><span className="grow">Supports ({supports.length})</span><button className="btn sm" disabled={!parts.length} onClick={() => setSupports((ss) => [...ss, { id: uid(), name: `Support ${ss.length + 1}`, kind: "fixed", region: { part: "", point: [0, 0, 0], normal: [0, 0, 1], scope: "face", radius: 0 }, stiffness: 1e6, disp: [0, 0, 0] }])}>+ Support</button></h3>
        <p className="hint">Fasten faces, holes or points. Use two or more supports per part if needed; for example, a fixed end plus a roller.</p>
        {supports.map((s) => {
          const k = SUPPORTS.find((x) => x.id === s.kind)!;
          const scopes: Region["scope"][] = s.kind === "bearing" ? ["cylinder"] : ["face", "patch", "cylinder"];
          return (
            <div className="item" key={s.id}>
              <div className="hd"><input type="text" value={s.name} onChange={(e) => upS(s.id, { name: e.target.value })} aria-label="Support name" /><button className="btn sm danger" onClick={() => setSupports((ss) => ss.filter((x) => x.id !== s.id))}>✕</button></div>
              <label className="f"><span>Type</span><select value={s.kind} onChange={(e) => upS(s.id, { kind: e.target.value as SupportKind })}>{SUPPORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
              <p className="hint">{k.desc}</p>
              <RegionPick key={s.kind === "bearing" ? "b" : "o"} r={s.region} target={{ kind: "support", id: s.id }} ctx={ctx} scopes={scopes} />
              {s.region.part && s.region.scope === "patch" && <Num label="Patch radius" suffix={lu} value={s.region.radius / S} onChange={(v) => upS(s.id, { region: { ...s.region, radius: Math.max(0, v * S) } })} />}
              {s.kind === "bearing" && s.region.part && s.region.scope !== "cylinder" && <div className="warn">Bearing supports need a hole/shaft pick.</div>}
              {s.kind === "spring" && <Num label="Total stiffness (each of X, Y, Z)" suffix="N/m" value={s.stiffness} onChange={(v) => upS(s.id, { stiffness: Math.max(0, v) })} />}
              {s.kind === "prescribed" && <VecIn label="Displacement" suffix={lu} v={s.disp} scale={S} onChange={(v) => upS(s.id, { disp: v })} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- results ----------
function ResultsTab({ res, parts, exportCSV, snapshot, mesh }: { res: Results | null; parts: Part[]; exportCSV: () => void; snapshot: () => void; mesh: PackedMesh | null }) {
  if (!res) return <div className="card"><h3>Results</h3><p className="hint">{mesh ? "Mesh preview ready. Press Run analysis to solve." : "Press Run analysis to solve. Results clear whenever you change the model so they never go stale."}</p></div>;
  const bal = len([res.reaction[0] + res.applied[0], res.reaction[1] + res.applied[1], res.reaction[2] + res.applied[2]]);
  return (
    <>
      <div className="card">
        <h3>Summary</h3>
        <div className="kpi">
          <div><small>Max von Mises</small><b>{si(res.maxStress, "Pa")}</b></div>
          <div><small>Max displacement</small><b>{si(res.maxDisp, "m")}</b></div>
          <div><small>Max equiv. strain</small><b>{res.maxStrain.toExponential(3)}</b></div>
          <div><small>Solve time</small><b>{res.seconds.toFixed(2)} s</b></div>
        </div>
        {res.warnings.map((w, i) => <div key={i} className="msg">{w}</div>)}
      </div>
      <div className="card">
        <h3>Per part</h3>
        <table className="t"><thead><tr><th>Part</th><th>σ max</th><th>|u| max</th><th title="Yield strength ÷ max von Mises (your material input)">σy/σ</th></tr></thead>
          <tbody>{res.partMax.map((p) => <tr key={p.name}><td>{p.name}</td><td className="num">{si(p.stress, "Pa")}</td><td className="num">{si(p.disp, "m")}</td><td className="num">{Number.isFinite(p.fos) ? p.fos.toFixed(2) : "—"}</td></tr>)}</tbody></table>
        <p className="hint">σy/σ compares your entered yield strength with the peak element stress. It is a reference ratio only; peak values at sharp corners and point loads are mesh-dependent.</p>
      </div>
      <div className="card">
        <h3>Load path</h3>
        <table className="t"><thead><tr><th>Item</th><th>Fx</th><th>Fy</th><th>Fz (N)</th></tr></thead>
          <tbody>
            <tr><td>Applied</td>{res.applied.map((v, i) => <td key={i} className="num">{fmt(v, "", 4)}</td>)}</tr>
            {res.perSupport.map((s) => <tr key={s.name}><td>{s.name}</td>{s.force.map((v, i) => <td key={i} className="num">{fmt(v, "", 4)}</td>)}</tr>)}
            {res.mateForces.map((s) => <tr key={s.name}><td>↔ {s.name}</td>{s.force.map((v, i) => <td key={i} className="num">{fmt(v, "", 4)}</td>)}</tr>)}
          </tbody></table>
        <p className={`hint ${bal > 0.01 * len(res.applied) ? "warn" : "ok"}`}>Equilibrium check: |ΣF| = {fmt(bal, "N", 3)} ({len(res.applied) ? ((100 * bal) / len(res.applied)).toFixed(3) : "0"}% of load). Mate rows show force transmitted into side B.</p>
      </div>
      <div className="card">
        <h3>Solver</h3>
        <table className="t"><tbody>
          <tr><td>Elements</td><td className="num">{res.elements.toLocaleString()}</td></tr>
          <tr><td>Nodes</td><td className="num">{res.nodes.toLocaleString()}</td></tr>
          <tr><td>Unknowns (DOF)</td><td className="num">{res.dofs.toLocaleString()}</td></tr>
          <tr><td>PCG iterations</td><td className="num">{res.iterations.toLocaleString()}</td></tr>
          <tr><td>Relative residual</td><td className="num">{res.residual.toExponential(2)}</td></tr>
          <tr><td>Parts</td><td className="num">{parts.filter((p) => p.visible).length}</td></tr>
        </tbody></table>
        <div className="row"><button className="btn sm" onClick={exportCSV}>Export node results (.csv)</button><button className="btn sm" onClick={snapshot}>Save view (.png)</button></div>
      </div>
    </>
  );
}

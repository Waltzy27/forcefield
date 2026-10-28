import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Part, Vec, Region, Force, Support, Mate, Results, rotMatrix, mv, mtv, sub, add, mul, cross, toWorld, len } from "./model";
import type { PackedMesh } from "./worker";

export type Field = "model" | "mesh" | "stress" | "strain" | "disp";
export function ramp(t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t));
  const stops: [number, number, number][] = [[0.0, 0.2, 1.0], [0.0, 0.85, 1.0], [0.1, 0.9, 0.2], [1.0, 0.9, 0.0], [1.0, 0.1, 0.05]];
  const x = t * 4, i = Math.min(3, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((k) => stops[i][k] + (stops[i + 1][k] - stops[i][k]) * f) as [number, number, number];
}
/** Uniformly subdivide triangles so that edges are <= target (display only). Returns positions and parent triangle index. */
export function subdivide(t: Float32Array, target: number, budget = 150000) {
  const n = t.length / 9;
  const edge = (i: number) => { const o = i * 9; let m = 0; for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) m = Math.max(m, Math.hypot(t[o + a] - t[o + b], t[o + a + 1] - t[o + b + 1], t[o + a + 2] - t[o + b + 2])); return m; };
  const E = Array.from({ length: n }, (_, i) => edge(i));
  let tgt = target;
  for (let k = 0; k < 30; k++) { let tot = 0; for (const e of E) tot += Math.ceil(e / tgt) ** 2; if (tot <= budget) break; tgt *= 1.3; }
  const pos: number[] = []; const parent: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = Math.max(1, Math.ceil(E[i] / tgt)); const o = i * 9;
    const P = (a: number, b: number) => { const c = m - a - b; return [0, 1, 2].map((q) => (t[o + q] * c + t[o + 3 + q] * a + t[o + 6 + q] * b) / m); };
    for (let a = 0; a < m; a++) for (let b = 0; b < m - a; b++) {
      pos.push(...P(a, b), ...P(a + 1, b), ...P(a, b + 1)); parent.push(i);
      if (a + b < m - 1) { pos.push(...P(a + 1, b), ...P(a + 1, b + 1), ...P(a, b + 1)); parent.push(i); }
    }
  }
  return { pos: new Float32Array(pos), parent: Int32Array.from(parent) };
}
export interface PickHit { part: string; tri: number; pointWorld: Vec; pointLocal: Vec; normalLocal: Vec; normalWorld: Vec }

export class Viewer {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera: THREE.PerspectiveCamera; controls: OrbitControls;
  root = new THREE.Group(); overlay = new THREE.Group(); meshLines: THREE.LineSegments | null = null;
  partMeshes = new Map<string, THREE.Mesh>(); ghosts = new Map<string, THREE.LineSegments>();
  onPick: ((h: PickHit) => void) | null = null; picking = false;
  private raf = 0; private ro: ResizeObserver; private down: { x: number; y: number } | null = null;
  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setClearColor(0x14171c);
    el.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1e-4, 1e4);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1.4, 0.9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30343c, 1.3));
    const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(2, -3, 4); this.camera.add(d); this.scene.add(this.camera);
    this.scene.add(this.root, this.overlay);
    const grid = new THREE.GridHelper(2, 20, 0x3a4250, 0x262b33); grid.rotation.x = Math.PI / 2; grid.name = "grid"; this.scene.add(grid);
    const axes = new THREE.AxesHelper(0.1); axes.name = "axes"; this.scene.add(axes);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el); this.resize();
    const c = this.renderer.domElement;
    c.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    c.addEventListener("pointerup", (e) => { if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) this.click(e); this.down = null; });
    const loop = () => { this.raf = requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }
  dispose() { cancelAnimationFrame(this.raf); this.ro.disconnect(); this.renderer.dispose(); this.el.innerHTML = ""; }
  resize() { const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1; this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  private click(e: PointerEvent) {
    if (!this.picking || !this.onPick) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hits = ray.intersectObjects([...this.partMeshes.values()].filter((m) => m.visible), false);
    if (!hits.length || hits[0].faceIndex == null) return;
    const h = hits[0]; const m = h.object as THREE.Mesh; const pid = m.userData.part as string;
    const p = m.userData.partObj as Part;
    const t = p.tris, sub = h.faceIndex!, i = (m.userData.parent as Int32Array)[sub];
    const a = new THREE.Vector3(t[i * 9], t[i * 9 + 1], t[i * 9 + 2]), b = new THREE.Vector3(t[i * 9 + 3], t[i * 9 + 4], t[i * 9 + 5]), c = new THREE.Vector3(t[i * 9 + 6], t[i * 9 + 7], t[i * 9 + 8]);
    const nL = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    // map hit on the (possibly deformed) display triangle back to the undeformed one
    const bary = new THREE.Vector3();
    const pos = (m.geometry.getAttribute("position") as THREE.BufferAttribute);
    const A = new THREE.Vector3().fromBufferAttribute(pos, sub * 3), B = new THREE.Vector3().fromBufferAttribute(pos, sub * 3 + 1), C = new THREE.Vector3().fromBufferAttribute(pos, sub * 3 + 2);
    const local = m.worldToLocal(h.point.clone());
    THREE.Triangle.getBarycoord(local, A, B, C, bary);
    const base = m.userData.base as Float32Array;
    const V = (k: number) => new THREE.Vector3(base[(sub * 3 + k) * 3], base[(sub * 3 + k) * 3 + 1], base[(sub * 3 + k) * 3 + 2]);
    const pl = V(0).multiplyScalar(bary.x).add(V(1).multiplyScalar(bary.y)).add(V(2).multiplyScalar(bary.z));
    const pL: Vec = [pl.x, pl.y, pl.z]; const nl: Vec = [nL.x, nL.y, nL.z];
    this.onPick({ part: pid, tri: i, pointLocal: pL, pointWorld: toWorld(p, pL), normalLocal: nl, normalWorld: mv(rotMatrix(p.rotation), nl) });
  }
  /** rebuild part meshes from parts */
  setParts(parts: Part[]) {
    for (const m of this.partMeshes.values()) { this.root.remove(m); m.geometry.dispose(); }
    for (const g of this.ghosts.values()) { this.root.remove(g); g.geometry.dispose(); }
    this.partMeshes.clear(); this.ghosts.clear();
    for (const p of parts) {
      const g = new THREE.BufferGeometry();
      const sd = subdivide(p.tris, p.size / 2);
      g.setAttribute("position", new THREE.BufferAttribute(sd.pos.slice(), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sd.pos.length).fill(1), 3));
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: p.color, metalness: 0.1, roughness: 0.65, side: THREE.DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      const m = new THREE.Mesh(g, mat);
      m.userData = { part: p.id, partObj: p, base: sd.pos, parent: sd.parent };
      m.position.set(...p.offset); m.rotation.set(...(p.rotation.map((d) => (d * Math.PI) / 180) as Vec), "XYZ");
      m.visible = p.visible;
      this.root.add(m); this.partMeshes.set(p.id, m);
      const g0 = new THREE.BufferGeometry(); g0.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p.tris), 3));
      const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(g0, 25), new THREE.LineBasicMaterial({ color: 0x9aa6b8, transparent: true, opacity: 0.35 }));
      ghost.position.copy(m.position); ghost.rotation.copy(m.rotation); ghost.visible = false;
      this.root.add(ghost); this.ghosts.set(p.id, ghost);
    }
  }
  modelSize() { const b = new THREE.Box3(); for (const m of this.partMeshes.values()) if (m.visible) { m.updateMatrixWorld(true); const bb = new THREE.Box3().setFromBufferAttribute(m.geometry.getAttribute("position") as THREE.BufferAttribute); bb.applyMatrix4(m.matrixWorld); b.union(bb); } return b; }
  fit() {
    const b = this.modelSize(); if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).length() || 1;
    this.controls.target.copy(c);
    this.camera.position.copy(c.clone().add(new THREE.Vector3(0.9, -1.3, 0.8).multiplyScalar(s * 1.05)));
    this.camera.near = s / 1000; this.camera.far = s * 100; this.camera.updateProjectionMatrix();
    const grid = this.scene.getObjectByName("grid")!; grid.scale.setScalar(Math.max(s, 1e-3) * 1.5); grid.position.set(c.x, c.y, b.min.z);
    this.scene.getObjectByName("axes")!.scale.setScalar(s * 2);
  }
  view(dir: Vec) { const b = this.modelSize(); const c = b.getCenter(new THREE.Vector3()); const s = b.getSize(new THREE.Vector3()).length() || 1; this.controls.target.copy(c); this.camera.position.copy(c.clone().add(new THREE.Vector3(...dir).normalize().multiplyScalar(s * 1.8))); }

  /** overlays: forces, supports, mates, refinements, selection highlight */
  setOverlay(parts: Part[], forces: Force[], supports: Support[], mates: Mate[], highlight: Region | null, showRefine: boolean, regions = true) {
    this.overlay.clear();
    const b = this.modelSize(); const S = b.isEmpty() ? 0.1 : b.getSize(new THREE.Vector3()).length();
    const pmap = new Map(parts.map((p) => [p.id, p]));
    const colors = ["#ff6b4a", "#ffb02e", "#e26bff"];
    forces.forEach((f, i) => {
      const d = new THREE.Vector3(...f.dir); if (d.length() === 0) return; d.normalize();
      const L = S * 0.18; const origin = new THREE.Vector3(...f.point).sub(d.clone().multiplyScalar(L));
      const a = new THREE.ArrowHelper(d, origin, L, new THREE.Color(colors[i % 3]).getHex(), L * 0.28, L * 0.14);
      this.overlay.add(a);
      const s = new THREE.Mesh(new THREE.SphereGeometry(S * 0.008), new THREE.MeshBasicMaterial({ color: colors[i % 3] })); s.position.set(...f.point); this.overlay.add(s);
      if (f.radius > 0) { const r = new THREE.Mesh(new THREE.SphereGeometry(f.radius, 16, 12), new THREE.MeshBasicMaterial({ color: colors[i % 3], wireframe: true, transparent: true, opacity: regions ? 0.3 : 0.12 })); r.position.set(...f.point); this.overlay.add(r); }
    });
    const regionColor: Record<string, string> = { fixed: "#3b82f6", pinned: "#22d3ee", roller: "#a3e635", symmetry: "#c084fc", spring: "#facc15", prescribed: "#fb7185", bearing: "#2dd4bf" };
    if (regions) for (const s of supports) this.drawRegion(pmap.get(s.region.part), s.region, regionColor[s.kind] ?? "#3b82f6", S);
    if (regions) mates.forEach((m) => { this.drawRegion(pmap.get(m.a.part), m.a, "#f472b6", S); this.drawRegion(pmap.get(m.b.part), m.b, "#fb923c", S); });
    if (highlight) this.drawRegion(pmap.get(highlight.part), highlight, "#ffffff", S);
    if (showRefine) for (const p of parts) for (const z of p.refinements) {
      const r = new THREE.Mesh(new THREE.SphereGeometry(z.radius, 20, 14), new THREE.MeshBasicMaterial({ color: 0x67e8f9, wireframe: true, transparent: true, opacity: 0.3 })); r.position.set(...z.center); this.overlay.add(r);
    }
  }
  private drawRegion(p: Part | undefined, r: Region, color: string, S: number) {
    if (!p) return;
    const m = this.partMeshes.get(p.id); if (!m) return;
    if (r.tris?.length) {
      const pos = new Float32Array(r.tris.length * 9);
      r.tris.forEach((ti, k) => { for (let q = 0; q < 9; q++) pos[k * 9 + q] = p.tris[ti * 9 + q]; });
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const hm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: true }));
      hm.position.copy(m.position); hm.rotation.copy(m.rotation); hm.renderOrder = 2; this.overlay.add(hm);
    } else {
      const w = toWorld(p, r.point);
      const s = new THREE.Mesh(new THREE.SphereGeometry(Math.max(r.radius, S * 0.01), 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45 })); s.position.set(...w); this.overlay.add(s);
    }
  }
  setMeshLines(lines: Float32Array | null, visible: boolean) {
    if (this.meshLines) { this.scene.remove(this.meshLines); this.meshLines.geometry.dispose(); this.meshLines = null; }
    if (!lines || !visible) return;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(lines, 3));
    this.meshLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.55 }));
    this.scene.add(this.meshLines);
  }
  /** colour + deform part meshes from results */
  applyResults(parts: Part[], mesh: PackedMesh | null, res: Results | null, field: Field, scale: number, ghost: boolean, range: [number, number]) {
    for (const p of parts) {
      const m = this.partMeshes.get(p.id); if (!m) continue;
      const g = m.geometry; const pos = g.getAttribute("position") as THREE.BufferAttribute; const col = g.getAttribute("color") as THREE.BufferAttribute;
      const mat = m.material as THREE.MeshStandardMaterial;
      const grid = mesh?.grids.find((q) => q.part === p.id);
      const useRes = !!(res && grid && field !== "model" && field !== "mesh");
      const R = rotMatrix(p.rotation);
      const base = m.userData.base as Float32Array;
      const nv = base.length / 3;
      const vals = res ? (field === "stress" ? res.nodeStress : field === "strain" ? res.nodeStrain : res.nodeDisp) : null;
      const key = `${res ? res.seconds + ":" + res.maxDisp : 0}|${field}|${p.offset}|${p.rotation}`;
      let cache = m.userData.cache as { key: string; U: Float32Array; V: Float32Array } | undefined;
      if (!cache || cache.key !== key) {
        const U = new Float32Array(nv * 3), Vv = new Float32Array(nv);
        if (res && grid) for (let i = 0; i < nv; i++) {
          const s = sampleNode(grid, mesh!, res, p, [base[i * 3], base[i * 3 + 1], base[i * 3 + 2]], vals);
          const ul = mtv(R, s.u); U[i * 3] = ul[0]; U[i * 3 + 1] = ul[1]; U[i * 3 + 2] = ul[2]; Vv[i] = s.v;
        }
        cache = { key, U, V: Vv }; m.userData.cache = cache;
      }
      const { U, V } = cache;
      for (let i = 0; i < nv; i++) {
        pos.setXYZ(i, base[i * 3] + scale * U[i * 3], base[i * 3 + 1] + scale * U[i * 3 + 1], base[i * 3 + 2] + scale * U[i * 3 + 2]);
        if (useRes) { const t = range[1] > range[0] ? (V[i] - range[0]) / (range[1] - range[0]) : 0; const c = ramp(t); col.setXYZ(i, c[0], c[1], c[2]); } else col.setXYZ(i, 1, 1, 1);
      }
      pos.needsUpdate = true; col.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
      mat.vertexColors = useRes; mat.color.set(useRes ? "#ffffff" : p.color); mat.flatShading = !useRes; mat.needsUpdate = true;
      const gh = this.ghosts.get(p.id); if (gh) gh.visible = ghost && scale > 0 && !!res && p.visible;
    }
  }
  /** world -> CSS pixel coords inside canvas (used by automated UI tests) */
  project(p: Vec) { const v = new THREE.Vector3(...p).project(this.camera); const r = this.renderer.domElement.getBoundingClientRect(); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; }
  snapshot() { return this.renderer.domElement.toDataURL("image/png"); }
}

function sampleNode(grid: PackedMesh["grids"][number], mesh: PackedMesh, res: Results, p: Part, pl: Vec, vals: Float64Array | null): { u: Vec; v: number } {
  const U = res.u;
  if (grid.beam) {
    const b = grid.beam; const ax = b.axis as Vec; const L2 = ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2;
    let s = ((pl[0] - b.origin[0]) * ax[0] + (pl[1] - b.origin[1]) * ax[1] + (pl[2] - b.origin[2]) * ax[2]) / L2;
    s = Math.min(1, Math.max(0, s));
    const n = b.nodes.length - 1; const k = Math.min(n - 1, Math.floor(s * n)); const f = s * n - k;
    const pw = toWorld(p, pl);
    const out: Vec = [0, 0, 0]; let v = 0;
    for (const [node, w] of [[b.nodes[k], 1 - f], [b.nodes[k + 1], f]] as [number, number][]) {
      const np: Vec = [mesh.nodePos[node * 3], mesh.nodePos[node * 3 + 1], mesh.nodePos[node * 3 + 2]];
      const th: Vec = [res.rot[node * 3], res.rot[node * 3 + 1], res.rot[node * 3 + 2]];
      const ut = add([U[node * 3], U[node * 3 + 1], U[node * 3 + 2]], cross(th, sub(pw, np)));
      for (let q = 0; q < 3; q++) out[q] += w * ut[q];
      if (vals) v += w * vals[node];
    }
    return { u: out, v };
  }
  const { gx, gy, gz, nodeIndex } = grid;
  const find = (arr: number[], x: number) => { let lo = 0, hi = arr.length - 2; if (x <= arr[0]) return 0; if (x >= arr[arr.length - 1]) return hi; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= x) lo = m; else hi = m - 1; } return lo; };
  const i = find(gx, pl[0]), j = find(gy, pl[1]), k = find(gz, pl[2]);
  const ny1 = gy.length, nz1 = gz.length;
  const tryCell = (i: number, j: number, k: number, clamp: boolean) => {
    if (i < 0 || j < 0 || k < 0 || i >= gx.length - 1 || j >= gy.length - 1 || k >= gz.length - 1) return null;
    let fx = (pl[0] - gx[i]) / (gx[i + 1] - gx[i]), fy = (pl[1] - gy[j]) / (gy[j + 1] - gy[j]), fz = (pl[2] - gz[k]) / (gz[k + 1] - gz[k]);
    if (clamp) { fx = Math.min(1, Math.max(0, fx)); fy = Math.min(1, Math.max(0, fy)); fz = Math.min(1, Math.max(0, fz)); }
    let W = 0; const u: Vec = [0, 0, 0]; let v = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
      const n = nodeIndex[((i + a) * ny1 + (j + b)) * nz1 + (k + c)]; if (n < 0) continue;
      const w = (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (c ? fz : 1 - fz) + 1e-9;
      W += w; u[0] += w * U[n * 3]; u[1] += w * U[n * 3 + 1]; u[2] += w * U[n * 3 + 2]; if (vals) v += w * vals[n];
    }
    return W > 0 ? { u: mul(u, 1 / W), v: v / W } : null;
  };
  let r = tryCell(i, j, k, false);
  if (r) return r;
  for (let d = 1; d <= 2 && !r; d++) for (let a = -d; a <= d && !r; a++) for (let b = -d; b <= d && !r; b++) for (let c = -d; c <= d && !r; c++) r = tryCell(i + a, j + b, k + c, true);
  return r ?? { u: [0, 0, 0], v: 0 };
}
export { len };

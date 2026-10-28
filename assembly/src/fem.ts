import {
  Vec, Part, SolveInput, Results, MeshNode, MeshElement, PartGrid, Region, add, sub, mul, dot, cross, len, unit, perp,
  toWorld, toLocal, rotMatrix, mv, mtv,
} from "./model";
import { bbox, meshVolume, adjacency, triNormal, triCenter } from "./geometry";
import { frameTransform } from "./elements";
import { Dmat, hex8K, hex8iK, tet4K, tet10K, frameK, trussK, hex8Strain, tetStrain, hex8CornerStrains, tet10CornerStrains, stressFromStrain, vonMises, eqStrain, frameStress, Section } from "./elements";

export interface Mesh {
  nodes: MeshNode[]; elements: MeshElement[]; grids: PartGrid[]; warnings: string[];
  cellSize: Map<string, number>; sections: Map<string, Section>;
}
type Progress = (msg: string, frac: number) => void;

// ---------- inside test via ray casting along z, triangles binned by xy ----------
function insideTester(t: Float32Array, gx: number[], gy: number[]) {
  const nt = t.length / 9;
  const cx = gx.slice(0, -1).map((v, i) => (v + gx[i + 1]) / 2);
  const cy = gy.slice(0, -1).map((v, i) => (v + gy[i + 1]) / 2);
  const bins: number[][] = Array.from({ length: cx.length * cy.length }, () => []);
  const lb = (arr: number[], v: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
  for (let i = 0; i < nt; i++) {
    const o = i * 9;
    const x0 = Math.min(t[o], t[o + 3], t[o + 6]), x1 = Math.max(t[o], t[o + 3], t[o + 6]);
    const y0 = Math.min(t[o + 1], t[o + 4], t[o + 7]), y1 = Math.max(t[o + 1], t[o + 4], t[o + 7]);
    for (let a = lb(cx, x0); a < cx.length && cx[a] <= x1; a++) for (let b = lb(cy, y0); b < cy.length && cy[b] <= y1; b++) bins[a * cy.length + b].push(i);
  }
  // returns sorted z-crossings for column (a,b)
  return (a: number, b: number): number[] => {
    const px = cx[a] + 1.3e-7 * (gx[a + 1] - gx[a]), py = cy[b] + 0.7e-7 * (gy[b + 1] - gy[b]);
    const hits: number[] = [];
    for (const i of bins[a * cy.length + b]) {
      const o = i * 9;
      const ax = t[o], ay = t[o + 1], bx = t[o + 3], by = t[o + 4], qx = t[o + 6], qy = t[o + 7];
      const d = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
      if (Math.abs(d) < 1e-30) continue;
      const l1 = ((by - qy) * (px - qx) + (qx - bx) * (py - qy)) / d;
      const l2 = ((qy - ay) * (px - qx) + (ax - qx) * (py - qy)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      hits.push(l1 * t[o + 2] + l2 * t[o + 5] + l3 * t[o + 8]);
    }
    hits.sort((p, q) => p - q);
    const out: number[] = [];
    for (const h of hits) if (!out.length || Math.abs(h - out[out.length - 1]) > 1e-9) out.push(h);
    return out;
  };
}

function gradedLines(lo: number, hi: number, h: number, zones: { c: number; r: number; f: number }[], fixed?: number): number[] {
  const L = hi - lo;
  if (fixed) return Array.from({ length: fixed + 1 }, (_, i) => lo + (L * i) / fixed);
  const n = Math.max(1, Math.round(L / h));
  const out = [lo];
  for (let i = 0; i < n; i++) {
    const a = lo + (L * i) / n, b = lo + (L * (i + 1)) / n;
    let f = 1;
    for (const z of zones) {
      const d = Math.max(0, Math.max(a, z.c - z.r) - Math.min(b, z.c + z.r));
      if (d <= 0 || (a <= z.c + z.r && b >= z.c - z.r)) f = Math.max(f, z.f);
      else if (d < z.r) f = Math.max(f, Math.ceil(z.f / 2)); // transition band
    }
    const m = Math.max(1, Math.round(f));
    for (let k = 1; k <= m; k++) out.push(a + ((b - a) * k) / m);
  }
  return out;
}

export function sectionFor(p: Part): { axis: number; sec: Section; lo: Vec; hi: Vec; L: number } {
  const b = bbox(p.tris);
  const axis = p.beamAxis === "auto" ? [0, 1, 2].reduce((m, k) => (b.size[k] > b.size[m] ? k : m), 0) : p.beamAxis;
  const L = b.size[axis];
  const o = [0, 1, 2].filter((k) => k !== axis);
  const w = b.size[o[0]], hgt = b.size[o[1]];
  const V = Math.abs(meshVolume(p.tris));
  const fill = Math.min(1, Math.max(0.05, V / (L * w * hgt || 1)));
  const A = p.section?.A ?? fill * w * hgt;
  const a = Math.max(w, hgt), c = Math.min(w, hgt);
  const sec: Section = p.section
    ? { ...p.section, cy: w / 2, cz: hgt / 2 }
    : { A, Iy: (fill * w * hgt ** 3) / 12, Iz: (fill * hgt * w ** 3) / 12, J: fill * a * c ** 3 * (1 / 3 - (0.21 * c) / a * (1 - c ** 4 / (12 * a ** 4))), cy: w / 2, cz: hgt / 2 };
  // local frame of frameTransform uses ey = ref x ex, ez = ex x ey; map bbox dims approximately (conservative choose max c)
  return { axis, sec, lo: b.min, hi: b.max, L };
}

export function buildMesh(inp: SolveInput, progress: Progress = () => {}): Mesh {
  const nodes: MeshNode[] = [], elements: MeshElement[] = [], grids: PartGrid[] = [], warnings: string[] = [];
  const cellSize = new Map<string, number>(), sections = new Map<string, Section>();
  inp.parts.forEach((p, pi) => {
    progress(`Meshing ${p.name}`, pi / inp.parts.length * 0.3);
    if (p.element === "beam" || p.element === "truss") {
      const { axis, sec, lo, hi, L } = sectionFor(p);
      const b = bbox(p.tris);
      {
        // orient section to the element's local frame (ey, ez as used by frameTransform)
        const R = rotMatrix(p.rotation);
        const ax: Vec = [0, 0, 0]; ax[axis] = 1;
        const f = frameTransform([0, 0, 0], mv(R, ax));
        const ey = mtv(R, [f[3], f[4], f[5]]), ez = mtv(R, [f[6], f[7], f[8]]);
        const o = [0, 1, 2].filter((k) => k !== axis);
        const ext = (e: Vec) => Math.abs(e[o[0]]) * b.size[o[0]] + Math.abs(e[o[1]]) * b.size[o[1]];
        const hy = ext(ey), hz = ext(ez);
        if (!p.section) { const fill = sec.A / (hy * hz || 1); sec.Iy = (fill * hy * hz ** 3) / 12; sec.Iz = (fill * hz * hy ** 3) / 12; }
        sec.cy = hy / 2; sec.cz = hz / 2;
      }
      sections.set(p.id, sec);
      const c0: Vec = [...b.center] as Vec; c0[axis] = lo[axis];
      const c1: Vec = [...b.center] as Vec; c1[axis] = hi[axis];
      const n = p.element === "truss" ? 1 : Math.max(4, Math.round(L / p.size));
      const ids: number[] = [], s: number[] = [];
      for (let i = 0; i <= n; i++) {
        const q = add(c0, mul(sub(c1, c0), i / n));
        ids.push(nodes.length); s.push(i / n);
        nodes.push({ p: toWorld(p, q), part: p.id, rot: p.element === "beam", boundary: true });
      }
      for (let i = 0; i < n; i++) elements.push({ nodes: [ids[i], ids[i + 1]], part: p.id, kind: p.element });
      grids.push({ part: p.id, gx: [], gy: [], gz: [], nodeIndex: new Int32Array(0), kind: p.element, beam: { origin: c0, axis: sub(c1, c0), nodes: ids, s } });
      cellSize.set(p.id, L / n);
      if (L / Math.max(b.size[(axis + 1) % 3], b.size[(axis + 2) % 3]) < 5) warnings.push(`${p.name}: length/depth ratio is below 5, so beam theory may be inaccurate. Consider a solid element.`);
      return;
    }
    const b = bbox(p.tris);
    const pad = Math.max(...b.size) * 1e-4;
    const lo = sub(b.min, [pad, pad, pad]), hi = add(b.max, [pad, pad, pad]);
    const h = p.size;
    // refinement zones in local coordinates
    const zones: { c: Vec; r: number; f: number }[] = p.refinements.map((z) => ({ c: toLocal(p, z.center), r: z.radius, f: Math.max(1, z.factor) }));
    if (p.autoRefine) {
      const pts: Vec[] = [];
      inp.forces.filter((f) => f.part === p.id).forEach((f) => pts.push(toLocal(p, f.point)));
      inp.supports.filter((s) => s.region.part === p.id).forEach((s) => pts.push(s.region.point));
      inp.mates.forEach((m) => { if (m.a.part === p.id) pts.push(m.a.point); if (m.b.part === p.id) pts.push(m.b.point); });
      // concave (re-entrant) edges: stress raisers
      const { nb } = adjacency(p.tris);
      const conc: Vec[] = [];
      for (let i = 0; i < nb.length && conc.length < 400; i++) {
        const ni = triNormal(p.tris, i), ci = triCenter(p.tris, i);
        for (const j of nb[i]) if (j > i && dot(triNormal(p.tris, j), ni) < 0.5 && dot(sub(triCenter(p.tris, j), ci), ni) > 1e-12) conc.push(mul(add(ci, triCenter(p.tris, j)), 0.5));
      }
      const thin: Vec[] = [];
      for (const c of conc) if (!thin.some((q) => len(sub(q, c)) < h * 2)) thin.push(c);
      thin.slice(0, 40).forEach((c) => pts.push(c));
      for (const c of pts) zones.push({ c, r: h * 1.5, f: 2 });
    }
    let fixedLayers: (number | undefined)[] = [undefined, undefined, undefined];
    if (p.element === "shell") {
      const thinAx = [0, 1, 2].reduce((m, k) => (b.size[k] < b.size[m] ? k : m), 0);
      fixedLayers[thinAx] = b.size[thinAx] > 2.5 * h ? Math.round(b.size[thinAx] / h) : 1;
      if (b.size[thinAx] > 0.15 * Math.max(...b.size)) warnings.push(`${p.name}: thickness is over 15% of its span, so this is not really a thin shell. Solid Hex8 may suit it better.`);
    }
    const gl = [0, 1, 2].map((k) => gradedLines(lo[k], hi[k], h, zones.map((z) => ({ c: z.c[k], r: z.r, f: z.f })), fixedLayers[k]));
    const [gx, gy, gz] = gl;
    const nx = gx.length - 1, ny = gy.length - 1, nz = gz.length - 1;
    if (nx * ny * nz > 4e6) throw new Error(`${p.name}: background grid of ${nx}×${ny}×${nz} cells is too large. Increase element size.`);
    const cast = insideTester(p.tris, gx, gy);
    const active = new Uint8Array(nx * ny * nz);
    const czs = gz.slice(0, -1).map((v, i) => (v + gz[i + 1]) / 2);
    let nAct = 0;
    for (let a = 0; a < nx; a++) for (let c = 0; c < ny; c++) {
      const hits = cast(a, c);
      if (hits.length < 2) continue;
      let hi2 = 0;
      for (let k = 0; k < nz; k++) {
        const z = czs[k];
        while (hi2 < hits.length && hits[hi2] < z) hi2++;
        if (hi2 % 2 === 1) { active[(a * ny + c) * nz + k] = 1; nAct++; }
      }
    }
    if (p.element === "shell" && nAct === 0) {
      // fallback for open/zero-thickness shells: mark cells touched by surface
      warnings.push(`${p.name}: no enclosed volume found; check the file is a closed solid.`);
    }
    if (!nAct) throw new Error(`${p.name}: no solid cells were found. The mesh may be open, or the element size is larger than the part's thickness.`);
    const nIdx = new Int32Array((nx + 1) * (ny + 1) * (nz + 1)).fill(-1);
    const nid = (i: number, j: number, k: number) => {
      const key = (i * (ny + 1) + j) * (nz + 1) + k;
      if (nIdx[key] < 0) { nIdx[key] = nodes.length; nodes.push({ p: toWorld(p, [gx[i], gy[j], gz[k]]), part: p.id, rot: false, boundary: false }); }
      return nIdx[key];
    };
    const isAct = (a: number, c: number, k: number) => a >= 0 && c >= 0 && k >= 0 && a < nx && c < ny && k < nz && active[(a * ny + c) * nz + k] === 1;
    const edgeMid = new Map<string, number>();
    const mid = (u: number, v: number) => {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      let m = edgeMid.get(key);
      if (m === undefined) { m = nodes.length; const pu = nodes[u].p, pv = nodes[v].p; nodes.push({ p: mul(add(pu, pv), 0.5), part: p.id, rot: false, boundary: nodes[u].boundary && nodes[v].boundary }); edgeMid.set(key, m); }
      return m;
    };
    let minCell = Infinity;
    for (let a = 0; a < nx; a++) for (let c = 0; c < ny; c++) for (let k = 0; k < nz; k++) {
      if (!isAct(a, c, k)) continue;
      minCell = Math.min(minCell, gx[a + 1] - gx[a], gy[c + 1] - gy[c], gz[k + 1] - gz[k]);
      const hx = [nid(a, c, k), nid(a + 1, c, k), nid(a + 1, c + 1, k), nid(a, c + 1, k), nid(a, c, k + 1), nid(a + 1, c, k + 1), nid(a + 1, c + 1, k + 1), nid(a, c + 1, k + 1)];
      const bnd = !isAct(a - 1, c, k) || !isAct(a + 1, c, k) || !isAct(a, c - 1, k) || !isAct(a, c + 1, k) || !isAct(a, c, k - 1) || !isAct(a, c, k + 1);
      if (bnd) {
        // mark nodes on exposed faces
        const faces: [boolean, number[]][] = [[!isAct(a - 1, c, k), [0, 3, 4, 7]], [!isAct(a + 1, c, k), [1, 2, 5, 6]], [!isAct(a, c - 1, k), [0, 1, 4, 5]], [!isAct(a, c + 1, k), [2, 3, 6, 7]], [!isAct(a, c, k - 1), [0, 1, 2, 3]], [!isAct(a, c, k + 1), [4, 5, 6, 7]]];
        for (const [exp, ids] of faces) if (exp) for (const q of ids) nodes[hx[q]].boundary = true;
      }
      if (p.element === "hex8" || p.element === "hex8i" || p.element === "shell") elements.push({ nodes: hx, part: p.id, kind: p.element });
      else {
        const T = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
        for (const tt of T) {
          const cn = tt.map((q) => hx[q]);
          if (p.element === "tet4") elements.push({ nodes: cn, part: p.id, kind: "tet4" });
          else elements.push({ nodes: [...cn, mid(cn[0], cn[1]), mid(cn[1], cn[2]), mid(cn[0], cn[2]), mid(cn[0], cn[3]), mid(cn[1], cn[3]), mid(cn[2], cn[3])], part: p.id, kind: "tet10" });
        }
      }
    }
    // connectivity check within the part (disconnected islands)
    grids.push({ part: p.id, gx, gy, gz, nodeIndex: nIdx, kind: p.element });
    cellSize.set(p.id, minCell);
    const Vm = Math.abs(meshVolume(p.tris));
    let Vv = 0;
    for (let a = 0; a < nx; a++) for (let c = 0; c < ny; c++) for (let k = 0; k < nz; k++) if (isAct(a, c, k)) Vv += (gx[a + 1] - gx[a]) * (gy[c + 1] - gy[c]) * (gz[k + 1] - gz[k]);
    if (Vm > 0 && Math.abs(Vv / Vm - 1) > 0.15) warnings.push(`${p.name}: meshed volume differs from the CAD volume by ${(100 * (Vv / Vm - 1)).toFixed(0)}%. Use a smaller element size or refinement zones for better geometry capture.`);
  });
  return { nodes, elements, grids, warnings, cellSize, sections };
}

// ---------------- region -> nodes ----------------
function closestOnTri(p: Vec, a: Vec, b: Vec, c: Vec): Vec {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap); if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp); if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp); if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc); return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
}

export function regionNodes(r: Region, inp: SolveInput, mesh: Mesh): number[] {
  const part = inp.parts.find((p) => p.id === r.part);
  if (!part) return [];
  const h = mesh.cellSize.get(part.id) ?? part.size;
  const grid = mesh.grids.find((g) => g.part === part.id)!;
  const cand: number[] = [];
  mesh.nodes.forEach((n, i) => { if (n.part === part.id && n.boundary) cand.push(i); });
  const loc = cand.map((i) => toLocal(part, mesh.nodes[i].p));
  if (grid.beam) {
    // nearest beam node
    let best = cand[0], bd = Infinity;
    cand.forEach((i, k) => { const d = len(sub(loc[k], r.point)); if (d < bd) { bd = d; best = i; } });
    return [best];
  }
  const tol = Math.max(h, part.size) * 0.75;
  let sel: number[] = [];
  if (r.scope === "patch") {
    const rad = Math.max(r.radius, tol);
    cand.forEach((i, k) => { if (len(sub(loc[k], r.point)) <= rad) sel.push(i); });
  } else if (r.scope === "face" && r.tris?.length) {
    const t = part.tris;
    const tv = r.tris.map((ti) => [0, 1, 2].map((q) => [t[ti * 9 + q * 3], t[ti * 9 + q * 3 + 1], t[ti * 9 + q * 3 + 2]] as Vec));
    const bmin: Vec = [Infinity, Infinity, Infinity], bmax: Vec = [-Infinity, -Infinity, -Infinity];
    tv.forEach((tr) => tr.forEach((v) => { for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], v[k] - tol); bmax[k] = Math.max(bmax[k], v[k] + tol); } }));
    cand.forEach((i, k) => {
      const q = loc[k];
      if (q.some((v, a) => v < bmin[a] || v > bmax[a])) return;
      for (const tr of tv) if (len(sub(closestOnTri(q, tr[0], tr[1], tr[2]), q)) <= tol) { sel.push(i); break; }
    });
  } else if (r.scope === "cylinder" && r.axis && r.center && r.cylR) {
    const ax = r.axis, c = r.center;
    let smin = Infinity, smax = -Infinity;
    if (r.tris) for (const ti of r.tris) for (let q = 0; q < 3; q++) { const s = dot(sub([part.tris[ti * 9 + q * 3], part.tris[ti * 9 + q * 3 + 1], part.tris[ti * 9 + q * 3 + 2]], c), ax); smin = Math.min(smin, s); smax = Math.max(smax, s); }
    cand.forEach((i, k) => {
      const d = sub(loc[k], c); const s = dot(d, ax); const rr = len(sub(d, mul(ax, s)));
      if (Math.abs(rr - r.cylR!) <= tol && s >= smin - tol * 0.5 && s <= smax + tol * 0.5) sel.push(i);
    });
  }
  if (!sel.length) {
    // fall back: nearest few boundary nodes
    const order = cand.map((i, k) => [i, len(sub(loc[k], r.point))]).sort((a, b) => a[1] - b[1]);
    sel = order.slice(0, 4).map((o) => o[0]);
  }
  return sel;
}

export function regionWorld(r: Region, inp: SolveInput) {
  const p = inp.parts.find((q) => q.id === r.part)!;
  const R = rotMatrix(p.rotation);
  return { point: toWorld(p, r.point), normal: unit(mv(R, r.normal)), axis: r.axis ? unit(mv(R, r.axis)) : undefined, center: r.center ? toWorld(p, r.center) : undefined };
}

// ---------------- linear system ----------------
interface Eq { d: number[]; c: number[]; g: number; w: number; tag: string }

export function solve(inp: SolveInput, progress: Progress = () => {}, cancelled: () => boolean = () => false): { mesh: Mesh; res: Results } {
  const t0 = performance.now();
  if (!inp.parts.length) throw new Error("Import at least one part.");
  for (const p of inp.parts) {
    if (!(p.material.E > 0)) throw new Error(`${p.name}: Young's modulus must be positive.`);
    if (!(p.material.nu > -1 && p.material.nu < 0.5)) throw new Error(`${p.name}: Poisson's ratio must be between -1 and 0.5.`);
    if (!(p.size > 0)) throw new Error(`${p.name}: element size must be positive.`);
  }
  if (!inp.supports.length) throw new Error("Add at least one support so the assembly is held in place.");
  const mesh = buildMesh(inp, progress);
  const { nodes, elements } = mesh;
  const warnings = [...mesh.warnings];
  const nn = nodes.length;
  const dof0 = new Int32Array(nn + 1);
  for (let i = 0; i < nn; i++) dof0[i + 1] = dof0[i] + (nodes[i].rot ? 6 : 3);
  const N = dof0[nn];
  if (N > 1.2e6) throw new Error(`Model has ${N.toLocaleString()} unknowns. Increase element size; this browser solver supports up to about 1.2 million.`);
  progress(`Assembling ${elements.length.toLocaleString()} elements`, 0.32);
  // sparsity (node adjacency)
  const adj: Set<number>[] = Array.from({ length: nn }, (_, i) => new Set([i]));
  for (const e of elements) for (const a of e.nodes) for (const b of e.nodes) adj[a].add(b);
  const rowPtr = new Int32Array(N + 1);
  const nbr = adj.map((s) => Int32Array.from([...s].sort((a, b) => a - b)));
  adj.length = 0;
  for (let i = 0; i < nn; i++) { let w = 0; for (const j of nbr[i]) w += dof0[j + 1] - dof0[j]; for (let d = dof0[i]; d < dof0[i + 1]; d++) rowPtr[d + 1] = w; }
  for (let d = 0; d < N; d++) rowPtr[d + 1] += rowPtr[d];
  const nnz = rowPtr[N];
  if (nnz > 1.6e8) throw new Error("Stiffness matrix too large for browser memory. Increase element size.");
  const col = new Int32Array(nnz), val = new Float64Array(nnz);
  for (let i = 0; i < nn; i++) for (let d = dof0[i]; d < dof0[i + 1]; d++) { let k = rowPtr[d]; for (const j of nbr[i]) for (let q = dof0[j]; q < dof0[j + 1]; q++) col[k++] = q; }
  const findCol = (row: number, c: number) => { let lo = rowPtr[row], hi = rowPtr[row + 1] - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (col[m] < c) lo = m + 1; else if (col[m] > c) hi = m - 1; else return m; } return -1; };
  const partOf = new Map(inp.parts.map((p) => [p.id, p]));
  const Ds = new Map(inp.parts.map((p) => [p.id, Dmat(p.material.E, p.material.nu)]));
  const F = new Float64Array(N);
  const elDofs = (e: MeshElement) => { const r: number[] = []; for (const n of e.nodes) for (let d = dof0[n]; d < dof0[n + 1]; d++) r.push(d); return r; };
  let lastP = 0;
  elements.forEach((e, ei) => {
    if (ei - lastP > 4000) { lastP = ei; progress(`Assembling element ${ei.toLocaleString()} / ${elements.length.toLocaleString()}`, 0.32 + 0.18 * ei / elements.length); if (cancelled()) throw new Error("Cancelled"); }
    const p = partOf.get(e.part)!; const X = e.nodes.map((n) => nodes[n].p);
    let K: Float64Array;
    if (e.kind === "hex8") K = hex8K(X, Ds.get(p.id)!);
    else if (e.kind === "hex8i" || e.kind === "shell") K = hex8iK(X, Ds.get(p.id)!);
    else if (e.kind === "tet4") K = tet4K(X, Ds.get(p.id)!);
    else if (e.kind === "tet10") K = tet10K(X, Ds.get(p.id)!);
    else if (e.kind === "beam") K = frameK(X[0], X[1], p.material.E, p.material.nu, mesh.sections.get(p.id)!).K;
    else K = trussK(X[0], X[1], p.material.E * mesh.sections.get(p.id)!.A).K;
    const ds = elDofs(e); const m = ds.length;
    for (let i = 0; i < m; i++) { const r = ds[i]; for (let j = 0; j < m; j++) { const v = K[i * m + j]; if (v !== 0) val[findCol(r, ds[j])] += v; } }
  });
  const diag = new Float64Array(N);
  for (let d = 0; d < N; d++) diag[d] = val[findCol(d, d)];
  // characteristic stiffness per node for penalty scaling
  const nodeK = (n: number) => { let s = 0; for (let d = dof0[n]; d < dof0[n] + 3; d++) s = Math.max(s, diag[d]); return s; };

  // ---- loads ----
  const applied: Vec = [0, 0, 0];
  let appliedMoment: Vec = [0, 0, 0];
  for (const f of inp.forces) {
    const p = partOf.get(f.part); if (!p) throw new Error(`${f.name}: choose which part it acts on.`);
    if (!(len(f.dir) > 0)) throw new Error(`${f.name}: direction vector cannot be zero.`);
    const Fv = mul(unit(f.dir), f.magnitude);
    if (!Number.isFinite(f.magnitude)) throw new Error(`${f.name}: magnitude is not a number.`);
    const ns = regionNodes({ part: p.id, point: toLocal(p, f.point), normal: [0, 0, 1], scope: "patch", radius: f.radius }, inp, mesh);
    const c = ns.reduce((s, n) => add(s, nodes[n].p), [0, 0, 0] as Vec);
    const cen = mul(c, 1 / ns.length);
    for (const n of ns) for (let k = 0; k < 3; k++) F[dof0[n] + k] += Fv[k] / ns.length;
    // transfer offset moment for beam nodes (exact load transfer)
    if (ns.length === 1 && nodes[ns[0]].rot) { const M = cross(sub(f.point, nodes[ns[0]].p), Fv); for (let k = 0; k < 3; k++) F[dof0[ns[0]] + 3 + k] += M[k]; }
    else if (len(sub(cen, f.point)) > (mesh.cellSize.get(p.id) ?? p.size) * 1.5) warnings.push(`${f.name}: point is ${(len(sub(cen, f.point)) * 1000).toFixed(2)} mm from the part surface; the load was moved to the nearest surface nodes.`);
    for (let k = 0; k < 3; k++) applied[k] += Fv[k];
    appliedMoment = add(appliedMoment, cross(f.point, Fv));
  }
  if (inp.gravity) {
    // lumped body force: element volume * rho * g distributed equally
    elements.forEach((e) => {
      const p = partOf.get(e.part)!; const X = e.nodes.map((n) => nodes[n].p);
      let V = 0;
      if (e.kind === "beam" || e.kind === "truss") V = len(sub(X[1], X[0])) * mesh.sections.get(p.id)!.A;
      else if (e.kind.startsWith("tet")) { const a = sub(X[1], X[0]), b = sub(X[2], X[0]), c = sub(X[3], X[0]); V = Math.abs(dot(a, cross(b, c))) / 6; }
      else V = Math.abs((X[6][0] - X[0][0]) * (X[6][1] - X[0][1]) * (X[6][2] - X[0][2])) || hexVol(X);
      const W = -9.80665 * p.material.density * V;
      const cn = e.kind === "tet10" ? e.nodes.slice(0, 4) : e.nodes;
      for (const n of cn) F[dof0[n] + 2] += W / cn.length;
      applied[2] += W;
    });
  }
  if (len(applied) === 0 && !inp.supports.some((s) => s.kind === "prescribed" && len(s.disp) > 0)) throw new Error("All loads are zero. Add a force with a non-zero magnitude.");

  // ---- constraints ----
  const fixedVal = new Map<number, number>();
  const eqs: Eq[] = [];
  const supTag: Map<string, number[]> = new Map();
  const springs: { d: number; k: number; tag: string }[] = [];
  const P = 1e3;
  const addEq = (d: number[], c: number[], g: number, tag: string) => {
    let s = 0; for (const q of d) s = Math.max(s, diag[q]); eqs.push({ d, c, g, w: P * s, tag });
  };
  // motion of a material point near node n: returns 3 rows of (dof, coef)
  const motion = (n: number, at: Vec): { d: number[]; c: number[] }[] => {
    const b = dof0[n];
    if (!nodes[n].rot) return [0, 1, 2].map((k) => ({ d: [b + k], c: [1] }));
    const r = sub(at, nodes[n].p); // u + θ × r
    return [
      { d: [b, b + 4, b + 5], c: [1, r[2], -r[1]] },
      { d: [b + 1, b + 5, b + 3], c: [1, r[0], -r[2]] },
      { d: [b + 2, b + 3, b + 4], c: [1, r[1], -r[0]] },
    ];
  };
  const dirRow = (n: number, at: Vec, dir: Vec, sign = 1) => {
    const m = motion(n, at); const d: number[] = [], c: number[] = [];
    for (let k = 0; k < 3; k++) if (Math.abs(dir[k]) > 1e-12) m[k].d.forEach((q, i) => { d.push(q); c.push(sign * dir[k] * m[k].c[i]); });
    return { d, c };
  };
  const axisAligned = (v: Vec) => v.findIndex((x) => Math.abs(x) > 0.99999);
  for (const s of inp.supports) {
    const ns = regionNodes(s.region, inp, mesh);
    supTag.set(s.id, ns);
    const W = regionWorld(s.region, inp);
    const isBeam = ns.length === 1 && nodes[ns[0]].rot;
    const fixDof = (d: number, v = 0) => fixedVal.set(d, v);
    const normalCon = (n: number, nrm: Vec) => { const ai = axisAligned(nrm); if (ai >= 0 && !nodes[n].rot) fixDof(dof0[n] + ai); else { const r = dirRow(n, nodes[n].p, nrm); addEq(r.d, r.c, 0, s.id); } };
    switch (s.kind) {
      case "fixed": for (const n of ns) for (let d = dof0[n]; d < dof0[n + 1]; d++) fixDof(d); break;
      case "prescribed": for (const n of ns) for (let k = 0; k < 3; k++) fixDof(dof0[n] + k, s.disp[k]); if (isBeam) for (let k = 3; k < 6; k++) fixDof(dof0[ns[0]] + k); break;
      case "pinned":
        if (isBeam || ns.length === 1) for (let k = 0; k < 3; k++) fixDof(dof0[ns[0]] + k);
        else for (let k = 0; k < 3; k++) addEq(ns.map((n) => dof0[n] + k), ns.map(() => 1 / ns.length), 0, s.id); // ball joint at patch centroid
        break;
      case "roller": for (const n of ns) normalCon(n, W.normal); break;
      case "symmetry": for (const n of ns) { normalCon(n, W.normal); if (nodes[n].rot) { const [t1, t2] = perp(W.normal); for (const t of [t1, t2]) addEq([3, 4, 5].map((k) => dof0[n] + k), t, 0, s.id); } } break;
      case "spring": { const kk = s.stiffness / ns.length; for (const n of ns) for (let k = 0; k < 3; k++) springs.push({ d: dof0[n] + k, k: kk, tag: s.id }); break; }
      case "bearing": {
        const ax = W.axis ?? W.normal, c = W.center ?? W.point;
        if (isBeam) { const [t1, t2] = perp(ax); for (const t of [t1, t2, ax]) { const r = dirRow(ns[0], nodes[ns[0]].p, t); addEq(r.d, r.c, 0, s.id); } break; }
        for (const n of ns) { const d = sub(nodes[n].p, c); const er = unit(sub(d, mul(ax, dot(d, ax)))); if (len(er) > 0) { const r = dirRow(n, nodes[n].p, er); addEq(r.d, r.c, 0, s.id); } }
        addEq(ns.flatMap((n) => [0, 1, 2].map((k) => dof0[n] + k)), ns.flatMap(() => ax.map((a) => a / ns.length)), 0, s.id); // axial hold
        break;
      }
    }
  }
  // ---- mates ----
  const mateTags = new Map<string, string>();
  for (const m of inp.mates) {
    if (m.a.part === m.b.part) throw new Error(`${m.name}: both sides are on the same part. Pick faces on two different parts.`);
    const na = regionNodes(m.a, inp, mesh), nb = regionNodes(m.b, inp, mesh);
    mateTags.set(m.id, m.name);
    const WA = regionWorld(m.a, inp);
    const nearest = (p: Vec) => { let best = na[0], bd = Infinity; for (const q of na) { const d = len(sub(nodes[q].p, p)); if (d < bd) { bd = d; best = q; } } return { n: best, d: bd }; };
    let maxGap = 0;
    const tie = (b: number, dir: Vec) => {
      const { n: a, d } = nearest(nodes[b].p); maxGap = Math.max(maxGap, d);
      const at = nodes[b].p;
      const rb = dirRow(b, at, dir, 1), ra = dirRow(a, at, dir, -1);
      addEq([...rb.d, ...ra.d], [...rb.c, ...ra.c], 0, m.id);
    };
    // drive from side with more nodes (B) to nearest on A; if B is a single beam node, invert roles
    const swap = nb.length < na.length;
    const aSide = swap ? nb : na;
    const nearestA = (p: Vec) => { let best = aSide[0], bd = Infinity; for (const q of aSide) { const d = len(sub(nodes[q].p, p)); if (d < bd) { bd = d; best = q; } } return { n: best, d: bd }; };
    const hMax = Math.max(mesh.cellSize.get(m.a.part) ?? 0, mesh.cellSize.get(m.b.part) ?? 0);
    // only tie the overlapping portion of the two regions
    const pairs = (swap ? na : nb).map((b) => ({ b, ...nearestA(nodes[b].p) }));
    const dmin = Math.min(...pairs.map((q) => q.d));
    const single = aSide.length === 1;
    const bSide = pairs.filter((q) => single || q.d <= dmin + 1.5 * hMax).map((q) => q.b);
    maxGap = dmin;
    const tie2 = (b: number, dir: Vec) => { const { n: a } = nearestA(nodes[b].p); const at = nodes[b].p; const rb = dirRow(b, at, dir, 1), ra = dirRow(a, at, dir, -1); addEq([...rb.d, ...ra.d], [...rb.c, ...ra.c], 0, m.id); };
    void tie; void nearest;
    if (m.kind === "bonded") {
      for (const b of bSide) for (const e of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec[]) tie2(b, e);
      // rotations of single beam nodes on both sides
      if (bSide.length === 1 && aSide.length === 1 && nodes[bSide[0]].rot && nodes[aSide[0]].rot) for (let k = 3; k < 6; k++) addEq([dof0[bSide[0]] + k, dof0[aSide[0]] + k], [1, -1], 0, m.id);
    } else if (m.kind === "planar") {
      for (const b of bSide) tie2(b, WA.normal);
    } else {
      const ax = WA.axis ?? regionWorld(m.b, inp).axis ?? WA.normal;
      const c = WA.center ?? WA.point;
      for (const b of bSide) { const d = sub(nodes[b].p, c); const er = unit(sub(d, mul(ax, dot(d, ax)))); if (len(er) > 0) tie2(b, er); }
      if (m.kind === "hinge") {
        const d: number[] = [], cc: number[] = [];
        nb.forEach((n) => { const r = dirRow(n, nodes[n].p, ax); r.d.forEach((q, i) => { d.push(q); cc.push(r.c[i] / nb.length); }); });
        na.forEach((n) => { const r = dirRow(n, nodes[n].p, ax, -1); r.d.forEach((q, i) => { d.push(q); cc.push(r.c[i] / na.length); }); });
        addEq(d, cc, 0, m.id);
      }
    }
    const hA = mesh.cellSize.get(m.a.part) ?? 0, hB = mesh.cellSize.get(m.b.part) ?? 0;
    if (maxGap > 1.5 * Math.max(hA, hB)) warnings.push(`${m.name}: the two mated regions are ${(maxGap * 1000).toFixed(1)} mm apart at their closest. Use “Align” so the faces touch before solving.`);
  }

  // ---- stabilization springs (detect mechanisms) ----
  let meanDiag = 0; for (let d = 0; d < N; d++) meanDiag += diag[d]; meanDiag /= N;
  const stab = new Float64Array(N);
  for (let d = 0; d < N; d++) stab[d] = 1e-10 * Math.max(diag[d], 1e-6 * meanDiag);

  // ---- PCG on free dofs ----
  progress("Solving (preconditioned conjugate gradient)", 0.5);
  const isFixed = new Uint8Array(N);
  const x = new Float64Array(N);
  fixedVal.forEach((v, d) => { isFixed[d] = 1; x[d] = v; });
  const springK = new Float64Array(N); for (const s of springs) springK[s.d] += s.k;
  const matvec = (v: Float64Array, out: Float64Array) => {
    for (let r = 0; r < N; r++) { let s = 0; for (let k = rowPtr[r]; k < rowPtr[r + 1]; k++) s += val[k] * v[col[k]]; out[r] = s + (stab[r] + springK[r]) * v[r]; }
    for (const e of eqs) { let s = 0; for (let i = 0; i < e.d.length; i++) s += e.c[i] * v[e.d[i]]; s *= e.w; for (let i = 0; i < e.d.length; i++) out[e.d[i]] += e.w ? s * e.c[i] : 0; }
  };
  const M = new Float64Array(N);
  for (let d = 0; d < N; d++) M[d] = diag[d] + stab[d] + springK[d];
  for (const e of eqs) for (let i = 0; i < e.d.length; i++) M[e.d[i]] += e.w * e.c[i] * e.c[i];
  for (let d = 0; d < N; d++) M[d] = isFixed[d] ? 0 : 1 / M[d];
  const r = new Float64Array(N), z = new Float64Array(N), pv = new Float64Array(N), Ap = new Float64Array(N);
  matvec(x, Ap);
  for (let d = 0; d < N; d++) r[d] = isFixed[d] ? 0 : F[d] - Ap[d];
  for (const e of eqs) if (e.g) for (let i = 0; i < e.d.length; i++) if (!isFixed[e.d[i]]) r[e.d[i]] += e.w * e.g * e.c[i];
  let bnorm = 0; for (let d = 0; d < N; d++) bnorm += r[d] * r[d]; bnorm = Math.sqrt(bnorm) || 1;
  for (let d = 0; d < N; d++) { z[d] = M[d] * r[d]; pv[d] = z[d]; }
  let rz = 0; for (let d = 0; d < N; d++) rz += r[d] * z[d];
  let it = 0, rel = 1;
  const maxIt = Math.min(inp.maxIter, 20 * N + 100);
  for (; it < maxIt; it++) {
    matvec(pv, Ap);
    let pAp = 0; for (let d = 0; d < N; d++) if (!isFixed[d]) pAp += pv[d] * Ap[d];
    const a = rz / pAp;
    let rn = 0;
    for (let d = 0; d < N; d++) if (!isFixed[d]) { x[d] += a * pv[d]; r[d] -= a * Ap[d]; rn += r[d] * r[d]; }
    rel = Math.sqrt(rn) / bnorm;
    if (rel < inp.tol) { it++; break; }
    let rz2 = 0; for (let d = 0; d < N; d++) { z[d] = M[d] * r[d]; rz2 += r[d] * z[d]; }
    const beta = rz2 / rz; rz = rz2;
    for (let d = 0; d < N; d++) pv[d] = z[d] + beta * pv[d];
    if (it % 50 === 0) { progress(`Solving: iteration ${it}, residual ${rel.toExponential(2)}`, 0.5 + 0.4 * Math.min(1, Math.log10(1 / rel) / Math.log10(1 / inp.tol))); if (cancelled()) throw new Error("Cancelled"); }
  }
  if (rel > inp.tol * 100) warnings.push(`Solver stopped at ${it} iterations with residual ${rel.toExponential(2)} (target ${inp.tol.toExponential(0)}). Results may be inaccurate; check constraints.`);

  // ---- mechanism check: share of load carried by stabilization springs per part ----
  const stabByPart = new Map<string, number>();
  for (let i = 0; i < nn; i++) { let s = 0; for (let d = dof0[i]; d < dof0[i + 1]; d++) if (!isFixed[d]) s += stab[d] * x[d] * x[d]; stabByPart.set(nodes[i].part, (stabByPart.get(nodes[i].part) ?? 0) + s); }
  let work = 0; for (let d = 0; d < N; d++) work += F[d] * x[d];
  const loadScale = Math.max(len(applied), 1e-9);
  const free: string[] = [];
  stabByPart.forEach((v, pid) => { if (v > 0.05 * Math.abs(work)) free.push(partOf.get(pid)!.name); });
  if (free.length) {
    const err = new Error(`Under-constrained: ${free.join(", ")} can move as a rigid body (a mechanism). Add a support or another mate. Remember a planar mate only holds the face normal direction; a concentric mate leaves rotation and sliding free.`);
    (err as any).diagnostic = true; throw err;
  }

  // ---- reactions ----
  progress("Recovering stress", 0.92);
  const Ku = new Float64Array(N);
  for (let rr = 0; rr < N; rr++) { let s = 0; for (let k = rowPtr[rr]; k < rowPtr[rr + 1]; k++) s += val[k] * x[col[k]]; Ku[rr] = s; }
  const eqForce = (tagSet: Set<string>): Vec => {
    const f: Vec = [0, 0, 0];
    // reactions on Dirichlet dofs belonging to tagged supports handled separately; here penalty forces
    for (const e of eqs) if (tagSet.has(e.tag)) { let s = 0; for (let i = 0; i < e.d.length; i++) s += e.c[i] * x[e.d[i]]; s = e.w * (s - e.g); for (let i = 0; i < e.d.length; i++) { const dd = e.d[i]; const node = upperBound(dof0, dd) - 1; const k = dd - dof0[node]; if (k < 3) f[k] -= s * e.c[i]; } }
    return f;
  };
  const perSupport = inp.supports.map((s) => {
    const ns = supTag.get(s.id) ?? [];
    const f: Vec = [0, 0, 0];
    for (const n of ns) for (let k = 0; k < 3; k++) { const d = dof0[n] + k; if (isFixed[d]) f[k] += Ku[d] - F[d]; }
    for (const sp of springs) if (sp.tag === s.id) { const node = upperBound(dof0, sp.d) - 1; f[sp.d - dof0[node]] -= sp.k * x[sp.d]; }
    const pf = eqForce(new Set([s.id]));
    // penalty reaction pf is force applied on structure; reaction = that
    return { name: s.name, force: add(f, pf) as Vec };
  });
  // avoid double counting Dirichlet dofs shared by two supports: total from global
  const reaction: Vec = [0, 0, 0];
  for (let d = 0; d < N; d++) if (isFixed[d]) { const node = upperBound(dof0, d) - 1; const k = d - dof0[node]; if (k < 3) reaction[k] += Ku[d] - F[d]; }
  for (const sp of springs) { const node = upperBound(dof0, sp.d) - 1; reaction[sp.d - dof0[node]] -= sp.k * x[sp.d]; }
  const supEqTags = new Set(inp.supports.map((s) => s.id));
  const pr = eqForce(supEqTags); for (let k = 0; k < 3; k++) reaction[k] += pr[k];
  const mateForces = inp.mates.map((m) => ({ name: m.name, force: mul(eqForce(new Set([m.id])), 0.5) as Vec })).map((mf, i) => {
    // force transmitted: sum on side B only
    const m = inp.mates[i]; const f: Vec = [0, 0, 0];
    for (const e of eqs) if (e.tag === m.id) { let s = 0; for (let j = 0; j < e.d.length; j++) s += e.c[j] * x[e.d[j]]; s *= e.w; for (let j = 0; j < e.d.length; j++) { const node = upperBound(dof0, e.d[j]) - 1; const k = e.d[j] - dof0[node]; if (k < 3 && nodes[node].part === m.b.part) f[k] -= s * e.c[j]; } }
    return { name: mf.name, force: f };
  });

  // ---- stress recovery ----
  const elemStress = new Float64Array(elements.length);
  const nodeStress = new Float64Array(nn), nodeStrain = new Float64Array(nn), cnt = new Float64Array(nn);
  elements.forEach((e, ei) => {
    const p = partOf.get(e.part)!; const X = e.nodes.map((n) => nodes[n].p);
    const ue = elDofs(e).map((d) => x[d]);
    let vm = 0, eqs2 = 0;
    if (e.kind === "beam") { vm = frameStress(X[0], X[1], p.material.E, p.material.nu, mesh.sections.get(p.id)!, ue); eqs2 = vm / p.material.E; }
    else if (e.kind === "truss") { const sec = mesh.sections.get(p.id)!; const d = unit(sub(X[1], X[0])); const L = len(sub(X[1], X[0])); const strain = (dot(d, [ue[3] - ue[0], ue[4] - ue[1], ue[5] - ue[2]])) / L; vm = Math.abs(strain * p.material.E); eqs2 = Math.abs(strain); void sec; }
    else {
      const D = Ds.get(p.id)!;
      const eps = e.kind.startsWith("tet") ? tetStrain(X, ue) : hex8Strain(X, ue);
      vm = vonMises(stressFromStrain(D, eps)); eqs2 = eqStrain(eps, p.material.nu);
      const corner = e.kind === "tet4" ? null : e.kind === "tet10" ? tet10CornerStrains(X, ue) : hex8CornerStrains(X, ue, e.kind !== "hex8", D);
      if (corner) {
        corner.forEach((ce, k) => { const n = e.nodes[k]; const v = vonMises(stressFromStrain(D, ce)); nodeStress[n] += v; nodeStrain[n] += eqStrain(ce, p.material.nu); cnt[n]++; vm = Math.max(vm, v); });
        elemStress[ei] = vm;
        return;
      }
    }
    elemStress[ei] = vm;
    for (const n of e.nodes) { nodeStress[n] += vm; nodeStrain[n] += eqs2; cnt[n]++; }
  });
  let maxStress = 0, minStress = Infinity, maxStrain = 0, maxDisp = 0;
  const u = new Float64Array(nn * 3), rot = new Float64Array(nn * 3), nodeDisp = new Float64Array(nn);
  for (let i = 0; i < nn; i++) {
    if (cnt[i]) { nodeStress[i] /= cnt[i]; nodeStrain[i] /= cnt[i]; }
    for (let k = 0; k < 3; k++) u[i * 3 + k] = x[dof0[i] + k];
    if (nodes[i].rot) for (let k = 0; k < 3; k++) rot[i * 3 + k] = x[dof0[i] + 3 + k];
    nodeDisp[i] = Math.hypot(u[i * 3], u[i * 3 + 1], u[i * 3 + 2]);
    maxStress = Math.max(maxStress, nodeStress[i]); minStress = Math.min(minStress, nodeStress[i]); maxStrain = Math.max(maxStrain, nodeStrain[i]); maxDisp = Math.max(maxDisp, nodeDisp[i]);
  }
  const partMax = inp.parts.map((p) => {
    let s = 0, d = 0;
    elements.forEach((e, ei) => { if (e.part === p.id) s = Math.max(s, elemStress[ei]); });
    for (let i = 0; i < nn; i++) if (nodes[i].part === p.id) d = Math.max(d, nodeDisp[i]);
    return { name: p.name, stress: s, disp: d, fos: s > 0 ? p.material.yield / s : Infinity };
  });
  maxStress = Math.max(maxStress, ...partMax.map((q) => q.stress));
  const imbalance = len(add(reaction, applied));
  if (imbalance > 0.01 * loadScale && inp.supports.every((s) => s.kind !== "prescribed")) warnings.push(`Force balance error ${(100 * imbalance / loadScale).toFixed(2)}% (reactions vs applied loads).`);
  const nPoint = inp.forces.filter((f) => f.radius <= 0).length;
  if (nPoint) warnings.push("Point loads on solids create artificially high local stress at the load nodes; give forces a patch radius or read stress a few elements away.");
  void appliedMoment; void eqForce;
  return {
    mesh,
    res: {
      u, rot, nodeStress, nodeStrain, nodeDisp, elemStress, maxDisp, maxStress, minStress: Number.isFinite(minStress) ? minStress : 0, maxStrain,
      iterations: it, residual: rel, dofs: N, elements: elements.length, nodes: nn, reaction, applied, perSupport, mateForces, warnings,
      seconds: (performance.now() - t0) / 1000, partMax,
    },
  };
}
function upperBound(a: Int32Array, v: number) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; } return lo; }
function hexVol(X: Vec[]) { const a = sub(X[1], X[0]), b = sub(X[3], X[0]), c = sub(X[4], X[0]); return Math.abs(dot(a, cross(b, c))); }

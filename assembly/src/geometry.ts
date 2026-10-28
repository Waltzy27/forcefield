import { Vec, sub, cross, unit, dot, len, add, mul } from "./model";

export function parseOBJ(text: string): Float32Array {
  const v: number[] = [];
  const out: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      v.push(+p[1], +p[2], +p[3]);
    } else if (line.startsWith("f ")) {
      const idx = line.split(/\s+/).slice(1).map((t) => {
        const i = parseInt(t.split("/")[0], 10);
        return i < 0 ? v.length / 3 + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) for (const i of [idx[0], idx[k], idx[k + 1]]) {
        if (i < 0 || i * 3 + 2 >= v.length) throw new Error("OBJ face references a missing vertex.");
        out.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      }
    }
  }
  if (!out.length) throw new Error("No triangles found in OBJ file.");
  if (out.some((n) => !Number.isFinite(n))) throw new Error("OBJ contains non-numeric coordinates.");
  return new Float32Array(out);
}

export function parseSTL(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      if (!n) throw new Error("STL file has no triangles.");
      return out;
    }
  }
  const text = new TextDecoder().decode(buf);
  const out: number[] = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (!out.length || out.length % 9) throw new Error("Could not read STL: not a valid ASCII or binary STL.");
  return new Float32Array(out);
}

export function bbox(t: Float32Array) {
  const min: Vec = [Infinity, Infinity, Infinity], max: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], t[i + k]); max[k] = Math.max(max[k], t[i + k]); }
  return { min, max, size: sub(max, min) as Vec, center: mul(add(min, max), 0.5) };
}

export const triNormal = (t: Float32Array, i: number): Vec => {
  const a: Vec = [t[i * 9], t[i * 9 + 1], t[i * 9 + 2]];
  const b: Vec = [t[i * 9 + 3], t[i * 9 + 4], t[i * 9 + 5]];
  const c: Vec = [t[i * 9 + 6], t[i * 9 + 7], t[i * 9 + 8]];
  return unit(cross(sub(b, a), sub(c, a)));
};
export const triCenter = (t: Float32Array, i: number): Vec => [0, 1, 2].map((k) => (t[i * 9 + k] + t[i * 9 + 3 + k] + t[i * 9 + 6 + k]) / 3) as Vec;

/** Closed-mesh check: each welded edge should be shared by exactly two triangles. Returns fraction of open edges. */
export function adjacency(t: Float32Array) {
  const n = t.length / 9;
  const b = bbox(t);
  const q = Math.max(...b.size) * 1e-6 + 1e-12;
  const vid = new Map<string, number>();
  const tv = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const key = `${Math.round(t[i * 3] / q)},${Math.round(t[i * 3 + 1] / q)},${Math.round(t[i * 3 + 2] / q)}`;
    let id = vid.get(key);
    if (id === undefined) { id = vid.size; vid.set(key, id); }
    tv[i] = id;
  }
  const edges = new Map<string, number[]>();
  for (let i = 0; i < n; i++) for (let e = 0; e < 3; e++) {
    const a = tv[i * 3 + e], c = tv[i * 3 + ((e + 1) % 3)];
    if (a === c) continue;
    const k = a < c ? `${a}_${c}` : `${c}_${a}`;
    const l = edges.get(k); if (l) l.push(i); else edges.set(k, [i]);
  }
  const nb: number[][] = Array.from({ length: n }, () => []);
  let open = 0;
  edges.forEach((l) => { if (l.length !== 2) open++; for (const x of l) for (const y of l) if (x !== y) nb[x].push(y); });
  return { nb, openFraction: edges.size ? open / edges.size : 1 };
}

/** Flood select neighbours whose normal stays within `deg` of neighbour (smooth) or of seed (planar). */
export function floodSelect(t: Float32Array, nb: number[][], seed: number, mode: "planar" | "smooth"): number[] {
  const n0 = triNormal(t, seed);
  const c0 = triCenter(t, seed);
  const seen = new Set([seed]);
  const stack = [seed];
  const scale = Math.max(...bbox(t).size);
  while (stack.length) {
    const i = stack.pop()!;
    const ni = triNormal(t, i);
    for (const j of nb[i]) {
      if (seen.has(j)) continue;
      const nj = triNormal(t, j);
      const ok = mode === "planar"
        ? dot(nj, n0) > 0.996 && Math.abs(dot(sub(triCenter(t, j), c0), n0)) < scale * 1e-4
        : dot(nj, ni) > Math.cos((35 * Math.PI) / 180);
      if (ok) { seen.add(j); stack.push(j); }
    }
    if (seen.size > 200000) break;
  }
  return [...seen];
}

/** Fit cylinder to selected triangles: axis = least-variance direction of normals. */
export function fitCylinder(t: Float32Array, tris: number[]) {
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const pts: Vec[] = [];
  for (const i of tris) {
    const n = triNormal(t, i);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += n[a] * n[b];
    pts.push(triCenter(t, i));
  }
  const axis = smallestEigen(C);
  const [e1, e2] = perpBasis(axis);
  // algebraic circle fit in (e1,e2) plane
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const m = pts.length;
  let along = 0;
  for (const p of pts) {
    const x = dot(p, e1), y = dot(p, e2), z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; along += dot(p, axis);
  }
  const A = [sxx, sxy, sx, sxy, syy, sy, sx, sy, m];
  const rhs: Vec = [sxz, syz, sz];
  const s = solve3(A, rhs);
  const cx = s[0] / 2, cy = s[1] / 2;
  const r = Math.sqrt(Math.max(s[2] + cx * cx + cy * cy, 0));
  const center = add(add(mul(e1, cx), mul(e2, cy)), mul(axis, along / m));
  return { axis, center, radius: r };
}

function perpBasis(n: Vec): [Vec, Vec] { const t = unit(cross(n, Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0])); return [t, cross(n, t)]; }
export function solve3(A: number[], b: Vec): Vec {
  const d = det3(A);
  if (Math.abs(d) < 1e-30) return [0, 0, 0];
  const r: Vec = [0, 0, 0];
  for (let c = 0; c < 3; c++) { const M = A.slice(); for (let k = 0; k < 3; k++) M[k * 3 + c] = b[k]; r[c] = det3(M) / d; }
  return r;
}
export const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Symmetric 3x3 eigen via Jacobi; returns eigenvector with the smallest eigenvalue. */
export function smallestEigen(S: number[]): Vec { const { vals, vecs } = eigSym3(S); let k = 0; for (let i = 1; i < 3; i++) if (vals[i] < vals[k]) k = i; return vecs[k]; }
export function eigSym3(S: number[]) {
  const a = S.slice(); const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-14) continue;
      const th = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
      for (let k = 0; k < 3; k++) { const akp = a[k * 3 + p], akq = a[k * 3 + q]; a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p * 3 + k], aqk = a[q * 3 + k]; a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k * 3 + p], vkq = v[k * 3 + q]; v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq; }
    }
  }
  return { vals: [a[0], a[4], a[8]], vecs: [0, 1, 2].map((k) => unit([v[k], v[3 + k], v[6 + k]] as Vec)) };
}

/** Signed volume (for unit sanity / closed check). */
export function meshVolume(t: Float32Array) {
  let V = 0;
  for (let i = 0; i < t.length; i += 9) {
    const a: Vec = [t[i], t[i + 1], t[i + 2]], b: Vec = [t[i + 3], t[i + 4], t[i + 5]], c: Vec = [t[i + 6], t[i + 7], t[i + 8]];
    V += dot(a, cross(b, c)) / 6;
  }
  return V;
}
export { len };

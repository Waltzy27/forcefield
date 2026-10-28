// Element stiffness matrices. All return dense row-major Float64Array.
import { Vec, sub, cross, unit, dot, len } from "./model";

export function Dmat(E: number, nu: number): number[] {
  const c = E / ((1 + nu) * (1 - 2 * nu));
  const a = c * (1 - nu), b = c * nu, g = E / (2 * (1 + nu));
  return [a, b, b, 0, 0, 0, b, a, b, 0, 0, 0, b, b, a, 0, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, 0, g];
}

function inv3(J: number[]) {
  const d = J[0] * (J[4] * J[8] - J[5] * J[7]) - J[1] * (J[3] * J[8] - J[5] * J[6]) + J[2] * (J[3] * J[7] - J[4] * J[6]);
  const r = [
    J[4] * J[8] - J[5] * J[7], J[2] * J[7] - J[1] * J[8], J[1] * J[5] - J[2] * J[4],
    J[5] * J[6] - J[3] * J[8], J[0] * J[8] - J[2] * J[6], J[2] * J[3] - J[0] * J[5],
    J[3] * J[7] - J[4] * J[6], J[1] * J[6] - J[0] * J[7], J[0] * J[4] - J[1] * J[3],
  ].map((v) => v / d);
  return { inv: r, det: d };
}

/** Fill B (6 x 3n) from global shape derivatives dN (n x 3). */
function Bfrom(dN: number[][]): number[][] {
  const n = dN.length;
  const B = Array.from({ length: 6 }, () => new Array(3 * n).fill(0));
  for (let i = 0; i < n; i++) {
    const [x, y, z] = dN[i];
    B[0][3 * i] = x; B[1][3 * i + 1] = y; B[2][3 * i + 2] = z;
    B[3][3 * i] = y; B[3][3 * i + 1] = x;
    B[4][3 * i + 1] = z; B[4][3 * i + 2] = y;
    B[5][3 * i] = z; B[5][3 * i + 2] = x;
  }
  return B;
}
function addBtDB(K: Float64Array, B: number[][], D: number[], w: number, m: number) {
  const DB = Array.from({ length: 6 }, (_, i) => { const r = new Array(m).fill(0); for (let k = 0; k < 6; k++) { const d = D[i * 6 + k]; if (d) for (let j = 0; j < m; j++) r[j] += d * B[k][j]; } return r; });
  for (let i = 0; i < m; i++) for (let k = 0; k < 6; k++) { const b = B[k][i]; if (!b) continue; const bw = b * w; const row = DB[k]; for (let j = 0; j < m; j++) K[i * m + j] += bw * row[j]; }
}
function mulDB(D: number[], B: number[][], u: number[]): number[] {
  const eps = B.map((r) => r.reduce((s, v, j) => s + v * u[j], 0));
  return [0, 1, 2, 3, 4, 5].map((i) => eps.reduce((s, e, k) => s + D[i * 6 + k] * e, 0));
}
export function vonMises(s: number[]) {
  const [a, b, c, xy, yz, zx] = s;
  return Math.sqrt(0.5 * ((a - b) ** 2 + (b - c) ** 2 + (c - a) ** 2) + 3 * (xy * xy + yz * yz + zx * zx));
}
/** equivalent (von Mises) strain from engineering strain vector */
export function eqStrain(e: number[], nu: number) {
  const [a, b, c, xy, yz, zx] = e;
  return (1 / (1 + nu)) * Math.sqrt(0.5 * ((a - b) ** 2 + (b - c) ** 2 + (c - a) ** 2) + 0.75 * (xy * xy + yz * yz + zx * zx));
}

// ---------------- Hex8 ----------------
const HX = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const G2 = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];
function hexDeriv(X: Vec[], xi: number, et: number, ze: number) {
  const dn = HX.map(([a, b, c]) => [a * (1 + b * et) * (1 + c * ze) / 8, b * (1 + a * xi) * (1 + c * ze) / 8, c * (1 + a * xi) * (1 + b * et) / 8]);
  const J = new Array(9).fill(0);
  for (let i = 0; i < 8; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[r * 3 + c] += dn[i][r] * X[i][c];
  const { inv, det } = inv3(J);
  const dN = dn.map((d) => [0, 1, 2].map((c) => inv[c * 3] * d[0] + inv[c * 3 + 1] * d[1] + inv[c * 3 + 2] * d[2]));
  return { dN, det, inv };
}
export function hex8K(X: Vec[], D: number[]) {
  const K = new Float64Array(24 * 24);
  for (const a of G2) for (const b of G2) for (const c of G2) { const { dN, det } = hexDeriv(X, a, b, c); addBtDB(K, Bfrom(dN), D, Math.abs(det), 24); }
  return K;
}
export function hex8CornerStrains(X: Vec[], u: number[], incompatible: boolean, D: number[]): number[][] {
  let alpha: number[] | null = null;
  const c0 = hexDeriv(X, 0, 0, 0);
  if (incompatible) {
    const { Kci, Kii } = hex8iParts(X, D);
    const Ki = invN(Kii, 9);
    const f = new Array(9).fill(0);
    for (let j = 0; j < 9; j++) for (let i = 0; i < 24; i++) f[j] += Kci[i * 9 + j] * u[i];
    alpha = new Array(9).fill(0);
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) alpha[i] -= Ki[i * 9 + j] * f[j];
  }
  return HX.map(([a, b, c]) => {
    const { dN, det } = hexDeriv(X, a, b, c);
    const eps = Bfrom(dN).map((r) => r.reduce((s, v, j) => s + v * u[j], 0));
    if (alpha) {
      const dl = [[-2 * a, 0, 0], [0, -2 * b, 0], [0, 0, -2 * c]];
      const dI = dl.map((d) => [0, 1, 2].map((k) => (c0.inv[k * 3] * d[0] + c0.inv[k * 3 + 1] * d[1] + c0.inv[k * 3 + 2] * d[2]) * (c0.det / det)));
      const Bi = Bfrom(dI);
      for (let k = 0; k < 6; k++) for (let j = 0; j < 9; j++) eps[k] += Bi[k][j] * alpha[j];
    }
    return eps;
  });
}
export function tet10CornerStrains(X: Vec[], u: number[]): number[][] {
  return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]].map((L) => { const { dN } = tet10Deriv(X, L); return Bfrom(dN).map((r) => r.reduce((s, v, j) => s + v * u[j], 0)); });
}
export function hex8Strain(X: Vec[], u: number[]) { const { dN } = hexDeriv(X, 0, 0, 0); const B = Bfrom(dN); return B.map((r) => r.reduce((s, v, j) => s + v * u[j], 0)); }

// ---------------- Hex8 with incompatible modes (Wilson-Taylor) ----------------
function hex8iParts(X: Vec[], D: number[]) {
  const Kcc = new Float64Array(24 * 24), Kci = new Float64Array(24 * 9), Kii = new Float64Array(81);
  const c0 = hexDeriv(X, 0, 0, 0);
  for (const a of G2) for (const b of G2) for (const c of G2) {
    const { dN, det } = hexDeriv(X, a, b, c);
    const w = Math.abs(det);
    const Bc = Bfrom(dN);
    // incompatible modes derivatives using centroid Jacobian, scaled det0/det (Taylor)
    const dl = [[-2 * a, 0, 0], [0, -2 * b, 0], [0, 0, -2 * c]];
    const dI = dl.map((d) => [0, 1, 2].map((k) => (c0.inv[k * 3] * d[0] + c0.inv[k * 3 + 1] * d[1] + c0.inv[k * 3 + 2] * d[2]) * (c0.det / det)));
    const Bi = Bfrom(dI);
    const DBc = Array.from({ length: 6 }, (_, i) => Bc[0].map((_, j) => { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * Bc[k][j]; return s; }));
    const DBi = Array.from({ length: 6 }, (_, i) => Bi[0].map((_, j) => { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * Bi[k][j]; return s; }));
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += Bc[k][i] * DBc[k][j]; Kcc[i * 24 + j] += s * w; }
    for (let i = 0; i < 24; i++) for (let j = 0; j < 9; j++) { let s = 0; for (let k = 0; k < 6; k++) s += Bc[k][i] * DBi[k][j]; Kci[i * 9 + j] += s * w; }
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) { let s = 0; for (let k = 0; k < 6; k++) s += Bi[k][i] * DBi[k][j]; Kii[i * 9 + j] += s * w; }
  }
  return { Kcc, Kci, Kii };
}
function invN(A: Float64Array, n: number) {
  const M = Array.from({ length: n }, (_, i) => [...Array.from(A.slice(i * n, i * n + n)), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  const R = new Float64Array(n * n); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) R[i * n + j] = M[i][n + j]; return R;
}
export function hex8iK(X: Vec[], D: number[]) {
  const { Kcc, Kci, Kii } = hex8iParts(X, D);
  const Ki = invN(Kii, 9);
  const T = new Float64Array(24 * 9); // Kci * Kii^-1
  for (let i = 0; i < 24; i++) for (let j = 0; j < 9; j++) { let s = 0; for (let k = 0; k < 9; k++) s += Kci[i * 9 + k] * Ki[k * 9 + j]; T[i * 9 + j] = s; }
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 9; k++) s += T[i * 9 + k] * Kci[j * 9 + k]; Kcc[i * 24 + j] -= s; }
  return Kcc;
}

// ---------------- Tet4 / Tet10 ----------------
export function tet4B(X: Vec[]) {
  const J = [X[1][0] - X[0][0], X[1][1] - X[0][1], X[1][2] - X[0][2], X[2][0] - X[0][0], X[2][1] - X[0][1], X[2][2] - X[0][2], X[3][0] - X[0][0], X[3][1] - X[0][1], X[3][2] - X[0][2]];
  const { inv, det } = inv3(J);
  const dl = [[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const dN = dl.map((d) => [0, 1, 2].map((c) => inv[c * 3] * d[0] + inv[c * 3 + 1] * d[1] + inv[c * 3 + 2] * d[2]));
  return { B: Bfrom(dN), V: Math.abs(det) / 6 };
}
export function tet4K(X: Vec[], D: number[]) { const { B, V } = tet4B(X); const K = new Float64Array(144); addBtDB(K, B, D, V, 12); return K; }

function tet10Deriv(X: Vec[], L: number[]) {
  // natural coords r=L1,s=L2,t=L3 ; L0 = 1-r-s-t. Node order: 0..3 corners, 4:(0-1) 5:(1-2) 6:(0-2) 7:(0-3) 8:(1-3) 9:(2-3)
  const [l0, l1, l2, l3] = L;
  // dN/dL_i then chain: dL0/dr = -1 etc
  const dNdL: number[][] = [
    [4 * l0 - 1, 0, 0, 0], [0, 4 * l1 - 1, 0, 0], [0, 0, 4 * l2 - 1, 0], [0, 0, 0, 4 * l3 - 1],
    [4 * l1, 4 * l0, 0, 0], [0, 4 * l2, 4 * l1, 0], [4 * l2, 0, 4 * l0, 0], [4 * l3, 0, 0, 4 * l0], [0, 4 * l3, 0, 4 * l1], [0, 0, 4 * l3, 4 * l2],
  ];
  const dn = dNdL.map((d) => [d[1] - d[0], d[2] - d[0], d[3] - d[0]]);
  const J = new Array(9).fill(0);
  for (let i = 0; i < 10; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) J[r * 3 + c] += dn[i][r] * X[i][c];
  const { inv, det } = inv3(J);
  return { dN: dn.map((d) => [0, 1, 2].map((c) => inv[c * 3] * d[0] + inv[c * 3 + 1] * d[1] + inv[c * 3 + 2] * d[2])), det };
}
const TQ_a = 0.5854101966249685, TQ_b = 0.1381966011250105;
const TQ = [[TQ_a, TQ_b, TQ_b, TQ_b], [TQ_b, TQ_a, TQ_b, TQ_b], [TQ_b, TQ_b, TQ_a, TQ_b], [TQ_b, TQ_b, TQ_b, TQ_a]];
export function tet10K(X: Vec[], D: number[]) {
  const K = new Float64Array(900);
  for (const L of TQ) { const { dN, det } = tet10Deriv(X, L); addBtDB(K, Bfrom(dN), D, Math.abs(det) / 24, 30); }
  return K;
}
export function tetStrain(X: Vec[], u: number[]) {
  if (X.length === 4) { const { B } = tet4B(X); return B.map((r) => r.reduce((s, v, j) => s + v * u[j], 0)); }
  const { dN } = tet10Deriv(X, [0.25, 0.25, 0.25, 0.25]); const B = Bfrom(dN); return B.map((r) => r.reduce((s, v, j) => s + v * u[j], 0));
}
export function stressFromStrain(D: number[], e: number[]) { return [0, 1, 2, 3, 4, 5].map((i) => e.reduce((s, v, k) => s + D[i * 6 + k] * v, 0)); }
export { mulDB };

// ---------------- 3D frame / truss ----------------
export interface Section { A: number; Iy: number; Iz: number; J: number; cy: number; cz: number }
export function frameTransform(p1: Vec, p2: Vec): number[] {
  const ex = unit(sub(p2, p1));
  const ref: Vec = Math.abs(ex[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const ey = unit(cross(ref, ex));
  const ez = cross(ex, ey);
  return [...ex, ...ey, ...ez];
}
export function frameLocalK(L: number, E: number, G: number, s: Section) {
  const k = new Float64Array(144);
  const set = (i: number, j: number, v: number) => { k[i * 12 + j] += v; if (i !== j) k[j * 12 + i] += v; };
  const EA = (E * s.A) / L, GJ = (G * s.J) / L;
  set(0, 0, EA); set(6, 6, EA); set(0, 6, -EA);
  set(3, 3, GJ); set(9, 9, GJ); set(3, 9, -GJ);
  // bending in local xy plane (about z): dofs v=1,θz=5
  const z = (E * s.Iz) / L ** 3;
  set(1, 1, 12 * z); set(7, 7, 12 * z); set(1, 7, -12 * z);
  set(1, 5, 6 * L * z); set(1, 11, 6 * L * z); set(5, 7, -6 * L * z); set(7, 11, -6 * L * z);
  set(5, 5, 4 * L * L * z); set(11, 11, 4 * L * L * z); set(5, 11, 2 * L * L * z);
  // bending in local xz plane (about y): dofs w=2,θy=4
  const y = (E * s.Iy) / L ** 3;
  set(2, 2, 12 * y); set(8, 8, 12 * y); set(2, 8, -12 * y);
  set(2, 4, -6 * L * y); set(2, 10, -6 * L * y); set(4, 8, 6 * L * y); set(8, 10, 6 * L * y);
  set(4, 4, 4 * L * L * y); set(10, 10, 4 * L * L * y); set(4, 10, 2 * L * L * y);
  return k;
}
export function frameK(p1: Vec, p2: Vec, E: number, nu: number, s: Section) {
  const L = len(sub(p2, p1));
  const kl = frameLocalK(L, E, E / (2 * (1 + nu)), s);
  const R = frameTransform(p1, p2);
  // T = blockdiag(R,R,R,R); K = T^T kl T
  const T = new Float64Array(144);
  for (let b = 0; b < 4; b++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[(b * 3 + i) * 12 + b * 3 + j] = R[i * 3 + j];
  const tmp = new Float64Array(144), K = new Float64Array(144);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let a = 0; for (let m = 0; m < 12; m++) a += kl[i * 12 + m] * T[m * 12 + j]; tmp[i * 12 + j] = a; }
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { let a = 0; for (let m = 0; m < 12; m++) a += T[m * 12 + i] * tmp[m * 12 + j]; K[i * 12 + j] = a; }
  return { K, kl, T, L };
}
/** Max von Mises at element ends from global displacement vector (12). */
export function frameStress(p1: Vec, p2: Vec, E: number, nu: number, s: Section, ug: number[]) {
  const { kl, T } = frameK(p1, p2, E, nu, s);
  const ul = new Array(12).fill(0);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) ul[i] += T[i * 12 + j] * ug[j];
  const f = new Array(12).fill(0);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) f[i] += kl[i * 12 + j] * ul[j];
  let best = 0;
  for (const o of [0, 6]) {
    const N = f[o], Mx = f[o + 3], My = f[o + 4], Mz = f[o + 5], Vy = f[o + 1], Vz = f[o + 2];
    const sig = Math.abs(N) / s.A + (Math.abs(My) * s.cz) / s.Iy + (Math.abs(Mz) * s.cy) / s.Iz;
    const tau = (Math.abs(Mx) * Math.max(s.cy, s.cz)) / s.J + 1.5 * Math.hypot(Vy, Vz) / s.A;
    best = Math.max(best, Math.sqrt(sig * sig + 3 * tau * tau));
  }
  return best;
}
export function trussK(p1: Vec, p2: Vec, EA: number) {
  const d = sub(p2, p1); const L = len(d); const e = unit(d);
  const K = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const v = (EA / L) * e[i] * e[j]; K[i * 6 + j] = v; K[(i + 3) * 6 + j + 3] = v; K[i * 6 + j + 3] = -v; K[(i + 3) * 6 + j] = -v; }
  return { K, L, e };
}
export { dot };

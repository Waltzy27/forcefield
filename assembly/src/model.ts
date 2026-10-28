export type Vec = [number, number, number];
export type ElementKind = "tet4" | "tet10" | "hex8" | "hex8i" | "shell" | "beam" | "truss";
export type SupportKind = "fixed" | "pinned" | "roller" | "symmetry" | "spring" | "prescribed" | "bearing";
export type MateKind = "bonded" | "planar" | "concentric" | "hinge";
export type Units = "mm" | "cm" | "m" | "in";
export const UNIT_SCALE: Record<Units, number> = { mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254 };

export interface Material { name: string; E: number; nu: number; yield: number; uts: number; density: number }
export const MATERIALS: Material[] = [
  { name: "Steel A36", E: 200e9, nu: 0.26, yield: 250e6, uts: 400e6, density: 7850 },
  { name: "Aluminum 6061-T6", E: 68.9e9, nu: 0.33, yield: 276e6, uts: 310e6, density: 2700 },
  { name: "Stainless 304", E: 193e9, nu: 0.29, yield: 215e6, uts: 505e6, density: 8000 },
  { name: "Titanium Ti-6Al-4V", E: 113.8e9, nu: 0.342, yield: 880e6, uts: 950e6, density: 4430 },
  { name: "PLA", E: 3.5e9, nu: 0.35, yield: 50e6, uts: 65e6, density: 1240 },
  { name: "ABS", E: 2.3e9, nu: 0.35, yield: 40e6, uts: 44e6, density: 1050 },
];

export interface Refinement { id: string; center: Vec; radius: number; factor: number }
export interface Part {
  id: string; name: string; file: string; units: Units;
  /** triangle soup in part-local meters, 9 numbers per triangle */
  tris: Float32Array;
  raw: Float32Array; // as read from file (file units)
  material: Material;
  offset: Vec; rotation: Vec; // degrees XYZ
  element: ElementKind; size: number; // meters
  autoRefine: boolean; refinements: Refinement[];
  beamAxis: "auto" | 0 | 1 | 2;
  section: { A: number; Iy: number; Iz: number; J: number } | null; // null => from bbox
  color: string; visible: boolean; notes: string;
}

/** A selected region on a part: a point patch or flood-selected face, in world coords at time of pick. */
export interface Region {
  part: string; point: Vec; normal: Vec; scope: "patch" | "face" | "cylinder";
  radius: number; // patch radius (m)
  tris?: number[]; // triangle indices for face/cylinder scope
  axis?: Vec; center?: Vec; cylR?: number; // for cylinder
}
export interface Support { id: string; name: string; kind: SupportKind; region: Region; stiffness: number; disp: Vec }
export interface Force { id: string; name: string; part: string; point: Vec; dir: Vec; magnitude: number; radius: number }
export interface Mate { id: string; name: string; kind: MateKind; a: Region; b: Region }

export interface MeshNode { p: Vec; part: string; rot: boolean; boundary: boolean }
export interface MeshElement { nodes: number[]; part: string; kind: ElementKind }
export interface PartGrid { part: string; gx: number[]; gy: number[]; gz: number[]; nodeIndex: Int32Array; kind: ElementKind; beam?: { origin: Vec; axis: Vec; nodes: number[]; s: number[] } }

export interface Results {
  u: Float64Array; // per node 3 (translations), plus rotations stored separately
  rot: Float64Array;
  nodeStress: Float64Array; nodeStrain: Float64Array; nodeDisp: Float64Array;
  elemStress: Float64Array;
  maxDisp: number; maxStress: number; minStress: number; maxStrain: number;
  iterations: number; residual: number; dofs: number; elements: number; nodes: number;
  reaction: Vec; applied: Vec; perSupport: { name: string; force: Vec }[]; mateForces: { name: string; force: Vec }[];
  warnings: string[]; seconds: number; partMax: { name: string; stress: number; disp: number; fos: number }[];
}

export const uid = () => Math.random().toString(36).slice(2, 9);
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec): Vec => { const n = len(a); return n < 1e-15 ? [0, 0, 0] : mul(a, 1 / n); };
export function perp(n: Vec): [Vec, Vec] { const t = unit(cross(n, Math.abs(n[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0])); return [t, cross(n, t)]; }

export function rotMatrix(deg: Vec): number[] {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Rz*Ry*Rx (matches three.js Euler 'XYZ' = Rx then Ry then Rz applied... three uses R = Rx*Ry*Rz for XYZ)
  // three.js XYZ order: matrix = Rx * Ry * Rz
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return m3(m3(Rx, Ry), Rz);
}
export function m3(a: number[], b: number[]) { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return r; }
export const mv = (m: number[], v: Vec): Vec => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const mtv = (m: number[], v: Vec): Vec => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
export const toWorld = (p: Part, v: Vec): Vec => add(mv(rotMatrix(p.rotation), v), p.offset);
export const toLocal = (p: Part, v: Vec): Vec => mtv(rotMatrix(p.rotation), sub(v, p.offset));

export function fmt(n: number, unitStr = "", digits = 4) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return `0 ${unitStr}`.trim();
  const a = Math.abs(n);
  return `${a >= 1e-3 && a < 1e5 ? n.toPrecision(digits) : n.toExponential(digits - 1)} ${unitStr}`.trim();
}
const SI: [number, string][] = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]];
export function si(n: number, u: string) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return `0 ${u}`;
  const a = Math.abs(n);
  for (const [s, p] of SI) if (a >= s * 0.9999) return `${(n / s).toPrecision(4)} ${p}${u}`;
  return `${n.toExponential(3)} ${u}`;
}

export interface SolveInput { parts: Part[]; forces: Force[]; supports: Support[]; mates: Mate[]; gravity: boolean; tol: number; maxIter: number }

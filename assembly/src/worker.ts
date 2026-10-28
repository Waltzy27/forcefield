/// <reference lib="webworker" />
import { solve, buildMesh, Mesh } from "./fem";
import type { SolveInput } from "./model";

function meshLines(mesh: Mesh): Float32Array {
  // exposed faces for solids (hex faces or tet faces), segments for line elements
  const out: number[] = [];
  const faceCount = new Map<string, { n: number; ids: number[] }>();
  const HF = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const TF = [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]];
  for (const e of mesh.elements) {
    if (e.kind === "beam" || e.kind === "truss") { for (const n of e.nodes) out.push(...mesh.nodes[n].p); continue; }
    const fs = e.kind.startsWith("tet") ? TF : HF;
    for (const f of fs) {
      const ids = f.map((q) => e.nodes[q]);
      const key = [...ids].sort((a, b) => a - b).join("_");
      const c = faceCount.get(key); if (c) c.n++; else faceCount.set(key, { n: 1, ids });
    }
  }
  const seen = new Set<string>();
  faceCount.forEach(({ n, ids }) => {
    if (n !== 1) return;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push(...mesh.nodes[a].p, ...mesh.nodes[b].p);
    }
  });
  return new Float32Array(out);
}

function packMesh(mesh: Mesh) {
  return {
    nodeCount: mesh.nodes.length, elementCount: mesh.elements.length,
    nodePart: mesh.nodes.map((n) => n.part), nodePos: Float64Array.from(mesh.nodes.flatMap((n) => n.p)),
    grids: mesh.grids.map((g) => ({ ...g, nodeIndex: g.nodeIndex })),
    lines: meshLines(mesh), warnings: mesh.warnings,
    perPart: Object.fromEntries([...new Set(mesh.elements.map((e) => e.part))].map((p) => [p, { elements: mesh.elements.filter((e) => e.part === p).length, kind: mesh.elements.find((e) => e.part === p)!.kind, h: mesh.cellSize.get(p) }])),
  };
}
export type PackedMesh = ReturnType<typeof packMesh>;

self.onmessage = (ev: MessageEvent<{ type: "mesh" | "solve"; input: SolveInput }>) => {
  const { type, input } = ev.data;
  input.parts.forEach((p) => { p.tris = new Float32Array(p.tris); });
  const progress = (msg: string, frac: number) => (self as any).postMessage({ type: "progress", msg, frac });
  try {
    if (type === "mesh") {
      const mesh = buildMesh(input, progress);
      (self as any).postMessage({ type: "mesh", mesh: packMesh(mesh) });
    } else {
      const { mesh, res } = solve(input, progress);
      (self as any).postMessage({ type: "result", mesh: packMesh(mesh), res });
    }
  } catch (e) {
    (self as any).postMessage({ type: "error", message: (e as Error).message, diagnostic: !!(e as any).diagnostic });
  }
};

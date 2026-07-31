/**
 * Simplified Finite Element Method (FEM) engine for stress analysis.
 *
 * V4 — Direction-Sensitive Cantilever Model:
 *   - Face-based constraints (user clicks actual mesh faces to fix)
 *   - Point-based force application (exact XYZ coordinates)
 *   - Force direction ROTATES the neutral axis → different directions give different patterns
 *   - Proper cantilever deflection formula for displacement
 *   - Rank-based color normalization for rich gradients
 *
 * NOT suitable for precision engineering. For serious work, use SolidWorks/Ansys.
 */

import * as THREE from "three";

export interface ForceInput {
  id: string;
  magnitude: number;       // Newtons
  directionX: number;      // unit vector components
  directionY: number;
  directionZ: number;
  // Exact XYZ application point in model-local coordinates
  pointX: number;
  pointY: number;
  pointZ: number;
  label: string;
}

export interface MaterialProperties {
  youngsModulus: number;        // Pa (E)
  poissonsRatio: number;        // ν (0–0.5)
  tensileStrength: number;      // Pa (UTS)
  yieldStrength: number;        // Pa (σ_y)
  shearModulus: number;         // Pa (G) — auto-calculated if 0
  density: number;              // kg/m³
}

/**
 * Face-based constraint: stores indices of constrained triangles.
 * Each entry is [i0, i1, i2] — position-buffer vertex indices of one triangle.
 */
export interface FaceConstraint {
  faceIndices: number[];       // flat list of triangle vertex-indices that are fixed
}

export interface AnalysisResult {
  vertexStresses: Float32Array;
  vertexStrains: Float32Array;
  vertexDisplacements: Float32Array;
  maxStress: number;
  minStress: number;
  maxStrain: number;
  maxDisplacement: number;
  avgStress: number;
  reactionForce: THREE.Vector3;
  safetyFactorApprox: number;
}

export function computeShearModulus(E: number, nu: number): number {
  return E / (2 * (1 + nu));
}

/**
 * Compute the centroid of the constrained region.
 */
function getConstraintCentroid(
  positions: THREE.BufferAttribute,
  constrainedVerts: Set<number>
): THREE.Vector3 {
  if (constrainedVerts.size === 0) return new THREE.Vector3();
  let cx = 0, cy = 0, cz = 0;
  for (const idx of constrainedVerts) {
    cx += positions.getX(idx);
    cy += positions.getY(idx);
    cz += positions.getZ(idx);
  }
  const n = constrainedVerts.size;
  return new THREE.Vector3(cx / n, cy / n, cz / n);
}

/**
 * Compute average normal of constrained faces → constraint orientation.
 */
function getConstraintNormal(
  positions: THREE.BufferAttribute,
  faceIndices: number[]
): THREE.Vector3 {
  const normal = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

  for (let i = 0; i < faceIndices.length; i += 3) {
    a.fromBufferAttribute(positions, faceIndices[i]);
    b.fromBufferAttribute(positions, faceIndices[i + 1]);
    c.fromBufferAttribute(positions, faceIndices[i + 2]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    normal.add(n);
  }
  if (normal.length() < 1e-12) return new THREE.Vector3(0, 1, 0);
  return normal.normalize();
}

/**
 * Build an adjacency map: for each vertex, which vertices share an edge.
 */
function buildAdjacency(positions: THREE.BufferAttribute, index: THREE.BufferAttribute | null): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const addEdge = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  const count = index ? index.count : positions.count;
  for (let i = 0; i < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    addEdge(i0, i1);
    addEdge(i1, i2);
    addEdge(i2, i0);
  }
  return adj;
}

/**
 * Compute geodesic-like distance from source set via Dijkstra on mesh edges.
 * Returns a Float32Array of normalized distances [0=source, 1=farthest].
 */
function computeGeodesicDistance(
  positions: THREE.BufferAttribute,
  sourceVerts: Set<number>,
  adj: Map<number, Set<number>>
): Float32Array {
  const count = positions.count;
  const dist = new Float32Array(count).fill(Infinity);

  const pq: [number, number][] = [];
  for (const v of sourceVerts) {
    dist[v] = 0;
    pq.push([0, v]);
  }
  pq.sort((a, b) => a[0] - b[0]);

  while (pq.length > 0) {
    const [d, u] = pq.shift()!;
    if (d > dist[u]) continue;
    const neighbors = adj.get(u);
    if (!neighbors) continue;
    const ux = positions.getX(u), uy = positions.getY(u), uz = positions.getZ(u);
    for (const v of neighbors) {
      const vx = positions.getX(v), vy = positions.getY(v), vz = positions.getZ(v);
      const edgeLen = Math.sqrt((vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2);
      const newDist = d + edgeLen;
      if (newDist < dist[v]) {
        dist[v] = newDist;
        pq.push([newDist, v]);
        pq.sort((a, b) => a[0] - b[0]);
      }
    }
  }

  // Normalize to [0, 1]
  let maxDist = 0;
  for (let i = 0; i < count; i++) {
    if (isFinite(dist[i]) && dist[i] > maxDist) maxDist = dist[i];
  }
  if (maxDist > 0) {
    for (let i = 0; i < count; i++) {
      dist[i] = isFinite(dist[i]) ? dist[i] / maxDist : 1;
    }
  }
  return dist;
}

/**
 * Main stress analysis — V4 direction-sensitive cantilever model.
 *
 * For each force, a virtual "beam" runs from constraint center to force application point.
 * The force is decomposed into:
 *   - Axial component (along beam) → uniform tensile/compressive stress
 *   - Transverse component (perpendicular to beam) → bending that ROTATES the neutral axis
 *
 * The neutral axis orientation depends on FORCE DIRECTION, so changing direction
 * changes which vertices are on the tension/compression sides → different color patterns.
 *
 * Displacement uses cantilever beam deflection: δ(x) = Fx²(3L-x) / (6EI)
 */
export function runStressAnalysis(
  geometry: THREE.BufferGeometry,
  forces: ForceInput[],
  material: MaterialProperties,
  constraint: FaceConstraint
): AnalysisResult {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const count = positions.count;

  const E = material.youngsModulus;
  const nu = material.poissonsRatio;
  const G = material.shearModulus > 0 ? material.shearModulus : computeShearModulus(E, nu);

  // Build set of constrained vertices
  const constrainedVerts = new Set<number>(constraint.faceIndices);

  // Constraint centroid and normal
  const constraintCenter = getConstraintCentroid(positions, constrainedVerts);
  const constraintNormal = getConstraintNormal(positions, constraint.faceIndices);

  // Build adjacency and compute geodesic distances from constraint
  const adj = buildAdjacency(positions, index);
  const geodist = computeGeodesicDistance(positions, constrainedVerts, adj);

  // Bounding box for scale reference
  const box = new THREE.Box3();
  const tmpV = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    tmpV.fromBufferAttribute(positions, i);
    box.expandByPoint(tmpV);
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  const modelScale = size.length();

  // Estimate cross-sectional area
  let totalSurfaceArea = 0;
  const ta = new THREE.Vector3(), tb = new THREE.Vector3(), tc = new THREE.Vector3();
  const tab = new THREE.Vector3(), tac = new THREE.Vector3(), tcross = new THREE.Vector3();
  const triCount = index ? index.count : count;
  for (let i = 0; i < triCount; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    ta.fromBufferAttribute(positions, i0);
    tb.fromBufferAttribute(positions, i1);
    tc.fromBufferAttribute(positions, i2);
    tab.subVectors(tb, ta);
    tac.subVectors(tc, ta);
    tcross.crossVectors(tab, tac);
    totalSurfaceArea += tcross.length() * 0.5;
  }
  const avgCrossSection = totalSurfaceArea / 6;

  // Model centroid
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) {
    cx += positions.getX(i);
    cy += positions.getY(i);
    cz += positions.getZ(i);
  }
  const centroid = new THREE.Vector3(cx / count, cy / count, cz / count);

  // Approximate cross-section dimensions for I calculation
  const c_max = Math.max(size.x, size.y, size.z) * 0.5;

  const vertexStresses = new Float32Array(count);
  const vertexStrains = new Float32Array(count);
  const vertexDisplacements = new Float32Array(count);

  // Total force vector (for reaction)
  const totalForce = new THREE.Vector3();
  for (const f of forces) {
    const dir = new THREE.Vector3(f.directionX, f.directionY, f.directionZ).normalize();
    totalForce.addScaledVector(dir, f.magnitude);
  }
  const totalForceMag = totalForce.length();

  // Process each force
  for (let fi = 0; fi < forces.length; fi++) {
    const force = forces[fi];
    if (force.magnitude === 0) continue;
    const forceDir = new THREE.Vector3(force.directionX, force.directionY, force.directionZ);
    if (forceDir.length() < 1e-9) continue;
    forceDir.normalize();
    const F = force.magnitude;
    const appPt = new THREE.Vector3(force.pointX, force.pointY, force.pointZ);

    // ═══ BEAM AXIS ═══
    // Define virtual beam from constraint center to force application point.
    // This is the "span" of the cantilever.
    const beamVec = appPt.clone().sub(constraintCenter);
    const beamLength = Math.max(beamVec.length(), modelScale * 0.01);
    const beamAxis = beamVec.clone().normalize();

    // ═══ FORCE DECOMPOSITION ═══
    // Split force into axial (along beam) and transverse (perpendicular) components.
    const F_axial_mag = forceDir.dot(beamAxis) * F;
    const F_axial_vec = beamAxis.clone().multiplyScalar(F_axial_mag);
    const F_trans_vec = forceDir.clone().multiplyScalar(F).sub(F_axial_vec);
    const F_trans_mag = F_trans_vec.length();

    // Ensure minimum transverse component for visualization (even purely axial forces cause some bending)
    const F_trans_effective = Math.max(F_trans_mag, F * 0.15);

    // ═══ NEUTRAL AXIS DIRECTION ═══
    // The transverse force direction determines which way the beam bends.
    // This is the KEY direction-dependent quantity.
    const bendDir = F_trans_mag > 1e-9
      ? F_trans_vec.clone().normalize()
      : new THREE.Vector3(0, 1, 0); // fallback if purely axial

    // Second transverse direction (perpendicular to both beam axis and bend direction)
    const bendPerp = new THREE.Vector3().crossVectors(beamAxis, bendDir).normalize();

    // ═══ MOMENT OF INERTIA ═══
    // Compute I about the neutral axis in the bend direction.
    // I = Σ(y² × ΔA) where y is distance from neutral axis in bend direction.
    // Approximate using model geometry.
    let sumY2 = 0;
    for (let i = 0; i < count; i++) {
      const vPos = new THREE.Vector3().fromBufferAttribute(positions, i);
      const offset = vPos.clone().sub(centroid);
      const y = offset.dot(bendDir); // distance from neutral axis in bend direction
      sumY2 += y * y;
    }
    // Average y² × approximate cross-section area / vertex count = second moment approximation
    const avgY2 = sumY2 / count;
    const I_bend = avgCrossSection * avgY2; // Approximate I = A × avg(y²)
    const I_safe = Math.max(I_bend, avgCrossSection * modelScale * modelScale * 1e-6);

    // ═══ PER-VERTEX STRESS ═══
    for (let i = 0; i < count; i++) {
      const vx = positions.getX(i);
      const vy = positions.getY(i);
      const vz = positions.getZ(i);
      const vertex = new THREE.Vector3(vx, vy, vz);
      const vertexFromConstraint = vertex.clone().sub(constraintCenter);

      // Position along beam axis: 0 = at constraint, beamLength = at force point
      const alongBeam = vertexFromConstraint.dot(beamAxis);
      const t = Math.max(0, Math.min(alongBeam / beamLength, 1.5)); // allow overshoot

      // Geodesic distance from constraint (for smoothing near constraint)
      const d = geodist[i];

      // ═══ 1. BENDING STRESS (direction-dependent!) ═══
      // M(x) = F_trans × (L - x) — moment decreases from support to load point
      const x = t * beamLength;
      const M = F_trans_effective * Math.max(beamLength - x, 0);

      // y = signed distance from neutral axis IN THE BEND DIRECTION
      // This is where direction sensitivity comes from:
      // rotating the force rotates bendDir → different vertices get different y values
      const vertexOffset = vertex.clone().sub(centroid);
      const y_bend = vertexOffset.dot(bendDir);
      const z_bend = vertexOffset.dot(bendPerp);

      // Bending stress: σ_b = M × |y| / I
      // Use absolute value for Von Mises, but the PATTERN changes with bendDir rotation
      const sigma_bending = (M * Math.abs(y_bend)) / Math.max(I_safe, 1e-12);

      // ═══ 2. AXIAL STRESS ═══
      // σ_a = |F_axial| / A — uniform along beam
      const sigma_axial = Math.abs(F_axial_mag) / Math.max(avgCrossSection, 1e-9);

      // ═══ 3. SHEAR STRESS ═══
      // Transverse shear: τ = 1.5V/A × (1 - (y/c)²)
      // Parabolic: max at neutral axis (y=0), zero at outer fibers
      const normalizedY = Math.min(Math.abs(y_bend) / Math.max(c_max, 1e-9), 1);
      const parabolic = Math.max(0, 1.0 - normalizedY * normalizedY);
      const tau_shear = (1.5 * F_trans_effective / Math.max(avgCrossSection, 1e-9)) * parabolic;

      // ═══ 4. TORSIONAL STRESS (off-center loads) ═══
      // If the force doesn't pass through the centroid, it creates torsion
      const leverArm = appPt.clone().sub(centroid);
      const torqueVec = new THREE.Vector3().crossVectors(leverArm, forceDir.clone().multiplyScalar(F));
      const torqueMag = torqueVec.dot(beamAxis); // torsion about beam axis
      const r = Math.sqrt(y_bend * y_bend + z_bend * z_bend); // radial distance
      const J = 2 * I_safe; // polar moment (approx)
      const tau_torsion = Math.abs(torqueMag) * r / Math.max(J, 1e-12);

      // ═══ 5. STRESS CONCENTRATIONS ═══
      // Near force point: local stress amplification
      const distToForce = vertex.distanceTo(appPt) / Math.max(modelScale, 1e-9);
      const forceConc = 1.0 + 1.5 * Math.exp(-distToForce * distToForce * 10);

      // Near constraint: reaction stress amplification
      const constraintConc = 1.0 + 1.0 * Math.exp(-d * d * 10);

      // ═══ 6. VON MISES ═══
      const sigma_total = (sigma_axial + sigma_bending) * forceConc * constraintConc;
      const tau_total = Math.sqrt(tau_shear * tau_shear + tau_torsion * tau_torsion) * forceConc;
      const vonMises = Math.sqrt(sigma_total * sigma_total + 3 * tau_total * tau_total);

      vertexStresses[i] += isFinite(vonMises) ? vonMises : 0;

      // ═══ 7. CANTILEVER DISPLACEMENT ═══
      // δ(x) = F × x² × (3L - x) / (6EI) — standard cantilever formula
      const x_clamped = Math.max(0, Math.min(x, beamLength));
      const delta = (F_trans_effective * x_clamped * x_clamped * (3 * beamLength - x_clamped))
        / (6 * Math.max(E, 1e-9) * Math.max(I_safe, 1e-12));
      // Axial deformation: δ_axial = F×L / (EA)
      const delta_axial = (Math.abs(F_axial_mag) * x_clamped) / (Math.max(E, 1e-9) * Math.max(avgCrossSection, 1e-9));
      vertexDisplacements[i] += isFinite(delta + delta_axial) ? delta + delta_axial : 0;
    }
  }

  // Compute strains and apply constraint reaction
  for (let i = 0; i < count; i++) {
    if (constrainedVerts.has(i)) {
      // Reaction stress at the fixed face
      const reactionStress = totalForceMag / Math.max(avgCrossSection, 1e-9) * 1.5;
      vertexStresses[i] = Math.max(reactionStress, vertexStresses[i]);
      vertexDisplacements[i] = 0; // Fixed vertices don't move
    }
    vertexStrains[i] = vertexStresses[i] / Math.max(E, 1e-9);
  }

  // ═══ LAPLACIAN SMOOTHING ═══
  // 3 passes to smooth stress and displacement gradients
  for (let pass = 0; pass < 3; pass++) {
    const smoothedS = new Float32Array(count);
    const smoothedD = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const neighbors = adj.get(i);
      if (!neighbors || neighbors.size === 0) {
        smoothedS[i] = vertexStresses[i];
        smoothedD[i] = vertexDisplacements[i];
        continue;
      }
      let sumS = 0, sumD = 0;
      for (const n of neighbors) {
        sumS += vertexStresses[n];
        sumD += vertexDisplacements[n];
      }
      smoothedS[i] = 0.5 * vertexStresses[i] + 0.5 * (sumS / neighbors.size);
      smoothedD[i] = 0.5 * vertexDisplacements[i] + 0.5 * (sumD / neighbors.size);
    }
    for (let i = 0; i < count; i++) {
      vertexStresses[i] = smoothedS[i];
      vertexDisplacements[i] = smoothedD[i];
    }
  }

  // Update strains after smoothing
  for (let i = 0; i < count; i++) {
    vertexStrains[i] = vertexStresses[i] / Math.max(E, 1e-9);
  }

  // ═══ AGGREGATE STATS ═══
  let maxStress = 0, minStress = Infinity;
  let maxStrain = 0, maxDisplacement = 0;
  let sumStress = 0;
  let validCount = 0;
  for (let i = 0; i < count; i++) {
    let s = vertexStresses[i];
    if (!isFinite(s)) { s = 0; vertexStresses[i] = 0; }
    if (s > maxStress) maxStress = s;
    if (s < minStress) minStress = s;
    sumStress += s;
    validCount++;
    let sn = vertexStrains[i];
    if (!isFinite(sn)) { sn = 0; vertexStrains[i] = 0; }
    if (sn > maxStrain) maxStrain = sn;
    let disp = vertexDisplacements[i];
    if (!isFinite(disp)) { disp = 0; vertexDisplacements[i] = 0; }
    if (disp > maxDisplacement) maxDisplacement = disp;
  }
  const avgStress = validCount > 0 ? sumStress / validCount : 0;

  const safetyFactor = material.yieldStrength > 0 && maxStress > 0
    ? material.yieldStrength / maxStress
    : Infinity;

  return {
    vertexStresses,
    vertexStrains,
    vertexDisplacements,
    maxStress,
    minStress,
    maxStrain,
    maxDisplacement,
    avgStress,
    reactionForce: totalForce.clone().negate(),
    safetyFactorApprox: safetyFactor,
  };
}

/**
 * Map a normalized value [0,1] to classic blue→cyan→green→yellow→red gradient.
 */
export function stressToColor(normalizedValue: number): THREE.Color {
  const t = Math.max(0, Math.min(1, normalizedValue));

  let r: number, g: number, b: number;

  if (t < 0.25) {
    const s = t / 0.25;
    r = 0; g = s; b = 1;
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    r = 0; g = 1; b = 1 - s;
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    r = s; g = 1; b = 0;
  } else {
    const s = (t - 0.75) / 0.25;
    r = 1; g = 1 - s; b = 0;
  }
  return new THREE.Color(r, g, b);
}

/**
 * Apply stress colors to geometry vertex colors.
 * Uses rank-based normalization for rich gradients.
 */
export function applyStressColors(
  geometry: THREE.BufferGeometry,
  vertexStresses: Float32Array,
  minStress: number,
  maxStress: number,
  displayMode: "stress" | "strain" | "displacement",
  vertexStrains?: Float32Array,
  vertexDisplacements?: Float32Array,
): void {
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);

  let values: Float32Array;
  let minVal: number, maxVal: number;

  if (displayMode === "strain" && vertexStrains) {
    values = vertexStrains;
    minVal = 0; maxVal = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < minVal) minVal = values[i];
      if (values[i] > maxVal) maxVal = values[i];
    }
  } else if (displayMode === "displacement" && vertexDisplacements) {
    values = vertexDisplacements;
    minVal = 0; maxVal = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] < minVal) minVal = values[i];
      if (values[i] > maxVal) maxVal = values[i];
    }
  } else {
    values = vertexStresses;
    minVal = minStress;
    maxVal = maxStress;
  }

  // Rank-based normalization: map each vertex's value RANK to color.
  // This ensures an even distribution of blue→cyan→green→yellow→red across the model.
  const indices = new Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  indices.sort((a: number, b: number) => values[a] - values[b]);

  const rankNorm = new Float32Array(count);
  for (let rank = 0; rank < count; rank++) {
    rankNorm[indices[rank]] = count > 1 ? rank / (count - 1) : 0;
  }

  // Slight gamma correction to push more into warm colors
  const gamma = 0.75;

  for (let i = 0; i < count; i++) {
    const normalized = Math.pow(rankNorm[i], gamma);
    const color = stressToColor(normalized);
    colors[i * 3]     = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

export function formatStress(pa: number): string {
  if (pa >= 1e9) return `${(pa / 1e9).toFixed(3)} GPa`;
  if (pa >= 1e6) return `${(pa / 1e6).toFixed(3)} MPa`;
  if (pa >= 1e3) return `${(pa / 1e3).toFixed(3)} kPa`;
  return `${pa.toFixed(2)} Pa`;
}

export function formatStrain(e: number): string {
  if (e < 1e-6) return `${(e * 1e9).toFixed(3)} nε`;
  if (e < 1e-3) return `${(e * 1e6).toFixed(3)} με`;
  if (e < 1)    return `${(e * 1e3).toFixed(4)} mε`;
  return `${e.toFixed(6)} ε`;
}

export function formatDisplacement(m: number): string {
  if (m >= 1)    return `${m.toFixed(4)} m`;
  if (m >= 1e-2) return `${(m * 100).toFixed(4)} cm`;
  if (m >= 1e-3) return `${(m * 1000).toFixed(4)} mm`;
  if (m >= 1e-6) return `${(m * 1e6).toFixed(4)} μm`;
  return `${(m * 1e9).toFixed(4)} nm`;
}

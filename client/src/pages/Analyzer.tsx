import { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  runStressAnalysis,
  applyStressColors,
  formatStress,
  formatStrain,
  formatDisplacement,
  computeShearModulus,
  type ForceInput,
  type MaterialProperties,
  type FaceConstraint,
} from "@/lib/fem";
import {
  Upload, Play, RotateCcw, Eye, Layers, ArrowRight, Lock,
  Info, FileText, Trash2, Plus, MousePointer, Crosshair
} from "lucide-react";

const GRADIENT = "linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)";

// ─── Material presets ───────────────────────────────────────────────────────
const MATERIAL_PRESETS: Record<string, MaterialProperties> = {
  "Steel (A36)": {
    youngsModulus: 200e9, poissonsRatio: 0.26, tensileStrength: 400e6,
    yieldStrength: 250e6, shearModulus: 79.3e9, density: 7850,
  },
  "Aluminum 6061": {
    youngsModulus: 68.9e9, poissonsRatio: 0.33, tensileStrength: 310e6,
    yieldStrength: 276e6, shearModulus: 26e9, density: 2700,
  },
  "PLA Plastic": {
    youngsModulus: 3.5e9, poissonsRatio: 0.35, tensileStrength: 65e6,
    yieldStrength: 50e6, shearModulus: 1.3e9, density: 1240,
  },
  "Custom": {
    youngsModulus: 200e9, poissonsRatio: 0.3, tensileStrength: 500e6,
    yieldStrength: 300e6, shearModulus: 0, density: 7800,
  },
};

// ─── Interaction modes ───────────────────────────────────────────────────────
type InteractionMode = "orbit" | "select-constraint" | "pick-force-point";

function formatScientific(val: number, unit: string): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(3)} G${unit}`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(3)} M${unit}`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(3)} k${unit}`;
  return `${val.toFixed(3)} ${unit}`;
}

// ─── Face-flood selection ────────────────────────────────────────────────────
// When user clicks a triangle, flood-fill to all neighboring coplanar triangles
// to select an entire smooth face region.
function floodSelectCoplanarFaces(
  geometry: THREE.BufferGeometry,
  seedTriIndex: number,
  angleThreshold: number = 30 // degrees — wider for tessellated meshes
): number[] {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const idx = geometry.getIndex();
  const triCount = idx ? idx.count / 3 : positions.count / 3;

  // Get triangle vertex indices
  const getTriVerts = (tri: number): [number, number, number] => {
    if (idx) return [idx.getX(tri * 3), idx.getX(tri * 3 + 1), idx.getX(tri * 3 + 2)];
    return [tri * 3, tri * 3 + 1, tri * 3 + 2];
  };

  // Compute triangle normal
  const triNormal = (tri: number): THREE.Vector3 => {
    const [i0, i1, i2] = getTriVerts(tri);
    const a = new THREE.Vector3().fromBufferAttribute(positions, i0);
    const b = new THREE.Vector3().fromBufferAttribute(positions, i1);
    const c = new THREE.Vector3().fromBufferAttribute(positions, i2);
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    return new THREE.Vector3().crossVectors(ab, ac).normalize();
  };

  // Build triangle adjacency (shared edge → neighbors)
  const edgeToTris = new Map<string, number[]>();
  const edgeKey = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return `${lo}-${hi}`;
  };
  for (let t = 0; t < triCount; t++) {
    const [i0, i1, i2] = getTriVerts(t);
    for (const [ea, eb] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const key = edgeKey(ea, eb);
      if (!edgeToTris.has(key)) edgeToTris.set(key, []);
      edgeToTris.get(key)!.push(t);
    }
  }

  const seedNormal = triNormal(seedTriIndex);
  const cosThreshold = Math.cos((angleThreshold * Math.PI) / 180);

  const selected = new Set<number>();
  const queue: number[] = [seedTriIndex];
  selected.add(seedTriIndex);

  while (queue.length > 0) {
    const current = queue.pop()!;
    const [i0, i1, i2] = getTriVerts(current);
    // Check each edge's neighbor
    for (const [ea, eb] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const key = edgeKey(ea, eb);
      const neighbors = edgeToTris.get(key);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (selected.has(neighbor)) continue;
        const nNormal = triNormal(neighbor);
        if (nNormal.dot(seedNormal) >= cosThreshold) {
          selected.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  // Convert to flat vertex index list
  const vertIndices: number[] = [];
  for (const tri of selected) {
    const [i0, i1, i2] = getTriVerts(tri);
    vertIndices.push(i0, i1, i2);
  }
  return vertIndices;
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function Analyzer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelRef = useRef<THREE.Mesh | null>(null);
  const frameRef = useRef<number>(0);
  const arrowHelpersRef = useRef<THREE.Object3D[]>([]);
  const constraintHighlightRef = useRef<THREE.Mesh | null>(null);
  const forcePointMarkersRef = useRef<THREE.Object3D[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

  const { toast } = useToast();

  // State
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelName, setModelName] = useState("");
  const [analysisRun, setAnalysisRun] = useState(false);
  const [displayMode, setDisplayMode] = useState<"stress" | "strain" | "displacement">("stress");
  const [analysisResult, setAnalysisResult] = useState<ReturnType<typeof runStressAnalysis> | null>(null);

  const [selectedPreset, setSelectedPreset] = useState("Steel (A36)");
  const [material, setMaterial] = useState<MaterialProperties>(MATERIAL_PRESETS["Steel (A36)"]);
  const [autoShearModulus, setAutoShearModulus] = useState(true);

  const [forces, setForces] = useState<ForceInput[]>([{
    id: "f1", magnitude: 1000, directionX: 0, directionY: -1, directionZ: 0,
    pointX: 0, pointY: 0, pointZ: 0, label: "Force 1",
  }]);

  // Face-based constraint
  const [constraintFaceIndices, setConstraintFaceIndices] = useState<number[]>([]);
  const [constraintFaceCount, setConstraintFaceCount] = useState(0);

  const [thermalNotes, setThermalNotes] = useState("");
  const [showWireframe, setShowWireframe] = useState(false);

  // Interaction mode: orbit (default), select-constraint, pick-force-point
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("orbit");
  const [pickingForceId, setPickingForceId] = useState<string | null>(null);

  // ── Three.js setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mountRef.current) return;
    const w = mountRef.current.clientWidth;
    const h = mountRef.current.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x1a1a1a);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(5, 10, 7);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x8888ff, 0.4);
    dir2.position.set(-5, -3, -5);
    scene.add(dir2);
    scene.add(new THREE.GridHelper(20, 20, 0x333333, 0x222222));
    scene.add(new THREE.AxesHelper(2));
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 10000);
    camera.position.set(3, 3, 5);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!mountRef.current) return;
      const w2 = mountRef.current.clientWidth;
      const h2 = mountRef.current.clientHeight;
      renderer.setSize(w2, h2);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", handleResize);
      renderer.dispose();
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ── Enable/disable orbit based on mode ──────────────────────────────────────
  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.enabled = interactionMode === "orbit";
    }
  }, [interactionMode]);

  // ── Load OBJ ────────────────────────────────────────────────────────────────
  const loadOBJ = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const loader = new OBJLoader();
      let obj: THREE.Object3D;
      try {
        obj = loader.parse(text);
      } catch (err) {
        toast({ title: "Import Failed", description: "Could not parse OBJ file.", variant: "destructive" });
        return;
      }

      const scene = sceneRef.current!;
      if (modelRef.current) {
        scene.remove(modelRef.current);
        modelRef.current = null;
      }
      clearVisuals();

      const meshes: THREE.Mesh[] = [];
      obj.traverse((child) => { if (child instanceof THREE.Mesh) meshes.push(child); });

      if (meshes.length === 0) {
        toast({ title: "No Mesh Found", description: "The OBJ file contains no mesh data.", variant: "destructive" });
        return;
      }

      let mergedGeometry = meshes[0].geometry.clone();
      if (!mergedGeometry.getAttribute("normal")) mergedGeometry.computeVertexNormals();

      // Ensure we have an index buffer for face operations
      if (!mergedGeometry.getIndex()) {
        // Non-indexed: create trivial index
        const posCount = mergedGeometry.getAttribute("position").count;
        const indices = new Uint32Array(posCount);
        for (let i = 0; i < posCount; i++) indices[i] = i;
        mergedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
      }

      // Center and normalize scale
      mergedGeometry.computeBoundingBox();
      const box = mergedGeometry.boundingBox!;
      const center = new THREE.Vector3();
      box.getCenter(center);
      mergedGeometry.translate(-center.x, -center.y, -center.z);

      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0) {
        const scale = 2 / maxDim;
        mergedGeometry.scale(scale, scale, scale);
      }

      mergedGeometry.computeBoundingBox();
      mergedGeometry.computeVertexNormals();

      const mat = new THREE.MeshPhongMaterial({
        color: 0x888888, vertexColors: false, side: THREE.DoubleSide, shininess: 60,
      });

      const mesh = new THREE.Mesh(mergedGeometry, mat);
      scene.add(mesh);
      modelRef.current = mesh;

      const camBox = new THREE.Box3().setFromObject(mesh);
      const camSize = camBox.getSize(new THREE.Vector3());
      const camMax = Math.max(camSize.x, camSize.y, camSize.z);
      cameraRef.current!.position.set(camMax * 2, camMax * 1.5, camMax * 2.5);
      controlsRef.current!.target.set(0, 0, 0);
      controlsRef.current!.update();

      setModelLoaded(true);
      setModelName(file.name);
      setAnalysisRun(false);
      setAnalysisResult(null);
      setConstraintFaceIndices([]);
      setConstraintFaceCount(0);
      setInteractionMode("orbit");

      // Reset force points to model centroid
      mergedGeometry.computeBoundingBox();
      const newBox = mergedGeometry.boundingBox!;
      const newCenter = new THREE.Vector3();
      newBox.getCenter(newCenter);
      setForces(prev => prev.map(f => ({
        ...f, pointX: +newCenter.x.toFixed(3), pointY: +newBox.max.y.toFixed(3), pointZ: +newCenter.z.toFixed(3),
      })));

      toast({ title: "Model Loaded", description: `${file.name} imported successfully.` });
    };
    reader.readAsText(file);
  }, [toast]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadOBJ(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith(".obj")) loadOBJ(file);
    else toast({ title: "Invalid File", description: "Please drop an .obj file.", variant: "destructive" });
  };

  // ── Clear all visual helpers ────────────────────────────────────────────────
  const clearVisuals = useCallback(() => {
    if (!sceneRef.current) return;
    for (const a of arrowHelpersRef.current) sceneRef.current.remove(a);
    arrowHelpersRef.current = [];
    for (const m of forcePointMarkersRef.current) sceneRef.current.remove(m);
    forcePointMarkersRef.current = [];
    if (constraintHighlightRef.current) {
      sceneRef.current.remove(constraintHighlightRef.current);
      constraintHighlightRef.current = null;
    }
  }, []);

  // ── Draw force arrows and point markers ────────────────────────────────────
  const drawForceVisuals = useCallback(() => {
    if (!sceneRef.current || !modelRef.current) return;
    // Clear old
    for (const a of arrowHelpersRef.current) sceneRef.current.remove(a);
    arrowHelpersRef.current = [];
    for (const m of forcePointMarkersRef.current) sceneRef.current.remove(m);
    forcePointMarkersRef.current = [];

    const geo = modelRef.current.geometry;
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox!.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    forces.forEach((f, idx) => {
      if (f.magnitude === 0) return;
      const dir = new THREE.Vector3(f.directionX, f.directionY, f.directionZ);
      if (dir.length() < 1e-9) return;
      dir.normalize();

      const pt = new THREE.Vector3(f.pointX, f.pointY, f.pointZ);

      // Arrow from outside pointing toward the application point
      const arrowOrigin = pt.clone().addScaledVector(dir.clone().negate(), maxDim * 0.6);
      const arrowLen = maxDim * 0.5;
      const colors = [0xff4444, 0x44aaff];
      const arrow = new THREE.ArrowHelper(dir, arrowOrigin, arrowLen, colors[idx % 2], arrowLen * 0.2, arrowLen * 0.1);
      sceneRef.current!.add(arrow);
      arrowHelpersRef.current.push(arrow);

      // Small sphere at application point
      const sphereGeo = new THREE.SphereGeometry(maxDim * 0.025, 12, 8);
      const sphereMat = new THREE.MeshBasicMaterial({ color: colors[idx % 2] });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.copy(pt);
      sceneRef.current!.add(sphere);
      forcePointMarkersRef.current.push(sphere);
    });
  }, [forces]);

  useEffect(() => {
    if (modelLoaded) drawForceVisuals();
  }, [forces, modelLoaded, drawForceVisuals]);

  // ── Draw constraint highlight ──────────────────────────────────────────────
  const drawConstraintHighlight = useCallback(() => {
    if (!sceneRef.current || !modelRef.current) return;
    if (constraintHighlightRef.current) {
      sceneRef.current.remove(constraintHighlightRef.current);
      constraintHighlightRef.current = null;
    }
    if (constraintFaceIndices.length === 0) return;

    const geo = modelRef.current.geometry;
    const positions = geo.getAttribute("position") as THREE.BufferAttribute;

    // Build geometry from selected triangles
    const highlightPositions = new Float32Array(constraintFaceIndices.length * 3);
    for (let i = 0; i < constraintFaceIndices.length; i++) {
      const vi = constraintFaceIndices[i];
      highlightPositions[i * 3] = positions.getX(vi);
      highlightPositions[i * 3 + 1] = positions.getY(vi);
      highlightPositions[i * 3 + 2] = positions.getZ(vi);
    }

    const highlightGeo = new THREE.BufferGeometry();
    highlightGeo.setAttribute("position", new THREE.BufferAttribute(highlightPositions, 3));
    highlightGeo.computeVertexNormals();

    const highlightMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false,
    });

    const highlightMesh = new THREE.Mesh(highlightGeo, highlightMat);
    sceneRef.current.add(highlightMesh);
    constraintHighlightRef.current = highlightMesh;
  }, [constraintFaceIndices]);

  useEffect(() => {
    drawConstraintHighlight();
  }, [constraintFaceIndices, drawConstraintHighlight]);

  // ── Raycasting click handler ────────────────────────────────────────────────
  const handleViewportClick = useCallback((e: React.MouseEvent) => {
    if (interactionMode === "orbit" || !modelRef.current || !mountRef.current || !cameraRef.current) return;

    const rect = mountRef.current.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current);
    const intersects = raycasterRef.current.intersectObject(modelRef.current, false);

    if (intersects.length === 0) {
      toast({ title: "Miss", description: "Click directly on the model surface.", variant: "destructive" });
      return;
    }

    const hit = intersects[0];

    if (interactionMode === "select-constraint") {
      // Flood-fill coplanar faces from the clicked triangle
      const faceIndex = hit.faceIndex;
      if (faceIndex === undefined || faceIndex === null) return;

      const geo = modelRef.current.geometry;
      const selectedVertIndices = floodSelectCoplanarFaces(geo, faceIndex, 20);
      const uniqueTris = selectedVertIndices.length / 3;

      setConstraintFaceIndices(selectedVertIndices);
      setConstraintFaceCount(uniqueTris);
      setInteractionMode("orbit");

      toast({ title: "Face Constrained", description: `${uniqueTris} triangles selected as fixed surface.` });

    } else if (interactionMode === "pick-force-point" && pickingForceId) {
      const pt = hit.point;
      setForces(prev => prev.map(f =>
        f.id === pickingForceId
          ? { ...f, pointX: +pt.x.toFixed(3), pointY: +pt.y.toFixed(3), pointZ: +pt.z.toFixed(3) }
          : f
      ));
      setInteractionMode("orbit");
      setPickingForceId(null);

      toast({ title: "Point Set", description: `(${pt.x.toFixed(3)}, ${pt.y.toFixed(3)}, ${pt.z.toFixed(3)})` });
    }
  }, [interactionMode, pickingForceId, toast]);

  // ── Wireframe toggle ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelRef.current) return;
    (modelRef.current.material as THREE.MeshPhongMaterial).wireframe = showWireframe;
  }, [showWireframe]);

  // ── Run analysis ──────────────────────────────────────────────────────────
  const runAnalysis = useCallback(() => {
    if (!modelRef.current) {
      toast({ title: "No Model", description: "Import an OBJ file first.", variant: "destructive" });
      return;
    }
    if (constraintFaceIndices.length === 0) {
      toast({ title: "No Constraint", description: "Select a constraint face first (click the lock button, then click a face on the model).", variant: "destructive" });
      return;
    }
    const validForces = forces.filter(f => f.magnitude > 0 &&
      (f.directionX !== 0 || f.directionY !== 0 || f.directionZ !== 0));
    if (validForces.length === 0) {
      toast({ title: "No Forces", description: "Add at least one force with non-zero magnitude and direction.", variant: "destructive" });
      return;
    }

    const geo = modelRef.current.geometry;
    const mat: MaterialProperties = {
      ...material,
      shearModulus: autoShearModulus ? 0 : material.shearModulus,
    };
    const constraint: FaceConstraint = { faceIndices: constraintFaceIndices };

    try {
      const result = runStressAnalysis(geo, validForces, mat, constraint);
      setAnalysisResult(result);
      setAnalysisRun(true);

      applyStressColors(geo, result.vertexStresses, result.minStress, result.maxStress, displayMode, result.vertexStrains, result.vertexDisplacements);

      const meshMat = modelRef.current.material as THREE.MeshPhongMaterial;
      meshMat.vertexColors = true;
      meshMat.color.set(0xffffff);
      meshMat.needsUpdate = true;

      drawForceVisuals();
      drawConstraintHighlight();

      toast({ title: "Analysis Complete", description: `Max stress: ${formatStress(result.maxStress)}` });
    } catch (err) {
      toast({ title: "Analysis Error", description: String(err), variant: "destructive" });
    }
  }, [material, autoShearModulus, forces, constraintFaceIndices, displayMode, toast, drawForceVisuals, drawConstraintHighlight]);

  // Update display when mode changes
  useEffect(() => {
    if (!analysisResult || !modelRef.current) return;
    const geo = modelRef.current.geometry;
    applyStressColors(geo, analysisResult.vertexStresses, analysisResult.minStress, analysisResult.maxStress, displayMode, analysisResult.vertexStrains, analysisResult.vertexDisplacements);
  }, [displayMode, analysisResult]);

  // Reset
  const resetView = useCallback(() => {
    if (!modelRef.current) return;
    const meshMat = modelRef.current.material as THREE.MeshPhongMaterial;
    meshMat.vertexColors = false;
    meshMat.color.set(0x888888);
    meshMat.needsUpdate = true;
    setAnalysisRun(false);
    setAnalysisResult(null);
    clearVisuals();
  }, [clearVisuals]);

  // ── Force management ──────────────────────────────────────────────────────
  const addForce = () => {
    if (forces.length >= 2) return;
    setForces(prev => [...prev, {
      id: `f${Date.now()}`, magnitude: 1000,
      directionX: 0, directionY: -1, directionZ: 0,
      pointX: 0, pointY: 0, pointZ: 0,
      label: `Force ${prev.length + 1}`,
    }]);
  };

  const removeForce = (id: string) => setForces(prev => prev.filter(f => f.id !== id));

  const updateForce = (id: string, field: keyof ForceInput, value: string | number) => {
    setForces(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
  };

  const applyPreset = (name: string) => {
    setSelectedPreset(name);
    const p = MATERIAL_PRESETS[name];
    if (p) { setMaterial(p); if (p.shearModulus > 0) setAutoShearModulus(false); }
  };

  const displayedG = autoShearModulus
    ? computeShearModulus(material.youngsModulus, material.poissonsRatio)
    : material.shearModulus;

  const getResultRange = () => {
    if (!analysisResult) return { minLabel: "0", maxLabel: "0", midLabel: "0" };
    let min: number, max: number;
    if (displayMode === "strain") { min = 0; max = analysisResult.maxStrain; }
    else if (displayMode === "displacement") { min = 0; max = analysisResult.maxDisplacement; }
    else { min = analysisResult.minStress; max = analysisResult.maxStress; }
    const mid = (min + max) / 2;
    const fmt = (v: number) => displayMode === "stress" ? formatStress(v) : displayMode === "strain" ? formatStrain(v) : formatDisplacement(v);
    return { minLabel: fmt(min), maxLabel: fmt(max), midLabel: fmt(mid) };
  };
  const legend = getResultRange();

  // Cursor style
  const cursorClass = interactionMode === "orbit" ? "" : "cursor-crosshair";

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden" data-testid="analyzer-root">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-label="ForceField logo">
            <rect width="28" height="28" rx="6" fill="#1d4ed8"/>
            <path d="M7 8h14M7 14h10M7 20h6" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            <circle cx="21" cy="20" r="3" fill="#ef4444"/>
          </svg>
          <span className="text-sm font-semibold tracking-wide text-zinc-100">ForceField</span>
          <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400 border-zinc-700">Hobbyist FEA</Badge>
          {modelName && (
            <Badge className="text-xs bg-blue-900/50 text-blue-300 border-blue-800 max-w-[180px] truncate">{modelName}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {interactionMode !== "orbit" && (
            <Badge className="text-xs bg-amber-900/60 text-amber-300 border-amber-700 animate-pulse">
              {interactionMode === "select-constraint" ? "Click a face to fix" : "Click a point for force"}
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={() => setShowWireframe(v => !v)}
            className={`text-xs gap-1 ${showWireframe ? "text-blue-400 bg-blue-950/40" : "text-zinc-400"}`}
            data-testid="btn-wireframe">
            <Layers className="w-3.5 h-3.5" /> Wireframe
          </Button>
          <Button variant="ghost" size="sm" onClick={resetView} disabled={!analysisRun}
            className="text-xs gap-1 text-zinc-400" data-testid="btn-reset-view">
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </Button>
          <Button size="sm" onClick={runAnalysis} disabled={!modelLoaded}
            className="text-xs gap-1 bg-blue-600 hover:bg-blue-700 text-white" data-testid="btn-run-analysis">
            <Play className="w-3.5 h-3.5" /> Run Analysis
          </Button>
        </div>
      </header>

      {/* ── Main layout ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel ──────────────────────────────────────────────── */}
        <aside className="w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col overflow-y-auto shrink-0">
          <div className="p-3 space-y-4">
            {/* Import */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Model Import</h2>
              <div className="border-2 border-dashed border-zinc-700 rounded-lg p-4 text-center cursor-pointer hover:border-blue-500 transition-colors"
                onClick={() => fileInputRef.current?.click()} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
                data-testid="drop-zone">
                <Upload className="w-6 h-6 mx-auto mb-1 text-zinc-500" />
                <p className="text-xs text-zinc-400">Drop .OBJ file here</p>
                <p className="text-xs text-zinc-600">or click to browse</p>
              </div>
              <input ref={fileInputRef} type="file" accept=".obj" onChange={handleFileInput} className="hidden" data-testid="file-input" />
            </section>

            <Separator className="bg-zinc-800" />

            {/* ── Constraint (face selection) ──────────────────────────── */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                <Lock className="w-3 h-3" /> Constraint (Fixed Face)
              </h2>
              <p className="text-xs text-zinc-600 mb-2 leading-relaxed">
                Click "Select Face" then click on the model surface you want to bolt/fasten. The entire smooth face region will be auto-selected.
              </p>
              <Button
                size="sm"
                variant={interactionMode === "select-constraint" ? "default" : "outline"}
                onClick={() => {
                  if (!modelLoaded) { toast({ title: "No Model", description: "Import a model first.", variant: "destructive" }); return; }
                  setInteractionMode(interactionMode === "select-constraint" ? "orbit" : "select-constraint");
                }}
                className={`w-full text-xs gap-1.5 mb-2 ${
                  interactionMode === "select-constraint" ? "bg-blue-600 text-white" : "border-zinc-700 text-zinc-300"
                }`}
                data-testid="btn-select-constraint">
                <MousePointer className="w-3.5 h-3.5" />
                {interactionMode === "select-constraint" ? "Click a face on model..." : "Select Face"}
              </Button>

              {constraintFaceCount > 0 && (
                <div className="bg-blue-950/40 border border-blue-800/60 rounded-lg p-2.5 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-blue-300 font-medium">Face selected</span>
                    <button onClick={() => { setConstraintFaceIndices([]); setConstraintFaceCount(0); }}
                      className="text-xs text-zinc-500 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                  </div>
                  <p className="text-xs text-zinc-500">{constraintFaceCount} triangles, {new Set(constraintFaceIndices).size} vertices</p>
                </div>
              )}
            </section>

            <Separator className="bg-zinc-800" />

            {/* ── Forces ───────────────────────────────────────────────── */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                  <ArrowRight className="w-3 h-3" /> Applied Forces
                </h2>
                {forces.length < 2 && (
                  <Button size="sm" variant="ghost" onClick={addForce} className="h-5 w-5 p-0 text-zinc-400 hover:text-blue-400" data-testid="btn-add-force">
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>

              <div className="space-y-3">
                {forces.map((force, idx) => (
                  <div key={force.id} className="bg-zinc-800/60 rounded-lg p-3 space-y-2" data-testid={`force-card-${idx}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2.5 h-2.5 rounded-full ${idx === 0 ? "bg-red-400" : "bg-blue-400"}`} />
                        <span className="text-xs font-medium text-zinc-200">{force.label}</span>
                      </div>
                      {forces.length > 1 && (
                        <button onClick={() => removeForce(force.id)} className="text-zinc-600 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                      )}
                    </div>

                    {/* Label */}
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500">Label</Label>
                      <Input value={force.label} onChange={(e) => updateForce(force.id, "label", e.target.value)}
                        className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200" />
                    </div>

                    {/* Magnitude */}
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500">Magnitude (N)</Label>
                      <Input type="number" value={force.magnitude}
                        onChange={(e) => updateForce(force.id, "magnitude", parseFloat(e.target.value) || 0)}
                        className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200" min={0} />
                    </div>

                    {/* Direction Vector */}
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-500">Direction Vector</Label>
                      <div className="grid grid-cols-3 gap-1">
                        {(["directionX", "directionY", "directionZ"] as const).map((axis) => (
                          <div key={axis} className="space-y-0.5">
                            <span className="text-xs text-zinc-600">{axis.slice(-1).toUpperCase()}</span>
                            <Input type="number" value={force[axis]}
                              onChange={(e) => updateForce(force.id, axis, parseFloat(e.target.value) || 0)}
                              className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200" step={0.1} />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-zinc-600">Auto-normalized</p>
                    </div>

                    {/* Application Point — XYZ coordinates + pick button */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-zinc-500">Application Point [X, Y, Z]</Label>
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => {
                            if (!modelLoaded) { toast({ title: "No Model", variant: "destructive" }); return; }
                            setPickingForceId(force.id);
                            setInteractionMode("pick-force-point");
                          }}
                          className={`h-5 px-1.5 text-xs gap-0.5 ${
                            interactionMode === "pick-force-point" && pickingForceId === force.id
                              ? "text-amber-400 bg-amber-950/40"
                              : "text-zinc-500 hover:text-blue-400"
                          }`}
                          data-testid={`btn-pick-point-${idx}`}
                        >
                          <Crosshair className="w-3 h-3" /> Pick
                        </Button>
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {(["pointX", "pointY", "pointZ"] as const).map((axis) => (
                          <div key={axis} className="space-y-0.5">
                            <span className="text-xs text-zinc-600">{axis.slice(-1).toUpperCase()}</span>
                            <Input type="number" value={force[axis]}
                              onChange={(e) => updateForce(force.id, axis, parseFloat(e.target.value) || 0)}
                              className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-200" step={0.001} />
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-zinc-600">Click "Pick" to choose on model, or type coordinates</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <Separator className="bg-zinc-800" />

            {/* Thermal Notes */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                <FileText className="w-3 h-3" /> Thermal / Environment Notes
              </h2>
              <Textarea value={thermalNotes} onChange={(e) => setThermalNotes(e.target.value)}
                placeholder="e.g., Operating temp: 250°C, thermal expansion not modeled..."
                className="text-xs bg-zinc-800 border-zinc-700 text-zinc-300 placeholder:text-zinc-600 resize-none h-20"
                data-testid="thermal-notes" />
              <p className="text-xs text-zinc-600 mt-1">Reference only — no thermal simulation.</p>
            </section>
          </div>
        </aside>

        {/* ── 3D Viewport ─────────────────────────────────────────────── */}
        <main className="flex-1 relative bg-zinc-950 overflow-hidden">
          <div ref={mountRef} className={`w-full h-full ${cursorClass}`}
            onClick={handleViewportClick} data-testid="viewport" />

          {!modelLoaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-xl bg-zinc-800 flex items-center justify-center mx-auto">
                  <Upload className="w-8 h-8 text-zinc-600" />
                </div>
                <p className="text-zinc-500 text-sm">Import an OBJ file to begin</p>
                <p className="text-zinc-700 text-xs">Use the panel on the left to drag & drop your model</p>
              </div>
            </div>
          )}

          {/* Color legend */}
          {analysisRun && analysisResult && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-zinc-900/90 backdrop-blur rounded-lg px-4 py-2 border border-zinc-700" data-testid="legend">
              <p className="text-xs text-zinc-400 mb-1.5 text-center capitalize">{displayMode} Distribution</p>
              <div className="relative">
                <div className="h-4 w-64 rounded" style={{ background: GRADIENT }} />
                <div className="flex justify-between mt-1">
                  <span className="text-xs text-blue-300">{legend.minLabel}</span>
                  <span className="text-xs text-yellow-300">{legend.midLabel}</span>
                  <span className="text-xs text-red-300">{legend.maxLabel}</span>
                </div>
              </div>
            </div>
          )}

          {/* Display mode tabs */}
          {analysisRun && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2">
              <div className="flex gap-1 bg-zinc-900/90 backdrop-blur rounded-lg p-1 border border-zinc-700">
                {(["stress", "strain", "displacement"] as const).map((mode) => (
                  <button key={mode} onClick={() => setDisplayMode(mode)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors capitalize ${
                      displayMode === mode ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                    }`} data-testid={`mode-${mode}`}>{mode}</button>
                ))}
              </div>
            </div>
          )}

          {/* Mode indicator overlay */}
          {interactionMode !== "orbit" && (
            <div className="absolute top-3 right-3 bg-amber-900/80 backdrop-blur text-amber-200 text-xs px-3 py-1.5 rounded-lg border border-amber-700 flex items-center gap-2">
              <Crosshair className="w-3.5 h-3.5" />
              {interactionMode === "select-constraint" ? "Click a face on the model to fasten it" : "Click on the model to set force point"}
              <button onClick={() => { setInteractionMode("orbit"); setPickingForceId(null); }}
                className="ml-1 text-amber-400 hover:text-white text-xs underline">Cancel</button>
            </div>
          )}

          {/* Controls hint */}
          <div className="absolute bottom-4 right-4 text-xs text-zinc-700 space-y-0.5">
            <p>Left drag: Rotate</p>
            <p>Right drag: Pan</p>
            <p>Scroll: Zoom</p>
          </div>
        </main>

        {/* ── Right panel ─────────────────────────────────────────────── */}
        <aside className="w-72 bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-y-auto shrink-0">
          <div className="p-3 space-y-4">
            {/* Material Properties */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Material Properties</h2>
              <div className="mb-3">
                <Label className="text-xs text-zinc-500 mb-1 block">Quick Preset</Label>
                <div className="grid grid-cols-2 gap-1">
                  {Object.keys(MATERIAL_PRESETS).map((name) => (
                    <button key={name} onClick={() => applyPreset(name)}
                      className={`text-xs px-2 py-1.5 rounded transition-colors ${
                        selectedPreset === name ? "bg-blue-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                      }`} data-testid={`preset-${name.replace(/\s+/g, "-")}`}>{name}</button>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Young's Modulus (E) <span className="text-zinc-600">Pa</span></Label>
                  <Input type="number" value={material.youngsModulus}
                    onChange={(e) => { setMaterial(m => ({ ...m, youngsModulus: parseFloat(e.target.value) || 0 })); setSelectedPreset("Custom"); }}
                    className="h-7 text-xs bg-zinc-800 border-zinc-700 text-zinc-200" data-testid="input-youngs" />
                  <p className="text-xs text-zinc-600">{formatScientific(material.youngsModulus, "Pa")}</p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Poisson's Ratio (ν) <span className="text-zinc-600">0–0.5</span></Label>
                  <div className="flex gap-2 items-center">
                    <Slider min={0} max={0.5} step={0.01} value={[material.poissonsRatio]}
                      onValueChange={([v]) => { setMaterial(m => ({ ...m, poissonsRatio: v })); setSelectedPreset("Custom"); }}
                      className="flex-1" />
                    <span className="text-xs text-zinc-300 w-10 text-right">{material.poissonsRatio.toFixed(2)}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-zinc-400">Shear Modulus (G) <span className="text-zinc-600">Pa</span></Label>
                    <button onClick={() => setAutoShearModulus(v => !v)}
                      className={`text-xs px-2 py-0.5 rounded ${autoShearModulus ? "bg-blue-800 text-blue-300" : "bg-zinc-700 text-zinc-400"}`}>
                      {autoShearModulus ? "Auto" : "Manual"}
                    </button>
                  </div>
                  {autoShearModulus ? (
                    <p className="text-xs text-zinc-500 bg-zinc-800/50 px-2 py-1 rounded">G = E/(2(1+ν)) = {formatScientific(displayedG, "Pa")}</p>
                  ) : (
                    <Input type="number" value={material.shearModulus}
                      onChange={(e) => setMaterial(m => ({ ...m, shearModulus: parseFloat(e.target.value) || 0 }))}
                      className="h-7 text-xs bg-zinc-800 border-zinc-700 text-zinc-200" />
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Tensile Strength (UTS) <span className="text-zinc-600">Pa</span></Label>
                  <Input type="number" value={material.tensileStrength}
                    onChange={(e) => { setMaterial(m => ({ ...m, tensileStrength: parseFloat(e.target.value) || 0 })); setSelectedPreset("Custom"); }}
                    className="h-7 text-xs bg-zinc-800 border-zinc-700 text-zinc-200" />
                  <p className="text-xs text-zinc-600">{formatScientific(material.tensileStrength, "Pa")}</p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Yield Strength (σ_y) <span className="text-zinc-600">Pa</span></Label>
                  <Input type="number" value={material.yieldStrength}
                    onChange={(e) => { setMaterial(m => ({ ...m, yieldStrength: parseFloat(e.target.value) || 0 })); setSelectedPreset("Custom"); }}
                    className="h-7 text-xs bg-zinc-800 border-zinc-700 text-zinc-200" />
                  <p className="text-xs text-zinc-600">{formatScientific(material.yieldStrength, "Pa")}</p>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-zinc-400">Density (ρ) <span className="text-zinc-600">kg/m³</span></Label>
                  <Input type="number" value={material.density}
                    onChange={(e) => { setMaterial(m => ({ ...m, density: parseFloat(e.target.value) || 0 })); setSelectedPreset("Custom"); }}
                    className="h-7 text-xs bg-zinc-800 border-zinc-700 text-zinc-200" />
                </div>
              </div>
            </section>

            <Separator className="bg-zinc-800" />

            {/* Results */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                <Eye className="w-3 h-3" /> Analysis Results
              </h2>
              {!analysisRun ? (
                <div className="text-center py-6 text-zinc-600">
                  <Info className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">Run analysis to see results</p>
                </div>
              ) : analysisResult ? (
                <div className="space-y-3">
                  <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
                    <h3 className="text-xs font-semibold text-zinc-300">Von Mises Stress</h3>
                    <ResultRow label="Maximum" value={formatStress(analysisResult.maxStress)} color="text-red-400" />
                    <ResultRow label="Average" value={formatStress(analysisResult.avgStress)} color="text-yellow-400" />
                    <ResultRow label="Minimum" value={formatStress(analysisResult.minStress)} color="text-blue-400" />
                  </div>
                  <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
                    <h3 className="text-xs font-semibold text-zinc-300">Strain</h3>
                    <ResultRow label="Max Strain (ε)" value={formatStrain(analysisResult.maxStrain)} color="text-orange-400" />
                  </div>
                  <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
                    <h3 className="text-xs font-semibold text-zinc-300">Displacement</h3>
                    <ResultRow label="Max Deform." value={formatDisplacement(analysisResult.maxDisplacement)} color="text-green-400" />
                  </div>
                  <div className="bg-zinc-800/60 rounded-lg p-3 space-y-2">
                    <h3 className="text-xs font-semibold text-zinc-300">Reaction Force</h3>
                    <ResultRow label="Rx" value={`${analysisResult.reactionForce.x.toFixed(1)} N`} />
                    <ResultRow label="Ry" value={`${analysisResult.reactionForce.y.toFixed(1)} N`} />
                    <ResultRow label="Rz" value={`${analysisResult.reactionForce.z.toFixed(1)} N`} />
                  </div>
                  {isFinite(analysisResult.safetyFactorApprox) && (
                    <div className="bg-zinc-800/60 rounded-lg p-3">
                      <h3 className="text-xs font-semibold text-zinc-300 mb-2">Safety Factor (σ_y / σ_max)</h3>
                      <div className="flex items-center justify-between">
                        <span className={`text-lg font-bold ${
                          analysisResult.safetyFactorApprox >= 2 ? "text-green-400"
                          : analysisResult.safetyFactorApprox >= 1 ? "text-yellow-400" : "text-red-400"
                        }`} data-testid="safety-factor">{analysisResult.safetyFactorApprox.toFixed(2)}×</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          analysisResult.safetyFactorApprox >= 2 ? "bg-green-900/40 text-green-400"
                          : analysisResult.safetyFactorApprox >= 1 ? "bg-yellow-900/40 text-yellow-400"
                          : "bg-red-900/40 text-red-400"
                        }`}>
                          {analysisResult.safetyFactorApprox >= 2 ? "Safe" : analysisResult.safetyFactorApprox >= 1 ? "Marginal" : "Exceeded"}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-600 mt-1">Based on your input values — verify material properties carefully.</p>
                    </div>
                  )}
                  <div className="bg-zinc-800/60 rounded-lg p-3">
                    <h3 className="text-xs font-semibold text-zinc-300 mb-2">Applied Forces</h3>
                    {forces.map((f) => (
                      <div key={f.id} className="flex justify-between text-xs mb-1">
                        <span className="text-zinc-500">{f.label}</span>
                        <span className="text-zinc-300">{f.magnitude.toLocaleString()} N</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            <div className="bg-amber-950/30 border border-amber-900/40 rounded-lg p-3">
              <div className="flex gap-2">
                <Info className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-600/80 leading-relaxed">
                  Simplified linear elastic approximation for hobbyist use. Not suitable for structural safety-critical applications.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ResultRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={`text-xs font-mono font-medium ${color || "text-zinc-200"}`}>{value}</span>
    </div>
  );
}

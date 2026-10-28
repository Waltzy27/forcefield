# ForceField — Hobbyist FEA Stress Analysis

A lightweight, fully offline desktop stress analysis tool for Linux. Import any `.OBJ` file, apply up to two forces at specific XYZ coordinates, fasten a face as a fixed constraint, set material properties, and visualize Von Mises stress, strain, and displacement with a classic blue-to-red gradient.

Built for makers, hobbyists, and engineering students — not a replacement for SolidWorks or ANSYS.

## Live apps

| Version | Link | What it is |
|---|---|---|
| **V2 — Assembly** (new) | **https://waltzy27.github.io/forcefield/v2/** | Multiple parts, mates, element types, constraint types, variable mesh refinement, deformed-shape view |
| **V1 — Classic** | https://waltzy27.github.io/forcefield/ | The original single-part OBJ app, unchanged |

The V1 source is also frozen at the git tag [`v1.0.0`](https://github.com/Waltzy27/forcefield/tree/v1.0.0).


---

## V2 — Assembly analysis

Everything runs locally in the browser (Web Worker solver). No uploads, no account.

### Workflow
1. **Project tab** — import one or more `.obj` / `.stl` (ASCII or binary) files. Choose the file's units (mm, cm, m, in) on import. Or click **Try sample assembly**.
2. **Part tabs** (one per part) — material preset or custom E, ν, yield, UTS, density; position offset and rotation; element type; element size; refinement zones; notes (e.g. heat applied — reference only, no thermal solve).
3. **Mates tab** — pick a face/hole on part A and one on part B, choose the mate type, optionally **Align** to snap B onto A.
4. **Loads & BCs tab** — up to **3 point forces** (each at an [X, Y, Z] point with its own direction and magnitude) and any number of supports (so two or more fixed faces/points are fine).
5. **Preview mesh**, then **Run analysis**. **Results tab** shows per-part peak stress/displacement, the load path (reactions and force carried by each mate), equilibrium check, and solver stats.

### Element types
| Element | Notes |
|---|---|
| Solid Hex (8-node) | Standard trilinear brick |
| Solid Hex, enhanced (8-node incompatible modes) | Recommended default for chunky parts; avoids shear locking in bending |
| Solid Tet (4-node) | Linear tetrahedron, stiff in bending; needs fine mesh |
| Solid Tet (10-node) | Quadratic tetrahedron, much more accurate than Tet4 |
| Shell (solid-shell) | One enhanced brick layer through the thinnest dimension — for plates/thin walls. Implemented as a solid-shell, not a classical Mindlin shell |
| Beam (3D frame) | Timoshenko-style 12-DOF frame along the part's long axis; section from bounding box (scaled by volume) or custom A, Iy, Iz, J |
| Truss / Rod | Axial-only 2-node element |

### Constraint types
| Constraint | Effect |
|---|---|
| Fixed | All translations held |
| Pinned | Region centroid held (ball joint); region free to rotate about it |
| Roller / Frictionless | Only the face-normal direction held; slides in-plane |
| Symmetry | Normal displacement zero on a symmetry plane |
| Spring / Elastic | Elastic foundation with user stiffness (N/m) |
| Prescribed displacement | Forces a known displacement vector |
| Bearing (cylindrical) | Hole/shaft held radially and axially; free to rotate about its axis |

### Mate types
| Mate | What it ties |
|---|---|
| Bonded | Faces glued — all directions transfer load |
| Planar (face–face contact) | Normal direction only; faces stay parallel but can slide in-plane — usually needs more mates/supports |
| Concentric (hole–pin) | Radial direction only; free to rotate and slide along the axis |
| Hinge | Radial + axial held; free to rotate about the axis |

If a mate set leaves a part free to move as a rigid body, the solver refuses to run and names the part, rather than showing meaningless results.

### Mesh refinement
Each part has a base element size. Add **refinement zones** (center, radius, factor) to use smaller elements near corners/holes/loads and larger ones elsewhere. **Auto-refine** also grades the mesh around loads, supports, mates, and concave edges. Mesh size is up to you — big meshes take longer and more memory.

### Deformed shape
Results views draw the model in its deformed shape. A slider scales the deformation (with **True scale** for 1:1) and an **Undeformed** ghost shows the original outline — a cantilever visibly bends.

### Exports
Project JSON (save/reopen a setup), node results CSV, PNG snapshot.

### Accuracy check (cantilever 1 × 0.1 × 0.1 m steel, 1000 N tip load, vs. beam theory)
| Element | Tip deflection / theory |
|---|---|
| Beam | 0.99 |
| Hex8 enhanced / Shell | 0.98 |
| Hex8 | 0.95 |
| Tet10 | 0.89 |
| Tet4 | 0.79 |

Reactions balance to < 0.1 % of applied load. The mesh is a graded voxel-style grid fitted inside the imported surface, so curved surfaces are stair-stepped; peak stresses at sharp corners and point loads are mesh-dependent. This is a learning/hobby tool, not a certified analysis code. Linear static, small-displacement, linear-elastic only; mates are linear (no separation or friction).

### Run V2 locally
```bash
npm ci
npm run build:v2          # outputs dist/v2
cd dist/v2 && python3 -m http.server 8080
# open http://localhost:8080
```
(It must be served over http — browsers block the solver worker on `file://`.) `bash build.sh` now builds both versions and `python3 launcher/forcefield.py` opens V2; add `--classic` for V1.

---

## V1 — Classic

### Features

- **OBJ file import** — drag and drop any `.OBJ` model
- **Face constraint selection** — click directly on the mesh to fasten a face
- **Force application** — up to 2 forces with magnitude (N), direction vector, and XYZ coordinate pick
- **Material properties** — Young's modulus, Poisson's ratio, shear modulus, tensile/yield strength, density; includes Steel (A36), Aluminum 6061, and PLA Plastic presets
- **Visualization modes** — Von Mises stress, strain, and displacement, all with full blue-to-red gradient
- **Safety factor** — computed from yield strength vs. peak stress
- **Thermal / environment notes** — reference text field (no thermal simulation)
- **100% offline** — no internet required, no account needed

---

## Requirements

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 18+ | `node --version` |
| npm | (bundled with Node) | `npm --version` |
| Python | 3.8+ | `python3 --version` |

**Install Node.js on Debian/Ubuntu/Pop!_OS:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Waltzy27/forcefield.git
cd forcefield

# 2. Build (installs dependencies, compiles, copies assets — ~1-2 minutes)
bash build.sh

# 3. Run
python3 launcher/forcefield.py
```

The app opens automatically in your default browser at `http://127.0.0.1:47832`. Press `Ctrl+C` in the terminal to quit.

---

## Install System-Wide (optional)

Adds ForceField to your app menu and lets you launch it by typing `forcefield` in any terminal:

```bash
bash build.sh           # build first if you haven't already
bash launcher/install.sh
```

To uninstall:
```bash
sudo rm -rf /opt/forcefield
sudo rm /usr/local/bin/forcefield
sudo rm /usr/share/applications/forcefield.desktop
```

---

## Build a Standalone Binary (no Python required to run)

Useful if you want to distribute the app to a machine without Python installed:

```bash
pip3 install pyinstaller
bash build.sh
bash launcher/build-executable.sh
# Result: launcher/dist/forcefield  (~20–30 MB single binary)
```

---

## How to Use

| Element | Description |
|---------|-------------|
| **Drop zone (left panel)** | Drag & drop any `.OBJ` file to import |
| **Select Face** | Click the button, then click a face on the model to fix it |
| **Forces** | Add up to 2 — set magnitude (N), direction vector, and XYZ application point |
| **Pick button** | Click on the model to pick a force application point interactively |
| **Material panel (right)** | E, ν, G, UTS, σ_y, density — quick presets included |
| **Thermal Notes** | Reference text only (no thermal simulation) |
| **Run Analysis** | Computes Von Mises stress, strain, and displacement |
| **Stress / Strain / Displacement** | Switch the color mode after analysis |
| **Wireframe** | Toggle mesh visibility |

### 3D Navigation
- **Left drag** — rotate
- **Right drag** — pan
- **Scroll** — zoom

---

## Physics Notes

Uses simplified linear elastic beam theory (not a full FEM solver):

- Axial stress: σ = F/A
- Bending stress: σ = Mc/I (direction-sensitive — neutral axis rotates with force direction)
- Shear stress: τ = VQ/(Ib)
- Combined via Von Mises: σ_VM = √(σ² + 3τ²)
- Strain: ε = σ/E
- Displacement: δ = Fx²(3L−x) / 6EI (cantilever deflection formula)

**Note:** OBJ files carry no unit information. The engine assumes model coordinates are in **meters**. If your model was authored in centimeters or millimeters, scale the force magnitude accordingly or the absolute values will be off (the relative color patterns will still be correct).

Results are estimates for relative comparison only. Not suitable for structural certification or safety-critical design.

---

## Project Structure

```
forcefield/
├── build.sh                  # One-shot build script
├── package.json              # Node.js project
├── client/                   # React + Three.js frontend
│   └── src/
│       ├── lib/fem.ts        # FEM engine (beam-axis model)
│       └── pages/Analyzer.tsx
├── server/                   # Express backend (session storage)
├── shared/                   # Shared schema (Drizzle ORM)
└── launcher/                 # Python native launcher
    ├── forcefield.py         # HTTP server + browser launcher
    ├── install.sh            # System-wide installer
    └── build-executable.sh  # PyInstaller binary builder
```

---

## License

MIT

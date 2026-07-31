# ForceField — Hobbyist FEA Stress Analysis

A lightweight, fully offline desktop stress analysis tool for Linux. Import any `.OBJ` file, apply up to two forces at specific XYZ coordinates, fasten a face as a fixed constraint, set material properties, and visualize Von Mises stress, strain, and displacement with a classic blue-to-red gradient.

Built for makers, hobbyists, and engineering students — not a replacement for SolidWorks or ANSYS.

LIVE APP --> waltzy27.github.io/forcefield 


---

## Features

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

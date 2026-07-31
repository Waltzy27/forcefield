# ForceField — Hobbyist FEA Stress Analysis

**Fully offline. No internet required. No account needed.**

Import any `.OBJ` file, apply forces, pick a constraint face, set material properties, and visualize stress/strain/displacement with a classic blue-to-red gradient. Built for makers, hobbyists, and students — not a replacement for SolidWorks or ANSYS.

---

## Quick Start (Python — no compile needed)

**Requirements:** Python 3.8 or newer (check with `python3 --version`)

```bash
# 1. Extract the zip anywhere you like
# 2. Run the launcher:
python3 forcefield.py

# The app opens in your default browser automatically.
# It's 100% local — nothing is sent anywhere.
```

---

## Install to your system (app menu + terminal command)

```bash
# Creates /opt/forcefield, symlinks to /usr/local/bin, adds to app menu:
bash install.sh

# After installing, just run:
forcefield
```

To uninstall:
```bash
sudo rm -rf /opt/forcefield
sudo rm /usr/local/bin/forcefield
sudo rm /usr/share/applications/forcefield.desktop
```

---

## Build a standalone binary (no Python needed to run)

If you want a single-file executable that works on any Linux machine without Python:

```bash
# Install PyInstaller (one time):
pip3 install pyinstaller

# Build:
bash build-executable.sh

# Result: dist/forcefield  (single binary, ~20–30 MB)
# Then run install.sh to install it system-wide.
```

---

## How to use

| Element | Description |
|---|---|
| **Drop zone (left panel)** | Drag & drop any `.OBJ` file to import |
| **Constraint face** | Which face is bolted/fixed to a surface |
| **Forces (up to 2)** | Magnitude (N), direction vector, application point |
| **Material panel (right)** | E, ν, G, UTS, σ_y, density — quick presets included |
| **Thermal notes** | Reference text only — no thermal simulation |
| **Run Analysis** | Computes Von Mises stress, strain, displacement |
| **Stress / Strain / Displacement** | Switch the color mode after analysis |
| **Wireframe** | Toggle mesh visibility |
| **Reset View** | Clear analysis colors |

### Controls
- **Left drag** — rotate
- **Right drag** — pan
- **Scroll** — zoom
- **Ctrl+C** in terminal — quit

---

## Physics notes

Uses simplified linear elastic theory (not a full FEM solver):
- Axial stress: σ = F/A
- Bending stress: σ = Mc/I  
- Shear stress: τ = VQ/(Ib)
- Combined via Von Mises: σ_VM = √(σ² + 3τ²)
- Strain: ε = σ/E
- Displacement: u = ε·L

Results are estimates for relative comparison only. Not for structural certification or safety-critical design.

---

## File structure

```
forcefield-native/
├── forcefield.py          # Main launcher (Python)
├── forcefield.spec        # PyInstaller build config
├── build-executable.sh    # Script to build binary
├── install.sh             # Linux system installer
├── forcefield.desktop     # App menu entry template
└── www/                   # Bundled web app (fully self-contained)
    ├── index.html
    ├── assets/
    │   ├── index-*.js     # All JS (Three.js, React, FEM engine)
    │   └── index-*.css
    └── fonts/
        ├── JetBrainsMono-Regular.ttf
        └── JetBrainsMono-Bold.ttf
```

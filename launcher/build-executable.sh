#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ForceField — Build Single-File Linux Executable
#
# Uses PyInstaller to bundle Python + all assets into one standalone binary.
# The result (dist/forcefield) runs on any Linux x86_64 without Python installed.
#
# Requirements:  pip install pyinstaller
# Run with:      bash build-executable.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "[ForceField Build] Checking PyInstaller..."
if ! python3 -c "import PyInstaller" 2>/dev/null; then
    echo "  Installing PyInstaller..."
    pip3 install pyinstaller --quiet
fi

echo "[ForceField Build] Building single-file executable..."
pyinstaller forcefield.spec \
    --clean \
    --noconfirm

if [ -f "dist/forcefield" ]; then
    SIZE=$(du -sh dist/forcefield | cut -f1)
    echo ""
    echo "╔═══════════════════════════════════════════╗"
    echo "║   Build successful!                       ║"
    echo "║   Output: dist/forcefield ($SIZE)           ║"
    echo "║                                           ║"
    echo "║   To install:                             ║"
    echo "║   Copy dist/forcefield + install.sh       ║"
    echo "║   then run: bash install.sh               ║"
    echo "╚═══════════════════════════════════════════╝"
else
    echo "Build failed — dist/forcefield not found."
    exit 1
fi

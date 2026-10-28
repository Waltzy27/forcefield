#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ForceField — One-shot build script
#
# Installs dependencies, compiles the web app, and copies the result into
# the launcher/www/ directory so the Python launcher can serve it offline.
#
# Requirements:
#   - Node.js 18+ and npm  (check: node --version)
#   - Python 3.8+          (check: python3 --version)
#
# Usage:
#   bash build.sh
#
# After building, run the app with:
#   python3 launcher/forcefield.py
#
# Or install system-wide (app menu + terminal command):
#   bash launcher/install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ForceField — Build Script              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Check dependencies ────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org (v18 or newer)."
    exit 1
fi

if ! command -v npm &>/dev/null; then
    echo "ERROR: npm not found. It should come with Node.js."
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python 3.8+ from https://python.org"
    exit 1
fi

NODE_VER=$(node --version)
PYTHON_VER=$(python3 --version)
echo "[1/3] Environment OK — Node $NODE_VER | $PYTHON_VER"
echo ""

# ── 2. Install npm dependencies ───────────────────────────────────────────────
echo "[2/3] Installing dependencies (npm install)..."
npm install
echo ""

# ── 3. Build the web app ─────────────────────────────────────────────────────
echo "[3/3] Building the web app (npm run build)..."
npm run build
echo "Building V2 (multi-part assembly)..."
npm run build:v2
echo ""

# ── 4. Copy built assets into the launcher ───────────────────────────────────
echo "Copying built assets to launcher/www/..."
rm -rf launcher/www
mkdir -p launcher/www
cp -r dist/public/* launcher/www/
mkdir -p launcher/www/v2
cp -r dist/v2/* launcher/www/v2/
echo ""

echo "╔══════════════════════════════════════════╗"
echo "║   Build complete!                        ║"
echo "║                                          ║"
echo "║   Run the app:                           ║"
echo "║     python3 launcher/forcefield.py       ║"
echo "║                                          ║"
echo "║   Or install system-wide:                ║"
echo "║     bash launcher/install.sh             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

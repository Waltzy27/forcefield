#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ForceField Installer for Linux
# Installs the app to /opt/forcefield and creates a .desktop launcher
# so it appears in your app menu and can be double-clicked or run from terminal.
#
# Run with:  bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

INSTALL_DIR="/opt/forcefield"
DESKTOP_FILE="/usr/share/applications/forcefield.desktop"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Detect run mode ──────────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/forcefield" ] && [ -x "$SCRIPT_DIR/forcefield" ]; then
    MODE="binary"
    echo "[ForceField] Found compiled binary — installing binary."
elif [ -f "$SCRIPT_DIR/forcefield.py" ]; then
    MODE="python"
    echo "[ForceField] No compiled binary found — installing Python launcher."
    # Check Python 3 is available
    if ! command -v python3 &>/dev/null; then
        echo "ERROR: python3 not found. Please install Python 3.8+."
        exit 1
    fi
    PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    echo "[ForceField] Using Python $PYTHON_VER"
else
    echo "ERROR: Neither forcefield binary nor forcefield.py found in $SCRIPT_DIR"
    exit 1
fi

# ── Require root for /opt and /usr/share ────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "This installer needs root to write to /opt and /usr/share/applications."
    echo "Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

# ── Install ──────────────────────────────────────────────────────────────────
echo "[ForceField] Creating $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# Copy www assets (always needed)
cp -r "$SCRIPT_DIR/www" "$INSTALL_DIR/"

# Copy icon if present
if [ -f "$SCRIPT_DIR/forcefield-icon.png" ]; then
    cp "$SCRIPT_DIR/forcefield-icon.png" "$INSTALL_DIR/"
fi

if [ "$MODE" = "binary" ]; then
    cp "$SCRIPT_DIR/forcefield" "$INSTALL_DIR/forcefield"
    chmod +x "$INSTALL_DIR/forcefield"
    EXEC_CMD="/opt/forcefield/forcefield"
else
    cp "$SCRIPT_DIR/forcefield.py" "$INSTALL_DIR/forcefield.py"
    chmod +x "$INSTALL_DIR/forcefield.py"
    EXEC_CMD="python3 /opt/forcefield/forcefield.py"

    # Create a thin shell wrapper so it can be run without typing python3
    cat > "$INSTALL_DIR/forcefield" << EOF2
#!/usr/bin/env bash
exec python3 /opt/forcefield/forcefield.py "\$@"
EOF2
    chmod +x "$INSTALL_DIR/forcefield"
fi

# Symlink to /usr/local/bin so it works from any terminal
ln -sf "$INSTALL_DIR/forcefield" /usr/local/bin/forcefield
echo "[ForceField] Symlinked to /usr/local/bin/forcefield"

# ── Desktop entry ────────────────────────────────────────────────────────────
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=ForceField
GenericName=Stress Analysis Tool
Comment=Hobbyist FEA — import OBJ files and run simplified stress analysis
Exec=$EXEC_CMD
Icon=/opt/forcefield/forcefield-icon.png
Terminal=false
Categories=Science;Engineering;Education;
Keywords=FEA;stress;strain;OBJ;engineering;mechanics;
StartupNotify=true
EOF

chmod 644 "$DESKTOP_FILE"
echo "[ForceField] Desktop entry written to $DESKTOP_FILE"

# Update desktop database if available
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database /usr/share/applications/ 2>/dev/null || true
fi

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║   ForceField installed successfully!      ║"
echo "║                                           ║"
echo "║   Run from terminal:  forcefield          ║"
echo "║   Or find it in your Applications menu.   ║"
echo "╚═══════════════════════════════════════════╝"

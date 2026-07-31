# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec file for ForceField
# Build with:  pyinstaller forcefield.spec

from PyInstaller.building.build_main import Analysis, PYZ, EXE, COLLECT

block_cipher = None

a = Analysis(
    ['forcefield.py'],
    pathex=['.'],
    binaries=[],
    # Bundle the entire www/ directory so the app works offline
    datas=[('www', 'www')],
    hiddenimports=[
        'http.server',
        'socketserver',
        'threading',
        'webbrowser',
        'signal',
        'socket',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'scipy',
        'PIL', 'cv2', 'pandas',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='forcefield',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # Single-file executable — no extracted folder needed
    onefile=True,
    console=True,   # Keep console for status messages / Ctrl+C
)

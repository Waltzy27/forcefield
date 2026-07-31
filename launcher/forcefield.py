#!/usr/bin/env python3
"""
ForceField — Hobbyist FEA Stress Analysis Tool
Launcher: starts a local HTTP server and opens the app in your default browser.

No internet connection required. All assets are bundled locally.

Usage:
  python3 forcefield.py          # normal launch
  python3 forcefield.py --port 8742  # use a custom port
"""

import sys
import os
import time
import socket
import threading
import argparse
import webbrowser
import signal
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


# ── Resolve the www directory ────────────────────────────────────────────────
# Works both when run as a plain .py file AND when packaged with PyInstaller.
if getattr(sys, "frozen", False):
    # Running inside a PyInstaller bundle
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).parent

WWW_DIR = BASE_DIR / "www"


# ── Custom request handler ────────────────────────────────────────────────────
class SilentHandler(SimpleHTTPRequestHandler):
    """Serves from WWW_DIR, suppresses console noise."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WWW_DIR), **kwargs)

    def log_message(self, fmt, *args):
        # Suppress access logs — this is a desktop app, not a server
        pass

    def log_error(self, fmt, *args):
        pass

    def end_headers(self):
        # Disable browser caching so restarts always serve fresh files
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        """Ensure correct MIME types for modern web assets."""
        p = str(path)
        if p.endswith(".js") or p.endswith(".mjs"):
            return "application/javascript"
        if p.endswith(".css"):
            return "text/css"
        if p.endswith(".woff2"):
            return "font/woff2"
        if p.endswith(".ttf"):
            return "font/ttf"
        if p.endswith(".html"):
            return "text/html"
        if p.endswith(".png"):
            return "image/png"
        if p.endswith(".svg"):
            return "image/svg+xml"
        # Fall back to parent implementation
        result = super().guess_type(path)
        if isinstance(result, tuple):
            return result[0] or "application/octet-stream"
        return result or "application/octet-stream"

    def do_GET(self):
        """Serve index.html for any unrecognized path (SPA routing)."""
        path = self.path.split("?")[0]
        target = WWW_DIR / path.lstrip("/")

        if not target.exists() or target.is_dir():
            # Fall back to index.html for client-side routing
            self.path = "/index.html"

        super().do_GET()


# ── Port utilities ────────────────────────────────────────────────────────────
def find_free_port(preferred: int = 47832) -> int:
    """Return preferred port if free, otherwise any available port."""
    for port in [preferred, 0]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
        except OSError:
            continue
    # Should never reach here since port=0 always works
    raise RuntimeError("Could not find a free port.")


def wait_for_server(port: int, timeout: float = 5.0) -> bool:
    """Poll until the server is accepting connections."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except (ConnectionRefusedError, OSError):
            time.sleep(0.05)
    return False


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="ForceField — Hobbyist FEA Launcher")
    parser.add_argument("--port", type=int, default=47832,
                        help="Port to serve on (default: 47832)")
    parser.add_argument("--no-browser", action="store_true",
                        help="Start server without opening browser")
    args = parser.parse_args()

    if not WWW_DIR.exists():
        print(f"[ForceField] ERROR: www/ directory not found at {WWW_DIR}")
        print("  Make sure the 'www' folder is next to forcefield.py")
        sys.exit(1)

    port = find_free_port(args.port)
    url = f"http://127.0.0.1:{port}"

    server = HTTPServer(("127.0.0.1", port), SilentHandler)

    # Run server in background thread so main thread can handle Ctrl+C
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    if not wait_for_server(port):
        print("[ForceField] ERROR: Server did not start in time.")
        sys.exit(1)

    print(f"""
╔══════════════════════════════════════════╗
║   ForceField — Hobbyist FEA             ║
║   Running at: {url:<27}║
║   Press Ctrl+C to quit                  ║
╚══════════════════════════════════════════╝
""")

    if not args.no_browser:
        webbrowser.open(url)

    # Block main thread, handle graceful Ctrl+C
    def shutdown(sig, frame):
        print("\n[ForceField] Shutting down...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    signal.pause()


if __name__ == "__main__":
    main()

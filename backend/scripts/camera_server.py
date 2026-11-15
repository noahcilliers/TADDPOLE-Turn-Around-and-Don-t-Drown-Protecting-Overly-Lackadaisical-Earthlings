"""Run on the laptop the webcam is plugged into: serves the current frame so the deployed
backend can run its camera water check.

    cd backend
    .venv/bin/python scripts/camera_server.py            # reads CAMERA + CAMERA_TOKEN from .env
    cloudflared tunnel --url http://localhost:8090       # in a 2nd terminal -> https://<random>.trycloudflare.com

Then on EC2 set CAMERA=https://<random>.trycloudflare.com/snapshot.jpg and the same CAMERA_TOKEN.

GET /snapshot.jpg   current frame (needs header X-Camera-Token: <CAMERA_TOKEN>)
GET /health         {"ok": true/false, "error": ...} (no token, no image)
Needs: pip install -r requirements-camera.txt
"""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # import app.* from backend/

log = logging.getLogger("camera_server")


def make_server(host: str, port: int, token: str, get_jpeg: Callable[[], bytes]) -> ThreadingHTTPServer:
    if not token:
        raise SystemExit("CAMERA_TOKEN is empty: refusing to put your webcam on the internet without one. "
                         "Set CAMERA_TOKEN in .env (e.g. python -c 'import secrets; print(secrets.token_urlsafe(24))').")

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj: dict) -> None:
            self._send(code, json.dumps(obj).encode(), "application/json")

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if path == "/health":
                try:
                    get_jpeg()
                    return self._json(200, {"ok": True})
                except Exception as e:
                    return self._json(503, {"ok": False, "error": str(e)})
            if path != "/snapshot.jpg":
                return self._json(404, {"error": "not found"})
            if not hmac.compare_digest(self.headers.get("X-Camera-Token", ""), token):
                return self._json(401, {"error": "bad or missing X-Camera-Token"})
            try:
                jpg = get_jpeg()
            except Exception as e:
                return self._json(503, {"error": str(e)})
            self._send(200, jpg, "image/jpeg")

        def log_message(self, fmt, *args):
            log.info("%s %s", self.address_string(), fmt % args)

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    from app.camera import Webcam, camera_source
    from app.config import get_settings

    cfg = get_settings()
    p = argparse.ArgumentParser()
    p.add_argument("--camera", default=cfg.camera, help="webcam number (default: CAMERA from .env)")
    p.add_argument("--host", default="127.0.0.1", help="127.0.0.1 = only reachable through the tunnel")
    p.add_argument("--port", type=int, default=8090)
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    source = camera_source(a.camera)
    if not isinstance(source, int):
        raise SystemExit(f"CAMERA={a.camera!r} is not a webcam number. On this laptop use e.g. CAMERA=1.")
    cam = Webcam(source)

    def get_jpeg() -> bytes:
        deadline = time.time() + 3
        while True:
            try:
                return cam.jpeg()
            except RuntimeError:
                if time.time() > deadline:
                    raise
                time.sleep(0.2)

    server = make_server(a.host, a.port, cfg.camera_token, get_jpeg)
    log.info("serving webcam %s on http://%s:%d/snapshot.jpg (needs X-Camera-Token)", source, a.host, a.port)
    log.info("now run:  cloudflared tunnel --url http://localhost:%d", a.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

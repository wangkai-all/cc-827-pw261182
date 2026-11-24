"""Dependency-free HTTP server for EchoSeq.

Run from the repository root:

    python3 -m app.server --host 127.0.0.1 --port 8765
"""

from __future__ import annotations

import argparse
import json
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlparse

from .service import event_inspection, make_synthetic, run_analysis

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "EchoSeq/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep test/terminal output concise.
        print(f"[server] {self.address_string()} - {fmt % args}")

    def _send_json(self, obj: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel: str) -> None:
        if rel in ("", "/"):
            path = WEB / "index.html"
        else:
            # Prevent path traversal.
            safe = rel.lstrip("/")
            path = (WEB / safe).resolve()
            if WEB.resolve() not in path.parents and path != WEB.resolve() / "index.html":
                self.send_error(403)
                return
        if not path.is_file():
            path = WEB / "index.html"
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self._send_json({"ok": True, "service": "echoseq", "version": "1.0.0"})
            return
        if path.startswith("/api/"):
            self._send_json({"ok": False, "error": "method not allowed"}, 405)
            return
        self._send_static(path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                self._send_json({"ok": False, "error": f"JSON 解析失败：{e}"}, 400)
                return
            if parsed.path == "/api/analyze":
                dataset = body.get("dataset")
                if not isinstance(dataset, dict):
                    self._send_json({"ok": False, "error": "缺少 dataset 对象"}, 400)
                    return
                result = run_analysis(dataset, body.get("options") or {})
                self._send_json(result)
                return
            if parsed.path == "/api/event":
                dataset = body.get("dataset")
                if not isinstance(dataset, dict) or not isinstance(body.get("fit"), dict):
                    self._send_json({"ok": False, "error": "event 接口需要 dataset 和 fit"}, 400)
                    return
                result = event_inspection(dataset, body)
                self._send_json({"ok": True, "event": result})
                return
            if parsed.path == "/api/synthetic":
                scenario = str(body.get("scenario", "self_excitation"))
                seed = int(body.get("seed", 11))
                self._send_json({"ok": True, "dataset": make_synthetic(scenario, seed)})
                return
            self._send_json({"ok": False, "error": "unknown endpoint"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._send_json({"ok": False, "error": str(e), "type": e.__class__.__name__}, 400)


def main() -> None:
    parser = argparse.ArgumentParser(description="EchoSeq event-sequence analysis server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"EchoSeq running at {url}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping EchoSeq.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

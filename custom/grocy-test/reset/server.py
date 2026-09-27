import hmac
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOCKET_PATH = os.environ["RESET_SOCKET"]
SECRET_FILE = os.environ["RESET_SECRET_FILE"]
MIN_INTERVAL = float(os.environ.get("RESET_MIN_INTERVAL", "30"))
HOST_TIMEOUT = 180

busy = threading.Lock()
last_started = 0.0


def read_secret():
    with open(SECRET_FILE) as f:
        return f.read().strip()


def run_host_reset():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(HOST_TIMEOUT)
        s.connect(SOCKET_PATH)
        s.sendall(b"reset\n")
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
    lines = b"".join(chunks).decode().strip().splitlines()
    if not lines:
        return {"ok": False, "error": "empty answer from host"}
    return json.loads(lines[-1])


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(405, {"ok": False, "error": "use POST"})

    def do_POST(self):
        global last_started
        if self.path.split("?")[0] != "/_reset":
            return self.reply(404, {"ok": False, "error": "not found"})
        try:
            expected = read_secret()
        except OSError:
            return self.reply(500, {"ok": False, "error": "secret not configured"})
        given = self.headers.get("X-Reset-Secret", "")
        if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
            return self.reply(401, {"ok": False, "error": "unauthorized"})
        if not busy.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "a reset is already running"})
        try:
            wait = last_started + MIN_INTERVAL - time.monotonic()
            if wait > 0:
                return self.reply(429, {"ok": False, "error": f"too soon, retry in {int(wait) + 1} s"})
            last_started = time.monotonic()
            try:
                result = run_host_reset()
            except Exception as exc:
                return self.reply(502, {"ok": False, "error": f"host reset failed: {exc}"})
            self.reply(200 if result.get("ok") else 500, result)
        finally:
            busy.release()

    def log_message(self, fmt, *args):
        print(f"{self.headers.get('X-Forwarded-For', self.client_address[0])} {fmt % args}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

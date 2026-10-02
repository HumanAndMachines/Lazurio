"""HTTP server of the App: one process, listener from the Launchpad.

Host and port come only from LAZURIO_RUNTIME_LISTENER_<ID>_HOST/_PORT through
lazurio-module-kit (Lazurio Module Standard 4.2); without them the App does
not start (exit 2). A foreign Host is refused with 403 and SIGTERM ends the
server with exit 0 (standard 4.4).
"""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import FrameType
from urllib.parse import urlsplit

from lazurio_module_kit import HealthResponse, ModuleKitError, health, listener

LISTENER = "{{listener_id}}"
HEALTH_PATH = "/healthz"
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_health = health(lambda: True)


async def _check_health() -> HealthResponse:
    return await _health()


def allowed_hosts(external_origin: str | None) -> frozenset[str]:
    """Loopback plus the hostname of a hosted listener; never a wildcard."""
    if external_origin is None:
        return LOOPBACK_HOSTS
    hostname = urlsplit(external_origin).hostname
    if hostname is None:
        return LOOPBACK_HOSTS
    return LOOPBACK_HOSTS | {hostname}


def host_allowed(header: str | None, hosts: frozenset[str]) -> bool:
    if not header:
        return False
    hostname = urlsplit(f"http://{header}").hostname
    return hostname is not None and hostname in hosts


def describe() -> dict[str, str]:
    return {
        "module": "{{slug}}",
        "organization": "{{organization}}",
        "title": "{{display_name}}",
    }


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], hosts: frozenset[str]) -> None:
        super().__init__(address, Handler)
        self.hosts = hosts


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        app_server = self.server
        hosts = app_server.hosts if isinstance(app_server, AppServer) else LOOPBACK_HOSTS
        if not host_allowed(self.headers.get("Host"), hosts):
            self._send(403, b"Forbidden host", "text/plain; charset=utf-8")
            return
        path = urlsplit(self.path).path
        if path == HEALTH_PATH:
            response = asyncio.run(_check_health())
            self._send(response.status, response.body, response.content_type)
        elif path == "/":
            self._send(200, json.dumps(describe()).encode(), "application/json")
        else:
            self._send(404, b'{"error":"not_found"}', "application/json")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write(f"{self.address_string()} {format % args}\n")


def main() -> None:
    try:
        app = listener(LISTENER)
    except ModuleKitError as error:
        print(f"Start through Lazurio lifecycle: {error}", file=sys.stderr)
        sys.exit(2)
    server = AppServer((app.host, app.port), allowed_hosts(app.external_origin))

    def stop(_signum: int, _frame: FrameType | None) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

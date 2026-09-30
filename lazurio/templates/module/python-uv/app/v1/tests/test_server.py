"""Start contract of the Lazurio Module Standard (kap. 4 and 7)."""

from __future__ import annotations

import http.client
import os
import signal
import socket
import subprocess
import sys
import time

from {{python_package}} import server

VARIABLE = "{{listener_env_prefix}}"


def _base_env() -> dict[str, str]:
    return {
        name: value for name, value in os.environ.items() if not name.startswith("LAZURIO_RUNTIME_")
    }


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _get(port: int, path: str, host: str | None = None) -> int:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path, headers={"Host": host or f"127.0.0.1:{port}"})
        return connection.getresponse().status
    finally:
        connection.close()


def test_describe_names_the_module() -> None:
    assert server.describe()["module"] == "{{slug}}"


def test_host_check_allows_loopback_and_the_hosted_origin_only() -> None:
    hosts = server.allowed_hosts("https://portal.example.invalid")
    assert server.host_allowed("127.0.0.1:4000", hosts)
    assert server.host_allowed("[::1]:4000", hosts)
    assert server.host_allowed("portal.example.invalid", hosts)
    assert not server.host_allowed("foreign.invalid", hosts)
    assert not server.host_allowed(None, hosts)


def test_refuses_to_start_without_the_listener_environment() -> None:
    run = subprocess.run(
        [sys.executable, "-m", "{{python_package}}.server"],
        env=_base_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert run.returncode == 2
    assert f"{VARIABLE}_HOST" in run.stderr


def test_health_foreign_host_and_sigterm() -> None:
    port = _free_port()
    env = {**_base_env(), f"{VARIABLE}_HOST": "127.0.0.1", f"{VARIABLE}_PORT": str(port)}
    process = subprocess.Popen([sys.executable, "-m", "{{python_package}}.server"], env=env)
    try:
        deadline = time.monotonic() + 30
        status = None
        while status is None and time.monotonic() < deadline:
            try:
                status = _get(port, "/healthz")
            except OSError:
                time.sleep(0.1)
        assert status == 200
        assert _get(port, "/healthz", host="foreign.invalid") == 403
    finally:
        process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=10) == 0

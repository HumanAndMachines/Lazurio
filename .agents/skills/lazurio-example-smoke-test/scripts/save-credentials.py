#!/usr/bin/env python3
"""Local one-time form (skill lazurio-example-smoke-test): the Operator pastes the
password and the GitHub 2FA key of Alena and Bob, the Example Organization's test
accounts, from the vault. The values go straight into the Organization-local custody
(manual/security/local-secret-custody.md), never to stdout, a log or the chat.
Serves 127.0.0.1 only, behind a random token, and exits after one successful save or
after the timeout. Env: TEST_ACCOUNT_FORM_ONLY=alena|bob (one account),
TEST_ACCOUNT_FORM_TIMEOUT_S (default 3600), TEST_ACCOUNT_FORM_ORG (Organization root).
"""
import base64, html, json, os, re, secrets, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlparse

ORG = os.environ.get("TEST_ACCOUNT_FORM_ORG") or os.path.expanduser("~/Lazurio/organizations/LazurioExampleOrganization_GEN3")
ACCOUNTS = {
    "alena": {"login": "lazurio-alena", "label": "Alena (Lazurio Example User)", "github_id": 343663580},
    "bob": {"login": "lazurio-bob", "label": "Bob (Lazurio Example Admin)", "github_id": 343656233},
}
if os.environ.get("TEST_ACCOUNT_FORM_ONLY"):
    ACCOUNTS = {k: v for k, v in ACCOUNTS.items() if k == os.environ["TEST_ACCOUNT_FORM_ONLY"]}
TOKEN = secrets.token_urlsafe(16)
TIMEOUT_S = int(os.environ.get("TEST_ACCOUNT_FORM_TIMEOUT_S", "3600"))


def custody_file(login: str) -> str:
    return os.path.join(ORG, "company/colleagues", login, "private/secrets/github", login, "login.json")


def totp_secret(raw: str) -> str:
    raw = raw.strip()
    if raw.lower().startswith("otpauth://"):
        query = parse_qs(urlparse(raw).query)
        raw = unquote(query.get("secret", [""])[0])
    key = re.sub(r"[\s-]", "", raw).upper()
    base64.b32decode(key + "=" * (-len(key) % 8))  # raises when it is not a 2FA key
    if len(key) < 16:
        raise ValueError("short")
    return key


PAGE = """<!doctype html><html lang="cs"><meta charset="utf-8">
<title>Testovací účty Example Organizace</title>
<style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1b1b1f}
h1{font-size:24px;margin:0 0 8px}p{color:#55565c;margin:0 0 24px}
fieldset{border:1px solid #e3e3e8;border-radius:12px;padding:16px 20px;margin:0 0 20px}
legend{font-weight:600;padding:0 6px}label{display:block;margin:10px 0 4px;font-size:14px;color:#55565c}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d0d0d7;border-radius:8px;font:inherit}
button{background:#1b1b1f;color:#fff;border:0;border-radius:8px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer}
.err{background:#fdecec;color:#8a1c1c;padding:12px 16px;border-radius:8px;margin:0 0 20px}
.ok{background:#eaf7ee;color:#1d5c2e;padding:16px 20px;border-radius:12px}
</style>
<body>@BODY@</body></html>"""

FORM = """<h1>Testovací účty Alena a Bob</h1>
<p>Z trezoru vložte heslo a klíč
pro dvoufázové ověření. Agenti se pak za Alenu a Boba přihlásí sami. Údaje se uloží
jen na tento Mac.</p>
%s
<form method="post">
%s
<button type="submit">Uložit</button>
</form>"""

FIELDSET = """<fieldset><legend>%s · %s</legend>
<label for="%s_password">Heslo</label>
<input id="%s_password" name="%s_password" type="password" autocomplete="off" required>
<label for="%s_totp">Klíč pro dvoufázové ověření (v trezoru pole „Klíč autentikátoru (TOTP)“)</label>
<input id="%s_totp" name="%s_totp" type="password" autocomplete="off" required>
</fieldset>"""


def form(error: str = "") -> bytes:
    sets = "".join(
        FIELDSET % (html.escape(a["label"]), a["login"], *([k] * 6)) for k, a in ACCOUNTS.items()
    )
    note = f'<div class="err">{html.escape(error)}</div>' if error else ""
    return PAGE.replace("@BODY@", FORM % (note, sets)).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):  # never log request lines or bodies
        pass

    def _send(self, body: bytes, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != f"/{TOKEN}":
            return self._send(b"Not found", 404)
        self._send(form())

    def do_POST(self):
        if self.path != f"/{TOKEN}":
            return self._send(b"Not found", 404)
        length = int(self.headers.get("Content-Length", "0"))
        fields = {k: v[0] for k, v in parse_qs(self.rfile.read(min(length, 65536)).decode()).items()}
        records = {}
        for key, account in ACCOUNTS.items():
            password = fields.get(f"{key}_password", "")
            if len(password) < 8:
                return self._send(form(f"Chybí heslo pro {account['label']}."))
            try:
                totp = totp_secret(fields.get(f"{key}_totp", ""))
            except Exception:
                return self._send(form(f"Klíč pro dvoufázové ověření u {account['label']} nevypadá správně. Zkopírujte celý klíč, ne šestimístný kód."))
            records[key] = {
                "schema": "lazurio-test-account-v1",
                "provider": "github",
                "login": account["login"],
                "github_id": account["github_id"],
                "label": account["label"],
                "password": password,
                "totp_secret": totp,
                "totp": {"algorithm": "SHA1", "digits": 6, "period": 30},
                "source": "Operator's vault, saved through save-credentials.py",
                "designated_by": "Operator, 2026-10-17: agents may use freely; nothing sensitive in these accounts",
            }
        for key, record in records.items():
            path = custody_file(record["login"])
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            d = os.path.dirname(path)
            while d.startswith(os.path.join(ORG, "company/colleagues")) and d != os.path.join(ORG, "company/colleagues"):
                os.chmod(d, 0o700)
                d = os.path.dirname(d)
            fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(record, f, indent=2)
                f.write("\n")
            os.replace(path + ".tmp", path)
        self._send(PAGE.replace("@BODY@", '<div class="ok"><h1>Uloženo</h1><p>Údaje Aleny a Boba jsou na tomto Macu. Tuto stránku můžete zavřít.</p></div>').encode())
        print("saved: " + ", ".join(custody_file(r["login"]) for r in records.values()), flush=True)
        threading.Thread(target=self.server.shutdown, daemon=True).start()


class Server(HTTPServer):
    def handle_error(self, request, client_address):  # no tracebacks: they could quote form input
        print("request failed", file=sys.stderr, flush=True)


def main():
    server = Server(("127.0.0.1", 0), Handler)
    print(f"FORM_URL=http://127.0.0.1:{server.server_port}/{TOKEN}", flush=True)
    threading.Timer(TIMEOUT_S, server.shutdown).start()
    server.serve_forever()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())

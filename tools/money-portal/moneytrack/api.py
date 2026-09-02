"""The HTTP layer: a tiny JSON API plus the static portal files.

Only the standard library is used, so this runs on a stock Raspberry Pi image
with no pip install and no build step.
"""

from __future__ import annotations

import datetime as dt
import hmac
import json
import mimetypes
import posixpath
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .config import Config
from .errors import ValidationError
from .gitsync import GitSync
from .ledger import Entry, Ledger, filter_entries, summarise

MAX_BODY = 64 * 1024
ALLOWED_STATIC_SUFFIXES = {".html", ".css", ".js", ".svg", ".png", ".ico", ".webmanifest"}


def _json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def make_handler(config: Config, ledger: Ledger, git: GitSync):
    """Build a request handler bound to one ledger. Returned, not registered,
    so tests can spin up an isolated server per case."""

    class MoneyHandler(BaseHTTPRequestHandler):
        server_version = "MoneyPortal/1.0"
        protocol_version = "HTTP/1.1"

        # -- plumbing ------------------------------------------------------
        def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
            self.server.access_log.append(fmt % args)

        def _send(self, status: int, payload: dict) -> None:
            body = _json_bytes(payload)
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _send_file(self, path: Path) -> None:
            body = path.read_bytes()
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _authorised(self, query: dict) -> bool:
            if not config.token:
                return True
            supplied = self.headers.get("X-Money-Token") or (query.get("token") or [""])[0]
            return hmac.compare_digest(supplied, config.token)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                raise ValidationError("body", "request body is empty")
            if length > MAX_BODY:
                raise ValidationError("body", "request body is too large")
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ValidationError("body", "request body is not valid JSON") from None
            if not isinstance(payload, dict):
                raise ValidationError("body", "expected a JSON object")
            return payload

        def _state(self, month: str | None = None) -> dict:
            entries, problems = ledger.read_with_problems()
            summary = summarise(entries)
            visible = filter_entries(entries, month=month) if month else entries
            return {
                "entries": [item.to_json() for item in reversed(visible)],
                "summary": summary,
                "problems": problems,
            }

        # -- routes --------------------------------------------------------
        def do_GET(self):  # noqa: N802 - stdlib signature
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            route = parsed.path.rstrip("/") or "/"

            if route == "/healthz":
                return self._send(HTTPStatus.OK, {"ok": True, "ledger": str(ledger.path)})

            if route.startswith("/api"):
                if not self._authorised(query):
                    return self._send(HTTPStatus.UNAUTHORIZED, {"error": "token required"})
                return self._api_get(route, query)

            return self._serve_static(parsed.path)

        do_HEAD = do_GET

        def _api_get(self, route: str, query: dict):
            if route == "/api/config":
                return self._send(
                    HTTPStatus.OK,
                    {
                        "currency": config.currency,
                        "categories": config.categories,
                        "methods": config.methods,
                        "ledger": str(ledger.path),
                        "git_sync": config.git_sync,
                        "today": dt.date.today().isoformat(),
                    },
                )
            if route == "/api/entries":
                try:
                    entries, problems = ledger.read_with_problems()
                    selected = filter_entries(
                        entries,
                        month=(query.get("month") or [None])[0],
                        category=(query.get("category") or [None])[0],
                        query=(query.get("q") or [None])[0],
                    )
                except ValidationError as exc:
                    return self._send(HTTPStatus.BAD_REQUEST, exc.as_dict())
                limit = min(int((query.get("limit") or ["200"])[0] or 200), 1000)
                return self._send(
                    HTTPStatus.OK,
                    {
                        "entries": [item.to_json() for item in list(reversed(selected))[:limit]],
                        "summary": summarise(entries),
                        "problems": problems,
                    },
                )
            if route == "/api/summary":
                entries = ledger.read_all()
                months = min(int((query.get("months") or ["6"])[0] or 6), 60)
                return self._send(HTTPStatus.OK, summarise(entries, months=months))
            return self._send(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})

        def do_POST(self):  # noqa: N802
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if not self._authorised(query):
                return self._send(HTTPStatus.UNAUTHORIZED, {"error": "token required"})
            if parsed.path.rstrip("/") != "/api/entries":
                return self._send(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            try:
                payload = self._read_json()
                entry = Entry.from_payload(payload, default_currency=config.currency)
            except ValidationError as exc:
                return self._send(HTTPStatus.BAD_REQUEST, exc.as_dict())
            stored = ledger.append(entry)
            git_result = git.commit(
                f"money: {stored.date} {stored.amount} {stored.currency} {stored.category}"
            )
            state = self._state()
            state.update({"entry": stored.to_json(), "git": git_result})
            return self._send(HTTPStatus.CREATED, state)

        def do_DELETE(self):  # noqa: N802
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            if not self._authorised(query):
                return self._send(HTTPStatus.UNAUTHORIZED, {"error": "token required"})
            prefix = "/api/entries/"
            if not parsed.path.startswith(prefix):
                return self._send(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            entry_id = unquote(parsed.path[len(prefix) :]).strip("/")
            removed = ledger.delete(entry_id)
            if removed is None:
                return self._send(HTTPStatus.NOT_FOUND, {"error": "no entry with that id"})
            git_result = git.commit(f"money: remove {removed.date} {removed.amount} {removed.category}")
            state = self._state()
            state.update({"removed": removed.to_json(), "git": git_result})
            return self._send(HTTPStatus.OK, state)

        # -- static --------------------------------------------------------
        def _serve_static(self, url_path: str):
            name = posixpath.normpath(unquote(url_path)).lstrip("/")
            if name in ("", "."):
                name = "index.html"
            candidate = (config.static_dir / name).resolve()
            static_root = config.static_dir.resolve()
            if static_root not in candidate.parents and candidate != static_root:
                return self._send(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            if candidate.suffix.lower() not in ALLOWED_STATIC_SUFFIXES or not candidate.is_file():
                return self._send(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return self._send_file(candidate)

    return MoneyHandler


class MoneyServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler_class):
        self.access_log: list[str] = []
        super().__init__(address, handler_class)


def build_server(config: Config, ledger: Ledger, git: GitSync) -> MoneyServer:
    return MoneyServer((config.host, config.port), make_handler(config, ledger, git))

"""A finite synthetic Slack read endpoint with cursor paging and retry audit."""

from __future__ import annotations

import hashlib
import json
import threading
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

TOKEN = "notebook-fixture-only"


class FixtureAPI:
    """Serve only the documented synthetic read methods; reject every write."""

    def __init__(self, directory: Path, artifacts: Path):
        manifest = json.loads((directory / "manifest.json").read_text())
        body = (directory / manifest["filename"]).read_bytes()
        self.fixture_hash = hashlib.sha256(body).hexdigest()
        if self.fixture_hash != manifest["sha256"]:
            raise ValueError("Synthetic fixture hash mismatch")
        data = json.loads(body)
        self.requests = []
        self.seen = set()
        self.lock = threading.Lock()
        artifacts.mkdir(exist_ok=True)
        audit_path = artifacts / "request-audit.json"
        audit_path.write_text("[]\n")
        owner = self

        def page(items, query):
            cursor = int(query.get("cursor", "0") or 0)
            if cursor < 0 or cursor > len(items) or cursor % 3:
                raise ValueError("Unknown fixture cursor")
            rows = items[cursor : cursor + 3]
            next_cursor = str(cursor + 3) if cursor + 3 < len(items) else ""
            return rows, next_cursor

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def send_payload(self, status, payload, record, retry=False):
                encoded = json.dumps(payload).encode()
                record.update(status=status, bytes=len(encoded))
                with owner.lock:
                    staged = audit_path.with_suffix(".tmp")
                    staged.write_text(json.dumps(owner.requests, indent=2))
                    staged.replace(audit_path)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                if retry:
                    self.send_header("Retry-After", "0")
                self.end_headers()
                self.wfile.write(encoded)

            def do_POST(self):
                record = {"method": "POST", "path": self.path}
                owner.requests.append(record)
                self.send_payload(405, {"ok": False, "error": "fixture_is_read_only"}, record)

            def do_GET(self):
                url = urlsplit(self.path)
                query = dict(parse_qsl(url.query))
                method = url.path.rsplit("/", 1)[-1]
                record = {"method": "GET", "endpoint": method, "query": query}
                with owner.lock:
                    owner.requests.append(record)
                    first = self.path not in owner.seen
                    owner.seen.add(self.path)
                try:
                    if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                        raise ValueError("This endpoint only accepts the synthetic fixture token")
                    if len(owner.requests) > 64:
                        raise ValueError("Fixture request budget exceeded")
                    if method not in {
                        "auth.test",
                        "conversations.list",
                        "users.list",
                        "conversations.history",
                        "conversations.replies",
                    }:
                        raise ValueError("Unsupported fixture method")
                    if first:
                        self.send_payload(429, {"ok": False, "error": "ratelimited"}, record, retry=True)
                        return
                    if method == "auth.test":
                        result = {
                            "team_id": "T0SYNTHETIC",
                            "team": "Synthetic notebook workspace",
                            "user_id": "U0BOT",
                            "user": "Fixture Bot",
                            "bot_id": "B0FIXTURE",
                            "url": "https://example.invalid/",
                        }
                    elif method == "conversations.list":
                        rows, cursor = page(data["channels"], query)
                        result = {"channels": rows, "response_metadata": {"next_cursor": cursor}}
                    elif method == "users.list":
                        rows, cursor = page(data["users"], query)
                        result = {"members": rows, "response_metadata": {"next_cursor": cursor}}
                    elif method == "conversations.history":
                        if query.get("channel") not in data["history"]:
                            raise ValueError("Channel was not selected for observation")
                        if (
                            query.get("inclusive") != "true"
                            or Decimal(query.get("oldest", "-1")) != Decimal("1767225600")
                            or Decimal(query.get("latest", "-1")) != Decimal("1767236400")
                        ):
                            raise ValueError("History requires the exact closed fixture fetch interval")
                        items = sorted(
                            data["history"][query["channel"]], key=lambda x: Decimal(x["ts"]), reverse=True
                        )
                        rows, cursor = page(items, query)
                        result = {
                            "messages": rows,
                            "has_more": bool(cursor),
                            "response_metadata": {"next_cursor": cursor},
                        }
                    else:
                        parent_ts = query.get("ts")
                        if query.get("channel") != "C0HELP" or parent_ts not in data["thread_replies"]:
                            raise ValueError("Unknown fixture thread")
                        parent = next(x for x in data["history"]["C0HELP"] if x["ts"] == parent_ts)
                        rows, cursor = page([parent, *data["thread_replies"][parent_ts]], query)
                        result = {
                            "messages": rows,
                            "has_more": bool(cursor),
                            "response_metadata": {"next_cursor": cursor},
                        }
                    self.send_payload(200, {"ok": True, **result}, record)
                except Exception as exc:
                    self.send_payload(400, {"ok": False, "error": str(exc)}, record)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api"

    def close(self):
        """Stop only this run's local fixture server."""
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

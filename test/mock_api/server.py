#!/usr/bin/env python3
"""A tiny, dependency-free mock of the Slack Web API used by the tests.

The worker is attached with ``api_url`` pointing here, so the suite is
deterministic and runs offline. It mimics Slack's conventions: errors are HTTP
200 with ``{"ok": false, "error": ...}``, pagination uses ``cursor`` /
``response_metadata.next_cursor``, and history is newest first.

Methods
-------
``auth.test``, ``conversations.list``, ``conversations.history``,
``conversations.replies``, ``users.list`` (GET) and ``chat.postMessage``
(POST, JSON body). Posted messages are appended to the channel's history, so a
test can post and read back.

Fixtures
--------
* Token: every call must send ``Authorization: Bearer xoxb-test-token``.
  Missing gives ``not_authed``; any other token gives ``invalid_auth``.
* Channels: C0GENERAL ``general`` (member, 25 messages, one thread with 2
  replies), C0RANDOM ``random`` (member, empty), G0SECRET ``secret`` (private,
  member, 1 message), C0OLD ``old-news`` (archived, not a member).
* Users: U0ADA, U0GRACE, U0BOT (bot), U0GONE (deleted).

Switches
--------
* ``MOCK_SLACK_FLAKY=1``: the first GET for each distinct URL returns 429 with
  ``Retry-After: 0``, exercising the client's retry path.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOKEN = "xoxb-test-token"
BASE_TS = 1_767_225_600  # 2026-01-01T00:00:00Z

CHANNELS = [
    {"id": "C0GENERAL", "name": "general", "is_private": False, "is_archived": False, "is_member": True,
     "num_members": 4, "topic": {"value": "Company-wide"}, "purpose": {"value": "Everything"},
     "creator": "U0ADA", "created": BASE_TS - 86400},
    {"id": "C0RANDOM", "name": "random", "is_private": False, "is_archived": False, "is_member": True,
     "num_members": 3, "topic": {"value": ""}, "purpose": {"value": "Off topic"},
     "creator": "U0GRACE", "created": BASE_TS - 3600},
    {"id": "G0SECRET", "name": "secret", "is_private": True, "is_archived": False, "is_member": True,
     "num_members": 2, "topic": {"value": ""}, "purpose": {"value": ""},
     "creator": "U0ADA", "created": BASE_TS},
    {"id": "C0OLD", "name": "old-news", "is_private": False, "is_archived": True, "is_member": False,
     "num_members": 0, "topic": {"value": ""}, "purpose": {"value": ""},
     "creator": "U0ADA", "created": BASE_TS - 7 * 86400},
]

USERS = [
    {"id": "U0ADA", "name": "ada", "real_name": "Ada Lovelace", "tz": "Europe/London", "is_bot": False,
     "is_admin": True, "deleted": False,
     "profile": {"real_name": "Ada Lovelace", "display_name": "ada", "email": "ada@example.com", "title": "Analyst"}},
    {"id": "U0GRACE", "name": "grace", "real_name": "Grace Hopper", "tz": "America/New_York", "is_bot": False,
     "is_admin": False, "deleted": False,
     "profile": {"real_name": "Grace Hopper", "display_name": "grace", "title": "Rear Admiral"}},
    {"id": "U0BOT", "name": "duckbot", "real_name": "Duck Bot", "tz": "America/Los_Angeles", "is_bot": True,
     "is_admin": False, "deleted": False, "profile": {"real_name": "Duck Bot", "display_name": "duckbot"}},
    {"id": "U0GONE", "name": "gone", "real_name": "Former User", "tz": "UTC", "is_bot": False,
     "is_admin": False, "deleted": True, "profile": {"real_name": "Former User"}},
]


def _ts(seconds: int, micros: int = 0) -> str:
    return f"{seconds}.{micros:06d}"


def _general() -> list[dict]:
    """25 messages one minute apart, oldest first; message 5 starts a thread."""
    out = []
    for i in range(25):
        msg = {"type": "message", "ts": _ts(BASE_TS + 60 * i, 100), "user": "U0ADA" if i % 3 else "U0GRACE",
               "text": f"message {i:02d}"}
        if i == 5:
            msg.update(thread_ts=msg["ts"], reply_count=2)
        if i == 7:
            msg["edited"] = {"user": "U0ADA", "ts": _ts(BASE_TS + 60 * i + 30)}
        out.append(msg)
    return out


HISTORY: dict[str, list[dict]] = {
    "C0GENERAL": _general(),
    "C0RANDOM": [],
    "G0SECRET": [{"type": "message", "ts": _ts(BASE_TS, 1), "user": "U0ADA", "text": "shh"}],
    "C0OLD": [],
}
THREAD_TS = _ts(BASE_TS + 300, 100)
REPLIES = {
    ("C0GENERAL", THREAD_TS): [
        {"type": "message", "ts": _ts(BASE_TS + 301), "user": "U0GRACE", "text": "reply one", "thread_ts": THREAD_TS},
        {"type": "message", "ts": _ts(BASE_TS + 302), "user": "U0ADA", "text": "reply two", "thread_ts": THREAD_TS},
    ]
}

_lock = threading.Lock()
_flaky_seen: set[str] = set()
_post_counter = [0]


# Slack may return fewer items than ``limit``; the mock caps pages at 10 so every
# multi-row read in the tests spans several pages (and several HTTP turns).
MAX_PAGE = 10


def _page(items: list, query: dict, default_limit: int = 100) -> tuple[list, str]:
    """Slice ``items`` by ``cursor`` (an offset) and ``limit`` (capped at MAX_PAGE)."""
    limit = max(1, min(int(query.get("limit", [default_limit])[0]), MAX_PAGE))
    offset = int(query.get("cursor", ["0"])[0] or 0)
    chunk = items[offset : offset + limit]
    nxt = str(offset + limit) if offset + limit < len(items) else ""
    return chunk, nxt


def _resolve(channel: str) -> str | None:
    for c in CHANNELS:
        if channel in (c["id"], c["name"], "#" + c["name"]):
            return c["id"]
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        sys.stderr.write("mock_slack: " + (format % args) + "\n")

    def _send(self, status: int, body: object, headers: dict[str, str] | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _ok(self, **body: object) -> None:
        self._send(200, {"ok": True, **body})

    def _err(self, error: str) -> None:
        self._send(200, {"ok": False, "error": error})

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization")
        if not auth:
            self._err("not_authed")
            return False
        if auth != f"Bearer {TOKEN}":
            self._err("invalid_auth")
            return False
        return True

    def do_GET(self) -> None:
        url = urlparse(self.path)
        method = url.path.rsplit("/", 1)[-1]
        if url.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if os.environ.get("MOCK_SLACK_FLAKY") == "1":
            with _lock:
                if self.path not in _flaky_seen:
                    _flaky_seen.add(self.path)
                    self._send(429, {"ok": False, "error": "ratelimited"}, {"Retry-After": "0"})
                    return
        if not self._authorized():
            return
        q = parse_qs(url.query)
        if method == "auth.test":
            self._ok(url="https://mock.slack.com/", team="Mock Team", user="duckbot", team_id="T0MOCK",
                     user_id="U0BOT", bot_id="B0BOT")
        elif method == "conversations.list":
            types = set(q.get("types", ["public_channel"])[0].split(","))
            excl = q.get("exclude_archived", ["false"])[0] == "true"
            rows = [c for c in CHANNELS
                    if ("private_channel" if c["is_private"] else "public_channel") in types
                    and not (excl and c["is_archived"])]
            chunk, nxt = _page(rows, q)
            self._ok(channels=chunk, response_metadata={"next_cursor": nxt})
        elif method == "users.list":
            chunk, nxt = _page(USERS, q)
            self._ok(members=chunk, response_metadata={"next_cursor": nxt})
        elif method == "conversations.history":
            ch = q.get("channel", [""])[0]
            if ch not in HISTORY:
                self._err("channel_not_found")
                return
            if not next(c for c in CHANNELS if c["id"] == ch)["is_member"]:
                self._err("not_in_channel")
                return
            oldest = float(q.get("oldest", ["0"])[0])
            latest = float(q.get("latest", ["1e12"])[0])
            with _lock:
                rows = [m for m in reversed(HISTORY[ch]) if oldest <= float(m["ts"]) <= latest]
            chunk, nxt = _page(rows, q)
            self._ok(messages=chunk, has_more=bool(nxt), response_metadata={"next_cursor": nxt})
        elif method == "conversations.replies":
            key = (q.get("channel", [""])[0], q.get("ts", [""])[0])
            if key[0] not in HISTORY:
                self._err("channel_not_found")
                return
            parent = next((m for m in HISTORY[key[0]] if m["ts"] == key[1]), None)
            if parent is None:
                self._err("thread_not_found")
                return
            chunk, nxt = _page([parent, *REPLIES.get(key, [])], q)
            self._ok(messages=chunk, has_more=bool(nxt), response_metadata={"next_cursor": nxt})
        else:
            self._err("unknown_method")

    def do_POST(self) -> None:
        method = urlparse(self.path).path.rsplit("/", 1)[-1]
        if not self._authorized():
            return
        if method != "chat.postMessage":
            self._err("unknown_method")
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._err("invalid_json")
            return
        ch = _resolve(str(body.get("channel", "")))
        if ch is None:
            self._err("channel_not_found")
            return
        if not body.get("text"):
            self._err("no_text")
            return
        with _lock:
            _post_counter[0] += 1
            ts = _ts(BASE_TS + 10 * 86400 + _post_counter[0])
            msg = {"type": "message", "ts": ts, "user": "U0BOT", "bot_id": "B0BOT", "text": body["text"]}
            if body.get("thread_ts"):
                msg["thread_ts"] = body["thread_ts"]
            else:
                HISTORY[ch].append(msg)
        self._ok(channel=ch, ts=ts, message=msg)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()

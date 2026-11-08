<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>Read Slack channels, people and messages, and post messages, from DuckDB SQL.</em></p>

# VGI Slack Worker

[![CI](https://github.com/Query-farm/vgi-slack/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-slack/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

A [VGI](https://query.farm/vgi) worker that brings the Slack Web API into DuckDB. Query
channels, users and history like tables, join them with your other data, and post
messages from a SQL pipeline. Written in TypeScript on
[`@query-farm/vgi`](https://github.com/Query-farm/vgi-typescript).

| Function | Kind | What it does |
|---|---|---|
| `auth_info()` | table | The workspace and bot behind the attached token |
| `channels(types := ..., exclude_archived := true)` | table | Channels the bot can see |
| `users(include_deleted := false)` | table | The workspace directory |
| `messages(channel, oldest := NULL, latest := NULL)` | table | A channel's history, newest first |
| `replies(channel, thread_ts)` | table | A thread: parent message and replies |
| `post_message(channel, text, thread_ts := NULL)` | table | Post one message, returns its `ts` |
| `post_messages((SELECT channel, text [, thread_ts] ...))` | table in-out | Post one message per row |

Channels can be given as IDs (`'C0123ABCD'`) or names (`'#general'`).

## Quick start

**Prerequisites:** [Bun](https://bun.sh) 1.3+, and a Slack app with a bot token
(`xoxb-...`) that has these scopes: `channels:read`, `groups:read`, `channels:history`,
`groups:history`, `users:read` (plus `users:read.email` for emails) and `chat:write`.
Invite the bot to every channel it should read or post in.

```bash
make build
export SLACK_BOT_TOKEN=xoxb-...
```

Attach it from DuckDB 2.0. `LOCATION` is the command DuckDB runs, so use an absolute path:

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;

ATTACH 'slack' (TYPE vgi, LOCATION '/abs/path/to/vgi-slack/bin/vgi-slack-worker',
                token getenv('SLACK_BOT_TOKEN'));

SELECT team, user FROM slack.main.auth_info();
```

On [Haybarn](https://query.farm/products/haybarn), use `INSTALL vgi FROM community; LOAD vgi;`
instead of the repository lines.

## ATTACH options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `token` | `VARCHAR`, secret | none | Slack bot token. Pass it as an expression, e.g. `getenv('SLACK_BOT_TOKEN')`, to keep it out of the SQL text. |
| `api_url` | `VARCHAR` | `https://slack.com/api` | Web API root. Change it only for a proxy or a test server. |

`token` is declared secret, so DuckDB shows it as `<redacted>` in `duckdb_databases()` and
never logs it. The worker keeps it in the attach's `attach_opaque_data`, which the SDK seals
per caller over HTTP, so no worker process holds it in memory between calls.

Without a token the catalog still attaches (so it can be explored), and every Slack call
explains how to pass one.

## Examples

```sql
-- Channels the bot can read, largest first.
SELECT name, num_members FROM slack.main.channels() WHERE is_member ORDER BY num_members DESC;

-- Who talked most in #general this year? Time bounds are applied by Slack.
SELECT u.real_name, count(*) AS messages
FROM slack.main.messages('#general', oldest := TIMESTAMPTZ '2026-01-01') m
JOIN slack.main.users() u ON u.id = m.user_id
GROUP BY ALL ORDER BY messages DESC LIMIT 10;

-- Read a busy thread.
SELECT posted_at, user_id, text FROM slack.main.replies('#general', '1700000000.000100') ORDER BY ts;

-- Post, then reply in the new message's thread.
SELECT ts FROM slack.main.post_message('#deploys', 'Deployed *v1.2* :rocket:');
SELECT ts FROM slack.main.post_message('#deploys', 'All green', thread_ts := '1700000000.000100');

-- One alert per row of a query.
SELECT count(*) AS posted FROM slack.main.post_messages((
  SELECT '#alerts' AS channel, 'Disk ' || pct || '% full on ' || host AS text
  FROM disk_usage WHERE pct > 95));
```

Readers page through Slack as DuckDB asks for rows, so `LIMIT` stops early. Bound history
with `oldest`/`latest` rather than a `WHERE` on `posted_at`, which pages through the whole
channel first. Rate limits (429) and server errors are retried, honouring `Retry-After`.

Writers post real messages and are marked `VOLATILE`, so DuckDB never caches or repeats them.

## Testing

```bash
make test-unit                 # bun unit tests (worker subprocess + mock Slack API)
make test-sql                  # test/sql/*.test through Haybarn (stdio)
make test-sql TRANSPORT=http   # ...over HTTP (also: launch)
make verify-duckdb             # vgi-worker.json through stock DuckDB 2.0 (needs a verifier with attach_options)
make check                     # everything CI runs
```

Every test runs offline against `test/mock_api/server.py`, a small Slack Web API mock. It
pages at 10 items and rate-limits the first request for every URL, so each read spans
several pages (and several HTTP turns) and exercises the retry path. No real token is needed.

The metadata check (`make lint-explain`, [vgi-lint](https://github.com/Query-farm/vgi-lint-check))
runs with `--no-execute`: the examples need a live workspace.

## Deploying

The same worker serves stdio (DuckDB starts it) or HTTP (you host it):

```bash
docker build -t vgi-slack .
docker run -p 8000:8000 vgi-slack            # health: GET /health
```

```sql
ATTACH 'slack' (TYPE vgi, LOCATION 'https://workers.example.com/slack', token getenv('SLACK_BOT_TOKEN'));
```

Each user attaches with their own token; nothing is configured on the server. Put hosted
workers behind TLS. See [authentication](https://query.farm/vgi/authentication).

## Releasing

Push a tag like `v0.1.0`. The release workflow compiles standalone executables for Linux
(x86-64, arm64), macOS (arm64) and Windows (x86-64) with `bun build --compile`, signs them
with cosign, and attaches them to the GitHub release with SLSA provenance.

## Development

[AGENTS.md](AGENTS.md) covers the layout, how to add a function, and the sharp edges. This
worker was generated from [vgi-starter-typescript](https://github.com/Query-farm/vgi-starter-typescript);
`make template-diff` shows upstream template changes. Requires `@query-farm/vgi` 0.48.2 or later.

## License

[0BSD](LICENSE). Copyright 2026 Query.Farm LLC.

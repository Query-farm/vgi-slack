# Slack notebooks

[01 · History, threads and observation windows](01_history_threads_and_observation_windows.ipynb)
reconciles channel history with thread reads, removes repeated parents by
`(channel_id, ts)`, and distinguishes total reply metadata from replies observed
before a local cutoff. The experiment expands the analytical window from one hour
to two without changing any source responses.

## Run from this directory alone

Install [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/) 1.3+ and Git:

```sh
cd notebooks
uv sync --locked
uv run --locked python execute.py
uv run --locked python -m ipykernel install --user --name vgi-slack-notebooks --display-name 'Python (vgi-slack notebooks)'
```

Select that kernel in Jupyter and start it here. The notebook supports Python
3.13/3.14 and uses Haybarn 2.0.0rc11. Tested with Bun 1.3.14 on macOS ARM64.
Initial setup downloads the locked notebook packages, VGI extension and pinned Git
worker. No worker source checkout, root .venv or locally built binary is required.
There is no live Slack mode or real credential requirement.

The literal connection remains visible:

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'slack' (
 TYPE vgi,
 LOCATION 'bun run github_worker.ts Query-farm/vgi-slack 65b5c84678ba47f96fd759242be89c199b3d1ee5 src/worker.ts',
 token 'notebook-fixture-only', api_url '{{FIXTURE_API_URL}}'
);
```

The literal token is non-secret and fixture-only; JupySQL inserts the owned loopback
endpoint into the api_url option. The LOCATION itself is a literal portable command.
The fixture rejects writes;
this walkthrough calls only read methods. No real Slack workspace is contacted.

## Portable runtime and protocol compatibility

This private npm package has no published worker release. `github_worker.ts`
fetches the publicly available immutable Git commit above and verifies HEAD.
Its bounded cache lock, atomic publication and checked success marker tolerate
concurrent starts. Installation diagnostics use stderr; stdout carries Arrow.

The source's frozen SDK 0.49.1 speaks protocol 3.2 and fails the published engine's
3.3 handshake. A **notebook-only runtime overlay** in `runtime/package.json` and
`runtime/bun.lock` pins published SDK 0.50.0; the unchanged source was tested under
that exact runtime. The launcher copies only those dependency files into its
private cached checkout and installs with `bun install --frozen-lockfile`.
It does not edit the reader's worker source or root dependency files.

The cache is keyed by repository, full commit, Bun version and SHA256 of the
notebook runtime manifest plus lock under
`${XDG_CACHE_HOME:-~/.cache}/vgi-notebook-workers`. A cold-cache native Haybarn
attach was verified. To upgrade source or runtime, edit the visible pin/companion
files deliberately and repeat notebook and source-suite validation. No engine
rebuild or new worker release is involved.

## Synthetic provenance and semantics

`fixtures/workspace.json` contains the entire invented workspace, with a hash in
`fixtures/manifest.json`: three channels, four directory identities, channel
history and four finite threads. Names, text and timestamps are not captured Slack
data. One channel is deliberately observed empty; another is not observed. A
missing directory identity remains unresolved, and a deactivated user is retained
by the explicit `users(include_deleted := true)` call.

`fixture_api.py` implements only the required read methods. It serves three rows
per page, emits one 429 with Retry-After 0 for each exact request URL, and audits
method, parameters, response status and byte length without tokens. Unknown methods,
threads, channels or history bounds fail; POST is rejected. The real worker handles
pagination, retry, mapping, timestamp parsing and Arrow transport. The fixture is
an explicit small model of API behavior, not a complete Slack emulator.

History is fetched with closed UTC bounds `[2026-01-01 00:00, 03:00]`; the worker
sends `inclusive=true`. SQL then selects `[00:00, WINDOW_HOURS:00)`, excluding the
right endpoint. Every hour boundary has an exact fixture event. Slack message
identifiers remain strings, and SQL checks their microsecond timestamp conversion.
Use `(channel_id, ts)` as the deduplication key, not timestamp alone.

Thread reads include the parent and all fixture replies. This worker has no
thread time-window arguments, so a bounded history query does not also bound a
real thread read. This example explicitly calls four known finite fixture threads.
After concatenation, SQL prefers history's version of duplicate parents and checks
that the two fixture copies agree. Real responses can change between reads.

The thread-response table selects parents posted within the analytical window and
counts only non-parent replies before its cutoff. First identified human reply
delay remains NULL if none is observed; a bot or unresolved author does not qualify.
The parent's total reply_count is not an in-window reply count. Widening the window
also changes the parent cohort, so these are not estimates of a population response
time distribution. Message counts do not measure effort, productivity or quality.

Primary API references: [history boundaries](https://docs.slack.dev/reference/methods/conversations.history/)
and [parent-inclusive thread reads](https://docs.slack.dev/reference/methods/conversations.replies/).
For a separate live integration, consult those current authentication/scope and
rate-limit requirements and use environment/secrets; this notebook does not enable
live reads or writes.

## Separate experiment

```sh
uv run --locked python execute.py --parameters '{"WINDOW_HOURS":2}' --output-dir validation/window-2
```

Compare population counts, the identity/type breakdown, thread response table and
shaded timeline. Input hashes, full fetched rows and requests should stay fixed.
The 01:00 event enters while 02:00 remains excluded. Reset the parameter to 1.

The runner uses fresh kernels and replaces saved defaults atomically only after
success. Parameter overrides require a separate destination; unknown names fail.
Experiment copies carry fixtures, helper, launcher, frozen runtime, branding and
locked notebook environment. `node_modules/`, `artifacts/` and `validation/` are
ignored. Successful default outputs remain embedded. See [STANDARD.md](STANDARD.md).

## Source validation and unchanged baseline

The original `make check` passed Biome, strict TypeScript and 12 Bun tests, then
failed SQL with client protocol 3.3 versus server 3.2. Source/root locks are preserved.
Under the notebook runtime overlay, unchanged source passes the same 12 Bun tests,
Biome and strict TypeScript, plus 131 stdio and 131 Unix-launch SQL assertions in
two cases including recipes, and 95 HTTP assertions in one worker case. The source
harness runs its own disposable mock, including its write tests only against that
local mock; no real messages are sent.

The configured metadata gate is structural only because source examples can post
to live Slack. With vgi-lint-check 2.5.0 and link checks disabled it passes at 92/100,
L1, with zero findings; the documented task-coverage waivers remain unchanged.
The notebook's own real SQL exercises its read workflow against the explicit fixture.

Final notebook validation passes default and a notebooks-only cold-cache two-hour
experiment, with two inspected charts each. Unique events increase from six to
twelve; naive appended rows increase from eight to fifteen because three parents
are repeated in the wider window. T2's first identified human response changes
from unobserved/NULL to 20 minutes, while the parent cohort grows from two to three.
The full source fingerprint, fixture hash and exact 28-request audit stay fixed
(14 successful pages plus 14 handled 429s). Boundary, timestamp, identity, duplicate,
reply-count and availability invariants pass, along with three runner guards and
fixture write/unknown-method rejection checks.

# Common tasks. `make help` lists them. Requires Bun (https://bun.sh) and uv (https://docs.astral.sh/uv/).
# managed-by: vgi-starters (language section below is typescript-specific)

HAYBARN_VERSION ?= 2.0.0rc11
# vgi-lint is deliberately not pinned: the gate tracks the current quality bar.
VGI_LINT        := uvx --prerelease=allow --from 'vgi-lint-check>=2,<3' vgi-lint lint
# Every example calls the live Slack API with a real token, so the metadata check
# runs at L1 (structural) and does not execute them.
LINT_ARGS       ?= --no-execute
WORKER          := $(CURDIR)/bin/vgi-slack-worker
TOOLS           := $(CURDIR)/.tools
HAYBARN_UNITTEST := $(TOOLS)/bin/haybarn-unittest
TRANSPORT       ?= stdio

.DEFAULT_GOAL := help
VERIFIER        ?= $(CURDIR)/../.claude/skills/vgi-worker/scripts/verify_worker.py

.PHONY: verify-duckdb help build test test-unit test-sql test-sql-all lint lint-explain lint-ai fmt check run run-http debug tools template-diff clean

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-14s %s\n",$$1,$$2}' $(MAKEFILE_LIST)


build: ## Install the worker's dependencies into node_modules
	bun install --frozen-lockfile

tools: ## Install the pinned SQL test runner into .tools
	@test -x $(HAYBARN_UNITTEST) || { uv venv -q $(TOOLS) && uv pip install -q -p $(TOOLS) haybarn-unittest==$(HAYBARN_VERSION); }

fmt: ## Format the code
	bun x biome check --write .

lint: build ## Static checks: biome (format + lint), tsc --noEmit
	bun x biome ci .
	bun x tsc --noEmit

test-unit: build ## Unit tests (bun test)
	bun test

test-sql: build tools ## SQL tests through DuckDB: make test-sql TRANSPORT=stdio|launch|http
	WORKER=$(WORKER) RECIPES_WORKER="$(CURDIR)/bin/run-recipe" HAYBARN_UNITTEST=$(HAYBARN_UNITTEST) TRANSPORT=$(TRANSPORT) PYTHON="uv run --no-project python" ci/run-integration.sh

test-sql-all: ## SQL tests over every transport
	$(MAKE) test-sql TRANSPORT=stdio
	$(MAKE) test-sql TRANSPORT=launch
	$(MAKE) test-sql TRANSPORT=http

test: test-unit test-sql ## Unit + SQL tests

verify-duckdb: build ## Stock DuckDB 2.0 check of vgi-worker.json against the mock Slack API (VERIFIER=path to verify_worker.py)
	@uv run -q --no-project python test/mock_api/server.py --port 18765 > /dev/null 2>&1 & pid=$$!; \
	  trap "kill $$pid" EXIT; sleep 1; \
	  SLACK_TEST_TOKEN=xoxb-test-token uv run -q --no-project --with duckdb==2.0.0 python "$(VERIFIER)" --project . --timeout 180 --output verification.json

lint-explain: build ## Metadata quality report (vgi-lint, settings in vgi-lint.toml). LINT_ARGS="--format agent" for agents
	$(VGI_LINT) "$(WORKER)" $(LINT_ARGS)

lint-ai: ## Opt-in L3 check: an agent runs vgi-agent-tests.yaml and docs are reviewed (needs the claude CLI)
	@$(MAKE) --no-print-directory lint-explain LINT_ARGS="--ai $(LINT_ARGS)"

check: lint test-unit test-sql-all lint-explain ## Everything CI runs. Done = this passes.

run: build ## Serve over stdio (what DuckDB launches)
	$(WORKER)

run-http: build ## Serve over HTTP on port 8000
	$(WORKER) --http --host 127.0.0.1 --port 8000

debug: build tools ## Run one query against the worker with debug logging on stderr
	@printf "LOAD vgi;\nATTACH 'slack' (TYPE vgi, LOCATION '$(WORKER) --debug', token getenv('SLACK_BOT_TOKEN'));\nSELECT * FROM slack.main.auth_info();\n" \
	  | uvx --from haybarn-cli==$(HAYBARN_VERSION) haybarn -no-agent

template-diff: ## Show upstream template changes since this project was created
	uv run --no-project python scripts/vgi_template.py template-diff --stat

clean: ## Remove build outputs and tool caches
	rm -rf node_modules .tools dist

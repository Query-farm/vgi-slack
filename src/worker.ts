/**
 * The worker entry point.
 *
 *   bin/vgi-slack-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-slack-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-slack-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'slack' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-slack-worker',
 *                   token getenv('SLACK_BOT_TOKEN'));
 */

import { CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";
import { makeSlackCatalogInterface } from "./slack_catalog.ts";

if (import.meta.main) {
  serve(CATALOG, {
    version: VERSION,
    doc: CATALOG_DOC_LLM,
    repositoryUrl: SOURCE_URL,
    catalogInterface: makeSlackCatalogInterface,
  });
}

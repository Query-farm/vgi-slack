/**
 * The catalog interface DuckDB attaches, with Slack's ATTACH options.
 *
 *   ATTACH 'slack' (TYPE vgi, LOCATION '/abs/path/bin/vgi-slack-worker',
 *                   token getenv('SLACK_BOT_TOKEN'));
 *
 * Options:
 *
 * - `token`   (VARCHAR, secret) the Slack bot token, `xoxb-...`. Declared
 *             `secret`, so DuckDB redacts it from `duckdb_databases()` and
 *             never logs it.
 * - `api_url` (VARCHAR) the Slack Web API root; defaults to
 *             `https://slack.com/api`. Override it for a proxy or a test mock.
 *
 * Where the token lives: `attach()` puts the options into the attach's
 * `attach_opaque_data`, which DuckDB hands back on every bind and scan. Over
 * HTTP the SDK seals that value in an authenticated-encrypted envelope bound to
 * the caller, so no worker process keeps the token in memory, and any process
 * behind a load balancer can serve the next request. Over stdio it stays inside
 * the DuckDB process that already holds the ATTACH options. Functions read it
 * from `bind_call.attach_opaque_data` on every call (the SDK unseals it on every
 * turn since @query-farm/vgi 0.48.2), so the token is never in function state.
 *
 * The options themselves are declared on the catalog descriptor
 * (`attachOptions`, see catalog.ts); this class only carries their values.
 */

import {
  type AttachOptionSpec,
  type BindRequest,
  type CatalogAttachResult,
  type CatalogDescriptor,
  type FunctionRegistry,
  ReadOnlyCatalogInterface,
  utf8,
} from "@query-farm/vgi";
import { DEFAULT_API_URL, SlackApiError, SlackClient, type SlackConfig } from "./slack_api.ts";

export const TOKEN_OPTION = "token";
export const API_URL_OPTION = "api_url";

export const ATTACH_OPTIONS: AttachOptionSpec[] = [
  {
    name: TOKEN_OPTION,
    description:
      "Slack bot token (xoxb-...). Pass it as an expression to keep it out of the SQL text: " +
      "token getenv('SLACK_BOT_TOKEN').",
    type: utf8(),
    secret: true,
  },
  {
    name: API_URL_OPTION,
    description: "Slack Web API root URL. Change it only for a proxy or a test server.",
    type: utf8(),
    default: DEFAULT_API_URL,
  },
];

/** Length of the random attach id ReadOnlyCatalogInterface mints (kept as a prefix). */
const ATTACH_ID_LEN = 16;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Pack the attach id and the Slack config into `attach_opaque_data`. */
export function encodeAttachData(attachId: Uint8Array, config: Partial<SlackConfig>): Uint8Array {
  const json = ENCODER.encode(JSON.stringify(config));
  const out = new Uint8Array(attachId.length + json.length);
  out.set(attachId, 0);
  out.set(json, attachId.length);
  return out;
}

/** Read the Slack config back out of `attach_opaque_data`. */
export function decodeAttachData(data: Uint8Array | null | undefined): Partial<SlackConfig> {
  if (!data || data.length <= ATTACH_ID_LEN) return {};
  try {
    return JSON.parse(DECODER.decode(data.subarray(ATTACH_ID_LEN))) as Partial<SlackConfig>;
  } catch {
    return {};
  }
}

const NO_TOKEN_MESSAGE =
  "No Slack token. Attach the worker with a bot token: " +
  "ATTACH 'slack' (TYPE vgi, LOCATION '...', token getenv('SLACK_BOT_TOKEN'))";

/** The Slack client for the ATTACH that issued this bind or scan. */
export function clientFor(bindCall: Pick<BindRequest, "attach_opaque_data">): SlackClient {
  const config = decodeAttachData(bindCall.attach_opaque_data as Uint8Array | null | undefined);
  if (!config.token) throw new SlackApiError("attach", "not_authed", NO_TOKEN_MESSAGE);
  return new SlackClient({ token: config.token, apiUrl: config.apiUrl || DEFAULT_API_URL });
}

function optionString(options: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!options) return undefined;
  // DuckDB lower-cases option names; accept any case from other clients.
  const key = Object.keys(options).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : options[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Carries the ATTACH option values to functions inside `attach_opaque_data`. */
export class SlackCatalogInterface extends ReadOnlyCatalogInterface {
  override async attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
    clientCapabilities?: Uint8Array | null,
  ): Promise<CatalogAttachResult> {
    const result = await super.attach(name, options, dataVersionSpec, implementationVersion, clientCapabilities);
    const token = optionString(options, TOKEN_OPTION);
    const apiUrl = optionString(options, API_URL_OPTION) ?? DEFAULT_API_URL;
    if (!/^https?:\/\//.test(apiUrl)) throw new Error(`api_url must start with http:// or https://, got '${apiUrl}'`);
    const attachId = (result.attach_opaque_data as Uint8Array).subarray(0, ATTACH_ID_LEN);
    return { ...result, attach_opaque_data: encodeAttachData(attachId, { token, apiUrl }) };
  }

  override detach(attachOpaqueData: Uint8Array): void {
    super.detach(attachOpaqueData.subarray(0, ATTACH_ID_LEN));
  }
}

export function makeSlackCatalogInterface(catalog: CatalogDescriptor, registry: FunctionRegistry) {
  return new SlackCatalogInterface(catalog, registry);
}

/**
 * A small Slack Web API client: just what the worker's functions need.
 *
 * - Every call is authenticated with the bot token from the ATTACH options.
 * - Slack reports most failures as HTTP 200 with `{"ok": false, "error": ...}`;
 *   those become a `SlackApiError` naming the method and Slack's error code.
 * - 429 and 5xx responses are retried with backoff that honours `Retry-After`.
 * - Requests time out after `TIMEOUT_MS`.
 *
 * The token never appears in logs or error messages.
 */

import { log } from "./log.ts";
import { VERSION } from "./meta.ts";

export const DEFAULT_API_URL = "https://slack.com/api";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 60_000;
const USER_AGENT = `vgi-slack-worker/${VERSION}`;

/** Slack (or the HTTP layer in front of it) refused a request. */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `Slack API ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

/** The parts of a Slack response every paginated method shares. */
export interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
  [key: string]: unknown;
}

type Params = Record<string, string | number | boolean | null | undefined>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connection details for one ATTACH: where the API is and which token to use. */
export interface SlackConfig {
  token: string;
  apiUrl: string;
}

export class SlackClient {
  constructor(private readonly config: SlackConfig) {}

  /** GET a read method (`conversations.list`, ...) with query parameters. */
  get(method: string, params: Params = {}): Promise<SlackResponse> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, String(v));
    const qs = query.toString();
    return this.request(method, "GET", qs ? `?${qs}` : "", undefined);
  }

  /** POST a write method (`chat.postMessage`, ...) with a JSON body. */
  post(method: string, body: Params): Promise<SlackResponse> {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
    return this.request(method, "POST", "", JSON.stringify(clean));
  }

  private async request(method: string, httpMethod: string, qs: string, body: string | undefined) {
    const url = `${this.config.apiUrl.replace(/\/+$/, "")}/${method}${qs}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { method: httpMethod, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new SlackApiError(method, "network_error", `Slack API ${method} failed: ${(err as Error).message}`);
        }
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("Retry-After");
        const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 500 * 2 ** attempt;
        log.debug(`Slack ${method}: HTTP ${response.status}, retrying in ${delay} ms`);
        await sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
        continue;
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        throw new SlackApiError(
          method,
          `http_${response.status}`,
          `Slack API ${method} failed with HTTP ${response.status}: ${text}`,
        );
      }
      const json = (await response.json()) as SlackResponse;
      if (!json.ok) {
        const code = json.error ?? "unknown_error";
        const hint = HINTS[code] ?? (json.needed ? ` (the token needs the '${json.needed}' scope)` : "");
        throw new SlackApiError(method, code, `Slack API ${method} failed: ${code}${hint}`);
      }
      return json;
    }
  }
}

/** Extra context for the errors people hit most often. */
const HINTS: Record<string, string> = {
  not_authed: " (no token was sent; pass token '...' in the ATTACH options)",
  invalid_auth: " (the token in the ATTACH options is not valid)",
  not_in_channel: " (invite the bot to the channel first: /invite @your-bot)",
  channel_not_found: " (check the channel ID, or that the bot can see the channel)",
};

/** The cursor for the next page, or null on the last page. */
export function nextCursor(response: SlackResponse): string | null {
  const cursor = response.response_metadata?.next_cursor;
  return cursor ? cursor : null;
}

/** Slack conversation IDs: C (public), G (private / group), D (DM). */
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;

/**
 * Resolve a channel argument to a conversation ID.
 *
 * Accepts an ID (`C0123ABCD`) as-is, or a name with or without the leading `#`
 * (`#general`, `general`), which is looked up with `conversations.list`.
 */
export async function resolveChannel(client: SlackClient, channel: string): Promise<string> {
  const trimmed = channel.trim();
  if (CHANNEL_ID.test(trimmed)) return trimmed;
  const name = trimmed.replace(/^#/, "").toLowerCase();
  if (!name) throw new SlackApiError("conversations.list", "channel_not_found", "channel must not be empty");
  let cursor: string | null = null;
  do {
    const page = await client.get("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    const channels = (page.channels ?? []) as { id: string; name?: string }[];
    const hit = channels.find((c) => c.name?.toLowerCase() === name);
    if (hit) return hit.id;
    cursor = nextCursor(page);
  } while (cursor);
  throw new SlackApiError(
    "conversations.list",
    "channel_not_found",
    `Slack channel '${channel}' not found (or the bot cannot see it)`,
  );
}

/**
 * Convert a Slack message timestamp (`"1700000000.123456"`) to microseconds
 * since the epoch. Parsed as text so no precision is lost to floating point.
 */
export function tsToMicros(ts: string | null | undefined): bigint | null {
  if (!ts) return null;
  const m = /^(\d+)(?:\.(\d{1,6}))?/.exec(ts);
  if (!m) return null;
  return BigInt(m[1] ?? "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Convert microseconds since the epoch to a Slack timestamp string. */
export function microsToTs(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Seconds since the epoch (Slack's `created`, `updated`) to microseconds. */
export function secondsToMicros(seconds: unknown): bigint | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? BigInt(Math.trunc(seconds)) * 1_000_000n : null;
}

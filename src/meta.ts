/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "slack";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-slack";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "workspace", title: "Workspace", description: "Channels, users and the token's identity." },
  { name: "messages", title: "Messages", description: "Read channel history and threads." },
  { name: "posting", title: "Posting", description: "Post messages to channels and threads." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const ATTACH_SQL =
  "ATTACH 'slack' (TYPE vgi, LOCATION '/abs/path/bin/vgi-slack-worker', token getenv('SLACK_BOT_TOKEN'))";

export const CATALOG_DOC_LLM =
  "Slack as SQL: read a workspace's channels, people and conversation history, and post " +
  "messages, using a Slack bot token. Attach with the token in the `token` ATTACH option, " +
  `for example \`${ATTACH_SQL}\`; the optional \`api_url\` option changes the API root. ` +
  "Key concepts: a channel is identified by an ID such as 'C0123ABCD' (names like '#general' " +
  "are accepted and looked up); a message is identified by its channel plus its `ts`, a " +
  "string like '1700000000.123456' that also serves as a thread ID (`thread_ts`). What a query " +
  "can see depends on the bot's scopes and on which channels it has been invited to. Reach for " +
  "this worker to analyse Slack activity alongside other data, or to send notifications from a " +
  "SQL pipeline. Every call goes to the live Slack Web API; rate limits are retried.";

export const CATALOG_DOC_MD =
  "# Slack for DuckDB\n\n" +
  "**Query Slack channels, people and messages, and post messages, from SQL.**\n\n" +
  `Attach with a bot token: \`${ATTACH_SQL}\`. The token is declared secret, so DuckDB ` +
  "redacts it from `duckdb_databases()` and never logs it.\n\n" +
  "Bot token scopes: `channels:read`, `groups:read`, `channels:history`, `groups:history`, " +
  "`users:read` (plus `users:read.email` for emails) and `chat:write`. Invite the bot to " +
  "every channel it should read or post in.";

export const SCHEMA_DOC_LLM =
  "Everything Slack lives in `main`. Readers stream Slack's paginated Web API one page per " +
  "batch, so SQL `LIMIT` stops paging early, and time-bounded history should use the reader's " +
  "own time arguments rather than a `WHERE` on the timestamp, which would page through the whole " +
  "channel first. Writers post real messages and return the new message's `ts`. Message rows " +
  "join to people on `user_id` and to channels on `channel_id`.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Readers for the workspace (channels, people, the token's identity) and for conversations " +
  "(channel history, threads), plus writers that post messages.\n\n" +
  "Readers page through the Slack API as DuckDB asks for rows, so `LIMIT` is cheap. Bound " +
  "history with the reader's time arguments instead of filtering afterwards.\n\n" +
  "Writers post real messages: run them deliberately.";

export const AGENT_TEST_TASKS = [
  {
    name: "bot_identity",
    prompt: "Using the slack worker, which Slack workspace (team name) is the bot connected to?",
  },
  {
    name: "busiest_thread",
    prompt: "Using the slack worker, show the replies in the thread with the most replies in #general, oldest first.",
  },
  { name: "member_channels", prompt: "Using the slack worker, list the names of the channels the bot is a member of." },
  {
    name: "general_message_count",
    prompt: "Using the slack worker, how many top-level messages are in the #general channel?",
  },
  {
    name: "top_poster",
    prompt: "Using the slack worker, which user (by real name) posted the most messages in #general?",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "VGI Slack Worker",
  "vgi.subtitle": "Read Slack channels, people and messages, and post messages, from DuckDB SQL.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray("slack, chat, messages, channels, notifications, duckdb, vgi"),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Slack Functions",
  domain: "collaboration",
  "vgi.keywords": keywordsArray("slack, channels, users, messages, threads, post message"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

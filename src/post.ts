/**
 * Functions that post to Slack.
 *
 *   post_message(channel, text, thread_ts := NULL)       post one message
 *   post_messages((SELECT channel, text [, thread_ts] ...))  post one per input row
 *
 * Both call chat.postMessage and return the posted message's `channel_id` and
 * `ts`, so the result can be stored, or used to reply in a thread.
 *
 * Posting has side effects, so the functions are marked VOLATILE: DuckDB must
 * not cache or deduplicate them.
 */

import {
  batchFromColumns,
  defineTableFunction,
  defineTableInOutFunction,
  FunctionStability,
  schema,
  timestampMicros,
  utf8,
  type VgiSchema,
} from "@query-farm/vgi";
import { column, objectTags } from "./meta.ts";
import { type SlackClient, tsToMicros } from "./slack_api.ts";
import { clientFor } from "./slack_catalog.ts";

export const MAX_TEXT_CHARS = 40_000;

export const POSTED_SCHEMA = schema([
  column("channel_id", utf8(), "Conversation ID the message was posted to.", false),
  column("ts", utf8(), "ts of the new message: its ID, and the thread_ts to reply to it.", false),
  column("posted_at", timestampMicros("UTC"), "When Slack recorded the message."),
  column("thread_ts", utf8(), "Parent message ts when the message was posted as a thread reply."),
  column("text", utf8(), "The text that was posted."),
]);

export interface PostResult {
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  text: string;
}

/** Validate and send one message. Channel names (`#general`) are accepted by Slack directly. */
export async function postOne(
  client: SlackClient,
  channel: string | null,
  text: string | null,
  threadTs: string | null,
): Promise<PostResult> {
  if (!channel?.trim()) throw new Error("post: channel must not be NULL or empty");
  if (text == null || text === "") throw new Error("post: text must not be NULL or empty");
  if (text.length > MAX_TEXT_CHARS) throw new Error(`post: text is longer than ${MAX_TEXT_CHARS} characters`);
  if (threadTs != null && !/^\d+\.\d+$/.test(threadTs)) {
    throw new Error(`post: thread_ts must look like '1700000000.123456', got '${threadTs}'`);
  }
  const r = await client.post("chat.postMessage", { channel: channel.trim(), text, thread_ts: threadTs });
  return { channel_id: String(r.channel), ts: String(r.ts), thread_ts: threadTs, text };
}

function postedBatch(results: PostResult[], outputSchema: VgiSchema) {
  return batchFromColumns(
    {
      channel_id: results.map((r) => r.channel_id),
      ts: results.map((r) => r.ts),
      posted_at: results.map((r) => tsToMicros(r.ts)),
      thread_ts: results.map((r) => r.thread_ts),
      text: results.map((r) => r.text),
    },
    outputSchema,
  );
}

const RESULT_DOC =
  "Returns `channel_id`, `ts` (the new message's ID; pass it as `thread_ts` to reply), " +
  "`posted_at`, `thread_ts` and `text`.";

// --------------------------------------------------------------- post_message

interface PostArgs {
  channel: string;
  text: string;
  thread_ts: string | null;
}

export const postMessage = defineTableFunction<PostArgs, { posted: boolean }>({
  name: "post_message",
  description: "Post one message to a Slack channel and return its ts",
  args: { channel: utf8(), text: utf8(), thread_ts: utf8() },
  argDefaults: { thread_ts: null },
  argDocs: {
    channel: "Channel ID ('C0123ABCD') or name ('#general'). The bot must be allowed to post there.",
    text: "Message text, in Slack mrkdwn (*bold*, _italic_, <https://example.com|links>, <@U0123ABCD> mentions).",
    thread_ts: "ts of a parent message to reply in its thread. Default NULL: a new top-level message.",
  },
  stability: FunctionStability.VOLATILE,
  onBind: () => ({ outputSchema: POSTED_SCHEMA }),
  cardinality: () => ({ estimate: 1n, max: 1n }),
  initialState: () => ({ posted: false }),
  process: async (params, state, out) => {
    if (state.posted) {
      out.finish();
      return;
    }
    // Mark first: if the emit fails, never post the same message twice.
    state.posted = true;
    const { channel, text, thread_ts } = params.args;
    const result = await postOne(clientFor(params.initCall.bind_call), channel, text, thread_ts ?? null);
    out.emit(postedBatch([result], params.outputSchema));
  },
  tags: {
    ...objectTags({
      title: "Post Slack Message",
      category: "posting",
      keywords: "slack, post, send message, chat.postMessage, notify, alert, reply in thread",
      docLlm:
        "Post one message to Slack with chat.postMessage and return one row describing it. " +
        "Positional arguments: `channel` (ID like 'C0123ABCD' or name like '#general') and `text` " +
        "(Slack mrkdwn). Named argument `thread_ts` (default NULL) replies in the thread of that " +
        `parent message. ${RESULT_DOC} Every call posts a real message; to post one message per ` +
        "row of a query use post_messages(). Needs the chat:write scope, and the bot must be in " +
        "the channel (or have chat:write.public for public channels).",
      docMd:
        "## post_message(channel, text, thread_ts := NULL)\n\n" +
        "Post a message and get its `ts` back. Pass that `ts` as `thread_ts` to reply in its thread.",
    }),
    "vgi.result_columns_schema": JSON.stringify(
      POSTED_SCHEMA.fields.map((f) => ({
        name: f.name,
        type: f.name === "posted_at" ? "TIMESTAMP WITH TIME ZONE" : "VARCHAR",
        description: f.metadata.get("comment") ?? "",
      })),
    ),
  },
  examples: [
    {
      sql: "SELECT channel_id, ts FROM slack.main.post_message('#deploys', 'Deployed *v1.2* :rocket:')",
      description: "Announce a deploy and keep the message ts",
    },
    {
      sql: "SELECT ts FROM slack.main.post_message('#deploys', 'Rollback finished', thread_ts := '1700000000.000100')",
      description: "Reply in an existing thread",
    },
  ],
});

// -------------------------------------------------------------- post_messages

export const postMessages = defineTableInOutFunction<Record<string, never>, null>({
  name: "post_messages",
  description: "Post one Slack message per input row (columns channel, text, optional thread_ts)",
  stability: FunctionStability.VOLATILE,
  argDocs: {
    data:
      "Subquery of messages to post, one per row, with columns `channel` (ID or '#name') and " +
      "`text`, and optionally `thread_ts` (NULL for a top-level message).",
  },
  onBind: (params) => {
    const input = params.bindCall.input_schema;
    const names = new Set(input?.fields.map((f) => f.name.toLowerCase()) ?? []);
    for (const required of ["channel", "text"]) {
      if (!names.has(required)) {
        throw new Error(`post_messages needs input columns 'channel' and 'text' (missing '${required}')`);
      }
    }
    return { outputSchema: POSTED_SCHEMA };
  },
  // Post the rows of each batch in order; Slack's per-channel rate limit is
  // handled by the client's 429 retry.
  process: async (params, _state, batch, out) => {
    const client = clientFor(params.initCall.bind_call);
    const byName = (name: string) => {
      const idx = batch.schema.fields.findIndex((f) => f.name.toLowerCase() === name);
      return idx < 0 ? null : batch.getChildAt(idx);
    };
    const channelCol = byName("channel");
    const textCol = byName("text");
    const threadCol = byName("thread_ts");
    const results: PostResult[] = [];
    for (let i = 0; i < batch.numRows; i++) {
      const channel = (channelCol?.get(i) ?? null) as string | null;
      const text = (textCol?.get(i) ?? null) as string | null;
      const thread = (threadCol?.get(i) ?? null) as string | null;
      results.push(await postOne(client, channel, text, thread));
    }
    out.emit(postedBatch(results, params.outputSchema));
  },
  tags: {
    "vgi.executable_examples": JSON.stringify([
      {
        description: "Dry run: an empty input posts nothing, so it needs no token or network",
        sql: "SELECT count(*) AS posted FROM slack.main.post_messages((SELECT '#alerts' AS channel, 'never sent' AS text WHERE false))",
        expected_result: [{ posted: 0 }],
      },
    ]),
    ...objectTags({
      title: "Post Slack Messages (Bulk)",
      category: "posting",
      keywords: "slack, bulk post, send messages, notify, alerts, fan out, chat.postMessage",
      docLlm:
        "Post one Slack message for every row of a subquery, in order. Pass the subquery as the " +
        "only argument; it must have `VARCHAR` columns `channel` (ID or '#name') and `text`, and may " +
        "have `thread_ts` to reply in a thread (NULL for a top-level message). Returns one row per " +
        `posted message. ${RESULT_DOC} A NULL or empty channel or text fails the query. Rate ` +
        "limits are respected by retrying with Slack's Retry-After. Needs the chat:write scope.",
      docMd:
        "## post_messages((SELECT channel, text [, thread_ts] ...))\n\n" +
        "Post one message per row of a subquery, for example one alert per failing host.",
    }),
    "vgi.result_columns_schema": JSON.stringify(
      POSTED_SCHEMA.fields.map((f) => ({
        name: f.name,
        type: f.name === "posted_at" ? "TIMESTAMP WITH TIME ZONE" : "VARCHAR",
        description: f.metadata.get("comment") ?? "",
      })),
    ),
  },
  examples: [
    {
      sql: "SELECT count(*) AS posted FROM slack.main.post_messages((SELECT '#alerts' AS channel, 'never sent' AS text WHERE false))",
      description: "Dry run: an empty input posts nothing (no token or network needed)",
    },
    {
      sql:
        "SELECT count(*) AS posted FROM slack.main.post_messages((SELECT '#alerts' AS channel, " +
        "'Host ' || h || ' is down' AS text FROM (VALUES ('web-1'), ('web-2')) t(h)))",
      description: "Post an alert per down host and count them",
    },
  ],
});

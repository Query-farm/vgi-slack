/**
 * Table functions that read from Slack.
 *
 *   auth_info()                               who the token belongs to
 *   channels(types := ..., exclude_archived := true)
 *   users(include_deleted := false)
 *   messages(channel, oldest := NULL, latest := NULL)
 *   replies(channel, thread_ts)
 *
 * Each one pages through a Slack Web API method with its cursor and streams
 * one page per Arrow batch. The cursor lives in the function state (it carries
 * no secrets); the token is read from the ATTACH on every call.
 */

import {
  batchFromColumns,
  bool,
  defineTableFunction,
  int64,
  schema,
  timestampMicros,
  utf8,
  type VgiField,
  type VgiSchema,
} from "@query-farm/vgi";
import { column, objectTags } from "./meta.ts";
import { microsToTs, nextCursor, resolveChannel, secondsToMicros, tsToMicros } from "./slack_api.ts";
import { clientFor } from "./slack_catalog.ts";

const TIMESTAMPTZ = () => timestampMicros("UTC");

/** Cursor shared by every paginated reader: `done` once Slack has no next page. */
interface PageState {
  cursor: string;
  done: boolean;
  /** Resolved conversation ID (for functions that take a channel argument). */
  channelId: string;
}

const initialPageState = (): PageState => ({ cursor: "", done: false, channelId: "" });

/** Build `vgi.result_columns_schema` from the Arrow schema and its column comments. */
function resultColumns(s: VgiSchema): string {
  const sqlType = (f: VgiField): string => {
    const t = String(f.type);
    if (/^Utf8/i.test(t)) return "VARCHAR";
    if (/^Bool/i.test(t)) return "BOOLEAN";
    if (/^Int64/i.test(t)) return "BIGINT";
    if (/^Timestamp/i.test(t)) return "TIMESTAMP WITH TIME ZONE";
    return t;
  };
  return JSON.stringify(
    s.fields.map((f) => ({ name: f.name, type: sqlType(f), description: f.metadata.get("comment") ?? "" })),
  );
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const intOrNull = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;

// ------------------------------------------------------------------ auth_info

export const AUTH_INFO_SCHEMA = schema([
  column("team_id", utf8(), "Workspace ID, e.g. 'T0123ABCD'."),
  column("team", utf8(), "Workspace name."),
  column("url", utf8(), "Workspace URL, e.g. 'https://acme.slack.com/'."),
  column("user_id", utf8(), "User ID the token acts as (the bot user for a bot token)."),
  column("user", utf8(), "User name the token acts as."),
  column("bot_id", utf8(), "Bot ID when the token is a bot token, otherwise NULL."),
]);

export const authInfo = defineTableFunction<Record<string, never>, { done: boolean }>({
  name: "auth_info",
  description: "Show which Slack workspace, user and bot the attached token belongs to",
  onBind: () => ({ outputSchema: AUTH_INFO_SCHEMA }),
  cardinality: () => ({ estimate: 1n, max: 1n }),
  initialState: () => ({ done: false }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const r = await clientFor(params.initCall.bind_call).get("auth.test");
    out.emit(
      batchFromColumns(
        {
          team_id: [str(r.team_id)],
          team: [str(r.team)],
          url: [str(r.url)],
          user_id: [str(r.user_id)],
          user: [str(r.user)],
          bot_id: [str(r.bot_id)],
        },
        params.outputSchema,
      ),
    );
    state.done = true;
  },
  tags: {
    ...objectTags({
      title: "Slack Auth Info",
      category: "workspace",
      keywords: "slack, auth, token, whoami, workspace, team, bot identity",
      docLlm:
        "Return one row describing the Slack token given in the ATTACH options: the workspace " +
        "(`team_id`, `team`, `url`) and the identity it acts as (`user_id`, `user`, and `bot_id` " +
        "for a bot token). Takes no arguments. Use it to check that the worker is attached with a " +
        "valid token before reading or posting; an invalid token fails with 'invalid_auth'.",
      docMd:
        "## auth_info()\n\n" +
        "One row: the workspace and identity behind the attached token. Handy for checking the " +
        "ATTACH worked.",
    }),
    "vgi.result_columns_schema": resultColumns(AUTH_INFO_SCHEMA),
  },
  examples: [
    {
      sql: "SELECT team, user, bot_id FROM slack.main.auth_info()",
      description: "Check which workspace and bot the token is for",
    },
  ],
});

// ------------------------------------------------------------------- channels

export const CHANNELS_SCHEMA = schema([
  column("id", utf8(), "Conversation ID, e.g. 'C0123ABCD'. Pass it to messages() or post_message().", false),
  column("name", utf8(), "Channel name without the leading '#'."),
  column("is_private", bool, "True for a private channel."),
  column("is_archived", bool, "True when the channel is archived."),
  column("is_member", bool, "True when the bot is a member (it can read the channel's history)."),
  column("num_members", int64(), "Number of members, when Slack reports it."),
  column("topic", utf8(), "Channel topic text."),
  column("purpose", utf8(), "Channel purpose text."),
  column("creator", utf8(), "User ID of the channel's creator."),
  column("created_at", TIMESTAMPTZ(), "When the channel was created."),
]);

interface ChannelsArgs {
  types: string;
  exclude_archived: boolean;
}

const CHANNEL_TYPES = ["public_channel", "private_channel", "mpim", "im"];

export const channels = defineTableFunction<ChannelsArgs, PageState>({
  name: "channels",
  description: "List the Slack channels the bot can see",
  args: { types: utf8(), exclude_archived: bool },
  argDefaults: { types: "public_channel,private_channel", exclude_archived: true },
  argDocs: {
    types:
      "Comma-separated conversation types: any of public_channel, private_channel, mpim, im. " +
      "Default 'public_channel,private_channel'.",
    exclude_archived: "Leave out archived channels. Default true.",
  },
  argConstraints: {
    types: { pattern: "^(public_channel|private_channel|mpim|im)(,(public_channel|private_channel|mpim|im))*$" },
  },
  onBind: (params) => {
    for (const t of params.args.types.split(",")) {
      if (!CHANNEL_TYPES.includes(t.trim())) {
        throw new Error(`types: unknown conversation type '${t}'; use ${CHANNEL_TYPES.join(", ")}`);
      }
    }
    return { outputSchema: CHANNELS_SCHEMA };
  },
  initialState: initialPageState,
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const page = await clientFor(params.initCall.bind_call).get("conversations.list", {
      types: params.args.types,
      exclude_archived: params.args.exclude_archived,
      limit: 200,
      cursor: state.cursor || undefined,
    });
    const rows = (page.channels ?? []) as Record<string, unknown>[];
    out.emit(
      batchFromColumns(
        {
          id: rows.map((c) => String(c.id)),
          name: rows.map((c) => str(c.name)),
          is_private: rows.map((c) => boolOrNull(c.is_private)),
          is_archived: rows.map((c) => boolOrNull(c.is_archived)),
          is_member: rows.map((c) => boolOrNull(c.is_member)),
          num_members: rows.map((c) => intOrNull(c.num_members)),
          topic: rows.map((c) => str((c.topic as { value?: unknown } | undefined)?.value)),
          purpose: rows.map((c) => str((c.purpose as { value?: unknown } | undefined)?.value)),
          creator: rows.map((c) => str(c.creator)),
          created_at: rows.map((c) => secondsToMicros(c.created)),
        },
        params.outputSchema,
      ),
    );
    const cursor = nextCursor(page);
    state.cursor = cursor ?? "";
    state.done = cursor === null;
  },
  tags: {
    ...objectTags({
      title: "Slack Channels",
      category: "workspace",
      keywords: "slack, channels, conversations, list channels, private channels, members",
      docLlm:
        "List the Slack conversations the attached bot token can see, one row per channel with " +
        "`id`, `name`, `is_private`, `is_archived`, `is_member`, `num_members`, `topic`, `purpose`, " +
        "`creator` and `created_at`. Named arguments: `types` (comma-separated subset of " +
        "public_channel, private_channel, mpim, im; default 'public_channel,private_channel') and " +
        "`exclude_archived` (default true). Use the `id` column with `messages()` and " +
        "`post_message()`. The bot can read history only where `is_member` is true. Needs the " +
        "channels:read (and groups:read for private channels) scope.",
      docMd:
        "## channels(types := 'public_channel,private_channel', exclude_archived := true)\n\n" +
        "Every channel the bot can see. Join on `id` to read messages.",
    }),
    "vgi.result_columns_schema": resultColumns(CHANNELS_SCHEMA),
  },
  examples: [
    {
      sql: "SELECT name, num_members FROM slack.main.channels() WHERE is_member ORDER BY num_members DESC LIMIT 10",
      description: "The ten largest channels the bot is in",
    },
    {
      sql: "SELECT is_private, count(*) AS channels FROM slack.main.channels(exclude_archived := false) GROUP BY is_private",
      description: "Count public and private channels, including archived ones",
    },
  ],
});

// ---------------------------------------------------------------------- users

export const USERS_SCHEMA = schema([
  column("id", utf8(), "User ID, e.g. 'U0123ABCD'. Matches messages.user_id.", false),
  column("name", utf8(), "Username (handle)."),
  column("real_name", utf8(), "Full name from the user's profile."),
  column("display_name", utf8(), "Display name from the user's profile."),
  column("email", utf8(), "Email address; NULL unless the token has the users:read.email scope."),
  column("title", utf8(), "Job title from the user's profile."),
  column("tz", utf8(), "IANA time zone, e.g. 'America/New_York'."),
  column("is_bot", bool, "True for bot users."),
  column("is_admin", bool, "True for workspace admins."),
  column("deleted", bool, "True for deactivated users."),
]);

interface UsersArgs {
  include_deleted: boolean;
}

export const users = defineTableFunction<UsersArgs, PageState>({
  name: "users",
  description: "List the members of the Slack workspace",
  args: { include_deleted: bool },
  argDefaults: { include_deleted: false },
  argDocs: { include_deleted: "Include deactivated users. Default false." },
  onBind: () => ({ outputSchema: USERS_SCHEMA }),
  initialState: initialPageState,
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const page = await clientFor(params.initCall.bind_call).get("users.list", {
      limit: 200,
      cursor: state.cursor || undefined,
    });
    let rows = (page.members ?? []) as Record<string, unknown>[];
    if (!params.args.include_deleted) rows = rows.filter((u) => u.deleted !== true);
    const profile = (u: Record<string, unknown>) => (u.profile ?? {}) as Record<string, unknown>;
    out.emit(
      batchFromColumns(
        {
          id: rows.map((u) => String(u.id)),
          name: rows.map((u) => str(u.name)),
          real_name: rows.map((u) => str(u.real_name) ?? str(profile(u).real_name)),
          display_name: rows.map((u) => str(profile(u).display_name)),
          email: rows.map((u) => str(profile(u).email)),
          title: rows.map((u) => str(profile(u).title)),
          tz: rows.map((u) => str(u.tz)),
          is_bot: rows.map((u) => boolOrNull(u.is_bot)),
          is_admin: rows.map((u) => boolOrNull(u.is_admin)),
          deleted: rows.map((u) => boolOrNull(u.deleted)),
        },
        params.outputSchema,
      ),
    );
    const cursor = nextCursor(page);
    state.cursor = cursor ?? "";
    state.done = cursor === null;
  },
  tags: {
    ...objectTags({
      title: "Slack Users",
      category: "workspace",
      keywords: "slack, users, members, people, directory, profiles",
      docLlm:
        "List the workspace's members, one row per user with `id`, `name`, `real_name`, " +
        "`display_name`, `email`, `title`, `tz`, `is_bot`, `is_admin` and `deleted`. Named argument " +
        "`include_deleted` (default false) keeps deactivated users. Join `id` to " +
        "`messages().user_id` to put names on messages. Needs the users:read scope; `email` also " +
        "needs users:read.email.",
      docMd:
        "## users(include_deleted := false)\n\n" +
        "The workspace directory. Join `id` with `messages().user_id` to show who said what.",
    }),
    "vgi.result_columns_schema": resultColumns(USERS_SCHEMA),
  },
  examples: [
    {
      sql: "SELECT tz, count(*) AS people FROM slack.main.users() WHERE NOT is_bot GROUP BY tz ORDER BY people DESC",
      description: "Where the workspace's people are, by time zone",
    },
  ],
});

// ------------------------------------------------------- messages and replies

export const MESSAGES_SCHEMA = schema([
  column("channel_id", utf8(), "Conversation ID the message is in.", false),
  column(
    "ts",
    utf8(),
    "Slack message timestamp, the message's ID within the channel (e.g. '1700000000.123456').",
    false,
  ),
  column("posted_at", TIMESTAMPTZ(), "When the message was posted (ts as a timestamp)."),
  column("user_id", utf8(), "User ID of the author; NULL for some bot and system messages."),
  column("bot_id", utf8(), "Bot ID when a bot or app posted the message."),
  column("type", utf8(), "Event type, normally 'message'."),
  column("subtype", utf8(), "Message subtype such as 'bot_message' or 'channel_join'; NULL for ordinary messages."),
  column("text", utf8(), "Message text in Slack's mrkdwn format."),
  column("thread_ts", utf8(), "ts of the thread's parent message; equals ts on a parent, NULL outside threads."),
  column("reply_count", int64(), "Number of replies, on a thread's parent message."),
  column("edited_at", TIMESTAMPTZ(), "When the message was last edited, or NULL."),
]);

function messageColumns(channelId: string, rows: Record<string, unknown>[]) {
  return {
    channel_id: rows.map(() => channelId),
    ts: rows.map((m) => String(m.ts)),
    posted_at: rows.map((m) => tsToMicros(str(m.ts))),
    user_id: rows.map((m) => str(m.user)),
    bot_id: rows.map((m) => str(m.bot_id)),
    type: rows.map((m) => str(m.type)),
    subtype: rows.map((m) => str(m.subtype)),
    text: rows.map((m) => str(m.text)),
    thread_ts: rows.map((m) => str(m.thread_ts)),
    reply_count: rows.map((m) => intOrNull(m.reply_count)),
    edited_at: rows.map((m) => tsToMicros(str((m.edited as { ts?: unknown } | undefined)?.ts))),
  };
}

/** A TIMESTAMPTZ argument (micros since epoch, Date, or NULL) as a Slack ts. */
export function timeArgToTs(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "bigint") return microsToTs(value);
  if (typeof value === "number") return microsToTs(BigInt(Math.trunc(value)));
  if (value instanceof Date) return microsToTs(BigInt(value.getTime()) * 1000n);
  throw new Error(`expected a timestamp, got ${typeof value}`);
}

interface MessagesArgs {
  channel: string;
  oldest: unknown;
  latest: unknown;
}

const MESSAGE_RESULT_DOC =
  "Columns: `channel_id`, `ts` (the message ID), `posted_at`, `user_id`, `bot_id`, `type`, " +
  "`subtype`, `text`, `thread_ts`, `reply_count`, `edited_at`.";

export const messages = defineTableFunction<MessagesArgs, PageState>({
  name: "messages",
  description: "Read a Slack channel's message history, newest first",
  args: { channel: utf8(), oldest: TIMESTAMPTZ(), latest: TIMESTAMPTZ() },
  argDefaults: { oldest: null, latest: null },
  argDocs: {
    channel: "Channel ID ('C0123ABCD') or name ('#general' or 'general'). The bot must be a member.",
    oldest: "Only messages posted at or after this time. Default NULL: no lower bound.",
    latest: "Only messages posted at or before this time. Default NULL: up to now.",
  },
  onBind: (params) => {
    if (!params.args.channel?.trim()) throw new Error("channel must not be empty");
    return { outputSchema: MESSAGES_SCHEMA };
  },
  initialState: initialPageState,
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const client = clientFor(params.initCall.bind_call);
    if (!state.channelId) state.channelId = await resolveChannel(client, params.args.channel);
    const page = await client.get("conversations.history", {
      channel: state.channelId,
      oldest: timeArgToTs(params.args.oldest),
      latest: timeArgToTs(params.args.latest),
      inclusive: true,
      limit: 200,
      cursor: state.cursor || undefined,
    });
    out.emit(
      batchFromColumns(
        messageColumns(state.channelId, (page.messages ?? []) as Record<string, unknown>[]),
        params.outputSchema,
      ),
    );
    const cursor = page.has_more === false ? null : nextCursor(page);
    state.cursor = cursor ?? "";
    state.done = cursor === null;
  },
  tags: {
    ...objectTags({
      title: "Slack Channel Messages",
      category: "messages",
      keywords: "slack, messages, history, chat, conversation history, read channel",
      docLlm:
        "Read the message history of one Slack channel, newest first, paging through " +
        "conversations.history. `channel` (positional) is a channel ID or a name like '#general'. " +
        "Named arguments `oldest` and `latest` (`TIMESTAMPTZ`, default NULL) bound the time range " +
        "on the server, which is much cheaper than filtering `posted_at` afterwards; use SQL " +
        `LIMIT to stop early. Thread replies are not included: use replies(). ${MESSAGE_RESULT_DOC} ` +
        "The bot must be a member of the channel (error 'not_in_channel' otherwise). Needs " +
        "channels:history / groups:history.",
      docMd:
        "## messages(channel, oldest := NULL, latest := NULL)\n\n" +
        "A channel's history, newest first. Bound the range with `oldest` and `latest`, which " +
        "Slack applies on its side, instead of filtering `posted_at` afterwards.",
    }),
    "vgi.result_columns_schema": resultColumns(MESSAGES_SCHEMA),
  },
  examples: [
    {
      sql:
        "SELECT u.real_name, count(*) AS messages FROM slack.main.messages('#general', oldest := TIMESTAMPTZ '2026-01-01') m " +
        "JOIN slack.main.users() u ON u.id = m.user_id GROUP BY u.real_name ORDER BY messages DESC LIMIT 10",
      description: "Most active people in #general since the start of 2026",
    },
    {
      sql: "SELECT posted_at, text FROM slack.main.messages('C0123ABCD') ORDER BY posted_at DESC LIMIT 20",
      description: "The twenty latest messages in a channel, by ID",
    },
  ],
});

interface RepliesArgs {
  channel: string;
  thread_ts: string;
}

export const replies = defineTableFunction<RepliesArgs, PageState>({
  name: "replies",
  description: "Read a Slack thread: the parent message and its replies, oldest first",
  args: { channel: utf8(), thread_ts: utf8() },
  argDocs: {
    channel: "Channel ID ('C0123ABCD') or name ('#general') the thread is in.",
    thread_ts: "ts of the thread's parent message, e.g. from messages().ts where reply_count > 0.",
  },
  argConstraints: { thread_ts: { pattern: "^\\d+\\.\\d+$" } },
  onBind: (params) => {
    if (!/^\d+\.\d+$/.test(params.args.thread_ts ?? "")) {
      throw new Error(`thread_ts must look like '1700000000.123456', got '${params.args.thread_ts}'`);
    }
    return { outputSchema: MESSAGES_SCHEMA };
  },
  initialState: initialPageState,
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    const client = clientFor(params.initCall.bind_call);
    if (!state.channelId) state.channelId = await resolveChannel(client, params.args.channel);
    const page = await client.get("conversations.replies", {
      channel: state.channelId,
      ts: params.args.thread_ts,
      limit: 200,
      cursor: state.cursor || undefined,
    });
    out.emit(
      batchFromColumns(
        messageColumns(state.channelId, (page.messages ?? []) as Record<string, unknown>[]),
        params.outputSchema,
      ),
    );
    const cursor = page.has_more === false ? null : nextCursor(page);
    state.cursor = cursor ?? "";
    state.done = cursor === null;
  },
  tags: {
    ...objectTags({
      title: "Slack Thread Replies",
      category: "messages",
      keywords: "slack, thread, replies, conversation replies, discussion",
      docLlm:
        "Read one Slack thread, oldest first: the parent message followed by every reply. " +
        "Arguments (both positional): `channel`, a channel ID or name, and `thread_ts`, the parent " +
        "message's `ts` as returned by messages() (rows with reply_count > 0). Same columns as " +
        `messages(). ${MESSAGE_RESULT_DOC}`,
      docMd:
        "## replies(channel, thread_ts)\n\n" +
        "A thread's parent message and all its replies. Find threads with " +
        "`messages(...) WHERE reply_count > 0`.",
    }),
    "vgi.result_columns_schema": resultColumns(MESSAGES_SCHEMA),
  },
  examples: [
    {
      sql: "SELECT posted_at, user_id, text FROM slack.main.replies('#general', '1700000000.000100') ORDER BY posted_at",
      description: "Read one thread in order",
    },
  ],
});

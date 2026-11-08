// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, deserializeAttachOptionSpecs, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { postOne } from "../src/post.ts";
import { timeArgToTs } from "../src/read.ts";
import { microsToTs, resolveChannel, SlackApiError, SlackClient, tsToMicros } from "../src/slack_api.ts";
import { clientFor, decodeAttachData, encodeAttachData } from "../src/slack_catalog.ts";

const ROOT = join(import.meta.dir, "..");
const TOKEN = "xoxb-test-token";

test("tsToMicros parses Slack timestamps exactly", () => {
  expect(tsToMicros("1767225600.000100")).toBe(1_767_225_600_000_100n);
  expect(tsToMicros("1767225600.5")).toBe(1_767_225_600_500_000n);
  expect(tsToMicros("1767225600")).toBe(1_767_225_600_000_000n);
  expect(tsToMicros(null)).toBeNull();
  expect(tsToMicros("garbage")).toBeNull();
});

test("microsToTs round-trips", () => {
  expect(microsToTs(1_767_225_600_000_100n)).toBe("1767225600.000100");
  expect(tsToMicros(microsToTs(42n))).toBe(42n);
});

test("timeArgToTs accepts micros, Date and NULL", () => {
  expect(timeArgToTs(null)).toBeUndefined();
  expect(timeArgToTs(1_000_000n)).toBe("1.000000");
  expect(timeArgToTs(new Date(1500))).toBe("1.500000");
});

test("attach data round-trips and tolerates sealed or empty input", () => {
  const id = new Uint8Array(16).fill(7);
  const packed = encodeAttachData(id, { token: TOKEN, apiUrl: "http://x" });
  expect(packed.subarray(0, 16)).toEqual(id);
  expect(decodeAttachData(packed)).toEqual({ token: TOKEN, apiUrl: "http://x" });
  expect(decodeAttachData(null)).toEqual({});
  expect(decodeAttachData(new Uint8Array(73).fill(200))).toEqual({});
});

test("clientFor explains a missing token", () => {
  expect(() => clientFor({ attach_opaque_data: null })).toThrow(/No Slack token/);
});

test("postOne validates before calling Slack", async () => {
  const client = new SlackClient({ token: TOKEN, apiUrl: "http://127.0.0.1:1" });
  await expect(postOne(client, null, "hi", null)).rejects.toThrow(/channel/);
  await expect(postOne(client, "#x", "", null)).rejects.toThrow(/text/);
  await expect(postOne(client, "#x", "hi", "nope")).rejects.toThrow(/thread_ts/);
});

describe("against the worker and the mock Slack API", () => {
  let worker: VgiClient;
  let mock: ReturnType<typeof Bun.spawn>;
  let apiUrl: string;
  let attach: Uint8Array;

  beforeAll(async () => {
    // The mock prints PORT:<n> once it is listening. Flaky mode: the first
    // request for every URL is a 429, so the retry path always runs.
    mock = Bun.spawn([process.env.PYTHON ?? "python3", join(ROOT, "test", "mock_api", "server.py")], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MOCK_SLACK_FLAKY: "1" },
    });
    const reader = (mock.stdout as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const port = text.match(/^PORT:(\d+)/)?.[1];
    if (!port) throw new Error(`mock API did not report a port: ${text}`);
    apiUrl = `http://127.0.0.1:${port}`;

    // A client that launches the worker as a subprocess, the way DuckDB does,
    // and attaches with the ATTACH options.
    worker = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
    const result = await worker.catalogAttach("slack", { options: { token: TOKEN, api_url: apiUrl } });
    attach = result.attach_opaque_data as Uint8Array;
  });

  afterAll(() => {
    worker?.close();
    mock?.kill();
  });

  async function table(name: string, positional: unknown[], named: Record<string, unknown> = {}, attachData = attach) {
    const rows: Record<string, unknown>[] = [];
    for await (const page of worker.tableFunctionRows({
      functionName: name,
      arguments: new Arguments(positional, new Map(Object.entries(named))),
      attachOpaqueData: attachData,
      int64: "bigint",
    })) {
      rows.push(...page);
    }
    return rows;
  }

  test("the catalog advertises the token option as secret", async () => {
    const [info] = await worker.catalogsInfo();
    const specs = deserializeAttachOptionSpecs(info?.attach_option_specs ?? []);
    const token = specs.find((s) => s.name === "token");
    expect(token?.secret).toBe(true);
    expect(specs.find((s) => s.name === "api_url")?.default).toBe("https://slack.com/api");
  });

  test("channels: pages through every channel", async () => {
    const rows = await table("channels", [], { exclude_archived: false });
    expect(rows.map((r) => r.id).sort()).toEqual(["C0GENERAL", "C0OLD", "C0RANDOM", "G0SECRET"]);
  });

  test("messages: three pages, newest first", async () => {
    const rows = await table("messages", ["#general"]);
    expect(rows.length).toBe(25);
    expect(rows[0]?.text).toBe("message 24");
    expect(rows.at(-1)?.text).toBe("message 00");
  });

  test("no token: a clear error", async () => {
    const bare = await worker.catalogAttach("slack", { options: { api_url: apiUrl } });
    await expect(table("auth_info", [], {}, bare.attach_opaque_data as Uint8Array)).rejects.toThrow(/No Slack token/);
  });

  test("SlackClient: ok:false becomes a SlackApiError with a hint", async () => {
    const bad = new SlackClient({ token: "xoxb-wrong", apiUrl });
    const err = await bad.get("auth.test").catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe("invalid_auth");
    expect(err.message).not.toContain("xoxb-wrong");
  });

  test("resolveChannel: IDs pass through, names are looked up", async () => {
    const client = new SlackClient({ token: TOKEN, apiUrl });
    expect(await resolveChannel(client, "C0ANYTHING")).toBe("C0ANYTHING");
    expect(await resolveChannel(client, "#Secret")).toBe("G0SECRET");
    await expect(resolveChannel(client, "#missing")).rejects.toThrow(/not found/);
  });
});

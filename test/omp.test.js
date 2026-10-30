"use strict";

/**
 * omp (Oh My Pi) provider tests — ~/.omp/agent/sessions/<bucket>/*.jsonl.
 * Fixtures mirror @oh-my-pi/pi-coding-agent src/session: a 256-byte title
 * slot line, then the {type:"session"} header, then entries. Usage lives on
 * assistant messages (message.usage) and model_usage entries; /fork copies
 * history verbatim (same entry id+timestamp), which must dedup across files.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const omp = require("../src/tools/omp");

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const T0 = 1_792_000_000_000;
const ISO0 = new Date(T0).toISOString();
const ISO1 = new Date(T0 + 60_000).toISOString();

const HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: ISO0,
  cwd: "D:\\proj\\demo",
});
const TITLE_SLOT = JSON.stringify({ type: "title", v: 1, title: "demo", updatedAt: ISO0, pad: "" });

function assistantEntry(id, iso) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: iso,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-5",
      timestamp: T0,
      stopReason: "stop",
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { input: 0.015, output: 0.015, cacheRead: 0.0015, cacheWrite: 0.001875, total: 0.033 },
      },
      content: [{ type: "text", text: "hi" }],
    },
  });
}

const MODEL_USAGE_ENTRY = JSON.stringify({
  type: "model_usage",
  id: "bbbbbbbb",
  parentId: null,
  timestamp: ISO1,
  purpose: "title",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  api: "anthropic-messages",
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.0001, output: 0.00025, cacheRead: 0, cacheWrite: 0, total: 0.00035 },
  },
  stopReason: "stop",
});

function writeSession(home, bucket, name, lines) {
  const dir = path.join(home, "sessions", bucket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.join("\n") + "\n");
}

test("omp provider: unavailable without a sessions dir", () => {
  const home = tmpHome("omp-off-");
  assert.strictEqual(omp.isAvailable(home), false);
  assert.strictEqual(omp.scan(home).records.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("omp provider: defaultHome honors PI_CODING_AGENT_DIR", () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "D:\\somewhere\\agent";
  try {
    assert.strictEqual(omp.defaultHome(), path.resolve("D:\\somewhere\\agent"));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test("omp provider: defaultHome falls back to legacy sessions when the new home only has config", (t) => {
  const home = tmpHome("omp-migration-");
  const primary = path.join(home, ".omp", "agent");
  const legacy = path.join(home, ".pi", "agent");
  fs.mkdirSync(primary, { recursive: true });
  fs.mkdirSync(path.join(legacy, "sessions"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  t.mock.method(os, "homedir", () => home);
  t.after(() => {
    if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.strictEqual(omp.defaultHome(), legacy);
});

test("omp provider: parses assistant + model_usage usage", () => {
  const home = tmpHome("omp-parse-");
  writeSession(home, "--D--proj--demo--", "s1.jsonl", [
    TITLE_SLOT,
    HEADER,
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: ISO0, message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    assistantEntry("aaaaaaaa", ISO0),
    // zero-usage placeholder must be skipped (and must not poison dedup)
    JSON.stringify({
      type: "message",
      id: "cccccccc",
      parentId: null,
      timestamp: ISO0,
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-5",
        timestamp: T0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    }),
    MODEL_USAGE_ENTRY,
  ]);
  // An artifact-dir .jsonl that is NOT a session (no header) yields nothing.
  const artifactDir = path.join(home, "sessions", "--D--proj--demo--", "s1");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "notes.jsonl"), JSON.stringify({ usage: { input: 9 } }) + "\n");

  const out = omp.scan(home);
  assert.strictEqual(out.records.length, 2, "assistant + model_usage only");

  const main = out.records.find((r) => r.inputOther === 1000);
  assert.ok(main);
  assert.strictEqual(main.tool, "omp");
  assert.strictEqual(main.output, 200);
  assert.strictEqual(main.inputCacheRead, 500);
  assert.strictEqual(main.inputCacheCreation, 100);
  assert.strictEqual(main.time, T0);
  assert.strictEqual(main.model, "claude-opus-5");
  assert.strictEqual(main.modelProvider, "anthropic");
  assert.strictEqual(main.priceId, "claude-opus-5");
  assert.ok(main.costCny > 0);
  assert.strictEqual(main.project, "D:\\proj\\demo");
  assert.strictEqual(main.session, "sess-1");
  assert.deepStrictEqual(main.sessionHint, { session: "sess-1", project: "D:\\proj\\demo" });

  const title = out.records.find((r) => r.inputOther === 100);
  assert.ok(title);
  assert.strictEqual(title.output, 50);
  assert.strictEqual(title.priceId, "claude-haiku-4-5");
  assert.strictEqual(title.time, Date.parse(ISO1));

  fs.rmSync(home, { recursive: true, force: true });
});

test("omp provider: fork-copied history dedups across files", () => {
  const home = tmpHome("omp-fork-");
  const shared = assistantEntry("aaaaaaaa", ISO0);
  writeSession(home, "--D--proj--demo--", "a.jsonl", [TITLE_SLOT, HEADER, shared]);
  // /fork writes a new file copying the history verbatim (same ids+timestamps).
  writeSession(home, "--D--proj--demo--", "b.jsonl", [
    TITLE_SLOT,
    JSON.stringify({ type: "session", version: 3, id: "sess-2", timestamp: ISO1, cwd: "D:\\proj\\demo" }),
    shared,
  ]);
  const out = omp.scan(home);
  assert.strictEqual(out.records.length, 1, "shared history counted once");
  fs.rmSync(home, { recursive: true, force: true });
});

test("omp provider: bad lines are skipped without throwing", () => {
  const home = tmpHome("omp-bad-");
  writeSession(home, "-", "c.jsonl", ["not json", HEADER, '{"type":"message",', assistantEntry("dddddddd", ISO0)]);
  const out = omp.scan(home);
  assert.strictEqual(out.records.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

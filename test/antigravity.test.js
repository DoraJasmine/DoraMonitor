"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const antigravity = require("../src/tools/antigravity");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
}

// --- minimal protobuf encoder for test fixtures ---
function varint(v) {
  let n = BigInt(v);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
function key(number, wire) {
  return varint((number << 3) | wire);
}
function varintField(number, value) {
  return Buffer.concat([key(number, 0), varint(value)]);
}
function bytesField(number, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  return Buffer.concat([key(number, 2), varint(buf.length), buf]);
}
function timestampField(number, epochMs) {
  return bytesField(number, varintField(1, Math.floor(epochMs / 1000)));
}

/** Build one steps.metadata blob (CortexStepMetadata). */
function stepMetadata({ createdAtMs, usage }) {
  return Buffer.concat([
    timestampField(1, createdAtMs),
    usage ? bytesField(9, usage) : Buffer.alloc(0),
  ]);
}

/** Build one ModelUsageStats blob. */
function modelUsage({ modelEnum = 1, input = 0, output = 0, cacheWrite = 0, cacheRead = 0, messageId = "msg-1" }) {
  return Buffer.concat([
    varintField(1, modelEnum),
    varintField(2, input),
    varintField(3, output),
    varintField(4, cacheWrite),
    varintField(5, cacheRead),
    bytesField(7, messageId),
  ]);
}

/** Build one gen_metadata.data blob (wrapper → ChatModelMetadata). */
function genMetadata({ usage, responseModel = "", displayName = "" }) {
  const chat = Buffer.concat([
    bytesField(4, usage),
    bytesField(19, responseModel),
    bytesField(21, displayName),
  ]);
  return bytesField(1, chat);
}

function seedConversation(home, conversationId, { steps = [], generations = [], workspaceUris = null } = {}) {
  const convDir = path.join(home, "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(convDir, `${conversationId}.db`));
  db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
  db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
  const insStep = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
  steps.forEach((meta, i) => insStep.run(i + 1, meta));
  const insGen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  generations.forEach((data, i) => insGen.run(i + 1, data));
  db.close();

  const sumPath = path.join(home, "conversation_summaries.db");
  const sdb = new DatabaseSync(sumPath);
  sdb.exec(
    "CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)"
  );
  sdb.prepare(
    "INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time) VALUES (?, ?, ?)"
  ).run(conversationId, workspaceUris, "2026-11-26 12:00:00.000000+00:00");
  sdb.close();
}

const T0 = Date.UTC(2026, 10, 25, 11, 8, 34);

test("antigravity: missing data → empty scan without throw", () => {
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = path.join(tmpDir(), "missing");
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const out = antigravity.scan();
    assert.ok(Array.isArray(out.records));
    assert.strictEqual(out.records.length, 0);
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: parses protobuf usage, prices by display name, dedupes by message id", () => {
  const home = tmpDir();
  const cid = "11111111-2222-3333-4444-555555555555";
  const usageA = modelUsage({ modelEnum: 1, input: 10025, output: 280, messageId: "msg-a" });
  const usageB = modelUsage({ modelEnum: 1, input: 3087, cacheRead: 10026, output: 285, messageId: "msg-b" });
  seedConversation(home, cid, {
    steps: [
      stepMetadata({ createdAtMs: T0, usage: usageA }),
      stepMetadata({ createdAtMs: T0 + 1000, usage: usageA }), // duplicate id
      stepMetadata({ createdAtMs: T0 + 6000, usage: usageB }),
      stepMetadata({ createdAtMs: T0 + 7000, usage: modelUsage({ messageId: "msg-zero" }) }), // zero
      stepMetadata({ createdAtMs: T0 + 8000, usage: null }), // no usage field
    ],
    generations: [
      genMetadata({ usage: usageA, responseModel: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen (High)" }),
      genMetadata({ usage: usageB, responseModel: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen (High)" }),
    ],
    workspaceUris: JSON.stringify(["file:///d%3A/Work/demo-telemetry"]),
  });

  // Point the adapter at this one fixture root via the env override.
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const out = antigravity.scan();
    assert.strictEqual(out.records.length, 2);
    const first = out.records.find((r) => r.inputOther === 10025);
    assert.ok(first);
    assert.strictEqual(first.tool, "antigravity");
    assert.strictEqual(first.model, "Gemini 4 Hydrogen");
    assert.strictEqual(first.modelDisplay, "Gemini 4 Hydrogen");
    assert.strictEqual(first.modelResolved, "gemini-4-hydrogen");
    assert.strictEqual(first.priceId, "gemini-4-hydrogen");
    assert.strictEqual(first.costEstimated, false);
    assert.ok(first.costCny > 0);
    assert.strictEqual(first.time, T0);
    assert.strictEqual(first.project, "d:/Work/demo-telemetry");
    assert.strictEqual(first.session, cid);
    const second = out.records.find((r) => r.inputOther === 3087);
    assert.strictEqual(second.inputCacheRead, 10026);
    assert.strictEqual(second.output, 285);
    assert.ok(out.records[0].time >= out.records[1].time);
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: a model-less checkpoint inherits its enum's generation name", () => {
  const home = tmpDir();
  const cid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const usageGen = modelUsage({ modelEnum: 5, input: 500, output: 50, messageId: "msg-gen" });
  const usageCkpt = modelUsage({ modelEnum: 5, input: 9000, output: 10, messageId: "msg-ckpt" });
  seedConversation(home, cid, {
    steps: [
      stepMetadata({ createdAtMs: T0, usage: usageGen }),
      stepMetadata({ createdAtMs: T0 + 5000, usage: usageCkpt }),
    ],
    generations: [
      genMetadata({ usage: usageGen, responseModel: "gemini-4-neon", displayName: "Gemini 4 Neon" }),
    ],
  });
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const out = antigravity.scan();
    assert.strictEqual(out.records.length, 2);
    const ckpt = out.records.find((r) => r.inputOther === 9000);
    assert.strictEqual(ckpt.model, "Gemini 4 Neon");
    assert.strictEqual(ckpt.modelResolved, "gemini-4-neon");
    assert.strictEqual(ckpt.priceId, "gemini-4-neon");
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: orchestrated generations price the model in the display name", () => {
  const home = tmpDir();
  const cid = "bbbbbbbb-1111-2222-3333-cccccccccccc";
  const usage = modelUsage({ modelEnum: 9, input: 12000, output: 400, messageId: "msg-orch" });
  seedConversation(home, cid, {
    steps: [stepMetadata({ createdAtMs: T0, usage })],
    generations: [
      genMetadata({ usage, responseModel: "gemini-pro-orchestrator", displayName: "Gemini 4 Carbon (Orchestrator)" }),
    ],
  });
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const out = antigravity.scan();
    assert.strictEqual(out.records.length, 1);
    assert.strictEqual(out.records[0].model, "Gemini 4 Carbon");
    assert.strictEqual(out.records[0].modelDisplay, "Gemini 4 Carbon");
    assert.strictEqual(out.records[0].modelResolved, "gemini-4-carbon");
    assert.strictEqual(out.records[0].priceId, "gemini-4-carbon");
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: corrupt databases never break the whole scan", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, "conversations"), { recursive: true });
  fs.writeFileSync(path.join(home, "conversations", "broken.db"), "not a sqlite db");
  const cid = "cccccccc-dddd-eeee-ffff-000000000000";
  seedConversation(home, cid, {
    steps: [stepMetadata({ createdAtMs: T0, usage: modelUsage({ input: 100, output: 10, messageId: "msg-ok" }) })],
    generations: [],
  });
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const out = antigravity.scan();
    assert.strictEqual(out.records.length, 1);
    assert.ok(out.meta.errors.length >= 1);
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: App and CLI conversations under different roots dedupe by message id", () => {
  const appHome = tmpDir();
  const cliHome = tmpDir();
  const cid = "dddddddd-1111-2222-3333-eeeeeeeeeeee";
  const usage = modelUsage({ input: 700, output: 70, messageId: "shared-msg" });
  const gen = genMetadata({ usage, responseModel: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen (XHigh)" });
  seedConversation(appHome, cid, { steps: [stepMetadata({ createdAtMs: T0, usage })], generations: [gen] });
  seedConversation(cliHome, cid, { steps: [stepMetadata({ createdAtMs: T0 + 1, usage })], generations: [gen] });
  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = appHome;
  process.env.ANTIGRAVITY_CLI_HOME = cliHome;
  try {
    const out = antigravity.scan();
    // Same message id under both roots → counted once.
    assert.strictEqual(out.records.length, 1);
    assert.strictEqual(out.records[0].inputOther, 700);
    assert.strictEqual(out.records[0].tool, "antigravity");
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: orchestrated non-Gemini models price by display name and sourceFiles tracks WAL/summaries", () => {
  const home = tmpDir();
  const cid = "eeeeeeee-1111-2222-3333-ffffffffffff";
  const usage = modelUsage({ modelEnum: 12, input: 10000, output: 300, messageId: "msg-claude-orch" });
  seedConversation(home, cid, {
    steps: [stepMetadata({ createdAtMs: T0, usage })],
    generations: [
      genMetadata({ usage, responseModel: "gemini-pro-orchestrator", displayName: "Claude Opus 5.5 (Orchestrator)" }),
    ],
    workspaceUris: JSON.stringify(["file://localhost/d%3A/DoraMonitor"]),
  });
  const walFile = path.join(home, "conversations", `${cid}.db-wal`);
  fs.writeFileSync(walFile, "");

  const prevApp = process.env.ANTIGRAVITY_HOME;
  const prevCli = process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = home;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  try {
    const files = antigravity.sourceFiles();
    assert.ok(files.includes(walFile), "sourceFiles includes active -wal");
    assert.ok(files.includes(path.join(home, "conversation_summaries.db")), "sourceFiles includes summaries db");
    const out = antigravity.scan();
    assert.strictEqual(out.records.length, 1);
    assert.strictEqual(out.records[0].priceId, "claude-opus-5-5");
    assert.strictEqual(out.records[0].costEstimated, false);
    assert.strictEqual(out.records[0].project, "d:/DoraMonitor");
  } finally {
    if (prevApp === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prevApp;
    if (prevCli === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = prevCli;
  }
});

test("antigravity: wslHomeCoveredByPeer skips WSL root only when peer sync already reports antigravity", () => {
  const root = tmpDir();
  const wslHome = path.join(root, "wsl-home");
  const cacheDir = path.join(root, "remote-cache");
  fs.mkdirSync(path.join(wslHome, ".doramonitor"), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(wslHome, ".doramonitor", "config.json"),
    JSON.stringify({ sync: { enabled: true, deviceName: "wsl" } })
  );
  const winSettings = { sync: { enabled: true } };

  // Peer cache without antigravity → do NOT skip WSL root.
  fs.writeFileSync(
    path.join(cacheDir, "wsl.json"),
    JSON.stringify({ device: "wsl", days: { "2026-11-26": { "kimi-code": { i: 1 } } } })
  );
  assert.strictEqual(
    antigravity.wslHomeCoveredByPeer(wslHome, { forcePlatformCheck: true, settings: winSettings, remoteCacheDir: cacheDir }),
    false
  );

  // Peer cache WITH antigravity → skip WSL root to avoid double-counting.
  fs.writeFileSync(
    path.join(cacheDir, "wsl.json"),
    JSON.stringify({ device: "wsl", days: { "2026-11-26": { antigravity: { "Gemini 4 Hydrogen": { i: 1 } } } } })
  );
  assert.strictEqual(
    antigravity.wslHomeCoveredByPeer(wslHome, { forcePlatformCheck: true, settings: winSettings, remoteCacheDir: cacheDir }),
    true
  );

  // Local sync disabled → never skip WSL root.
  assert.strictEqual(
    antigravity.wslHomeCoveredByPeer(wslHome, { forcePlatformCheck: true, settings: { sync: { enabled: false } }, remoteCacheDir: cacheDir }),
    false
  );
});

test("antigravity: strips thinking-level and role suffixes from model names", () => {
  const cases = [
    [["gemini-4-neon", "Gemini 4 Neon (XHigh)"], { model: "Gemini 4 Neon", priceKey: "gemini-4-neon" }],
    [["gemini-4-neon", "Gemini 4 Neon (High)"], { model: "Gemini 4 Neon", priceKey: "gemini-4-neon" }],
    [["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"], { model: "Gemini 4 Hydrogen", priceKey: "gemini-4-hydrogen" }],
    [["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"], { model: "Gemini 4 Hydrogen", priceKey: "gemini-4-hydrogen" }],
    [["claude-4-6-opus", "Claude Opus 4.6 (Thinking)"], { model: "Claude Opus 4.6", priceKey: "claude-opus-4.6" }],
    [["gemini-pro-orchestrator", "Gemini 4 Carbon (Orchestrator)"], { model: "Gemini 4 Carbon", priceKey: "gemini-4-carbon" }],
    [["gemini-pro-orchestrator", "Orchestrator (Carbon)"], { model: "Carbon", priceKey: "carbon" }],
    [["gemini-4-hydrogen-xhigh", ""], { model: "gemini-4-hydrogen", priceKey: null }],
  ];
  for (const [[response, display], expected] of cases) {
    assert.deepStrictEqual(antigravity.resolveModelName(response, display), expected, `${response} | ${display}`);
  }
});

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const dsh = require("../src/tools/dsh");
const { matchPrice } = require("../src/pricing");

// Node's zlib zstd bindings (22.15+) are only needed to BUILD fixtures —
// the provider itself decompresses through the pure-JS fzstd package.
const hasZstd = typeof zlib.zstdCompressSync === "function";
const zstdOpts = hasZstd ? {} : { skip: "node:zlib zstd bindings unavailable" };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aum-dsh-test-"));
}

/** Concatenate independently compressed frames — dsh appends a frame per write. */
function zstdMultiFrame(chunks) {
  return Buffer.concat(chunks.map((c) => zlib.zstdCompressSync(Buffer.from(c, "utf8"))));
}

/**
 * files: { "sessions/--G-proj--/session-a/session.v4.jsonl.zstd": [[lines],[lines]], ... }
 * Array value = frames (each a list of line objects); string value = raw bytes.
 */
function sessionHome(files) {
  const home = tmpDir();
  for (const rel of Object.keys(files)) {
    const full = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const v = files[rel];
    if (Buffer.isBuffer(v)) {
      fs.writeFileSync(full, v);
    } else if (rel.endsWith(".zstd")) {
      fs.writeFileSync(
        full,
        zstdMultiFrame(v.map((frame) => frame.map((l) => JSON.stringify(l)).join("\n") + "\n"))
      );
    } else {
      fs.writeFileSync(full, v.flat().map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
  }
  return home;
}

function sessionHeader({ id, cwd }) {
  return { type: "session", version: 4, id, createdAt: 1791531793638, cwd, isSeeded: false };
}

function assistantLine({ msgId, time, model, usage }) {
  return {
    type: "assistant/message",
    seq: 26,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        source: { kind: "model", provider: "deepseek-account", model },
        id: msgId,
      },
      usage,
    },
  };
}

const FLASH_USAGE = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 400,
  cacheWriteTokens: 50,
  totalTokens: 1600,
};
const T1 = 1791774519824;

test("dsh provider: missing sessions dir returns empty without throwing", () => {
  const home = tmpDir();
  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.strictEqual(dsh.isAvailable(home), false);
});

test("dsh provider: parses multi-frame zstd, maps DeepSeek token fields", zstdOpts, () => {
  const home = sessionHome({
    "sessions/--G-3dgs-3DGS--/session-aaa/session.v4.jsonl.zstd": [
      [sessionHeader({ id: "session-aaa", cwd: "G:\\3dgs\\3DGS" })],
      [
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: FLASH_USAGE }),
        // a second frame appended later by the running CLI
      ],
      [assistantLine({ msgId: "m2", time: T1 + 1000, model: "deepseek-flash", usage: { inputTokens: 5, outputTokens: 1 } })],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.meta.errors.length, 0);
  assert.strictEqual(out.records.length, 2);
  // newest first
  const r = out.records[1];
  assert.strictEqual(r.tool, "dsh");
  assert.strictEqual(r.inputOther, 1000);
  assert.strictEqual(r.inputCacheRead, 400);
  assert.strictEqual(r.inputCacheCreation, 50);
  assert.strictEqual(r.output, 200);
  assert.strictEqual(r.model, "deepseek-flash");
  assert.strictEqual(r.modelDisplay, "DeepSeek-V4.1-Flash");
  assert.strictEqual(r.project, "G:\\3dgs\\3DGS");
  assert.strictEqual(r.session, "session-aaa");
  assert.strictEqual(r.time, T1);
  // DeepSeek Flash official pricing (peak/off-peak resolved from record time)
  assert.strictEqual(r.priceId, "deepseek-flash");
  const p = matchPrice("deepseek-flash", { time: T1, inputTokens: 1000 + 400 + 50 });
  const expected =
    (1000 / 1e6) * p.input + (400 / 1e6) * p.cacheHit + (50 / 1e6) * p.cacheWrite + (200 / 1e6) * p.output;
  assert.ok(Math.abs(r.costCny - expected) < 1e-12, `costCny=${r.costCny} expected=${expected}`);
});

test("dsh provider: dedupes assistant messages by message.id", zstdOpts, () => {
  const home = sessionHome({
    "sessions/--G-one--/session-a/session.v4.jsonl.zstd": [
      [
        sessionHeader({ id: "session-a", cwd: "G:\\one" }),
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: FLASH_USAGE }),
        assistantLine({ msgId: "m2", time: T1 + 1, model: "deepseek-flash", usage: FLASH_USAGE }),
      ],
    ],
    "sessions/--G-two--/session-b/session.v4.jsonl.zstd": [
      [
        sessionHeader({ id: "session-b", cwd: "G:\\two" }),
        // duplicate id from another file
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: FLASH_USAGE }),
        assistantLine({ msgId: "m3", time: T1 + 2, model: "deepseek-flash", usage: { inputTokens: 10, outputTokens: 1 } }),
      ],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 3);
});

test("dsh provider: skips zero-usage rows and non-assistant lines", zstdOpts, () => {
  const home = sessionHome({
    "sessions/--G-proj--/session-a/session.v4.jsonl.zstd": [
      [
        sessionHeader({ id: "session-a", cwd: "G:\\proj" }),
        { type: "step/start", seq: 1, time: T1 },
        assistantLine({
          msgId: "m0",
          time: T1,
          model: "deepseek-flash",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: { inputTokens: 5, outputTokens: 1 } }),
      ],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].inputOther, 5);
});

test("dsh provider: corrupt file lands in errors without breaking other files", zstdOpts, () => {
  const home = sessionHome({
    "sessions/--G-bad--/session-bad/session.v4.jsonl.zstd": Buffer.from("not a zstd stream at all"),
    "sessions/--G-good--/session-good/session.v4.jsonl.zstd": [
      [
        sessionHeader({ id: "session-good", cwd: "G:\\good" }),
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: FLASH_USAGE }),
      ],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].project, "G:\\good");
  assert.strictEqual(out.meta.errors.length, 1);
  assert.ok(out.meta.errors[0].file.includes("session-bad"));
});

test("dsh provider: accepts plaintext .jsonl transcripts too", () => {
  const home = sessionHome({
    "sessions/--G-proj--/session-a/session.v4.jsonl": [
      [
        sessionHeader({ id: "session-a", cwd: "G:\\proj" }),
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: FLASH_USAGE }),
      ],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].session, "session-a");
});

test("dsh provider: falls back to dir names when the session header is absent", () => {
  const home = sessionHome({
    "sessions/--G-proj--/session-a/session.v4.jsonl": [
      [assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: { inputTokens: 5, outputTokens: 1 } })],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.records[0].project, "--G-proj--");
  assert.strictEqual(out.records[0].session, "session-a");
});

test("dsh provider: exposes no quota (by design)", zstdOpts, () => {
  const home = sessionHome({
    "sessions/--G-proj--/session-a/session.v4.jsonl.zstd": [
      [
        sessionHeader({ id: "session-a", cwd: "G:\\proj" }),
        assistantLine({ msgId: "m1", time: T1, model: "deepseek-flash", usage: { inputTokens: 5, outputTokens: 1 } }),
      ],
    ],
  });
  const out = dsh.scan(home);
  assert.strictEqual(out.quota, undefined);
});

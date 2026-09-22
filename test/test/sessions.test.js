"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listSessions,
  archiveSession,
  unarchiveSession,
  deleteSession,
  deleteWorkspace,
  getSessionPreview,
  ARCHIVE_DIR,
} = require("../src/sessions");

describe("sessions manager", () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kcd-sess-"));
    const ws = "wd_demo_abcdef12";
    const sid = "session_11111111-2222-3333-4444-555555555555";
    const sessDir = path.join(tmp, "sessions", ws, sid);
    fs.mkdirSync(path.join(sessDir, "agents", "main"), { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, "state.json"),
      JSON.stringify({
        title: "Demo session",
        workDir: "D:/codes/demo",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-02T00:00:00.000Z",
        lastPrompt: "SECRET should not appear",
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(sessDir, "agents", "main", "wire.jsonl"),
      '{"type":"usage.record"}\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmp, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: {
          [ws]: { root: "D:/codes/demo", name: "demo", created_at: "2026-07-01T00:00:00.000Z" },
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmp, "session_index.jsonl"),
      JSON.stringify({
        sessionId: sid,
        sessionDir: sessDir.replace(/\\/g, "/"),
        workDir: "D:/codes/demo",
      }) + "\n",
      "utf8"
    );
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("lists sessions without leaking lastPrompt", () => {
    const res = listSessions(tmp, { status: "all" });
    assert.equal(res.workspaces.length, 1);
    assert.equal(res.sessions.length, 1);
    assert.equal(res.sessions[0].title, "Demo session");
    const blob = JSON.stringify(res);
    assert.equal(blob.includes("SECRET"), false);
    assert.equal(blob.includes("lastPrompt"), false);
  });

  it("archives and unarchives within workspace isolation", () => {
    const ws = "wd_demo_abcdef12";
    const sid = "session_11111111-2222-3333-4444-555555555555";
    archiveSession(tmp, ws, sid);
    const arch = path.join(tmp, "sessions", ARCHIVE_DIR, ws, sid);
    assert.ok(fs.existsSync(arch));
    assert.ok(!fs.existsSync(path.join(tmp, "sessions", ws, sid)));

    let res = listSessions(tmp, { status: "archived", workspace: ws });
    assert.equal(res.sessions.length, 1);
    assert.equal(res.sessions[0].status, "archived");

    unarchiveSession(tmp, ws, sid);
    assert.ok(fs.existsSync(path.join(tmp, "sessions", ws, sid)));
    res = listSessions(tmp, { status: "active", workspace: ws });
    assert.equal(res.sessions.length, 1);
  });

  it("deletes session permanently", () => {
    const ws = "wd_demo_abcdef12";
    const sid = "session_11111111-2222-3333-4444-555555555555";
    deleteSession(tmp, ws, sid, "active");
    assert.ok(!fs.existsSync(path.join(tmp, "sessions", ws, sid)));
    assert.ok(!fs.existsSync(path.join(tmp, "sessions", ARCHIVE_DIR, ws, sid)));
    const res = listSessions(tmp, { status: "all", workspace: ws });
    assert.equal(res.sessions.length, 0);
  });

  it("rejects path escape / bad ids", () => {
    assert.throws(() => archiveSession(tmp, "../etc", "session_x"), /invalid/);
    assert.throws(
      () => archiveSession(tmp, "wd_demo_abcdef12", "../session_x"),
      /invalid/
    );
  });

  it("deletes empty workspace only", () => {
    const emptyWs = "wd_empty_deadbeef";
    const emptyDir = path.join(tmp, "sessions", emptyWs);
    fs.mkdirSync(emptyDir, { recursive: true });
    // non-empty should fail
    const filled = "wd_demo_abcdef12";
    // recreate a session so filled is not empty after previous delete test
    // (previous test already deleted the only session — ensure empty filled or skip)
    const filledActive = path.join(tmp, "sessions", filled);
    fs.mkdirSync(filledActive, { recursive: true });
    // filled has no sessions now → also empty; create one
    const sid2 = "session_22222222-2222-4222-8222-222222222222";
    fs.mkdirSync(path.join(filledActive, sid2), { recursive: true });
    fs.writeFileSync(
      path.join(filledActive, sid2, "state.json"),
      JSON.stringify({ title: "keep" }),
      "utf8"
    );

    assert.throws(() => deleteWorkspace(tmp, filled), /not empty|not_empty/i);
    const out = deleteWorkspace(tmp, emptyWs);
    assert.equal(out.ok, true);
    assert.ok(!fs.existsSync(emptyDir));
  });

  it("previews session messages without secrets", () => {
    const ws = "wd_demo_abcdef12";
    const sid = "session_22222222-2222-4222-8222-222222222222";
    const wireDir = path.join(tmp, "sessions", ws, sid, "agents", "main");
    fs.mkdirSync(wireDir, { recursive: true });
    const lines = [
      // Duplicate user path: turn.prompt + append_message (should dedupe)
      JSON.stringify({
        type: "turn.prompt",
        input: [{ type: "text", text: "hello preview" }],
        time: 1,
      }),
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello preview" }],
        },
        time: 2,
      }),
      // Assistant lives in content.part stream, not role=assistant messages
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "content.part",
          turnId: "0",
          step: 1,
          stepUuid: "step-1",
          part: { type: "think", think: "hidden reasoning" },
        },
        time: 3,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "content.part",
          turnId: "0",
          step: 1,
          stepUuid: "step-1",
          part: { type: "text", text: "hi " },
        },
        time: 4,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "content.part",
          turnId: "0",
          step: 1,
          stepUuid: "step-1",
          part: { type: "text", text: "there" },
        },
        time: 5,
      }),
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "step.end", turnId: "0", step: 1, stepUuid: "step-1" },
        time: 6,
      }),
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "api_key = sk-ABCDEFGHIJKLMNOP" }],
        },
        time: 7,
      }),
    ];
    fs.writeFileSync(path.join(wireDir, "wire.jsonl"), lines.join("\n"), "utf8");
    const prev = getSessionPreview(tmp, ws, sid, "active");
    // 1 user (deduped) + 1 assistant + 1 redacted user
    assert.equal(prev.messages.length, 3);
    assert.equal(prev.messages[0].role, "user");
    assert.equal(prev.messages[0].text.includes("hello"), true);
    assert.equal(prev.messages[1].role, "assistant");
    assert.equal(prev.messages[1].text, "hi there");
    assert.equal(prev.messages[1].text.includes("hidden reasoning"), false);
    const blob = JSON.stringify(prev);
    assert.equal(blob.includes("sk-ABCDEF"), false);
  });
});

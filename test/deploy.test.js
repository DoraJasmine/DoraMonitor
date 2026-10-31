"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs } = require("../scripts/deploy");

test("source deployment defaults to a local build without starting", () => {
  assert.deepEqual(parseArgs([]), { install: true, start: false, background: false, host: "127.0.0.1", port: 3847, help: false });
});

test("source deployment accepts detached startup and existing dependencies", () => {
  const opts = parseArgs(["--skip-install", "--background", "--host", "::1", "--port", "3848"]);
  assert.equal(opts.install, false);
  assert.equal(opts.background, true);
  assert.equal(opts.host, "::1");
  assert.equal(opts.port, 3848);
});

test("source deployment rejects conflicting or invalid options", () => {
  assert.throws(() => parseArgs(["--start", "--background"]), /cannot be used together/);
  assert.throws(() => parseArgs(["--port", "0"]), /1 to 65535/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

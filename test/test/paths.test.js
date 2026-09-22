"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { resolveKimiHome, expandHome } = require("../src/paths");

describe("paths", () => {
  it("expands ~", () => {
    assert.equal(expandHome("~/foo"), path.join(os.homedir(), "foo"));
  });

  it("uses KIMI_CODE_HOME when set", () => {
    const prev = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = path.join(os.tmpdir(), "kimi-home-test");
    try {
      const h = resolveKimiHome(null);
      assert.equal(h, path.resolve(process.env.KIMI_CODE_HOME));
    } finally {
      if (prev === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = prev;
    }
  });

  it("override wins over env", () => {
    const prev = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = path.join(os.tmpdir(), "env-home");
    try {
      const override = path.join(os.tmpdir(), "override-home");
      assert.equal(resolveKimiHome(override), path.resolve(override));
    } finally {
      if (prev === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = prev;
    }
  });
});

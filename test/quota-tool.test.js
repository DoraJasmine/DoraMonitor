"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createQuotaIntegrationRegistry, normalizeQuotaTool, quotaProviderForTool, toolForQuotaProvider, resolveQuotaTool, resolveQuotaAccount } = require("../src/quota-tool");

test("quota tool mapping is explicit in both directions", () => {
  assert.equal(normalizeQuotaTool("kimi-code"), "kimi-code");
  assert.equal(normalizeQuotaTool("codex"), "codex");
  assert.equal(normalizeQuotaTool("kimi"), null);
  assert.equal(quotaProviderForTool("kimi-code"), "kimi");
  assert.equal(quotaProviderForTool("codex"), "openai");
  assert.equal(toolForQuotaProvider("kimi"), "kimi-code");
  assert.equal(toolForQuotaProvider("openai"), "codex");
  assert.equal(quotaProviderForTool("zcode"), "zcode");
  assert.equal(quotaProviderForTool("unknown"), null);
});

test("new tool and legacy provider requests resolve to the same tool", () => {
  assert.equal(resolveQuotaTool({ tool: "codex" }), "codex");
  assert.equal(resolveQuotaTool({ provider: "openai" }), "codex");
  assert.equal(resolveQuotaTool({ tool: "kimi-code", provider: "kimi" }), "kimi-code");
  assert.equal(resolveQuotaTool({}), "kimi-code");
});

test("conflicting tool and legacy provider is rejected", () => {
  assert.throws(() => resolveQuotaTool({ tool: "codex", provider: "kimi" }), (error) => {
    assert.equal(error.code, "conflicting_tool_provider");
    assert.equal(error.status, 400);
    return true;
  });
});

test("unknown tools never fall back to Kimi", () => {
  assert.throws(() => resolveQuotaTool({ tool: "unknown" }), /Unsupported quota tool/);
  assert.throws(() => resolveQuotaTool({ provider: "unknown" }), /Unsupported quota provider/);
});

test("HTTP quota routes reject unknown and conflicting identities before reading data", async (context) => {
  const { createServer } = require("../src/server");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    ["/api/quota?tool=unknown", "unsupported_tool"],
    ["/api/quota/capacity/history?tool=codex&provider=kimi", "conflicting_tool_provider"],
    ["/api/quota/samples?tool=unknown", "unsupported_tool"],
  ];
  for (const [path, code] of cases) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, code);
  }
  const calibration = await fetch(`${base}/api/quota/capacity/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "codex", provider: "kimi", action: "cancel", window: "session" }),
  });
  assert.equal(calibration.status, 400);
  assert.equal((await calibration.json()).error, "conflicting_tool_provider");
});

test("a future quota integration registers without changing existing tools", () => {
  const registry = createQuotaIntegrationRegistry();
  registry.register({ tool: "zcode", quotaProvider: "zcode", capabilities: { windows: ["daily"], estimation: false } });
  assert.equal(registry.get("zcode").quotaProvider, "zcode");
  assert.deepEqual(registry.get("zcode").capabilities.windows, ["daily"]);
  assert.equal(registry.get("kimi-code"), null);
  assert.throws(() => registry.register({ tool: "zcode", quotaProvider: "other", capabilities: {} }), /Duplicate/);
});

test("account resolution isolates multiple accounts and never guesses", () => {
  const accounts = ["kimi:default", "kimi:work"];
  assert.equal(resolveQuotaAccount({ accountKey: "kimi:work", accounts }), "kimi:work");
  assert.throws(() => resolveQuotaAccount({ accounts }), (error) => error.code === "account_required");
  assert.throws(() => resolveQuotaAccount({ accountKey: "kimi:other", accounts }), (error) => error.code === "account_unavailable");
  assert.equal(resolveQuotaAccount({ accounts: ["kimi:default"] }), "kimi:default");
});

"use strict";

/**
 * Gemini CLI provider tests — the OTel file-export NDJSON parser.
 * Fixtures mirror real ExportMetricsServiceRequest lines: cumulative token
 * counters per (model, type), diffed into per-scan records; a decreasing
 * counter means a fresh CLI process and re-seeds from the new total.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const gemini = require("../src/providers/gemini");
const { matchPrice } = require("../src/pricing");

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function enableTelemetry(home, outfile) {
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ telemetry: { enabled: true, target: "local", outfile } })
  );
}

/** One OTLP metrics line with a counter data point. */
function metricLine(name, attributes, value, timeNano) {
  return JSON.stringify({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                sum: { dataPoints: [{ attributes, asInt: String(value), timeUnixNano: String(timeNano) }] },
              },
            ],
          },
        ],
      },
    ],
  });
}

const T0 = 1_792_000_000_000;
const attrs = (model, type) => [
  { key: "model", value: { stringValue: model } },
  { key: "type", value: { stringValue: type } },
];

function writeLines(home, lines) {
  fs.appendFileSync(path.join(home, "otel.jsonl"), lines.join("\n") + "\n");
}

test("gemini provider: unavailable without settings/telemetry", () => {
  const home = tmpHome("gemini-off-");
  assert.strictEqual(gemini.isAvailable(home), false);
  const out = gemini.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.ok(out.meta.errors.length >= 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("gemini provider: diffs cumulative counters into records", () => {
  const home = tmpHome("gemini-diff-");
  const outfile = path.join(home, "otel.jsonl");
  enableTelemetry(home, outfile);

  // First export: cumulative 1000 input, 200 output, 500 cache.
  writeLines(home, [
    metricLine("gemini_cli.token.usage", attrs("gemini-3.1-pro-preview", "input"), 1000, T0 * 1e6),
    metricLine("gemini_cli.token.usage", attrs("gemini-3.1-pro-preview", "output"), 200, T0 * 1e6),
    metricLine("gemini_cli.token.usage", attrs("gemini-3.1-pro-preview", "cache"), 500, T0 * 1e6),
    metricLine("gemini_cli.token.usage", attrs("gemini-3.1-pro-preview", "thought"), 50, T0 * 1e6),
  ]);
  const first = gemini.scan(home);
  assert.strictEqual(first.records.length, 4, "one record per (model,type)");
  const input = first.records.find((r) => r.inputOther > 0);
  assert.strictEqual(input.inputOther, 1000);
  // thought is its own counter type — a separate record, also billed output.
  const out = first.records.filter((r) => r.output > 0);
  assert.strictEqual(out.length, 2, "output + thought records");
  assert.strictEqual(out.reduce((s, r) => s + r.output, 0), 250);
  const cache = first.records.find((r) => r.inputCacheRead > 0);
  assert.strictEqual(cache.inputCacheRead, 500);
  assert.strictEqual(cache.inputOther, 0, "cache type is not plain input");
  assert.ok(cache.costCny > 0);
  assert.strictEqual(cache.priceId, "gemini-3.1-pro");
  assert.ok(first.records.every((r) => r.time === T0));

  // Second export: cumulative grows (input +500) → delta 500.
  writeLines(home, [
    metricLine("gemini_cli.token.usage", attrs("gemini-3.1-pro-preview", "input"), 1500, T0 * 2e6),
  ]);
  const second = gemini.scan(home);
  assert.strictEqual(second.records.length, 1);
  assert.strictEqual(second.records[0].inputOther, 500);
  assert.strictEqual(second.records[0].time, T0 * 2);

  fs.rmSync(home, { recursive: true, force: true });
});

test("gemini provider: decreasing counter means a new session", () => {
  const home = tmpHome("gemini-new-");
  const outfile = path.join(home, "otel.jsonl");
  enableTelemetry(home, outfile);
  writeLines(home, [
    metricLine("gemini_cli.token.usage", attrs("gemini-3-flash", "input"), 5000, T0 * 1e6),
  ]);
  gemini.scan(home);
  // CLI restart: counter resets below the previous cumulative.
  writeLines(home, [
    metricLine("gemini_cli.token.usage", attrs("gemini-3-flash", "input"), 700, T0 * 3e6),
  ]);
  const out = gemini.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].inputOther, 700);
  fs.rmSync(home, { recursive: true, force: true });
});

test("gemini provider: tool.call counter folds into events", () => {
  const home = tmpHome("gemini-tool-");
  const outfile = path.join(home, "otel.jsonl");
  enableTelemetry(home, outfile);
  writeLines(home, [
    metricLine("gemini_cli.tool.call.count", [{ key: "function_name", value: { stringValue: "google_web_search" } }], 3, T0 * 1e6),
  ]);
  const out = gemini.scan(home);
  assert.strictEqual(out.events.length, 1);
  assert.strictEqual(out.events[0].eventName, "google_web_search");
  assert.strictEqual(out.events[0].kind, "event");
  fs.rmSync(home, { recursive: true, force: true });
});

test("gemini provider: bad lines are skipped without throwing", () => {
  const home = tmpHome("gemini-bad-");
  const outfile = path.join(home, "otel.jsonl");
  enableTelemetry(home, outfile);
  fs.writeFileSync(
    path.join(home, "otel.jsonl"),
    ["not json at all", JSON.stringify({ resourceMetrics: [] })].join("\n") + "\n"
  );
  const out = gemini.scan(home);
  assert.strictEqual(out.records.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test("gemini pricing: announced rates", () => {
  const pro = matchPrice("gemini-3.1-pro-preview", { fxRate: 6.67 });
  assert.equal(pro.id, "gemini-3.1-pro");
  assert.equal(pro.input, 2.0 * 6.67);
  // Long-context tier at 200K — same shape as the OpenAI modifier.
  const long = matchPrice("gemini-3.1-pro-preview", { fxRate: 6.67, inputTokens: 250_000 });
  assert.equal(long.input, 4.0 * 6.67);
  const flash = matchPrice("gemini-3.8-flash", { fxRate: 6.67 });
  assert.equal(flash.cacheHit, 0.075 * 6.67);
});

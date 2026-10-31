"use strict";

/**
 * Canonical usage-record schema — the versioned contract between the tool
 * collectors, aggregation, and the store (M3.5 ②).
 *
 * Rules:
 *   - Collectors build records via `emptyRecord()` (schema defaults) and may
 *     only set fields declared here. Adding a field = adding ONE entry here
 *     (+ a store migration when it must be queryable) — never a cross-layer
 *     field hunt.
 *   - `validateRecord()` runs at the store ingest boundary: malformed records
 *     are skipped and counted, never silently folded.
 *   - Extra keys (e.g. `requests` on peer summaries, display hints) are
 *     tolerated; validation only guards the declared contract.
 */

const RECORD_FIELDS = [
  { key: "tool", type: "string", required: true },
  { key: "time", type: "number", required: true, doc: "epoch ms; 0 = unknown time" },
  { key: "device", type: "string", default: "local", doc: 'local scans "local"; peers named by sync' },
  { key: "model", type: "string", default: "unknown" },
  { key: "modelDisplay", type: "string", default: "unknown" },
  { key: "modelResolved", type: "string", nullable: true, doc: "pricing identity" },
  { key: "modelProvider", type: "string", nullable: true, doc: "upstream vendor when the tool records one" },
  { key: "inputOther", type: "number", default: 0 },
  { key: "output", type: "number", default: 0 },
  { key: "inputCacheRead", type: "number", default: 0 },
  { key: "inputCacheCreation", type: "number", default: 0 },
  { key: "inputCacheCreationShort", type: "number", nullable: true },
  { key: "inputCacheCreationLong", type: "number", nullable: true },
  { key: "costCny", type: "number", default: 0 },
  { key: "costEstimated", type: "boolean", default: false },
  { key: "priceId", type: "string", nullable: true },
  { key: "credits", type: "number", nullable: true },
  { key: "project", type: "string", nullable: true, doc: "cwd or wd_* id — workspace source" },
  { key: "session", type: "string", nullable: true },
  { key: "sessionHint", type: "any", nullable: true, doc: "display-only; string or {workspace, session}" },
  { key: "requests", type: "number", nullable: true, doc: "peer day-summaries carry N original requests; local = 1" },
];

const FIELD_BY_KEY = new Map(RECORD_FIELDS.map((f) => [f.key, f]));

function typeOk(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "any":
      return true;
    default:
      return false;
  }
}

/**
 * Validate one record against the schema. Returns { ok, errors } — `errors`
 * lists human-readable problems; empty when valid.
 */
function validateRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== "object") {
    return { ok: false, errors: ["record is not an object"] };
  }
  for (const field of RECORD_FIELDS) {
    const value = rec[field.key];
    if (value === undefined || value === null) {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }
    if (!typeOk(field.type, value)) {
      errors.push(`${field.key} must be ${field.type}, got ${typeof value}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Schema-defaulted record factory (the single emptyRecord implementation). */
function emptyRecord(tool) {
  const rec = {};
  for (const field of RECORD_FIELDS) {
    if (field.key === "tool") continue;
    if (field.default !== undefined) rec[field.key] = field.default;
    else if (field.nullable || field.type === "any") rec[field.key] = null;
    else if (field.type === "number") rec[field.key] = 0;
  }
  rec.tool = tool;
  return rec;
}

module.exports = {
  RECORD_FIELDS,
  validateRecord,
  emptyRecord,
};

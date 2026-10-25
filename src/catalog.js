"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { loadConfig, saveConfig, ConfigError } = require("./config-store");

/**
 * models.dev-style provider catalog (https://models.dev/api.json).
 *
 * Runtime flow mirrors kimi-code's fetchCatalogOrBuiltIn: try the live
 * catalog first, fall back to a persisted full snapshot, then to the bundled
 * snapshot (src/data/builtin-catalog.json) when the network is unavailable.
 * All three are stripped to the same field whitelist kimi-code uses, so
 * import behaves identically on any source.
 */

/**
 * models.dev official data via the gh-proxy.org mirror of the JochenYang fork
 * (raw.githubusercontent content, full snapshot, reasoning_options kept). The
 * fork tracks models.dev closely; the bundled snapshot is the offline
 * fallback. raw.githubusercontent is the canonical content URL — a /blob/
 * page URL only works because gh-proxy happens to rewrite it to raw, which
 * is too implicit to rely on.
 */
const DEFAULT_CATALOG_URL =
  "https://gh-proxy.org/https://raw.githubusercontent.com/JochenYang/models.dev/main/api.json";
const BUILTIN_PATH = path.join(__dirname, "data", "builtin-catalog.json");
/** Persisted full snapshot written after each successful remote fetch. */
const DEFAULT_CACHE_FILE = path.join(
  os.homedir(),
  ".kimicode-dashboard",
  "catalog-cache.json"
);

const KEEP_PROVIDER = ["id", "name", "api", "env", "npm", "type", "models"];
const KEEP_MODEL = [
  "id",
  "name",
  "family",
  "limit",
  "tool_call",
  "reasoning",
  "reasoning_options",
  "interleaved",
  "modalities",
  "dynamically_loaded_tools",
  "status",
];

const PROVIDER_TYPES = [
  "kimi",
  "anthropic",
  "openai",
  "openai_responses",
  "google-genai",
  "vertexai",
];

let cache = { at: 0, data: null };

function stripEntry(entry, keep) {
  const out = {};
  for (const k of keep) {
    if (entry && entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
}

/** Reduce a full models.dev/api.json document to the field whitelist. */
function stripCatalog(raw) {
  const providers = [];
  if (!raw || typeof raw !== "object") return providers;
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== "object") continue;
    const entry = stripEntry(p, KEEP_PROVIDER);
    entry.id = entry.id || id;
    if (p.models && typeof p.models === "object") {
      entry.models = {};
      for (const [mid, m] of Object.entries(p.models)) {
        if (!m || typeof m !== "object") continue;
        const model = stripEntry(m, KEEP_MODEL);
        model.id = model.id || mid;
        entry.models[mid] = model;
      }
    }
    providers.push(entry);
  }
  return providers;
}

function loadBuiltin() {
  let text;
  try {
    text = fs.readFileSync(BUILTIN_PATH, "utf8");
  } catch (err) {
    throw new ConfigError("catalog_missing", `Builtin catalog missing: ${err.message}`);
  }
  const raw = JSON.parse(text);
  // Strip-format snapshot ({ fetchedAt, providers }) — same shape as the
  // persisted cache, so the full models.dev mirror can ship as the bundled
  // fallback. Legacy raw-document snapshots still go through stripCatalog.
  if (raw && typeof raw === "object" && Array.isArray(raw.providers)) {
    return { source: "builtin", fetchedAt: null, providers: raw.providers };
  }
  return { source: "builtin", fetchedAt: null, providers: stripCatalog(raw) };
}

function httpGetJson(url, { timeoutMs = 15000, userAgent = "kimicode-dashboard/1.6.4" } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": userAgent } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`catalog http ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("catalog timeout")));
    req.on("error", reject);
  });
}

/**
 * Persisted snapshot of the last successful remote fetch:
 * `{ fetchedAt: number, providers: stripped[] }`. Read/write failures are
 * silent — a broken cache must never break the catalog path. Accepts the
 * Tauri-written `fetched_at` spelling for cross-shell cache sharing.
 */
function readDiskCache(cacheFile) {
  if (!cacheFile) return null;
  let raw;
  try {
    raw = fs.readFileSync(cacheFile, "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || !Array.isArray(data.providers)) {
      return null;
    }
    const fetchedAt =
      typeof data.fetchedAt === "number"
        ? data.fetchedAt
        : typeof data.fetched_at === "number"
          ? data.fetched_at
          : null;
    if (fetchedAt === null) return null;
    return { fetchedAt, providers: data.providers };
  } catch {
    return null;
  }
}

function writeDiskCache(cacheFile, providers, fetchedAt) {
  if (!cacheFile) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ fetchedAt, providers }, null, 2),
      "utf8"
    );
  } catch {
    // Non-fatal: the in-memory cache still serves this request.
  }
}

/**
 * Fetch the live catalog, falling back to the persisted snapshot, then the
 * bundled snapshot. Returns { source: 'remote'|'cached'|'builtin', fetchedAt,
 * providers }. `cacheFile`/`url` are injectable for tests.
 */
async function fetchCatalogOrBuiltIn({
  force = false,
  cacheFile = DEFAULT_CACHE_FILE,
  url = DEFAULT_CATALOG_URL,
} = {}) {
  const cacheTtl = 60_000;
  if (!force && cache.data && Date.now() - cache.at < cacheTtl) {
    return cache.data;
  }
  try {
    const raw = await httpGetJson(url);
    const providers = stripCatalog(raw);
    writeDiskCache(cacheFile, providers, Date.now());
    const data = { source: "remote", fetchedAt: Date.now(), providers };
    cache = { at: Date.now(), data };
    return data;
  } catch {
    const disk = readDiskCache(cacheFile);
    if (disk) {
      const data = { source: "cached", fetchedAt: disk.fetchedAt, providers: disk.providers };
      cache = { at: Date.now(), data };
      return data;
    }
    const data = loadBuiltin();
    cache = { at: Date.now(), data };
    return data;
  }
}

// ---------------------------------------------------------------------------
// Normalization for UI + import
// ---------------------------------------------------------------------------

function isChatModel(m) {
  if (!m || typeof m !== "object") return false;
  const out = m.modalities && m.modalities.output;
  if (Array.isArray(out) && out.length > 0 && !out.includes("text")) return false;
  const id = String(m.id || "").toLowerCase();
  if (id.includes("embedding") || /(?:^|[-_/])embed(?:$|[-_/])/.test(id)) return false;
  const status = String(m.status || "").toLowerCase();
  if (status === "deprecated" || status === "alpha") return false;
  return true;
}

/**
 * Mirrors kosong's catalogThinkingOptions: reads `reasoning_options` into
 * selectable effort levels, the wire-level "off" value, and the always-on
 * flag. `'none'` is the disable tier and becomes `offEffort`, never a level.
 */
function catalogThinkingOptions(reasoningOptions) {
  if (!Array.isArray(reasoningOptions)) {
    return { efforts: undefined, offEffort: undefined, hasToggle: false, alwaysThinking: undefined };
  }
  let efforts;
  let offEffort;
  let hasToggle = false;
  for (const option of reasoningOptions) {
    if (option && option.type === "toggle") {
      hasToggle = true;
      continue;
    }
    if (!option || option.type !== "effort" || !Array.isArray(option.values)) continue;
    const hasNullTier = option.values.some((v) => v === null);
    const levels = option.values.filter((v) => typeof v === "string" && v.length > 0);
    const off = levels.find((v) => v.toLowerCase() === "none");
    if (off !== undefined) offEffort = off;
    else if (hasNullTier) offEffort = "none";
    const selectable = levels.filter((v) => v.toLowerCase() !== "none");
    if (selectable.length > 0) efforts = selectable;
  }
  const alwaysThinking =
    efforts !== undefined && offEffort === undefined && !hasToggle ? true : undefined;
  return { efforts, offEffort, hasToggle, alwaysThinking };
}

function catalogReasoningKey(interleaved) {
  if (typeof interleaved !== "object" || interleaved === null) return undefined;
  const field = interleaved.field && interleaved.field.trim();
  return field && field.length > 0 ? field : undefined;
}

/**
 * Normalize one catalog model (mirrors kosong's catalogModelToCapability).
 * Returns undefined for invalid entries. `capabilities` follows the official
 * wire order: image_in, video_in, audio_in, thinking, tool_use.
 */
function normalizeCatalogModel(m) {
  if (!m || typeof m.id !== "string" || m.id.length === 0) return undefined;
  const context = m.limit && m.limit.context;
  if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) return undefined;
  if (!isChatModel(m)) return undefined;
  const inputs = Array.isArray(m.modalities && m.modalities.input) ? m.modalities.input : [];
  const output = m.limit && m.limit.output;
  const thinking = catalogThinkingOptions(m.reasoning_options);
  const input = m.limit && m.limit.input;
  const maxInputTokens =
    typeof input === "number" && Number.isInteger(input) && input > 0
      ? Math.min(input, context)
      : undefined;
  const caps = [];
  if (inputs.includes("image")) caps.push("image_in");
  if (inputs.includes("video")) caps.push("video_in");
  if (inputs.includes("audio")) caps.push("audio_in");
  if (Boolean(m.reasoning) || thinking.efforts !== undefined || thinking.hasToggle) {
    caps.push("thinking");
  }
  if (m.tool_call !== false) caps.push("tool_use");
  if (m.dynamically_loaded_tools === true) caps.push("dynamically_loaded_tools");
  return {
    id: m.id,
    name: typeof m.name === "string" && m.name.length > 0 ? m.name : undefined,
    context,
    maxInputSize: maxInputTokens,
    maxOutputSize: typeof output === "number" && output > 0 ? output : undefined,
    reasoningKey: catalogReasoningKey(m.interleaved),
    supportEfforts: thinking.efforts,
    offEffort: thinking.offEffort,
    alwaysThinking: thinking.alwaysThinking,
    capabilities: caps.length > 0 ? caps : undefined,
  };
}

/**
 * Usable chat models for a catalog provider, normalized for display/import.
 * Returns [{ id, name, context, maxInputSize, maxOutputSize, capabilities,
 * supportEfforts, offEffort, alwaysThinking, reasoningKey }].
 */
function catalogProviderModels(providerEntry) {
  if (!providerEntry || !providerEntry.models || typeof providerEntry.models !== "object") {
    return [];
  }
  const out = [];
  for (const m of Object.values(providerEntry.models)) {
    const model = normalizeCatalogModel(m);
    if (model) out.push(model);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Resolve the wire type for a catalog provider: explicit type when it is one
 * of the supported protocols, otherwise OpenAI-compatible (guessed).
 */
function catalogProviderType(providerEntry) {
  const declared = providerEntry && providerEntry.type;
  if (declared && PROVIDER_TYPES.includes(declared)) {
    return { type: declared, guessed: false };
  }
  return { type: "openai", guessed: true };
}

function normalizeUrl(v) {
  if (v === undefined || v === null || String(v).trim() === "") return undefined;
  const url = String(v).trim();
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/**
 * Import a catalog provider into config.toml in one atomic write:
 * creates [providers.<id>] and the `<id>/<modelId>` aliases for every usable
 * model, then points default_model at the chosen model if provided. Model
 * metadata (context, output limit, capabilities, efforts) comes from the
 * catalog so the user does not hand-write it — same as kimi-code's
 * applyCatalogProvider.
 */
function importCatalogProvider(home, { providerId, apiKey, baseUrl, defaultModel }) {
  const key = normalizeProviderKey(providerId);
  const catalog = cache.data || loadBuiltin();
  const providerEntry = catalog.providers.find((p) => p.id === key);
  if (!providerEntry) {
    throw new ConfigError("not_found", `Provider "${key}" is not in the catalog`);
  }
  const { type, guessed } = catalogProviderType(providerEntry);
  const models = catalogProviderModels(providerEntry);
  if (models.length === 0) {
    throw new ConfigError("no_models", `No usable chat models for "${key}"`);
  }

  const doc = loadConfig(home);
  if (!doc.providers || typeof doc.providers !== "object") doc.providers = {};
  const entry = doc.providers[key] && typeof doc.providers[key] === "object"
    ? doc.providers[key]
    : {};
  doc.providers[key] = entry;
  entry.type = type;
  const apiKeyVal = String(apiKey || "").trim();
  if (apiKeyVal !== "") entry.api_key = apiKeyVal;
  const url = normalizeUrl(baseUrl) || normalizeUrl(providerEntry.api);
  if (url) entry.base_url = url;
  else delete entry.base_url;

  if (!doc.models || typeof doc.models !== "object") doc.models = {};
  for (const m of models) {
    const alias = `${key}/${m.id}`;
    const modelEntry = doc.models[alias] && typeof doc.models[alias] === "object"
      ? doc.models[alias]
      : {};
    // Official [models] alias shape — `provider` + `max_context_size` are
    // required by kimi-code's schema (entries failing them get dropped).
    modelEntry.provider = key;
    delete modelEntry.provider_id;
    modelEntry.model = m.id;
    if (m.name && m.name !== m.id) modelEntry.display_name = m.name;
    modelEntry.max_context_size = m.context;
    if (m.maxInputSize) modelEntry.max_input_size = m.maxInputSize;
    if (m.maxOutputSize) modelEntry.max_output_size = m.maxOutputSize;
    if (m.reasoningKey) modelEntry.reasoning_key = m.reasoningKey;
    if (m.supportEfforts) modelEntry.support_efforts = [...m.supportEfforts];
    if (m.offEffort) modelEntry.off_effort = m.offEffort;
    // kimi-code defaults the effort to "high" when the model supports it
    // (modelAuth.ts); persist it so the config is explicit and self-contained.
    if (
      m.supportEfforts &&
      m.supportEfforts.includes("high") &&
      modelEntry.default_effort === undefined
    ) {
      modelEntry.default_effort = "high";
    }
    if (m.capabilities) {
      modelEntry.capabilities =
        m.alwaysThinking === true
          ? m.capabilities.map((c) => (c === "thinking" ? "always_thinking" : c))
          : [...m.capabilities];
    }
    doc.models[alias] = modelEntry;
  }
  const defaultAlias =
    defaultModel && defaultModel !== "" ? `${key}/${String(defaultModel).trim()}` : undefined;
  if (defaultAlias && doc.models[defaultAlias]) {
    doc.default_model = defaultAlias;
  }
  if (typeof doc.default_provider !== "string") doc.default_provider = key;

  saveConfig(home, doc);
  return {
    providerId: key,
    type,
    guessed,
    modelsImported: models.length,
    defaultModel: doc.default_model || null,
  };
}

function normalizeProviderKey(id) {
  const cleaned = String(id).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) {
    throw new ConfigError("invalid_id", "Provider id may only contain letters, digits, '-' and '_'");
  }
  return cleaned;
}

module.exports = {
  DEFAULT_CATALOG_URL,
  BUILTIN_PATH,
  DEFAULT_CACHE_FILE,
  readDiskCache,
  writeDiskCache,
  stripCatalog,
  loadBuiltin,
  fetchCatalogOrBuiltIn,
  catalogProviderModels,
  catalogProviderType,
  importCatalogProvider,
};

"use strict";

const fs = require("fs");
const path = require("path");
const { parse: parseToml, stringify: stringifyToml } = require("smol-toml");
const { configPath } = require("./paths");

/**
 * Safe read/write of Kimi Code config.toml.
 *
 * The file is parsed as a whole with smol-toml (same library kimi-code uses),
 * only the model-setting sections are touched, and everything else (hooks,
 * permission, thinking, unknown sections) is preserved verbatim by writing the
 * full document back. Secrets are never returned by the view API — api_key
 * becomes `has_api_key`, env values are dropped.
 *
 * Disk format is snake_case, matching kimi-code's config.toml:
 *   [providers.<id>]  type / api_key / base_url / env / custom_headers / default_model
 *   [models.<alias>]  provider / model / max_context_size / capabilities / ...
 *   default_model     top-level string, references a [models] alias
 *   [secondary_model] model + optional patch fields
 */

const PROVIDER_TYPES = [
  "kimi",
  "anthropic",
  "openai",
  "openai_responses",
  "google-genai",
  "vertexai",
];

/** Aliases with this prefix are reserved by the runtime (env model, derived secondary). */
const RESERVED_ALIAS_PREFIX = "__";

class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Load the full parsed config document. Missing or empty file → {} */
function loadConfig(home) {
  const p = configPath(home);
  if (!fs.existsSync(p)) return {};
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new ConfigError("read_failed", `Cannot read ${p}: ${err.message}`);
  }
  if (text.trim() === "") return {};
  try {
    return parseToml(text);
  } catch (err) {
    throw new ConfigError("invalid_toml", `config.toml is not valid TOML: ${err.message}`);
  }
}

/** Serialize + write the full document atomically, keeping one backup. */
function saveConfig(home, data) {
  const p = configPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, `${p}.kcd-bak`);
    } catch {
      // Backup is best-effort — never block a save on it.
    }
  }
  const body = stringifyToml(data);
  const out = body === "" ? "" : `${body}\n`;
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.tmp-${process.pid}-${Date.now()}`
  );
  try {
    fs.writeFileSync(tmp, out, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw new ConfigError("write_failed", `Cannot write ${p}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Normalization & validation
// ---------------------------------------------------------------------------

function normalizeId(raw, label) {
  const id = String(raw || "").trim();
  if (!id) throw new ConfigError("invalid_id", `${label} must not be empty`);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ConfigError(
      "invalid_id",
      `${label} may only contain letters, digits, '-' and '_'`
    );
  }
  return id;
}

function normalizeAlias(raw) {
  const alias = String(raw || "").trim();
  if (!alias) throw new ConfigError("invalid_alias", "Model alias must not be empty");
  if (alias.startsWith(RESERVED_ALIAS_PREFIX)) {
    throw new ConfigError(
      "invalid_alias",
      `Alias may not start with "${RESERVED_ALIAS_PREFIX}" (reserved by the runtime)`
    );
  }
  return alias;
}

function normalizeProviderType(raw) {
  const type = String(raw || "").trim();
  if (!PROVIDER_TYPES.includes(type)) {
    throw new ConfigError(
      "invalid_type",
      `Provider type must be one of: ${PROVIDER_TYPES.join(", ")}`
    );
  }
  return type;
}

function positiveInt(raw, label, { required = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (required) {
      throw new ConfigError("invalid_value", `${label} is required`);
    }
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new ConfigError("invalid_value", `${label} must be a positive integer`);
  }
  return n;
}

function stringList(raw, label) {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v).trim()).filter(Boolean)
    : [String(raw).trim()].filter(Boolean);
  return [...new Set(list)];
}

function boolOf(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return raw === true || raw === "true" || raw === "1";
}

/** Normalize + validate a provider entry for [providers.<id>]. */
function normalizeProviderEntry(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError("invalid_provider", "Provider must be an object");
  }
  const entry = {};
  if (raw.type !== undefined) entry.type = normalizeProviderType(raw.type);
  if (raw.api_key !== undefined) entry.api_key = String(raw.api_key);
  if (raw.base_url !== undefined) {
    const url = String(raw.base_url).trim();
    if (url !== "" && !/^https?:\/\//i.test(url)) {
      throw new ConfigError("invalid_url", "base_url must start with http(s)://");
    }
    entry.base_url = url;
  }
  if (raw.default_model !== undefined) entry.default_model = String(raw.default_model);
  if (isPlainObject(raw.env)) {
    const env = {};
    for (const [k, v] of Object.entries(raw.env)) env[k] = String(v);
    entry.env = env;
  }
  if (isPlainObject(raw.custom_headers)) {
    const headers = {};
    for (const [k, v] of Object.entries(raw.custom_headers)) headers[k] = String(v);
    entry.custom_headers = headers;
  }
  return entry;
}

/** Normalize + validate a model entry for [models.<alias>]. */
function normalizeModelEntry(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError("invalid_model", "Model must be an object");
  }
  const entry = {};
  if (raw.model !== undefined) entry.model = String(raw.model);
  if (raw.name !== undefined) entry.name = String(raw.name);
  if (raw.provider !== undefined) entry.provider = String(raw.provider);
  if (raw.provider_id !== undefined) entry.provider_id = String(raw.provider_id);
  if (raw.display_name !== undefined) entry.display_name = String(raw.display_name);
  if (raw.reasoning_key !== undefined) entry.reasoning_key = String(raw.reasoning_key);
  if (raw.base_url !== undefined) entry.base_url = String(raw.base_url);
  if (raw.api_key !== undefined) entry.api_key = String(raw.api_key);
  if (raw.protocol !== undefined) entry.protocol = String(raw.protocol);
  const ctx = positiveInt(raw.max_context_size, "max_context_size");
  if (ctx !== undefined) entry.max_context_size = ctx;
  const inSize = positiveInt(raw.max_input_size, "max_input_size");
  if (inSize !== undefined) entry.max_input_size = inSize;
  const outSize = positiveInt(raw.max_output_size, "max_output_size");
  if (outSize !== undefined) entry.max_output_size = outSize;
  const caps = stringList(raw.capabilities, "capabilities");
  if (caps !== undefined) entry.capabilities = caps;
  const efforts = stringList(raw.support_efforts, "support_efforts");
  if (efforts !== undefined) entry.support_efforts = efforts;
  if (raw.default_effort !== undefined) entry.default_effort = String(raw.default_effort);
  if (raw.off_effort !== undefined) entry.off_effort = String(raw.off_effort);
  const adaptive = boolOf(raw.adaptive_thinking);
  if (adaptive !== undefined) entry.adaptive_thinking = adaptive;
  const beta = boolOf(raw.beta_api);
  if (beta !== undefined) entry.beta_api = beta;
  if (isPlainObject(raw.overrides)) entry.overrides = raw.overrides;
  return entry;
}

function requireModelIdentity(entry, alias) {
  const hasWireName = entry.model || entry.name;
  const hasPointer = entry.provider || entry.provider_id || entry.base_url;
  if (!hasWireName) {
    throw new ConfigError(
      "invalid_model",
      `Model "${alias}" needs a wire model id (model/name)`
    );
  }
  if (!hasPointer) {
    throw new ConfigError(
      "invalid_model",
      `Model "${alias}" needs provider or provider_id or base_url`
    );
  }
}

// ---------------------------------------------------------------------------
// View (masked)
// ---------------------------------------------------------------------------

function maskEntry(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "api_key") continue;
    if (k === "env") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Masked view of the model-setting sections. `api_key` → `has_api_key`,
 * `env` values dropped (keys only). `__`-prefixed runtime aliases hidden.
 */
function getConfigView(home) {
  const doc = loadConfig(home);
  const providers = [];
  const providerModels = {};
  const rawProviders = isPlainObject(doc.providers) ? doc.providers : {};
  for (const [id, p] of Object.entries(rawProviders)) {
    if (!isPlainObject(p)) continue;
    providers.push({
      id,
      ...maskEntry(p),
      has_api_key: typeof p.api_key === "string" && p.api_key !== "",
      env_keys: isPlainObject(p.env) ? Object.keys(p.env) : [],
      models: [],
    });
    providerModels[id] = [];
  }

  const models = [];
  const rawModels = isPlainObject(doc.models) ? doc.models : {};
  for (const [alias, m] of Object.entries(rawModels)) {
    if (!isPlainObject(m)) continue;
    if (alias.startsWith(RESERVED_ALIAS_PREFIX)) continue;
    const row = { alias, ...maskEntry(m), has_api_key: false };
    if (typeof m.api_key === "string" && m.api_key !== "") row.has_api_key = true;
    models.push(row);
    const pid = m.provider_id || m.provider || null;
    if (pid && providerModels[pid]) providerModels[pid].push(alias);
  }

  for (const p of providers) {
    p.models = providerModels[p.id] || [];
  }
  models.sort((a, b) => a.alias.localeCompare(b.alias));
  providers.sort((a, b) => a.id.localeCompare(b.id));

  const secondaryModel =
    isPlainObject(doc.secondary_model) && Object.keys(doc.secondary_model).length > 0
      ? { ...doc.secondary_model }
      : null;

  return {
    defaultModel: typeof doc.default_model === "string" ? doc.default_model : null,
    defaultProvider: typeof doc.default_provider === "string" ? doc.default_provider : null,
    providers,
    models,
    secondaryModel,
  };
}

// ---------------------------------------------------------------------------
// Mutations (read full doc → patch → write back)
// ---------------------------------------------------------------------------

function ensureProviderExists(doc, id, type) {
  if (!isPlainObject(doc.providers)) doc.providers = {};
  if (!isPlainObject(doc.providers[id])) doc.providers[id] = {};
  if (type) doc.providers[id].type = type;
  return doc.providers[id];
}

/** Create or update a provider. `type` is required on create; optional on update. */
function saveProvider(home, input) {
  const id = normalizeId(input && input.id, "Provider id");
  const doc = loadConfig(home);
  const existing = isPlainObject(doc.providers) ? doc.providers[id] : undefined;
  const hasExistingType =
    existing && typeof existing.type === "string" && existing.type !== "";
  const type = input.type !== undefined ? normalizeProviderType(input.type) : undefined;
  if (!type && !hasExistingType) {
    throw new ConfigError("invalid_type", "Provider type is required");
  }
  const patch = normalizeProviderEntry({
    api_key: input.apiKey,
    base_url: input.baseUrl,
    default_model: input.defaultModel,
    env: input.env,
    custom_headers: input.customHeaders,
  });
  const entry = ensureProviderExists(doc, id, type || undefined);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === "") delete entry[k];
    else entry[k] = v;
  }
  if (input.defaultModel !== undefined && String(input.defaultModel).trim() === "") {
    delete entry.default_model;
  }
  if (input.apiKey !== undefined && String(input.apiKey).trim() === "") {
    delete entry.api_key;
  }
  saveConfig(home, doc);
  return getConfigView(home);
}

/** Remove a provider, its model aliases, and any pointers to them. */
function deleteProvider(home, rawId) {
  const id = normalizeId(rawId, "Provider id");
  const doc = loadConfig(home);
  if (!isPlainObject(doc.providers) || !doc.providers[id]) {
    throw new ConfigError("not_found", `Provider "${id}" does not exist`);
  }
  delete doc.providers[id];

  const removedAliases = new Set();
  if (isPlainObject(doc.models)) {
    for (const [alias, m] of Object.entries(doc.models)) {
      const pid = m && (m.provider_id || m.provider);
      if (pid === id) {
        delete doc.models[alias];
        removedAliases.add(alias);
      }
    }
    if (Object.keys(doc.models).length === 0) delete doc.models;
  }
  clearPointers(doc, (alias) => removedAliases.has(alias), (pid) => pid === id);
  saveConfig(home, doc);
  return getConfigView(home);
}

/** Create or update a model alias. */
function saveModel(home, input) {
  const alias = normalizeAlias(input && input.alias);
  const doc = loadConfig(home);
  if (!isPlainObject(doc.models)) doc.models = {};
  const patch = normalizeModelEntry({
    model: input.model,
    name: input.name,
    // `provider` is handled by the structured-path block below; never route
    // providerId through the patch (it would re-create a provider_id field
    // the wire does not understand).
    display_name: input.displayName,
    reasoning_key: input.reasoningKey,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    protocol: input.protocol,
    max_context_size: input.maxContextSize,
    max_input_size: input.maxInputSize,
    max_output_size: input.maxOutputSize,
    capabilities: input.capabilities,
    support_efforts: input.supportEfforts,
    default_effort: input.defaultEffort,
    off_effort: input.offEffort,
    adaptive_thinking: input.adaptiveThinking,
    beta_api: input.betaApi,
  });
  const entry = isPlainObject(doc.models[alias]) ? doc.models[alias] : {};

  // Structured path: alias references a [providers] entry. The wire field is
  // `provider` — kimi-code's schema requires it (entries missing it are
  // dropped on load), and max_context_size must be a positive integer.
  if (input.providerId) {
    const pid = normalizeId(input.providerId, "Provider id");
    if (!isPlainObject(doc.providers) || !doc.providers[pid]) {
      throw new ConfigError("not_found", `Provider "${pid}" does not exist`);
    }
    entry.provider = pid;
    delete entry.provider_id;
    delete entry.base_url;
    delete entry.api_key;
    delete entry.protocol;
  }
  // Flat path: inline endpoint, no provider pointer.
  if (input.flat === true) {
    delete entry.provider_id;
    delete entry.provider;
  }

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === "") delete entry[k];
    else entry[k] = v;
  }
  if (input.apiKey !== undefined && String(input.apiKey).trim() === "") {
    delete entry.api_key;
  }
  if (input.baseUrl !== undefined && String(input.baseUrl).trim() === "") {
    delete entry.base_url;
  }
  requireModelIdentity(entry, alias);
  if (entry.max_context_size === undefined) {
    throw new ConfigError(
      "invalid_value",
      `Model "${alias}" must define a positive max_context_size`
    );
  }
  doc.models[alias] = entry;
  saveConfig(home, doc);
  return getConfigView(home);
}

/** Remove a model alias and any pointers to it. */
function deleteModel(home, rawAlias) {
  const alias = normalizeAlias(rawAlias);
  const doc = loadConfig(home);
  if (!isPlainObject(doc.models) || !doc.models[alias]) {
    throw new ConfigError("not_found", `Model "${alias}" does not exist`);
  }
  delete doc.models[alias];
  if (Object.keys(doc.models).length === 0) delete doc.models;
  clearPointers(doc, (a) => a === alias);
  saveConfig(home, doc);
  return getConfigView(home);
}

/** Set (or clear with empty string) the default model alias. */
function setDefaultModel(home, rawAlias) {
  const alias = String(rawAlias || "").trim();
  const doc = loadConfig(home);
  if (alias === "") {
    delete doc.default_model;
  } else {
    if (!isPlainObject(doc.models) || !doc.models[alias]) {
      throw new ConfigError("not_found", `Model "${alias}" is not configured`);
    }
    doc.default_model = alias;
  }
  saveConfig(home, doc);
  return getConfigView(home);
}

/**
 * Set [secondary_model]. Empty body or empty model clears it.
 * Accepts `model` (a [models] alias) plus optional patch fields
 * (default_effort, max_output_size, support_efforts, ...).
 */
function setSecondaryModel(home, input) {
  const doc = loadConfig(home);
  const model = String((input && input.model) || "").trim();
  if (model === "") {
    delete doc.secondary_model;
    saveConfig(home, doc);
    return getConfigView(home);
  }
  if (!isPlainObject(doc.models) || !doc.models[model]) {
    throw new ConfigError("not_found", `Model "${model}" is not configured`);
  }
  const section = {};
  section.model = model;
  if (input.defaultEffort !== undefined && String(input.defaultEffort).trim() !== "") {
    section.default_effort = String(input.defaultEffort).trim();
  }
  const out = positiveInt(input.maxOutputSize, "max_output_size");
  if (out !== undefined) section.max_output_size = out;
  const ctx = positiveInt(input.maxContextSize, "max_context_size");
  if (ctx !== undefined) section.max_context_size = ctx;
  const efforts = stringList(input.supportEfforts, "support_efforts");
  if (efforts !== undefined) section.support_efforts = efforts;
  if (input.offEffort !== undefined && String(input.offEffort).trim() !== "") {
    section.off_effort = String(input.offEffort).trim();
  }
  if (input.maxInputSize !== undefined) {
    const v = positiveInt(input.maxInputSize, "max_input_size");
    if (v !== undefined) section.max_input_size = v;
  }
  doc.secondary_model = section;
  saveConfig(home, doc);
  return getConfigView(home);
}

/** Clear default_model / default_provider / secondary_model pointing at removed ids. */
function clearPointers(doc, matchAlias, matchProvider) {
  const aliasMatch = (a) => a !== null && matchAlias(a);
  if (typeof doc.default_model === "string" && aliasMatch(doc.default_model)) {
    delete doc.default_model;
  }
  if (typeof doc.default_provider === "string" && matchProvider && matchProvider(doc.default_provider)) {
    delete doc.default_provider;
  }
  if (isPlainObject(doc.secondary_model)) {
    const m = doc.secondary_model.model;
    if (typeof m === "string" && aliasMatch(m)) delete doc.secondary_model;
  }
  if (isPlainObject(doc.providers) && Object.keys(doc.providers).length === 0) {
    delete doc.providers;
  }
}

module.exports = {
  PROVIDER_TYPES,
  ConfigError,
  loadConfig,
  saveConfig,
  getConfigView,
  saveProvider,
  deleteProvider,
  saveModel,
  deleteModel,
  setDefaultModel,
  setSecondaryModel,
  normalizeProviderType,
  normalizeModelEntry,
};

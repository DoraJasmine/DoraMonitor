"use strict";

const fs = require("fs");
const { configPath } = require("./paths");

const ENV_MODEL_ALIAS = "__kimi_env_model__";

/**
 * Safely load model alias mappings from config.toml.
 * Only reads model identity fields — never api_key / secrets / base_url credentials.
 *
 * Returns:
 * {
 *   defaultModel,
 *   aliases: { "provider/alias": { provider, model, displayName } },
 *   envModel: { name, provider, model } | null  // from KIMI_MODEL_NAME
 * }
 */
function loadModelMap(home) {
  const result = {
    defaultModel: null,
    aliases: {},
    envModel: readEnvModel(),
    source: null,
  };

  const cfg = configPath(home);
  if (!fs.existsSync(cfg)) return result;

  let text;
  try {
    text = fs.readFileSync(cfg, "utf8");
  } catch {
    return result;
  }
  result.source = cfg;

  // Strip secret-like lines before any parsing (defense in depth)
  const safe = text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(api[_-]?key|token|secret|password|authorization)\s*=/i.test(line)) {
        return "";
      }
      if (/^\s*[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=/i.test(line)) {
        return "";
      }
      return line;
    })
    .join("\n");

  // default_model = "..."
  const dm = safe.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (dm) result.defaultModel = dm[1];

  // [models."provider/name"] blocks
  const sectionRe = /^\[models\."([^"]+)"\]\s*$/gm;
  const sections = [];
  let m;
  while ((m = sectionRe.exec(safe)) !== null) {
    sections.push({ alias: m[1], start: m.index + m[0].length, headerEnd: m.index });
  }
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length ? sections[i + 1].headerEnd : safe.length;
    const body = safe.slice(sections[i].start, end);
    const entry = {
      provider: pick(body, "provider"),
      model: pick(body, "model"),
      displayName: pick(body, "display_name"),
    };
    result.aliases[sections[i].alias] = entry;
  }

  // Wire env model into aliases under the official placeholder name
  if (result.envModel) {
    result.aliases[ENV_MODEL_ALIAS] = {
      provider: result.envModel.provider || "env",
      model: result.envModel.model || result.envModel.name,
      displayName: result.envModel.name,
      fromEnv: true,
    };
  }

  return result;
}

function pick(body, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "im");
  const m = body.match(re);
  return m ? m[1] : null;
}

/**
 * Read KIMI_MODEL_* env channel (no secrets returned).
 * KIMI_MODEL_NAME is the model id; optional provider via KIMI_MODEL_PROVIDER.
 */
function readEnvModel() {
  const name = process.env.KIMI_MODEL_NAME;
  if (!name || !String(name).trim()) return null;
  return {
    name: String(name).trim(),
    provider: (process.env.KIMI_MODEL_PROVIDER || "").trim() || null,
    model: (process.env.KIMI_MODEL_ID || process.env.KIMI_MODEL_NAME || "").trim() || null,
  };
}

/**
 * Resolve a usage.record model field to a display / pricing identity.
 */
function resolveModel(rawModel, map) {
  const raw = rawModel || "unknown";
  if (raw === ENV_MODEL_ALIAS || raw === "__kimi_env_model__") {
    const env = map.envModel;
    if (env) {
      return {
        raw,
        resolved: env.model || env.name,
        display: env.name,
        fromEnv: true,
      };
    }
    return { raw, resolved: raw, display: "Env model", fromEnv: true };
  }
  const alias = map.aliases[raw];
  if (alias) {
    return {
      raw,
      resolved: alias.model || raw,
      display: alias.displayName || alias.model || raw,
      provider: alias.provider || null,
      fromEnv: !!alias.fromEnv,
    };
  }
  // provider/model form — use bare model for pricing match
  const bare = raw.includes("/") ? raw.split("/").pop() : raw;
  return {
    raw,
    resolved: bare,
    display: raw,
    provider: raw.includes("/") ? raw.split("/")[0] : null,
    fromEnv: false,
  };
}

module.exports = {
  ENV_MODEL_ALIAS,
  loadModelMap,
  readEnvModel,
  resolveModel,
};

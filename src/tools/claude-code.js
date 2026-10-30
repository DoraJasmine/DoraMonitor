"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

/**
 * Claude Code tool adapter — recursively scans ~/.claude/projects for
 * <encoded-cwd>/<session-uuid>.jsonl transcripts (Claude Code CLI / desktop).
 *
 * Token usage lives on assistant lines:
 *   message.usage.{input_tokens, cache_read_input_tokens,
 *                  cache_creation_input_tokens, output_tokens}
 * Anthropic's input_tokens EXCLUDES the cached portions (unlike Codex's
 * OpenAI-style rollouts), so inputOther is input_tokens as-is.
 *
 * Responses are de-duplicated by message.id (+ requestId): resuming a session
 * (`claude --resume` / `--continue`) copies prior turns into a NEW transcript
 * file, so the same assistant message appears in several files.
 *
 * No quota windows — Claude Code transcripts carry no rate-limit snapshot
 * (Max/Pro limits are opaque), so unlike codex this tool has no quota
 * part by design.
 */
const tool = {
  id: "claude-code",
  label: "Claude Code",

  defaultHome() {
    if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()) {
      return path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR.trim()));
    }
    return path.join(os.homedir(), ".claude");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "projects"));
  },

  scan(home) {
    const root = path.join(home, "projects");
    const records = [];
    const errors = [];
    const seenMessages = new Set();
    let filesScanned = 0;
    let linesSeen = 0;

    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();

    for (const file of listTranscriptFiles(root)) {
      filesScanned += 1;
      const projectDirName = path.basename(path.dirname(file));
      try {
        const text = fs.readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          linesSeen += 1;
          // Fast reject before full parse — only assistant lines carry usage
          if (!line.includes('"usage"')) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj.type !== "assistant") continue;
          const message = obj.message;
          if (!message || typeof message !== "object") continue;
          const usage = message.usage;
          if (!usage || typeof usage !== "object") continue;

          const inputOther = n(usage.input_tokens);
          const cacheRead = n(usage.cache_read_input_tokens);
          // Older builds log only the combined total; newer ones also break
          // it down by TTL — fall back to the breakdown when the total is 0.
          let cacheCreate = n(usage.cache_creation_input_tokens);
          if (!cacheCreate && usage.cache_creation && typeof usage.cache_creation === "object") {
            cacheCreate =
              n(usage.cache_creation.ephemeral_5m_write_tokens) +
              n(usage.cache_creation.ephemeral_1h_write_tokens);
          }
          const output = n(usage.output_tokens);
          // Skip all-zero placeholders BEFORE dedupe: registering the key first
          // would let a zero-usage placeholder swallow the real record that
          // carries the same message.id + requestId.
          if (inputOther + cacheRead + cacheCreate + output <= 0) continue;

          // Resume copies share message.id + requestId across files; without
          // an id there is nothing stable to dedupe on, so count the line.
          const messageId = String(message.id || "");
          if (messageId) {
            const dedupKey = `${messageId}|${obj.requestId || ""}`;
            if (seenMessages.has(dedupKey)) continue;
            seenMessages.add(dedupKey);
          }

          const rec = emptyRecord("claude-code");
          rec.time = Date.parse(obj.timestamp) || 0;
          rec.model = String(message.model || "unknown");
          rec.modelDisplay = rec.model;
          rec.modelResolved = rec.model;
          rec.inputOther = inputOther;
          rec.output = output;
          rec.inputCacheRead = cacheRead;
          rec.inputCacheCreation = cacheCreate;
          const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings });
          rec.costCny = cost.total;
          rec.costEstimated = cost.estimated;
          rec.priceId = cost.priceId;
          rec.project = typeof obj.cwd === "string" && obj.cwd ? obj.cwd : projectDirName;
          rec.session = obj.sessionId
            ? String(obj.sessionId)
            : path.basename(file, ".jsonl");
          rec.sessionHint = { session: rec.session, project: rec.project };
          records.push(rec);
        }
      } catch (err) {
        errors.push({ file, message: String(err && err.message ? err.message : err) });
      }
    }

    // newest first for "recent"
    records.sort((a, b) => b.time - a.time);

    return {
      records,
      meta: {
        filesScanned,
        linesSeen,
        recordCount: records.length,
        home,
        projectsRoot: root,
        errors: errors.slice(0, 20),
      },
    };
  },
};

function listTranscriptFiles(root) {
  const out = [];
  walk(root, out);
  return out;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      walk(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

module.exports = tool;

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
 * REQUEST TIMING (latencyMs/firstTokenMs): ported from CC Switch's
 * `session_usage.rs` via ccs-ssh-sync. The transcript's uuid/parentUuid chain
 * gives the true request start (first non-attachment ancestor of the first
 * streamed block), `api-request` rows refine it, and `thinkingDurationMs`
 * back-dates the first output token (TTFT). Latency is only trusted on
 * messages that carry a stop_reason and start at the first block.
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
        // Per-file timing state (the chain is file-scoped: resume copies
        // re-dedup by message.id, so whichever file parses a message first
        // computes the same latency from identical lines).
        const chain = new Map();
        const apiRequests = new Map();
        const timings = new Map();
        const pendingTiming = [];
        for (const line of lines) {
          if (!line) continue;
          linesSeen += 1;
          // Fast reject before full parse — usage lives on assistant lines;
          // the uuid/parentUuid chain needs every transcript line though.
          if (!line.includes('"usage"') && !line.includes('"uuid"')) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }

          // Chain nodes & api-request rows feed the timing estimator.
          const lineTsMs = Date.parse(obj.timestamp) || null;
          if (typeof obj.uuid === "string" && obj.uuid.trim()) {
            chain.set(obj.uuid.trim(), {
              parent: typeof obj.parentUuid === "string" ? obj.parentUuid.trim() : null,
              tsMs: lineTsMs,
              isAttachment: obj.type === "attachment",
            });
          }
          if (obj.type === "api-request" && typeof obj.id === "string" && lineTsMs != null) {
            apiRequests.set(obj.id, lineTsMs);
          }

          if (obj.type !== "assistant") continue;
          const message = obj.message;
          if (!message || typeof message !== "object") continue;

          // Streamed blocks share message.id; track the window even for
          // usage-less trailing lines (the stop block closes it).
          const messageId = String(message.id || "");
          if (messageId) {
            let t = timings.get(messageId);
            if (!t) {
              const startsAtFirst = obj.apiBlockIndex == null || Number(obj.apiBlockIndex) === 0;
              t = {
                firstParent: typeof obj.parentUuid === "string" ? obj.parentUuid.trim() : null,
                requestRef: typeof obj.requestRef === "string" ? obj.requestRef : null,
                startsAtFirstBlock: startsAtFirst,
                firstOutputMs: startsAtFirst ? thinkingBlockStartMs(obj, lineTsMs) : null,
                endMs: null,
              };
              timings.set(messageId, t);
            }
            if (lineTsMs != null && (t.endMs == null || lineTsMs > t.endMs)) {
              t.endMs = lineTsMs;
            }
          }

          const usage = message.usage;
          if (!usage || typeof usage !== "object") continue;

          const inputOther = n(usage.input_tokens);
          const cacheRead = n(usage.cache_read_input_tokens);
          // Older builds log only the combined total; newer ones also break
          // it down by TTL — fall back to the breakdown when the total is 0.
          let cacheCreate = n(usage.cache_creation_input_tokens);
          const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object" ? usage.cache_creation : null;
          const cacheCreateShort = cacheCreation
            ? n(cacheCreation.ephemeral_5m_input_tokens ?? cacheCreation.ephemeral_5m_write_tokens)
            : null;
          const cacheCreateLong = cacheCreation
            ? n(cacheCreation.ephemeral_1h_input_tokens ?? cacheCreation.ephemeral_1h_write_tokens)
            : null;
          if (!cacheCreate && cacheCreation) cacheCreate = cacheCreateShort + cacheCreateLong;
          const output = n(usage.output_tokens);
          // Skip all-zero placeholders BEFORE dedupe: registering the key first
          // would let a zero-usage placeholder swallow the real record that
          // carries the same message.id + requestId.
          if (inputOther + cacheRead + cacheCreate + output <= 0) continue;

          // Resume copies share message.id + requestId across files; without
          // an id there is nothing stable to dedupe on, so count the line.
          if (messageId) {
            const dedupKey = `${messageId}|${obj.requestId || ""}`;
            if (seenMessages.has(dedupKey)) continue;
            seenMessages.add(dedupKey);
          }

          const rec = emptyRecord("claude-code");
          rec.time = Date.parse(obj.timestamp) || 0;
          // Stable per-request identity (message id + API request id) — the
          // same key the resume-copy dedup uses, so request-level sync and
          // the CC Switch bridge can address this exact request.
          rec.nativeId = messageId ? `${messageId}|${obj.requestId || ""}` : null;
          rec.model = String(message.model || "unknown");
          rec.modelDisplay = rec.model;
          rec.modelResolved = rec.model;
          rec.inputOther = inputOther;
          rec.output = output;
          rec.inputCacheRead = cacheRead;
          rec.inputCacheCreation = cacheCreate;
          rec.inputCacheCreationShort = cacheCreateShort;
          rec.inputCacheCreationLong = cacheCreateLong;
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
          pendingTiming.push({
            rec,
            msgId: messageId,
            hasStop: typeof message.stop_reason === "string" && message.stop_reason.length > 0,
          });
        }
        resolvePendingTiming(pendingTiming, chain, apiRequests, timings);
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

// ---------------------------------------------------------------------------
// Request-timing estimator (ported from CC Switch session_usage.rs)
// ---------------------------------------------------------------------------

const MAX_CHAIN_HOPS = 32;
const MIN_LATENCY_MS = 100;
const MAX_LATENCY_MS = 3_600_000;

/** Walk the parent chain (skipping attachment nodes) to the request start. */
function chainStartMs(chain, firstParent) {
  let cursor = firstParent;
  for (let i = 0; i < MAX_CHAIN_HOPS && cursor; i += 1) {
    const node = chain.get(cursor);
    if (!node) return null;
    if (!node.isAttachment) return node.tsMs ?? null;
    cursor = node.parent || null;
  }
  return null;
}

/** Request start = later of chain start and the api-request send time. */
function requestStartMs(chain, apiRequests, t) {
  const chainMs = chainStartMs(chain, t.firstParent);
  const sentMs = t.requestRef ? apiRequests.get(t.requestRef) ?? null : null;
  if (chainMs != null && sentMs != null) return Math.max(chainMs, sentMs);
  return chainMs ?? sentMs ?? null;
}

/** Back-date the first output token when the block opens with thinking. */
function thinkingBlockStartMs(obj, blockEndMs) {
  if (blockEndMs == null) return null;
  const dur = Number(obj.thinkingDurationMs);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content) || !content.length || content[0].type !== "thinking") return null;
  return blockEndMs - Math.round(dur);
}

/** Fill latencyMs/firstTokenMs on a file's records once its lines are known. */
function resolvePendingTiming(pending, chain, apiRequests, timings) {
  for (const { rec, msgId, hasStop } of pending) {
    const t = hasStop && msgId ? timings.get(msgId) : null;
    if (!t || !t.startsAtFirstBlock) continue;
    const startMs = requestStartMs(chain, apiRequests, t);
    if (startMs == null || t.endMs == null) continue;
    const diff = Math.round(t.endMs - startMs);
    if (diff < MIN_LATENCY_MS || diff > MAX_LATENCY_MS) continue;
    rec.latencyMs = diff;
    if (t.firstOutputMs != null) {
      const ft = Math.round(t.firstOutputMs - startMs);
      if (ft > 0 && ft <= diff) rec.firstTokenMs = ft;
    }
  }
}

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

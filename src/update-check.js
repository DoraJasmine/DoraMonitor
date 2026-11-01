"use strict";

/**
 * Update check — the single permitted automatic outbound request.
 *
 * Reads the latest published release from the GitHub Releases API
 * (repos/DoraJasmine/DoraMonitor/releases/latest), a read-only GET that
 * carries no local data. Results are cached in memory for 6 hours; any
 * failure degrades silently to "no update info". Disable via
 * settings.updates.check = false.
 */

const PKG = require("../package.json");
const RELEASES_API_URL = "https://api.github.com/repos/DoraJasmine/DoraMonitor/releases/latest";
const RELEASES_PAGE_URL = "https://github.com/DoraJasmine/DoraMonitor/releases";
const TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 5000;

let cache = { at: 0, data: null };

/** Semver-ish comparison for MAJOR.MINOR.PATCH (pre-release ignored). */
function isNewerVersion(candidate, current) {
  const parse = (v) => String(v || "").split(/[-+]/)[0].split(".").map((x) => Number(x) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

async function fetchLatestRelease(fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) return null;
  const res = await doFetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub API 要求携带 User-Agent
      "User-Agent": "DoraMonitor-update-check",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const tag = data && typeof data.tag_name === "string" ? data.tag_name : null;
  const version = tag ? tag.replace(/^v/, "") : null;
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null;
  return {
    version,
    url: typeof data.html_url === "string" && data.html_url ? data.html_url : RELEASES_PAGE_URL,
    publishedAt: typeof data.published_at === "string" ? data.published_at : null,
  };
}

/**
 * Update status for the dashboard header. Options: { fetchImpl, now } for
 * tests; { force } to bypass the cache. Never throws.
 */
async function getUpdateStatus(options = {}) {
  const settings = (() => {
    try {
      return require("./settings").loadSettings();
    } catch {
      return {};
    }
  })();
  const enabled = !(settings.updates && settings.updates.check === false);
  const now = options.now || Date.now();
  const current = PKG.version;

  if (!enabled) {
    return { current, latest: null, updateAvailable: false, checkedAt: null, enabled: false, releaseUrl: RELEASES_PAGE_URL };
  }
  if (!options.force && cache.data && now - cache.at < TTL_MS) {
    return { ...cache.data, checkedAt: new Date(cache.at).toISOString() };
  }
  let release = null;
  try {
    release = await fetchLatestRelease(options.fetchImpl);
  } catch {
    release = null; // offline / timeout / rate limit — degrade silently
  }
  if (release) {
    cache = { at: now, data: null };
    cache.data = {
      current,
      latest: release.version,
      updateAvailable: isNewerVersion(release.version, current),
      enabled: true,
      releaseUrl: release.url,
    };
    return { ...cache.data, checkedAt: new Date(now).toISOString() };
  }
  // 失败时不缓存失败状态,下次请求重试;本次返回无更新信息。
  return { current, latest: null, updateAvailable: false, checkedAt: null, enabled: true, releaseUrl: RELEASES_PAGE_URL };
}

function resetCache() {
  cache = { at: 0, data: null };
}

module.exports = { getUpdateStatus, isNewerVersion, resetCache, RELEASES_API_URL, RELEASES_PAGE_URL, TTL_MS };

/**
 * Data access layer for Kimi Code Dashboard.
 * Web: HTTP /api/* via Vite proxy or Node server.
 * Tauri: invoke Rust commands with the same camelCase payload shape.
 */

function detectTauri() {
  if (typeof window === "undefined") return false;
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    Boolean(window.__TAURI_METADATA__)
  );
}

let invokeFn = null;
let invokeReady = null;

async function getInvoke() {
  if (!detectTauri()) return null;
  if (invokeFn) return invokeFn;
  if (!invokeReady) {
    invokeReady = import("@tauri-apps/api/core")
      .then((mod) => {
        invokeFn = mod.invoke;
        return invokeFn;
      })
      .catch(() => {
        invokeFn = null;
        return null;
      });
  }
  return invokeReady;
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || res.statusText || "request failed");
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function withHome(params, home) {
  const qs = new URLSearchParams(params || {});
  if (home) qs.set("home", home);
  return qs;
}

/** GET /api/paths or invoke get_paths */
export async function fetchPaths() {
  const invoke = await getInvoke();
  if (invoke) return invoke("get_paths");
  return httpJson("/api/paths");
}

/** GET /api/prices or invoke get_prices */
export async function fetchPrices() {
  const invoke = await getInvoke();
  if (invoke) return invoke("get_prices");
  return httpJson("/api/prices");
}

/** GET /api/summary or invoke get_summary */
export async function fetchSummary(home, range = "30d", refresh = false) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("get_summary", {
      homeOverride: home || null,
      range: range || "30d",
      refresh: Boolean(refresh),
    });
  }
  const qs = withHome({ range }, home);
  if (refresh) qs.set("refresh", "1");
  return httpJson(`/api/summary?${qs.toString()}`);
}

/** GET /api/sessions or invoke list_sessions */
export async function fetchSessions(home, status = "active", workspace = null) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("list_sessions", {
      homeOverride: home || null,
      status: status || "active",
      workspace: workspace || null,
    });
  }
  const qs = withHome({ status }, home);
  if (workspace) qs.set("workspace", workspace);
  return httpJson(`/api/sessions?${qs.toString()}`);
}

async function sessionPost(webPath, command, home, body) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke(command, {
      homeOverride: home || null,
      ...body,
    });
  }
  const qs = withHome({}, home);
  return httpJson(`/api/sessions/${webPath}?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function archiveSession(home, workspaceId, sessionId) {
  return sessionPost("archive", "archive_session", home, {
    workspaceId,
    sessionId,
  });
}

export async function unarchiveSession(home, workspaceId, sessionId) {
  return sessionPost("unarchive", "unarchive_session", home, {
    workspaceId,
    sessionId,
  });
}

export async function deleteSession(home, workspaceId, sessionId, status) {
  return sessionPost("delete", "delete_session", home, {
    workspaceId,
    sessionId,
    status: status || null,
    confirm: true,
  });
}

export async function deleteWorkspace(home, workspaceId) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("delete_workspace", {
      homeOverride: home || null,
      workspaceId,
      confirm: true,
      force: null,
    });
  }
  const qs = withHome({}, home);
  return httpJson(`/api/workspaces/delete?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, confirm: true }),
  });
}

/** GET /api/sessions/preview or invoke get_session_preview */
export async function fetchSessionPreview(home, workspaceId, sessionId, status) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("get_session_preview", {
      homeOverride: home || null,
      workspaceId,
      sessionId,
      status: status || null,
    });
  }
  const qs = withHome(
    {
      workspaceId,
      sessionId,
    },
    home
  );
  if (status) qs.set("status", status);
  return httpJson(`/api/sessions/preview?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Model configuration (config.toml) + provider catalog
// ---------------------------------------------------------------------------

/** GET /api/config or invoke get_config */
export async function fetchConfig(home) {
  const invoke = await getInvoke();
  if (invoke) return invoke("get_config", { homeOverride: home || null });
  const qs = withHome({}, home);
  return httpJson(`/api/config?${qs.toString()}`);
}

/** POST /api/config/providers or invoke save_provider */
export async function saveProvider(home, body) {
  const invoke = await getInvoke();
  if (invoke) return invoke("save_provider", { homeOverride: home || null, ...body });
  return httpJson("/api/config/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/config/providers/<id> or invoke delete_provider */
export async function deleteProvider(home, providerId) {
  const invoke = await getInvoke();
  if (invoke) return invoke("delete_provider", { homeOverride: home || null, providerId });
  const qs = withHome({}, home);
  return httpJson(`/api/config/providers/${encodeURIComponent(providerId)}?${qs.toString()}`, {
    method: "DELETE",
  });
}

/** POST /api/config/providers/<id>/models or invoke save_model */
export async function saveModel(home, providerId, body) {
  const invoke = await getInvoke();
  if (invoke) return invoke("save_model", { homeOverride: home || null, providerId, ...body });
  return httpJson(`/api/config/providers/${encodeURIComponent(providerId)}/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/config/models/<alias> or invoke delete_model */
export async function deleteModel(home, alias) {
  const invoke = await getInvoke();
  if (invoke) return invoke("delete_model", { homeOverride: home || null, alias });
  const qs = withHome({}, home);
  return httpJson(`/api/config/models/${encodeURIComponent(alias)}?${qs.toString()}`, {
    method: "DELETE",
  });
}

/** POST /api/config/default-model or invoke set_default_model */
export async function setDefaultModel(home, alias) {
  const invoke = await getInvoke();
  if (invoke) return invoke("set_default_model", { homeOverride: home || null, alias });
  return httpJson("/api/config/default-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alias }),
  });
}

/** POST /api/config/secondary-model or invoke set_secondary_model */
export async function setSecondaryModel(home, body) {
  const invoke = await getInvoke();
  if (invoke) return invoke("set_secondary_model", { homeOverride: home || null, ...body });
  return httpJson("/api/config/secondary-model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /api/catalog or invoke get_catalog (builtin fallback when offline) */
export async function fetchCatalog(home, refresh = false) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke("get_catalog", { homeOverride: home || null, refresh: Boolean(refresh) });
  }
  const qs = withHome({}, home);
  if (refresh) qs.set("refresh", "1");
  return httpJson(`/api/catalog?${qs.toString()}`);
}

/** POST /api/catalog/import or invoke import_catalog */
export async function importCatalog(home, body) {
  const invoke = await getInvoke();
  if (invoke) return invoke("import_catalog", { homeOverride: home || null, ...body });
  return httpJson("/api/catalog/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Open an external URL. Tauri shell (shell:allow-open) opens the system
 * browser; the web build falls back to a new tab.
 */
export async function openExternal(url) {
  if (detectTauri()) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
      return;
    } catch (e) {
      // fall through to window.open when the plugin is unavailable
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

import React, { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ccSwitchSyncNow, fetchCcSwitchStatus, fetchSettings, fetchSyncStatus, saveSettings, syncNow } from "@/lib/backend";
import { fill } from "@/i18n";
import { cn } from "@/lib/utils";

function toForm(sync = {}) {
  return {
    enabled: sync.enabled === true,
    backend: sync.backend || "ssh",
    deviceName: sync.deviceName || "",
    syncInterval: String(sync.syncInterval || 300),
    local: { path: sync.local?.path || "" },
    ssh: {
      host: sync.ssh?.host || "",
      user: sync.ssh?.user || "",
      port: String(sync.ssh?.port || 22),
      remotePath: sync.ssh?.remotePath || "~/.kimi-status-sync",
      identityFile: sync.ssh?.identityFile || "",
    },
    webdav: {
      url: sync.webdav?.url || "",
      username: sync.webdav?.username || "",
      password: "",
    },
  };
}

function Field({ label, hint, children }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}

function SyncStatus({ connection, t, locale }) {
  if (!connection) return <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">{t("syncStatusUnavailable")}</div>;
  const state = connection.state || {};
  const peers = state.peerNames || (connection.cachedPeers || []).map((peer) => peer.device);
  const backend = connection.backend === "local" ? t("syncBackendLocal") : String(connection.backend || "").toUpperCase();
  const lastSync = Date.parse(state.lastSync || "");
  const failed = state.lastAttemptAt && (!state.uploaded || !state.downloaded);
  return (
    <Card className={cn("border-success/30 bg-success/5", !connection.enabled && "border-border bg-muted/20", connection.enabled && !connection.configured && "border-warning/30 bg-warning/5")}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={cn("h-2 w-2 rounded-full bg-success", !connection.enabled && "bg-muted-foreground", connection.enabled && !connection.configured && "bg-warning")} />
            {connection.enabled ? t(connection.configured ? "syncConfigured" : "syncNotConfigured") : t("syncNotEnabled")}
          </div>
          <span className="text-xs text-muted-foreground">
            {Number.isFinite(lastSync) ? fill(t("syncLastSuccess"), { time: new Date(lastSync).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false }) }) : t("syncNeverRan")}
          </span>
        </div>
        {connection.enabled && <p className="text-xs text-muted-foreground">{fill(t("syncSavedAs"), { device: connection.device, backend, interval: connection.syncInterval })}</p>}
        {failed && <p role="alert" className="text-xs text-destructive">{fill(t("syncLastAttemptFailed"), { reason: state.uploadError || state.error || t("syncFailedUnknown") })}</p>}
        {connection.enabled && <p className="text-xs text-muted-foreground">{peers.length ? fill(t("syncPeerDevices"), { devices: peers.join(", ") }) : t("syncNoPeers")}</p>}
        {connection.enabled && connection.configured && <p className="text-[11px] text-muted-foreground">{t("syncStatusHint")}</p>}
      </CardContent>
    </Card>
  );
}

/** CC Switch bridge section: toggle + status + ccs-ssh-sync conflict notice. */
function CcSwitchCard({ t, locale }) {
  const [form, setForm] = useState({ enabled: false, dbPath: "", includeLocal: false });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = async () => {
    try {
      const [settings, st] = await Promise.all([fetchSettings(), fetchCcSwitchStatus().catch(() => null)]);
      setForm({
        enabled: settings.ccSwitch?.enabled === true,
        dbPath: settings.ccSwitch?.dbPath || "",
        includeLocal: settings.ccSwitch?.includeLocal === true,
      });
      if (st) setStatus(st);
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (withRun) => {
    setError(null);
    setNote(null);
    setBusy(withRun ? "run" : "save");
    try {
      const saved = await saveSettings({ ccSwitch: { ...form } });
      setForm({
        enabled: saved.ccSwitch?.enabled === true,
        dbPath: saved.ccSwitch?.dbPath || "",
        includeLocal: saved.ccSwitch?.includeLocal === true,
      });
      if (!withRun) {
        setNote(t("saved"));
      } else {
        if (!saved.ccSwitch?.enabled) throw new Error(t("ccSwitchDisabledError"));
        const result = await ccSwitchSyncNow();
        if (result.paused) {
          setNote(fill(t("ccSwitchPausedNotice"), { detail: result.detail || result.reason || "" }));
        } else if (!result.ok) {
          throw new Error(result.error || result.reason || t("ccSwitchRunFailed"));
        } else {
          setNote(fill(t("ccSwitchRunDone"), { inserted: result.inserted || 0, updated: result.updated || 0 }));
        }
      }
      const st = await fetchCcSwitchStatus().catch(() => null);
      if (st) setStatus(st);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const lastRun = Date.parse(status?.lastRunAt || "");
  const paused = status?.pausedByConflict === true;
  const result = status?.lastResult || {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ccSwitchTitle")}</CardTitle>
        <CardDescription>{t("ccSwitchDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        {paused && (
          <div role="alert" className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
            <strong>{t("ccSwitchConflictTitle")}</strong>
            <p className="mt-1 text-xs">{fill(t("ccSwitchConflictDetail"), { detail: status.conflictDetail || status.conflictReason || "" })}</p>
            <p className="mt-1 text-xs">{t("ccSwitchConflictResume")}</p>
          </div>
        )}
        {!paused && status && Object.keys(status.watermarks || {}).length > 0 && (
          <div role="status" className="mb-4 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            <strong className="text-foreground">{t("ccSwitchCoexistTitle")}</strong>
            <p className="mt-1 text-xs">{fill(t("ccSwitchCoexistDetail"), {
              apps: Object.entries(status.watermarks)
                .map(([app, sec]) => `${app} @ ${new Date(sec * 1000).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false })}`)
                .join(" · "),
            })}</p>
          </div>
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save(false);
          }}
        >
          <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={form.enabled}
              disabled={Boolean(busy)}
              onChange={(event) => setForm((c) => ({ ...c, enabled: event.target.checked }))}
            />
            {t("ccSwitchEnabled")}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">{t("ccSwitchDbPath")}</span>
              <Input
                value={form.dbPath}
                disabled={Boolean(busy)}
                placeholder={t("ccSwitchDbPathPlaceholder")}
                onChange={(event) => setForm((c) => ({ ...c, dbPath: event.target.value }))}
              />
            </label>
            <label className="flex items-end gap-2 pb-1 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={form.includeLocal}
                disabled={Boolean(busy)}
                onChange={(event) => setForm((c) => ({ ...c, includeLocal: event.target.checked }))}
              />
              <span>{t("ccSwitchIncludeLocal")}</span>
            </label>
          </div>

          {status && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={cn("inline-block h-2 w-2 rounded-full", form.enabled ? (paused ? "bg-warning" : "bg-success") : "bg-muted-foreground")} />
                <span className="font-medium text-foreground">
                  {form.enabled ? (paused ? t("ccSwitchStatePaused") : t("ccSwitchStateOn")) : t("ccSwitchStateOff")}
                </span>
                {Number.isFinite(lastRun) && (
                  <span>{fill(t("ccSwitchLastRun"), { time: new Date(lastRun).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false }) })}</span>
                )}
              </div>
              {form.enabled && status.lastRunAt && (
                <p className="mt-2">
                  {fill(t("ccSwitchRows"), {
                    inserted: result.inserted || 0,
                    updated: result.updated || 0,
                    unchanged: result.unchanged || 0,
                    pruned: result.pruned || 0,
                  })}
                  {Object.keys(result.byDevice || {}).length
                    ? " · " +
                      Object.entries(result.byDevice)
                        .map(([dev, n]) => fill(t("ccSwitchDeviceRows"), { device: dev, n }))
                        .join(" · ")
                    : ""}
                </p>
              )}
              {status.lastError && <p role="alert" className="mt-2 text-destructive">{fill(t("ccSwitchLastError"), { error: status.lastError })}</p>}
              {!form.enabled && <p className="mt-2">{t("ccSwitchOffHint")}</p>}
            </div>
          )}

          {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          {note && <div role="status" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">{note}</div>}

          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">{t("ccSwitchDaemonHint")}</p>
            <div className="flex shrink-0 gap-2">
              <Button type="submit" variant="secondary" disabled={Boolean(busy)}>
                <Save aria-hidden />{busy === "save" ? t("saving") : t("save")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={Boolean(busy) || !form.enabled || paused}
                title={paused ? t("ccSwitchRunBlockedByConflict") : undefined}
                onClick={() => save(true)}
              >
                <RefreshCw className={cn(busy === "run" && "icon-spin")} aria-hidden />
                {busy === "run" ? t("ccSwitchRunning") : t("ccSwitchRunNow")}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SyncSettingsPage({ t, locale, onSaved, onSynced }) {
  const [form, setForm] = useState(() => toForm());
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [connection, setConnection] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, current] = await Promise.all([fetchSettings(), fetchSyncStatus().catch(() => null)]);
      setForm(toForm(settings.sync));
      setHasPassword(settings.sync?.webdav?.hasPassword === true);
      setConnection(current);
    } catch (e) {
      setError(e.message || t("settingsSaveFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateNested = (section, key, value) => setForm((current) => ({
    ...current,
    [section]: { ...current[section], [key]: value },
  }));

  const save = async (withSync) => {
    setError(null);
    setStatus(null);
    const missing = form.enabled && (
      (form.backend === "local" && !form.local.path.trim())
      || (form.backend === "ssh" && !form.ssh.host.trim())
      || (form.backend === "webdav" && !form.webdav.url.trim())
    );
    if (missing) {
      setError(t("syncRequiredFields"));
      return;
    }
    const sync = {
      ...form,
      syncInterval: Number(form.syncInterval),
      ssh: { ...form.ssh, port: Number(form.ssh.port) },
    };
    if (!sync.webdav.password && hasPassword) delete sync.webdav.password;
    setBusy(withSync ? "sync" : "save");
    try {
      const saved = await saveSettings({ sync });
      setForm(toForm(saved.sync));
      setHasPassword(saved.sync?.webdav?.hasPassword === true);
      const savedStatus = await fetchSyncStatus().catch(() => null);
      if (savedStatus) setConnection(savedStatus);
      onSaved?.(saved);
      if (!withSync) {
        setStatus(t("saved"));
      } else {
        if (!saved.sync?.enabled) throw new Error(t("syncDisabled"));
        const result = await syncNow();
        const current = await fetchSyncStatus().catch(() => null);
        if (current) setConnection(current);
        const problem = result.uploadError || result.error;
        if (problem) throw new Error(problem === "duplicate_device_name" ? t("syncDuplicateDevice") : problem);
        setStatus(fill(t("syncComplete"), { n: (result.peers || []).length }));
        onSynced?.(saved);
      }
    } catch (e) {
      const reason = e.message || String(e);
      setError(reason === "duplicate_device_name" ? t("syncDuplicateDevice") : reason);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t("syncSettingsTitle")}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("syncSettingsSubtitle")}</p>
      </div>
      {!loading && <SyncStatus connection={connection} t={t} locale={locale} />}
      <Card>
        <CardHeader>
          <CardTitle>{t("syncConnectionTitle")}</CardTitle>
          <CardDescription>{t("syncConnectionHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-sm text-muted-foreground" aria-busy="true">{t("loading")}</div>
          ) : (
            <form className="space-y-6" onSubmit={(event) => { event.preventDefault(); save(false); }}>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={form.enabled}
                  disabled={Boolean(busy)}
                  onChange={(event) => update("enabled", event.target.checked)}
                />
                {t("syncEnabled")}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("syncBackend")}>
                  <Select value={form.backend} onValueChange={(value) => update("backend", value)} disabled={Boolean(busy)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">{t("syncBackendLocal")}</SelectItem>
                      <SelectItem value="ssh">SSH</SelectItem>
                      <SelectItem value="webdav">WebDAV</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t("syncDeviceName")} hint={t("syncDeviceNameHint")}>
                  <Input value={form.deviceName} maxLength={64} disabled={Boolean(busy)} placeholder={t("syncDeviceNamePlaceholder")} onChange={(event) => update("deviceName", event.target.value)} />
                </Field>
                <Field label={t("syncInterval")} hint={t("syncIntervalHint")}>
                  <Input type="number" min="30" step="1" value={form.syncInterval} disabled={Boolean(busy)} onChange={(event) => update("syncInterval", event.target.value)} />
                </Field>
              </div>

              <div className="border-t border-border/60 pt-5">
                {form.backend === "local" && (
                  <Field label={t("syncLocalPath")} hint={t("syncLocalPathHint")}>
                    <Input value={form.local.path} disabled={Boolean(busy)} placeholder="D:\DoraSync 或 /mnt/d/DoraSync" onChange={(event) => updateNested("local", "path", event.target.value)} />
                  </Field>
                )}
                {form.backend === "ssh" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("syncSshHost")}><Input value={form.ssh.host} disabled={Boolean(busy)} placeholder="example.com" onChange={(event) => updateNested("ssh", "host", event.target.value)} /></Field>
                    <Field label={t("syncSshUser")}><Input value={form.ssh.user} disabled={Boolean(busy)} onChange={(event) => updateNested("ssh", "user", event.target.value)} /></Field>
                    <Field label={t("syncSshPort")}><Input type="number" min="1" max="65535" value={form.ssh.port} disabled={Boolean(busy)} onChange={(event) => updateNested("ssh", "port", event.target.value)} /></Field>
                    <Field label={t("syncRemotePath")}><Input value={form.ssh.remotePath} disabled={Boolean(busy)} onChange={(event) => updateNested("ssh", "remotePath", event.target.value)} /></Field>
                    <div className="sm:col-span-2">
                      <Field label={t("syncIdentityFile")} hint={t("syncIdentityFileHint")}><Input value={form.ssh.identityFile} disabled={Boolean(busy)} placeholder="~/.ssh/id_ed25519" onChange={(event) => updateNested("ssh", "identityFile", event.target.value)} /></Field>
                    </div>
                  </div>
                )}
                {form.backend === "webdav" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2"><Field label={t("syncWebdavUrl")}><Input type="url" value={form.webdav.url} disabled={Boolean(busy)} placeholder="https://example.com/dav/" onChange={(event) => updateNested("webdav", "url", event.target.value)} /></Field></div>
                    <Field label={t("syncWebdavUsername")}><Input value={form.webdav.username} disabled={Boolean(busy)} autoComplete="username" onChange={(event) => updateNested("webdav", "username", event.target.value)} /></Field>
                    <Field label={t("syncWebdavPassword")} hint={hasPassword ? t("syncPasswordKeep") : null}><Input type="password" value={form.webdav.password} disabled={Boolean(busy)} autoComplete="new-password" onChange={(event) => updateNested("webdav", "password", event.target.value)} /></Field>
                  </div>
                )}
              </div>

              {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
              {status && <div role="status" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">{status}</div>}

              <div className="flex flex-col gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">{t("syncDaemonHint")}</p>
                <div className="flex shrink-0 gap-2">
                  <Button type="submit" variant="secondary" disabled={Boolean(busy)}>
                    <Save aria-hidden />{busy === "save" ? t("saving") : t("save")}
                  </Button>
                  <Button type="button" disabled={Boolean(busy)} onClick={() => save(true)}>
                    <RefreshCw className={cn(busy === "sync" && "icon-spin")} aria-hidden />
                    {busy === "sync" ? t("syncing") : t("syncSaveAndRun")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
      <CcSwitchCard t={t} locale={locale} />
    </div>
  );
}

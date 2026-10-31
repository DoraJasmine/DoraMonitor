import React, { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchSettings, saveSettings, syncNow } from "@/lib/backend";
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

export default function SyncSettingsPage({ t, onSaved, onSynced }) {
  const [form, setForm] = useState(() => toForm());
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await fetchSettings();
      setForm(toForm(settings.sync));
      setHasPassword(settings.sync?.webdav?.hasPassword === true);
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
      onSaved?.(saved);
      if (!withSync) {
        setStatus(t("saved"));
      } else {
        if (!saved.sync?.enabled) throw new Error(t("syncDisabled"));
        const result = await syncNow();
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
    </div>
  );
}

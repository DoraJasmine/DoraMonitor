import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fill } from "@/i18n";
import {
  deleteModel,
  deleteProvider,
  fetchCatalog,
  fetchConfig,
  importCatalog,
  saveModel,
  saveProvider,
  setDefaultModel,
  setSecondaryModel,
} from "@/lib/backend";
import { cn } from "@/lib/utils";

const PROVIDER_TYPES = [
  "kimi",
  "anthropic",
  "openai",
  "openai_responses",
  "google-genai",
  "vertexai",
];

/** Capability key → i18n label key. Order matters for display. */
const CAP_ORDER = [
  "tool_use",
  "image_in",
  "video_in",
  "audio_in",
  "thinking",
  "always_thinking",
  "dynamically_loaded_tools",
];

function capLabelKey(cap) {
  const map = {
    tool_use: "capToolUse",
    image_in: "capImageIn",
    video_in: "capVideoIn",
    audio_in: "capAudioIn",
    thinking: "capThinking",
    always_thinking: "capThinkingAlways",
    dynamically_loaded_tools: "capDynTools",
  };
  return map[cap];
}

function fmtCapBadge(t, cap) {
  const key = capLabelKey(cap);
  return key ? t(key) : cap;
}

/** A capability checkbox row. */
function CapCheck({ label, hint, checked, disabled, onChange }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-secondary/40 px-3 py-2 text-sm transition-colors hover:bg-secondary/70",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <input
        type="checkbox"
        className="h-4 w-4 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Field({ label, required, children, hint }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {required ? <span className="ml-0.5 text-red-300">*</span> : null}
      </span>
      {children}
      {hint ? <span className="block text-[11px] leading-relaxed text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

function parseCaps(raw) {
  const caps = Array.isArray(raw) ? raw : [];
  return new Set(caps.filter((c) => CAP_ORDER.includes(c)));
}

// ---------------------------------------------------------------------------
// Add / edit provider dialog (catalog import or manual entry)
// ---------------------------------------------------------------------------

function ProviderDialog({ t, open, mode, row, catalog, catalogLoading, onRetryCatalog, onClose, onSaved }) {
  const isEdit = mode === "edit";
  const [source, setSource] = useState("catalog");
  const [catId, setCatId] = useState("");
  const [catApiKey, setCatApiKey] = useState("");
  const [catDefault, setCatDefault] = useState("");
  const [id, setId] = useState("");
  const [type, setType] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSource("catalog");
    setCatId("");
    setCatApiKey("");
    setCatDefault("");
    setId(isEdit ? row.id : "");
    setType(isEdit ? row.type : "openai");
    setApiKey("");
    setBaseUrl(isEdit ? row.base_url || "" : "");
    setDefaultModel(isEdit ? row.default_model || "" : "");
    setBusy(false);
    setErr(null);
  }, [open, isEdit, row]);

  const catProvider = catalog?.providers?.find((p) => p.id === catId);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (!isEdit && source === "catalog") {
        if (!catId) {
          setErr(t("selectProvider"));
          setBusy(false);
          return;
        }
        await onSaved(
          "import",
          { providerId: catId, apiKey: catApiKey, baseUrl: "", defaultModel: catDefault },
          catProvider?.name
        );
      } else {
        await onSaved(
          "saveProvider",
          {
            id: isEdit ? row.id : id,
            type,
            apiKey,
            baseUrl,
            ...(isEdit ? { defaultModel } : {}),
          },
          isEdit ? row.id : id
        );
      }
    } catch (e) {
      setErr(e.message || String(e));
      setBusy(false);
    }
  }

  const showCatalogSource = !isEdit && source === "catalog";
  const catModels = catProvider?.models || [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("editProvider") : t("addProvider")}
            {isEdit ? ` · ${row.id}` : ""}
          </DialogTitle>
          <DialogDescription>{t("providerTypeHint")}</DialogDescription>
        </DialogHeader>

        {!isEdit ? (
          <Tabs value={source} onValueChange={setSource}>
            <TabsList className="w-full">
              <TabsTrigger value="catalog" className="flex-1">
                {t("fromCatalog")}
              </TabsTrigger>
              <TabsTrigger value="manual" className="flex-1">
                {t("manualEntry")}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}

        <div className="space-y-3">
          {showCatalogSource ? (
            <>
              {catalogLoading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {t("scanning")}
                </div>
              ) : catalog?.source === "error" ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
                    {catalog.error || t("writeFailed")}
                  </div>
                  <Button variant="outline" size="sm" onClick={onRetryCatalog}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    {t("retry")}
                  </Button>
                </div>
              ) : (
                <>
                  <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                    {fill(t("catalogSourceHint"), { n: catalog?.providers?.length || 0 })}
                    {catalog ? (
                      <>
                        {" "}
                        ·{" "}
                        <span className="text-foreground/80">
                          {fill(t("catalogSource"), {
                            source: t(
                              catalog.source === "remote"
                                ? "sourceRemote"
                                : catalog.source === "cached"
                                  ? "sourceCached"
                                  : "sourceBuiltin"
                            ),
                          })}
                        </span>
                      </>
                    ) : null}
                  </p>
                  <Field label={t("selectProvider")} required>
                    <Select value={catId} onValueChange={setCatId}>
                      <SelectTrigger aria-label={t("selectProvider")}>
                        <SelectValue placeholder={t("selectProvider")} />
                      </SelectTrigger>
                      <SelectContent>
                        {catalog?.providers?.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name ? `${p.name} (${p.id})` : p.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {catProvider ? (
                    <>
                      {catProvider.api ? (
                        <p className="break-all font-mono text-[11px] text-muted-foreground">
                          {catProvider.api}
                        </p>
                      ) : null}
                      <Field label={t("modelCount")} hint={t("modelCapabilitiesHint")}>
                        <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-secondary/30 p-2 thin-scroll">
                          {catModels.map((m) => (
                            <div
                              key={m.id}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="font-mono text-foreground/90">{m.id}</span>
                              <span className="flex flex-wrap justify-end gap-1">
                                {m.context ? (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                    {(m.context / 1024).toFixed(0)}k
                                  </Badge>
                                ) : null}
                                {(m.capabilities || []).slice(0, 3).map((c) => (
                                  <Badge key={c} variant="secondary" className="px-1 py-0 text-[10px]">
                                    {fmtCapBadge(t, c)}
                                  </Badge>
                                ))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </Field>
                      <Field label={t("apiKeyOptional")}>
                        <Input
                          type="password"
                          value={catApiKey}
                          onChange={(e) => setCatApiKey(e.target.value)}
                          autoComplete="off"
                          placeholder="sk-…"
                        />
                      </Field>
                      <Field label={t("selectDefaultModel")} hint={t("defaultModelOptional")}>
                        <Select value={catDefault} onValueChange={setCatDefault}>
                          <SelectTrigger aria-label={t("selectDefaultModel")}>
                            <SelectValue placeholder={t("secondaryNone")} />
                          </SelectTrigger>
                          <SelectContent>
                            {catModels.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <Field label={t("providerId")} required hint={t("providerIdHint")}>
                <Input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  disabled={isEdit}
                  placeholder="my-provider"
                />
              </Field>
              <Field label={t("providerType")} required>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger aria-label={t("providerType")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_TYPES.map((pt) => (
                      <SelectItem key={pt} value={pt}>
                        {pt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("apiKeyOptional")}>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  placeholder={row?.has_api_key ? "••••••••" : "sk-…"}
                />
              </Field>
              <Field label={t("baseUrl")} hint={t("baseUrlPlaceholder")}>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </Field>
              {isEdit ? (
                <Field label={t("defaultModel")} hint={fill(t("providerDefaultHint"), { format: `${row.id}/model-id` })}>
                  <Input
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                    placeholder={`${row.id}/model-id`}
                  />
                </Field>
              ) : null}
            </>
          )}
        </div>

        {err ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={busy} aria-busy={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? t("saving") : isEdit ? t("save") : t("importProvider")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add / edit model dialog
// ---------------------------------------------------------------------------

function ModelDialog({ t, open, providerId, row, onClose, onSaved }) {
  const isEdit = Boolean(row);
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [maxContextSize, setMaxContextSize] = useState("");
  const [maxInputSize, setMaxInputSize] = useState("");
  const [maxOutputSize, setMaxOutputSize] = useState("");
  const [caps, setCaps] = useState(() => new Set());
  const [supportEfforts, setSupportEfforts] = useState("");
  const [defaultEffort, setDefaultEffort] = useState("");
  const [offEffort, setOffEffort] = useState("");
  const [reasoningKey, setReasoningKey] = useState("");
  const [adaptive, setAdaptive] = useState("auto"); // auto | on | off
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setAlias(isEdit ? row.alias : `${providerId}/`);
    setModel(isEdit ? row.model || "" : "");
    setDisplayName(isEdit ? row.display_name || "" : "");
    setMaxContextSize(isEdit ? String(row.max_context_size ?? "") : "");
    setMaxInputSize(isEdit ? String(row.max_input_size ?? "") : "");
    setMaxOutputSize(isEdit ? String(row.max_output_size ?? "") : "");
    setCaps(isEdit ? parseCaps(row.capabilities) : new Set());
    setSupportEfforts(isEdit && row.support_efforts ? row.support_efforts.join(", ") : "");
    setDefaultEffort(isEdit ? row.default_effort || "" : "");
    setOffEffort(isEdit ? row.off_effort || "" : "");
    setReasoningKey(isEdit ? row.reasoning_key || "" : "");
    setAdaptive(
      isEdit
        ? row.adaptive_thinking === true
          ? "on"
          : row.adaptive_thinking === false
            ? "off"
            : "auto"
        : "auto"
    );
    setBusy(false);
    setErr(null);
  }, [open, isEdit, row, providerId]);

  const thinking = caps.has("thinking") || caps.has("always_thinking");

  function toggleCap(cap, on) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (on) next.add(cap);
      else next.delete(cap);
      return next;
    });
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    // Fields may be pre-filled with numbers (catalog import) — coerce before trim.
    const str = (v) => String(v ?? "").trim();
    const num = (v) => (str(v) ? Number(str(v)) : undefined);
    try {
      const body = {
        alias: str(alias),
        model: str(model),
        displayName: str(displayName) || undefined,
        maxContextSize: num(maxContextSize),
        maxInputSize: num(maxInputSize),
        maxOutputSize: num(maxOutputSize),
        capabilities: [...caps],
        supportEfforts: str(supportEfforts)
          ? supportEfforts.split(",").map((s) => str(s)).filter(Boolean)
          : undefined,
        defaultEffort: str(defaultEffort) || undefined,
        offEffort: str(offEffort) || undefined,
        reasoningKey: str(reasoningKey) || undefined,
        adaptiveThinking: adaptive === "auto" ? undefined : adaptive === "on",
      };
      await onSaved(body);
    } catch (e) {
      setErr(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editModel") : t("addModel")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{providerId}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field
            label={t("modelAlias")}
            required
            hint={!isEdit ? fill(t("aliasHint"), { format: `${providerId}/model-id` }) : undefined}
          >
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              disabled={isEdit}
              className="font-mono"
            />
          </Field>
          <Field label={t("wireModel")} required>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("wireModelPlaceholder")}
              className="font-mono"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("displayName")}>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field label={t("contextSize")} required hint={t("contextSizeRequired")}>
              <Input
                type="number"
                min="1"
                value={maxContextSize}
                onChange={(e) => setMaxContextSize(e.target.value)}
                placeholder="131072"
                className="font-mono"
              />
            </Field>
            <Field label={t("maxInputSize")}>
              <Input
                type="number"
                min="1"
                value={maxInputSize}
                onChange={(e) => setMaxInputSize(e.target.value)}
                placeholder="128000"
                className="font-mono"
              />
            </Field>
            <Field label={t("maxOutputSize")}>
              <Input
                type="number"
                min="1"
                value={maxOutputSize}
                onChange={(e) => setMaxOutputSize(e.target.value)}
                placeholder="8192"
                className="font-mono"
              />
            </Field>
          </div>

          <Field label={t("capabilities")}>
            <div className="grid gap-2 sm:grid-cols-2">
              <CapCheck
                label={t("capText")}
                hint={t("capTextLocked")}
                checked
                disabled
                onChange={() => {}}
              />
              <CapCheck
                label={t("capToolUse")}
                checked={caps.has("tool_use")}
                onChange={(v) => toggleCap("tool_use", v)}
              />
              <CapCheck
                label={t("capImageIn")}
                checked={caps.has("image_in")}
                onChange={(v) => toggleCap("image_in", v)}
              />
              <CapCheck
                label={t("capVideoIn")}
                checked={caps.has("video_in")}
                onChange={(v) => toggleCap("video_in", v)}
              />
              <CapCheck
                label={t("capAudioIn")}
                checked={caps.has("audio_in")}
                onChange={(v) => toggleCap("audio_in", v)}
              />
              <CapCheck
                label={t("capThinking")}
                checked={thinking}
                onChange={(v) => {
                  // A model may carry `always_thinking` (locked on). Toggling
                  // replaces it with a plain `thinking` capability.
                  setCaps((prev) => {
                    const next = new Set(prev);
                    next.delete("always_thinking");
                    if (v) next.add("thinking");
                    else next.delete("thinking");
                    return next;
                  });
                }}
              />
            </div>
          </Field>

          {thinking ? (
            <>
              <Field label={t("thinkingEfforts")} hint={t("effortsPlaceholder")}>
                <Input
                  value={supportEfforts}
                  onChange={(e) => setSupportEfforts(e.target.value)}
                  placeholder="low, medium, high"
                  className="font-mono"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("defaultEffort")}>
                  <Input
                    value={defaultEffort}
                    onChange={(e) => setDefaultEffort(e.target.value)}
                    placeholder="medium"
                    className="font-mono"
                  />
                </Field>
                <Field label={t("offEffort")} hint={t("offEffortHint")}>
                  <Input
                    value={offEffort}
                    onChange={(e) => setOffEffort(e.target.value)}
                    placeholder="none"
                    className="font-mono"
                  />
                </Field>
              </div>
            </>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("reasoningKey")} hint={t("reasoningKeyHint")}>
              <Input
                value={reasoningKey}
                onChange={(e) => setReasoningKey(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label={t("adaptiveThinking")} hint={t("adaptiveThinkingHint")}>
              <Select value={adaptive} onValueChange={setAdaptive}>
                <SelectTrigger aria-label={t("adaptiveThinking")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("secondaryNone")}</SelectItem>
                  <SelectItem value="on">{t("capThinking")}</SelectItem>
                  <SelectItem value="off">{t("secondaryNone")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>

        {err ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={busy} aria-busy={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ModelsPage({ home, t }) {
  const [config, setConfig] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(false);
  const [tab, setTab] = useState("providers");
  const [providerDlg, setProviderDlg] = useState(null); // { mode:'add'|'edit', row? }
  const [modelDlg, setModelDlg] = useState(null); // { providerId, row? }
  const [deleteTarget, setDeleteTarget] = useState(null); // { kind, id | alias }
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const loadingRef = useRef(false);
  const flashTimer = useRef(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const load = useCallback(
    async (opts = {}) => {
      if (loadingRef.current && opts.manual) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      const started = Date.now();
      try {
        const c = await fetchConfig(home);
        setConfig(c);
        if (opts.manual) {
          setFlash(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(false), 1200);
        }
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        const minMs = opts.manual ? 320 : 0;
        const wait = Math.max(0, minMs - (Date.now() - started));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [home]
  );

  const loadCatalog = useCallback(async () => {
    setCatalog(null);
    try {
      const data = await fetchCatalog(home);
      setCatalog(data);
    } catch (e) {
      setCatalog({ source: "error", error: e.message || String(e) });
    }
  }, [home]);

  // Load config on mount / home change; catalog lazily when the dialog opens.
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (providerDlg && providerDlg.mode === "add" && !catalog) loadCatalog();
  }, [providerDlg, catalog, loadCatalog]);

  function noteSaved() {
    setSavedNote(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedNote(false), 1600);
  }

  async function handleProviderSaved(kind, payload) {
    if (kind === "import") {
      await importCatalog(home, payload);
    } else {
      await saveProvider(home, payload);
    }
    await load();
    noteSaved();
    setProviderDlg(null);
  }

  async function handleModelSaved(body) {
    await saveModel(home, modelDlg.providerId, body);
    await load();
    noteSaved();
    setModelDlg(null);
  }

  async function doDelete() {
    setDeleteBusy(true);
    try {
      if (deleteTarget.kind === "provider") {
        await deleteProvider(home, deleteTarget.id);
      } else {
        await deleteModel(home, deleteTarget.alias);
      }
      await load();
      noteSaved();
      setDeleteTarget(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  const modelByAlias = useMemoMap(config);
  const providers = config?.providers || [];
  const models = config?.models || [];
  const defaultModel = config?.defaultModel || null;
  const secondaryModel = config?.secondaryModel || null;

  function openModelDialog(providerId, row) {
    setModelDlg({ providerId, row: row || null });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{t("modelsTitle")}</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            {t("modelsSubtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {savedNote ? (
            <span className="text-xs text-emerald-300">{t("saved")}</span>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => load({ manual: true })}
            disabled={loading}
            aria-busy={loading}
            className={cn(flash && !loading && "ring-1 ring-primary/50 text-primary")}
          >
            <RefreshCw
              className={cn("h-4 w-4 shrink-0 text-current", loading && "icon-spin")}
              aria-hidden
            />
            <span>{loading ? t("refreshing") : t("refresh")}</span>
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="providers">{t("tabProviders")}</TabsTrigger>
          <TabsTrigger value="models">{t("tabModels")}</TabsTrigger>
          <TabsTrigger value="secondary">{t("tabSecondary")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {!config ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {t("scanning")}
        </div>
      ) : null}

      {tab === "providers" && config ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button onClick={() => setProviderDlg({ mode: "add" })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("addProvider")}
            </Button>
          </div>
          {providers.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {t("noProviders")}
              </CardContent>
            </Card>
          ) : (
            providers.map((p) => (
              <Card key={p.id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{p.id}</span>
                        {p.id === config.defaultProvider ? (
                          <Badge variant="default">{t("mDefault")}</Badge>
                        ) : null}
                      </CardTitle>
                      <CardDescription className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
                        <span>{p.type}</span>
                        {p.base_url ? (
                          <span className="max-w-[28rem] truncate text-muted-foreground/70">
                            {p.base_url}
                          </span>
                        ) : null}
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge variant={p.has_api_key ? "success" : "warn"}>
                        {p.has_api_key ? (
                          <KeyRound className="mr-1 h-3 w-3" aria-hidden />
                        ) : null}
                        {p.has_api_key ? t("apiKeySet") : t("apiKeyUnset")}
                      </Badge>
                      {p.env_keys.length > 0 ? (
                        <Badge
                          variant="secondary"
                          title={p.env_keys.join(", ")}
                        >
                          {t("envKeys")}: {p.env_keys.length}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {fill(t("modelCount"), { n: p.models.length })}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => openModelDialog(p.id, null)}>
                        <Plus className="h-3.5 w-3.5" aria-hidden />
                        {t("addModel")}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setProviderDlg({ mode: "edit", row: p })}
                        title={t("editProvider")}
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-red-300 hover:text-red-200"
                        onClick={() => setDeleteTarget({ kind: "provider", id: p.id })}
                        title={t("delete")}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  {p.models.length === 0 ? (
                    <p className="py-2 text-xs text-muted-foreground">{t("noModels")}</p>
                  ) : (
                    <div className="max-h-96 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-secondary/20 thin-scroll">
                      {p.models.map((alias) => {
                        const m = modelByAlias[alias];
                        if (!m) return null;
                        const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
                        const isDefault = alias === defaultModel;
                        const isSecondary = secondaryModel?.model === alias;
                        return (
                          <div
                            key={alias}
                            className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-sm text-foreground/90">
                                  {alias}
                                </span>
                                {isDefault ? (
                                  <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                                    {t("mDefault")}
                                  </Badge>
                                ) : null}
                                {isSecondary ? (
                                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                    {t("mSecondary")}
                                  </Badge>
                                ) : null}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                <span className="font-mono">{m.model || alias}</span>
                                {m.display_name ? (
                                  <span className="truncate text-muted-foreground/70">
                                    {m.display_name}
                                  </span>
                                ) : null}
                                {typeof m.max_context_size === "number" ? (
                                  <span className="tabular-nums">
                                    {(m.max_context_size / 1024).toFixed(0)}k ctx
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              {caps.map((c) => (
                                <Badge key={c} variant="secondary" className="px-1.5 py-0 text-[10px]">
                                  {fmtCapBadge(t, c)}
                                </Badge>
                              ))}
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={() => openModelDialog(p.id, m)}
                                title={t("editModel")}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-red-300 hover:text-red-200"
                                onClick={() => setDeleteTarget({ kind: "model", alias })}
                                title={t("delete")}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {tab === "models" && config ? <ModelsTabView config={config} t={t} onAdd={openModelDialog} onEdit={openModelDialog} /> : null}

      {tab === "secondary" && config ? (
        <SecondaryTab
          t={t}
          home={home}
          config={config}
          onSaved={async (body) => {
            await setSecondaryModel(home, body);
            await load();
            noteSaved();
          }}
          savedNote={savedNote}
        />
      ) : null}

      <ProviderDialog
        t={t}
        open={Boolean(providerDlg)}
        mode={providerDlg?.mode || "add"}
        row={providerDlg?.row || null}
        catalog={catalog}
        catalogLoading={!catalog && providerDlg?.mode === "add"}
        onRetryCatalog={loadCatalog}
        onClose={() => setProviderDlg(null)}
        onSaved={handleProviderSaved}
      />

      <ModelDialog
        t={t}
        open={Boolean(modelDlg)}
        providerId={modelDlg?.providerId || ""}
        row={modelDlg?.row || null}
        onClose={() => setModelDlg(null)}
        onSaved={handleModelSaved}
      />

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden />
              {t(
                deleteTarget?.kind === "provider"
                  ? "confirmDeleteProviderTitle"
                  : "confirmDeleteModelTitle"
              )}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.kind === "provider"
                ? fill(t("confirmDeleteProvider"), { id: deleteTarget.id })
                : fill(t("confirmDeleteModel"), { alias: deleteTarget?.alias })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              className="bg-red-600 text-white hover:bg-red-500"
              onClick={doDelete}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden />
              )}
              {t("deleteForever")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Index models by alias once per config snapshot. */
function useMemoMap(config) {
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!config) return;
    const m = {};
    for (const row of config.models || []) m[row.alias] = row;
    setMap(m);
  }, [config]);
  return map;
}

// ---------------------------------------------------------------------------
// Models tab: every model grouped by provider
// ---------------------------------------------------------------------------

function ModelsTabView({ config, t, onAdd, onEdit }) {
  const groups = [];
  const byProvider = {};
  for (const p of config.providers) byProvider[p.id] = [];
  for (const m of config.models || []) {
    const pid = m.provider || m.provider_id;
    if (pid && byProvider[pid]) byProvider[pid].push(m);
  }
  for (const p of config.providers) {
    groups.push({ provider: p, models: byProvider[p.id] || [] });
  }
  const ungrouped = (config.models || []).filter((m) => {
    const pid = m.provider || m.provider_id;
    return !pid || !byProvider[pid];
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{fill(t("modelsCount"), { n: config.models?.length || 0 })}</Badge>
        {config.defaultModel ? (
          <span>
            {t("defaultModel")}: <span className="font-mono text-foreground/80">{config.defaultModel}</span>
          </span>
        ) : null}
        {config.secondaryModel?.model ? (
          <span>
            {t("mSecondary")}:{" "}
            <span className="font-mono text-foreground/80">{config.secondaryModel.model}</span>
          </span>
        ) : null}
      </div>
      {groups.map(({ provider, models: list }) => (
        <Card key={provider.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <span className="font-mono">{provider.id}</span>
                <span className="text-xs font-normal text-muted-foreground">{provider.type}</span>
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => onAdd(provider.id, null)}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {t("addModel")}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {list.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">{t("noModels")}</p>
            ) : (
              <div className="max-h-96 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-secondary/20 thin-scroll">
                {list.map((m) => (
                  <div key={m.alias} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-sm text-foreground/90">{m.alias}</span>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        <span className="font-mono">{m.model || m.alias}</span>
                        {m.display_name ? ` · ${m.display_name}` : ""}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {(m.capabilities || []).map((c) => (
                        <Badge key={c} variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {fmtCapBadge(t, c)}
                        </Badge>
                      ))}
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7 p-0" onClick={() => onEdit(provider.id, m)} title={t("editModel")}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {ungrouped.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("modelsUngrouped")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 bg-secondary/20 thin-scroll">
              {ungrouped.map((m) => (
                <div key={m.alias} className="px-3 py-2">
                  <span className="font-mono text-sm text-foreground/90">{m.alias}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secondary model tab
// ---------------------------------------------------------------------------

function SecondaryTab({ t, home, config, onSaved, savedNote }) {
  const aliases = (config.models || []).map((m) => m.alias).sort((a, b) => a.localeCompare(b));
  const current = config.secondaryModel || null;
  const [model, setModel] = useState(current?.model || "");
  const [defaultEffort, setDefaultEffort] = useState(current?.default_effort || "");
  const [offEffort, setOffEffort] = useState(current?.off_effort || "");
  const [maxOutputSize, setMaxOutputSize] = useState(
    current?.max_output_size ? String(current.max_output_size) : ""
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Re-sync when config reloads with a fresh secondary_model.
  useEffect(() => {
    setModel(current?.model || "");
    setDefaultEffort(current?.default_effort || "");
    setOffEffort(current?.off_effort || "");
    setMaxOutputSize(current?.max_output_size ? String(current.max_output_size) : "");
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  async function submit() {
    if (!model) {
      setErr(t("secondaryModel"));
      return;
    }
    setBusy(true);
    setErr(null);
    const str = (v) => String(v ?? "").trim();
    try {
      await onSaved({
        model: str(model),
        defaultEffort: str(defaultEffort) || undefined,
        offEffort: str(offEffort) || undefined,
        maxOutputSize: str(maxOutputSize) ? Number(str(maxOutputSize)) : undefined,
      });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearIt() {
    setBusy(true);
    setErr(null);
    try {
      await onSaved({ model: "" });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{t("secondaryExperiment")}</span>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>{t("secondaryTitle")}</CardTitle>
          <CardDescription>{t("secondarySubtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label={t("secondaryModel")} required>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger aria-label={t("secondaryModel")}>
                <SelectValue placeholder={t("secondaryNone")} />
              </SelectTrigger>
              <SelectContent>
                {aliases.map((a) => (
                  <SelectItem key={a} value={a}>
                    <span className="font-mono">{a}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("defaultEffort")} hint={t("effortsPlaceholder")}>
              <Input
                value={defaultEffort}
                onChange={(e) => setDefaultEffort(e.target.value)}
                placeholder="medium"
                className="font-mono"
              />
            </Field>
            <Field label={t("offEffort")} hint={t("offEffortHint")}>
              <Input
                value={offEffort}
                onChange={(e) => setOffEffort(e.target.value)}
                placeholder="none"
                className="font-mono"
              />
            </Field>
          </div>
          <Field label={t("maxOutputSize")}>
            <Input
              type="number"
              min="1"
              value={maxOutputSize}
              onChange={(e) => setMaxOutputSize(e.target.value)}
              className="font-mono"
            />
          </Field>

          {err ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
              {err}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={submit} disabled={busy || !model} aria-busy={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {busy ? t("saving") : t("save")}
            </Button>
            {current ? (
              <Button variant="outline" onClick={clearIt} disabled={busy}>
                {t("clearSecondary")}
              </Button>
            ) : null}
            {savedNote ? <span className="text-xs text-emerald-300">{t("secondarySaved")}</span> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

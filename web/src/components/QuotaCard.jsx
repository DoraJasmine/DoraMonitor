import React, { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, Play, RefreshCw, Square, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchQuota, fetchQuotaCapacityHistory, fetchQuotaSampleHistory, fetchSettings, runQuotaCalibration, saveSettings } from "@/lib/backend";
import { fill } from "@/i18n";
import { fmtTokens } from "@/format";
import { cn } from "@/lib/utils";

function countdown(targetIso, nowMs) {
  const t = Date.parse(targetIso);
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, t - nowMs);
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 48) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

const REASON_KEY = {
  token_expired: "quotaTokenExpired",
  no_credentials: "quotaTokenExpired",
};

const CALIBRATION_ERROR_KEY = {
  calibration_exists: "calibrationErrorExists",
  calibration_not_found: "calibrationErrorNotFound",
  calibration_too_short: "calibrationErrorTooShort",
  calibration_too_few_tokens: "calibrationErrorTooFewTokens",
  calibration_no_quota_change: "calibrationErrorNoQuotaChange",
  calibration_coverage_pending: "calibrationErrorCoverage",
  calibration_reset: "calibrationErrorReset",
  quota_window_unavailable: "calibrationErrorWindow",
  quota_unavailable: "calibrationErrorWindow",
};

const TOOL_I18N = {
  "kimi-code": { title: "quotaTitle", hint: "quotaHint" },
  codex: { title: "codexQuotaTitle", hint: "codexQuotaHint" },
};

function formatDate(value, locale) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatCny(value, locale) {
  if (!Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return locale === "zh" ? `¥${formatted}` : `CNY ${formatted}`;
}

function methodKey(method) {
  return `capacityMethod${method.charAt(0).toUpperCase()}${method.slice(1)}`;
}

function HistoryList({ target, capacity, locale, t }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const query = {
    provider: capacity.provider,
    accountKey: capacity.accountKey,
    scope: capacity.usageScope,
    window: target.window,
    cacheHitRate: target.cacheHitRate,
    estimateKind: target.estimateKind || "standard",
  };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    setHistory(null);
    setTotal(0);
    setFailed(false);
  }, [queryKey]);

  const load = async (offset = 0) => {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const data = await fetchQuotaCapacityHistory({ ...query, limit: 30, offset });
      const rows = data.history || [];
      setHistory((current) => offset === 0 || !current ? rows : [...current, ...rows]);
      setTotal(Number(data.total) || rows.length);
    } catch {
      setFailed(true);
      if (offset === 0) setHistory([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <button type="button" className="rounded-sm text-[11px] font-medium text-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open} onClick={() => {
        const next = !open;
        setOpen(next);
        if (next && history === null) load(0);
      }}>
        {t("capacityHistory")}
      </button>
      {open && <div className="mt-2 space-y-2">
        {loading && history === null && <div>{t("loading")}</div>}
        {failed && <div className="flex items-center gap-2 text-destructive"><span>{t("capacityHistoryFailed")}</span><Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => load(0)}>{t("retry")}</Button></div>}
        {history && !history.length && !loading && <div>{t("capacityNoHistory")}</div>}
        {history && [...history].reverse().map((item) => (
          <article key={`${item.createdAt}-${item.cacheHitRate}`} className="space-y-1 border-b border-border/40 pb-2 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2 text-foreground/85">
              <span className="num font-medium">{fmtTokens(item.fullWindowTokens)} · {formatCny(item.fullWindowCostCny, locale)}</span>
              <span>{fill(t("capacityScore"), { score: item.confidenceScore ?? 0 })} · {item.trigger === "manual" ? t("calibrationManual") : t("calibrationScheduled")}</span>
            </div>
            <div>{t("capacityInterval")}: {formatDate(item.calculationStartAt || item.dataRange?.start, locale)} → {formatDate(item.calculationEndAt || item.dataRange?.end, locale)}</div>
            <div>{t("capacityPreviousEnd")}: {formatDate(item.previousCalculationEndAt, locale)}</div>
            <div>{t("capacityRecordedAt")}: {formatDate(item.createdAt, locale)}</div>
          </article>
        ))}
        {history && history.length < total && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={loading} onClick={() => load(history.length)}>
            {loading ? t("loading") : fill(t("capacityLoadMore"), { remaining: total - history.length })}
          </Button>
        )}
      </div>}
    </div>
  );
}

function CapacityTarget({ target, maximum, capacity, locale, t, expanded }) {
  const [open, setOpen] = useState(false);
  const insufficient = !Number.isFinite(target.fullWindowTokens);
  const row = (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 text-xs">
      <span className="font-medium">{Math.round(target.cacheHitRate * 100)}%</span>
      <span className={cn("num", insufficient ? "text-muted-foreground" : "font-semibold")}>{insufficient ? t("capacityInsufficient") : fmtTokens(target.fullWindowTokens)}</span>
      <span className="num text-muted-foreground">{insufficient ? "—" : formatCny(target.fullWindowCostCny, locale)}</span>
      <span className="text-[10px] text-muted-foreground">{insufficient ? "—" : fill(t("capacityScore"), { score: target.confidenceScore ?? 0 })}</span>
    </div>
  );
  if (!expanded) return <div className="py-1.5">{row}</div>;
  return (
    <div className="border-b border-border/40 py-1.5 last:border-0">
      <button type="button" className="w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default" disabled={insufficient} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <div className="flex items-center gap-1">
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">{row}</div>
        </div>
      </button>
      {open && !insufficient && (
        <div className="ml-4 mt-2 space-y-1.5 text-[11px] text-muted-foreground">
          <div>{t(methodKey(target.method))} · {fill(t("capacitySamples"), { n: target.sampleCount })} · {t(`capacityConfidence${target.confidence.charAt(0).toUpperCase()}${target.confidence.slice(1)}`)}</div>
          {Number.isFinite(target.low) && Number.isFinite(target.high) && <div>{t("capacityRange")}: {fmtTokens(target.low)}–{fmtTokens(target.high)}</div>}
          {maximum && <div>{t("capacityMax")}: {fmtTokens(maximum.fullWindowTokens)} · {formatCny(maximum.fullWindowCostCny, locale)} · {formatDate(maximum.createdAt, locale)}</div>}
          <div>{t("capacityInterval")}: {formatDate(target.dataRange?.start, locale)} → {formatDate(target.dataRange?.end, locale)}</div>
          <HistoryList target={target} capacity={capacity} locale={locale} t={t} />
        </div>
      )}
    </div>
  );
}

function CalibrationControls({ window, capacity, locale, t, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const active = (capacity.calibrations || []).find((item) => item.window === window);

  const run = async (action) => {
    setBusy(true);
    setMessage(null);
    try {
      await runQuotaCalibration({
        action,
        provider: capacity.provider,
        accountKey: capacity.accountKey,
        scope: capacity.usageScope,
        window,
      });
      setMessage({ kind: "success", text: t(action === "start" ? "calibrationStarted" : action === "end" ? "calibrationFinished" : "calibrationCancelled") });
      await onChanged();
    } catch (error) {
      const key = CALIBRATION_ERROR_KEY[error.data?.error];
      setMessage({ kind: "error", text: key ? t(key) : error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-border/50 pt-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" disabled={busy} onClick={() => run("end")}>
              <Square className="h-3 w-3" aria-hidden />{t("calibrationEnd")}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-muted-foreground" disabled={busy} onClick={() => run("cancel")}>
              <X className="h-3 w-3" aria-hidden />{t("cancel")}
            </Button>
            <span className="text-muted-foreground">{t("calibrationActiveSince")}: {formatDate(active.startAt, locale)}</span>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" disabled={busy} onClick={() => run("start")}>
              <Play className="h-3 w-3" aria-hidden />{t("calibrationStart")}
            </Button>
            <span className="text-muted-foreground">{t("calibrationRequirement")}</span>
          </>
        )}
      </div>
      {message && <div className={cn("mt-2", message.kind === "error" ? "text-destructive" : "text-emerald-600")} role="status">{message.text}</div>}
    </div>
  );
}

function QuotaSampleHistory({ quota, locale, t }) {
  const [open, setOpen] = useState(false);
  const [samples, setSamples] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const provider = quota.capacity?.provider;
  const accountKey = quota.accountKey || quota.capacity?.accountKey;
  const queryKey = `${provider}:${accountKey}`;

  useEffect(() => {
    setSamples(null);
    setTotal(0);
    setOpen(false);
  }, [queryKey]);

  const load = async (offset = 0) => {
    if (loading || !provider || !accountKey) return;
    setLoading(true);
    setFailed(false);
    try {
      const data = await fetchQuotaSampleHistory({ provider, accountKey, limit: 20, offset });
      const rows = data.samples || [];
      setSamples((current) => offset === 0 || !current ? rows : [...current, ...rows]);
      setTotal(Number(data.total) || rows.length);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  if (!provider || !accountKey) return null;
  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <Button variant="ghost" size="sm" className="h-7 px-0 text-[11px] text-muted-foreground" aria-expanded={open} onClick={() => {
        const next = !open;
        setOpen(next);
        if (next && samples === null) load(0);
      }}>
        {t("quotaSamplesTitle")}
      </Button>
      {open && <div className="mt-1 space-y-2 text-[11px] text-muted-foreground">
        <div>{t("quotaSamplesHint")}</div>
        {loading && samples === null && <div>{t("loading")}</div>}
        {failed && <div className="text-destructive">{t("capacityHistoryFailed")}</div>}
        {samples && !samples.length && <div>{t("capacityNoHistory")}</div>}
        {(samples || []).map((sample) => (
          <div key={`${sample.window}-${sample.sampledAt}-${sample.source}`} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border/40 pb-1.5 last:border-0">
            <span>{formatDate(sample.sampledAt, locale)}</span>
            <span>{sample.window === "session" ? t("quota5h") : t("quotaWeekly")} · <strong className="text-foreground/80">{sample.usedPercent}% {t("quotaUsed")}</strong> · {sample.source === "manual-calibration" ? t("calibrationManual") : t("calibrationScheduled")}</span>
          </div>
        ))}
        {samples && samples.length < total && <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={loading} onClick={() => load(samples.length)}>{loading ? t("loading") : fill(t("capacityLoadMore"), { remaining: total - samples.length })}</Button>}
      </div>}
    </div>
  );
}

function CapacitySection({ capacity, locale, t, onChanged }) {
  const storageKey = `dora-capacity-expanded:${capacity?.provider || "default"}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  if (!capacity || !Array.isArray(capacity.targets)) return null;
  const visibleRates = expanded ? [0.85, 0.9, 0.95, 0.98] : [0.9, 0.95];

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {}
  };

  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{t("capacityTitle")}</h3>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{t("capacityHint")}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground" onClick={toggle} aria-expanded={expanded}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          {expanded ? t("capacityCollapse") : t("capacityExpand")}
        </Button>
      </div>
      <div className="mt-3 grid gap-x-8 gap-y-5 lg:grid-cols-2">
        {["session", "weekly"].map((window) => {
          const targets = capacity.targets.filter((target) => target.window === window && visibleRates.includes(target.cacheHitRate));
          return (
            <div key={window}>
              <div className="mb-1 text-xs font-medium">{window === "session" ? t("quota5h") : t("quotaWeekly")}</div>
              <div className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b border-border/60 pb-1.5 text-[10px] text-muted-foreground">
                <span>{t("capacityCache")}</span>
                <span>{t("capacityFull")}</span>
                <span>{t("capacityCost")}</span>
                <span>{t("capacityQuality")}</span>
              </div>
              {targets.map((target) => (
                <CapacityTarget
                  key={`${target.window}-${target.cacheHitRate}`}
                  target={target}
                  maximum={(capacity.maxima || []).find((item) => item.window === target.window && item.cacheHitRate === target.cacheHitRate && (item.estimateKind || "standard") === "standard")}
                  capacity={capacity}
                  locale={locale}
                  t={t}
                  expanded={expanded}
                />
              ))}
              {expanded && <CalibrationControls window={window} capacity={capacity} locale={locale} t={t} onChanged={onChanged} />}
            </div>
          );
        })}
      </div>
      {capacity.usageScope === "kimi-code-only" && <div className="mt-3 text-[11px] text-amber-600">{t("capacityScopeWarning")}</div>}
    </section>
  );
}

function LongTermCapacitySection({ capacity, locale, t }) {
  const targets = capacity?.longTermTargets || [];
  if (!targets.length) return null;
  const hasData = targets.some((target) => Number.isFinite(target.fullWindowTokens));
  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      <h3 className="text-sm font-medium">{t("longTermTitle")}</h3>
      <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">{t("longTermHint")}</p>
      {!hasData ? (
        <div className="mt-2 text-[11px] text-muted-foreground">{t("longTermInsufficient")}</div>
      ) : (
        <div className="mt-3 grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {["session", "weekly"].map((window) => (
            <div key={window}>
              <div className="mb-1 text-xs font-medium">{window === "session" ? t("quota5h") : t("quotaWeekly")}</div>
              <div className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 border-b border-border/60 pb-1.5 text-[10px] text-muted-foreground">
                <span>{t("capacityCache")}</span><span>{t("capacityFull")}</span><span>{t("capacityCost")}</span><span>{t("capacityQuality")}</span>
              </div>
              {targets.filter((target) => target.window === window && [0.9, 0.95].includes(target.cacheHitRate)).map((target) => (
                <CapacityTarget
                  key={`long-${target.window}-${target.cacheHitRate}`}
                  target={target}
                  maximum={(capacity.maxima || []).find((item) => item.window === target.window && item.cacheHitRate === target.cacheHitRate && item.estimateKind === "long-term")}
                  capacity={capacity}
                  locale={locale}
                  t={t}
                  expanded
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function QuotaCard({ t, locale, refreshSignal, tool = "kimi-code" }) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState("all-clients");
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (tool !== "kimi-code") return;
    fetchSettings().then((settings) => {
      setScope(settings.quotaEstimation?.kimiCodeOnly ? "kimi-code-only" : "all-clients");
    }).catch(() => {});
  }, [tool]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const d = await fetchQuota(refresh, tool === "kimi-code" ? null : tool, tool === "kimi-code" ? scope : null);
      setQuota(d);
    } catch {
      setQuota(null);
    } finally {
      setLoading(false);
    }
  }, [tool, scope]);

  useEffect(() => {
    load(false);
  }, [load, refreshSignal]);
  useEffect(() => {
    const timer = setInterval(() => forceTick((x) => x + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const changeScope = async (next) => {
    const previous = scope;
    setScope(next);
    try {
      await saveSettings({ quotaEstimation: { kimiCodeOnly: next === "kimi-code-only" } });
    } catch {
      setScope(previous);
    }
  };

  const windows = quota?.windows || [];
  const reasonKey = REASON_KEY[quota?.reason];
  const reasonText = reasonKey
    ? t(reasonKey)
    : (quota?.reason || "").startsWith("http_")
      ? `HTTP ${quota.reason.slice(5)}`
      : quota?.reason || "—";
  const i18n = TOOL_I18N[tool] || TOOL_I18N["kimi-code"];

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle>{t(i18n.title)}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {tool === "kimi-code" && (
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
                value={scope}
                onChange={(event) => changeScope(event.target.value)}
                aria-label={t("capacityScope")}
              >
                <option value="all-clients">{t("capacityScopeAll")}</option>
                <option value="kimi-code-only">{t("capacityScopeKimiCode")}</option>
              </select>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" disabled={loading} onClick={() => load(true)} aria-label={t("refresh")}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "icon-spin")} />
            </Button>
          </div>
        </div>
        <CardDescription>{t(i18n.hint)}</CardDescription>
      </CardHeader>
      <CardContent>
        {!quota ? (
          <div className="py-2 text-sm text-muted-foreground">{t("quotaNoUsage")}</div>
        ) : !quota.available ? (
          <div className="py-2 text-sm text-muted-foreground">{fill(t("quotaUnavailable"), { reason: reasonText })}</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {[...windows].sort((a, b) => (a.kind === "session" ? 0 : 1) - (b.kind === "session" ? 0 : 1)).map((w) => {
              const used = Math.round(w.usedPercent);
              const remainingPercent = Math.max(0, Math.min(100, 100 - used));
              const remaining = countdown(w.resetsAt, Date.now());
              return (
                <div key={w.kind} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{w.kind === "session" ? t("quota5h") : w.label || t("quotaWeekly")}</span>
                    <span className="text-sm font-semibold num">{remainingPercent}% {t("quotaRemaining")}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${remainingPercent}%` }} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">{w.resetsAt ? fill(t("quotaResetsIn"), { t: remaining || "—" }) : "\u00a0"}</div>
                </div>
              );
            })}
          </div>
        )}
        {quota?.available && <QuotaSampleHistory quota={quota} locale={locale} t={t} />}
        {quota && <CapacitySection capacity={quota.capacity} locale={locale} t={t} onChanged={() => load(false)} />}
        {quota && <LongTermCapacitySection capacity={quota.capacity} locale={locale} t={t} />}
      </CardContent>
    </Card>
  );
}

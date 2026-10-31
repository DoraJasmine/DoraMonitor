import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, Play, RefreshCw, Square, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchQuota, fetchQuotaAccounts, fetchQuotaCapacityHistory, fetchQuotaSampleHistory, fetchSettings, runQuotaCalibration, saveSettings } from "@/lib/backend";
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

function formatRange(startIso, endIso, locale) {
  const start = Date.parse(startIso || "");
  const end = Date.parse(endIso || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return `${formatDate(startIso, locale)} → ${formatDate(endIso, locale)}`;
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  const dayTime = new Date(start).toLocaleString(tag, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (new Date(start).toDateString() === new Date(end).toDateString()) {
    return `${dayTime} → ${new Date(end).toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
  }
  return `${dayTime} → ${new Date(end).toLocaleString(tag, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`;
}

function methodKey(method) {
  return `capacityMethod${method.charAt(0).toUpperCase()}${method.slice(1)}`;
}

function historyBatches(history) {
  const batches = new Map();
  for (const item of history) {
    const key = `${item.createdAt}-${item.trigger || "scheduled"}-${item.calibrationId || ""}`;
    if (!batches.has(key)) batches.set(key, { ...item, targets: [] });
    batches.get(key).targets.push(item);
  }
  return [...batches.values()];
}

function observationSummary(targets, calculationStartAt, calculationEndAt) {
  // Observations belong to the estimate's own data window; the calculation
  // chain start (previous run's end) can sit inside that window, so filtering
  // by it would wrongly discard every interval. Prefer the target dataRange.
  const range = targets[0]?.dataRange || {};
  const start = Date.parse(range.start || calculationStartAt || "");
  const end = Date.parse(range.end || calculationEndAt || "");
  const observations = (targets[0]?.observations || []).filter((observation) => {
    const observedStart = Date.parse(observation.start || "");
    const observedEnd = Date.parse(observation.end || "");
    return (!Number.isFinite(start) || observedStart >= start) && (!Number.isFinite(end) || observedEnd <= end);
  });
  const models = new Map();
  let totalTokens = 0;
  let costCny = 0;
  let percentSpan = 0;
  let inputTotal = 0;
  let cacheReadTotal = 0;
  for (const observation of observations) {
    totalTokens += observation.totalTokens || 0;
    costCny += observation.costCny || 0;
    percentSpan += observation.dp || 0;
    for (const [name, usage] of Object.entries(observation.models || {})) {
      if (!models.has(name)) models.set(name, { totalTokens: 0, input: 0, cacheRead: 0 });
      const model = models.get(name);
      model.totalTokens += usage.totalTokens || 0;
      const input = (usage.inputOther || 0) + (usage.inputCacheRead || 0) + (usage.inputCacheCreation || 0);
      model.input += input;
      model.cacheRead += usage.inputCacheRead || 0;
      inputTotal += input;
      cacheReadTotal += usage.inputCacheRead || 0;
    }
  }
  const cacheHit = inputTotal > 0 ? cacheReadTotal / inputTotal : null;
  return { totalTokens, costCny, percentSpan, cacheHit, models: [...models.entries()], hasObservations: observations.length > 0 };
}

function HistoryList({ window, estimateKind = "standard", capacity, locale, t }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeq = useRef(0);
  const query = {
    tool: capacity.tool,
    accountKey: capacity.accountKey,
    scope: capacity.usageScope,
    window,
    estimateKind,
  };
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    requestSeq.current += 1;
    setHistory(null);
    setTotal(0);
    setLoading(false);
    setFailed(false);
    setOpen(false);
  }, [queryKey]);

  const load = async (offset = 0) => {
    if (loading) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    try {
      const data = await fetchQuotaCapacityHistory({ ...query, limit: 40, offset });
      if (seq !== requestSeq.current) return;
      const rows = data.history || [];
      setHistory((current) => offset === 0 || !current ? rows : [...current, ...rows]);
      setTotal(Number(data.total) || rows.length);
    } catch {
      if (seq !== requestSeq.current) return;
      setFailed(true);
      if (offset === 0) setHistory([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <Button variant="outline" size="sm" className="h-8 gap-1.5 px-3 text-xs" aria-expanded={open} onClick={() => {
        const next = !open;
        setOpen(next);
        if (next && history === null) load(0);
      }}>
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
        {t("capacityHistory")}
      </Button>
      {open && <div className="mt-2 space-y-2.5">
        {loading && history === null && <div>{t("loading")}</div>}
        {failed && <div className="flex items-center gap-2 text-destructive"><span>{t("capacityHistoryFailed")}</span><Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => load(0)}>{t("retry")}</Button></div>}
        {history && !history.length && !loading && <div>{t("capacityNoHistory")}</div>}
        {history && historyBatches(history).map((batch) => {
          const observed = observationSummary(batch.targets, batch.calculationStartAt, batch.calculationEndAt);
          const trigger = batch.trigger === "manual" ? t("calibrationManual") : batch.trigger === "manual-end" ? t("calibrationManualEnd") : batch.trigger === "reanchor" ? t("calibrationReanchor") : t("calibrationScheduled");
          const dominant = observed.models.reduce((best, entry) => (entry[1].totalTokens > (best?.[1].totalTokens || 0) ? entry : best), null);
          return (
            <article key={`${batch.createdAt}-${batch.trigger}-${batch.calibrationId}`} className="space-y-1.5 border-b border-border/40 pb-2.5 last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="num t-body font-medium">
                  {formatCny(batch.targets.find((target) => Number.isFinite(target.fullWindowCostCny))?.fullWindowCostCny, locale)}
                  {dominant && <span className="ml-2 t-caption" title={dominant[0]}>{dominant[0]}</span>}
                </span>
                <span className="t-caption">{trigger} · {fill(t("capacityScore"), { score: batch.targets[0]?.confidenceScore ?? 0 })}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                {[0.85, 0.9, 0.95, 0.98].map((rate) => {
                  const target = batch.targets.find((item) => item.cacheHitRate === rate);
                  return <div key={rate} className="num whitespace-nowrap text-foreground/85"><span className="text-muted-foreground">{Math.round(rate * 100)}% </span><strong>{Number.isFinite(target?.fullWindowTokens) ? fmtTokens(target.fullWindowTokens) : "—"}</strong></div>;
                })}
              </div>
              <div className="t-caption">
                {t("capacityInterval")}: {formatRange(batch.dataRange?.start || batch.calculationStartAt, batch.dataRange?.end || batch.calculationEndAt, locale)}
              </div>
              {observed.hasObservations ? (
                <>
                  <div className="num t-body">
                    {t("capacityObservedUsage")}: {fmtTokens(observed.totalTokens)} · {formatCny(observed.costCny, locale)} · +{observed.percentSpan}%
                    {Number.isFinite(observed.cacheHit) && <span><span className="mx-1.5">·</span>{t("capacityCache")} {Math.round(observed.cacheHit * 1000) / 10}%</span>}
                  </div>
                  {observed.models.length > 0 && <div className="t-caption">
                    <div>{t("capacityModelBreakdown")}:</div>
                    <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                      {observed.models.map(([name, model]) => (
                        <span key={name} className="num whitespace-nowrap">
                          <span className="text-foreground/80" title={name}>{name}</span> {fmtTokens(model.totalTokens)} · {model.input > 0 ? Math.round(model.cacheRead / model.input * 1000) / 10 : 0}%
                        </span>
                      ))}
                    </div>
                  </div>}
                </>
              ) : <div className="t-caption">{t("capacityNoObservations")}</div>}
            </article>
          );
        })}
        {history && history.length < total && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={loading} onClick={() => load(history.length)}>
            {loading ? t("loading") : fill(t("capacityLoadMore"), { remaining: total - history.length })}
          </Button>
        )}
      </div>}
    </div>
  );
}

function RateBasis({ rate, t }) {
  const parts = t("capacityBasis").split("{rate}");
  return (
    <span className="t-caption whitespace-nowrap">
      {parts[0]}<strong className="font-bold text-foreground">{rate}</strong>{parts[1] ?? ""}
    </span>
  );
}

function estimateModelLabel(target) {
  const entries = Object.entries(target?.modelMix || {}).sort((a, b) => b[1].mix - a[1].mix);
  if (!entries.length) return null;
  const shown = entries.filter(([, shape]) => shape.mix >= 0.05).slice(0, 2);
  const list = shown.length ? shown : entries.slice(0, 1);
  if (list.length === 1) return list[0][0];
  const total = list.reduce((sum, [, shape]) => sum + shape.mix, 0);
  return list.map(([name, shape]) => `${name} ${Math.round((shape.mix / total) * 100)}%`).join(" + ");
}

function CapacityRateLine({ target, locale, t }) {
  const insufficient = !Number.isFinite(target?.fullWindowTokens);
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-0.5 py-1.5">
      <RateBasis rate={`${Math.round((target?.cacheHitRate || 0) * 100)}%`} t={t} />
      <span className="t-caption">
        {t("capacityFull")}{" "}
        <strong className={cn("num", insufficient ? "font-normal" : "t-strong")}>
          {insufficient ? t("capacityInsufficient") : fmtTokens(target.fullWindowTokens)}
        </strong>
        {!insufficient && estimateModelLabel(target) && <span className="ml-1 whitespace-nowrap">· {estimateModelLabel(target)}</span>}
      </span>
      <span className="t-caption">
        {t("capacityCost")}{" "}
        <span className="num t-body font-medium">{Number.isFinite(target?.fullWindowCostCny) ? formatCny(target.fullWindowCostCny, locale) : "—"}</span>
      </span>
      <span className="t-caption">
        {t("capacityQuality")}{" "}
        <span className="num t-body font-medium">{Number.isFinite(target?.confidenceScore) ? fill(t("capacityScore"), { score: target.confidenceScore }) : "—"}</span>
      </span>
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
        tool: capacity.tool,
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
            <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" disabled={busy} onClick={() => run("end")}>
              <Square className="h-3 w-3" aria-hidden />{t("calibrationEnd")}
            </Button>
            <span className="text-muted-foreground">{t("calibrationRequirement")}</span>
          </>
        )}
      </div>
      {message && <div className={cn("mt-2", message.kind === "error" ? "text-destructive" : "text-success")} role="status">{message.text}</div>}
    </div>
  );
}

function QuotaSampleHistory({ quota, locale, t }) {
  const [open, setOpen] = useState(false);
  const [samples, setSamples] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeq = useRef(0);
  const tool = quota.tool;
  const accountKey = quota.accountKey || quota.capacity?.accountKey;
  const queryKey = `${tool}:${accountKey}`;

  useEffect(() => {
    requestSeq.current += 1;
    setSamples(null);
    setTotal(0);
    setLoading(false);
    setOpen(false);
  }, [queryKey]);

  const load = async (offset = 0) => {
    if (loading || !tool || !accountKey) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    try {
      const data = await fetchQuotaSampleHistory({ tool, accountKey, limit: 20, offset });
      if (seq !== requestSeq.current) return;
      const rows = data.samples || [];
      setSamples((current) => offset === 0 || !current ? rows : [...current, ...rows]);
      setTotal(Number(data.total) || rows.length);
    } catch {
      if (seq === requestSeq.current) setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  if (!tool || !accountKey) return null;
  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <Button variant="outline" size="sm" className="h-8 gap-1.5 px-3 text-xs" aria-expanded={open} onClick={() => {
        const next = !open;
        setOpen(next);
        if (next && samples === null) load(0);
      }}>
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
        {t("quotaSamplesTitle")}
      </Button>
      {open && <div className="mt-2 space-y-2">
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
  const storageKey = `dora-capacity-expanded:${capacity?.tool || "default"}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  const [detailKey, setDetailKey] = useState(null);
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
    <section className="mt-3 border-t border-border/60 pt-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t("capacityTitle")}</h3>
          <p className="t-caption mt-1 max-w-3xl">{t("capacityHint")}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground" onClick={toggle} aria-expanded={expanded}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
          {expanded ? t("capacityCollapse") : t("capacityExpand")}
        </Button>
      </div>
      <div className="mt-2 grid gap-x-8 gap-y-3 lg:grid-cols-2">
        {["session", "weekly"].map((window) => {
          const targets = capacity.targets.filter((target) => target.window === window && visibleRates.includes(target.cacheHitRate));
          const costTarget = targets.find((target) => Number.isFinite(target.fullWindowCostCny));
          const best = targets.reduce((current, target) => (target.confidenceScore || 0) > (current?.confidenceScore || 0) ? target : current, null);
          const detailTarget = targets.find((target) => `${window}:${target.cacheHitRate}` === detailKey);
          const detailMaximum = detailTarget
            ? (capacity.maxima || []).find((item) => item.window === detailTarget.window && item.cacheHitRate === detailTarget.cacheHitRate && (item.estimateKind || "standard") === "standard")
            : null;
          return (
            <div key={window}>
              <div className="t-label text-sm">{window === "session" ? t("quota5h") : t("quotaWeekly")}</div>
              {(costTarget || (best && Number.isFinite(best.confidenceScore))) && (
                <div className="num mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm font-semibold text-foreground">
                  {costTarget && <span>{t("capacityCost")} {formatCny(costTarget.fullWindowCostCny, locale)}</span>}
                  {best && Number.isFinite(best.confidenceScore) && <span>{t("capacityQuality")} {fill(t("capacityScore"), { score: best.confidenceScore })}</span>}
                  {(costTarget || best) && estimateModelLabel(costTarget || best) && <span className="font-medium">{t("capacityEstimateModel")} {estimateModelLabel(costTarget || best)}</span>}
                </div>
              )}
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                {targets.map((target) => {
                  const rate = Math.round(target.cacheHitRate * 100);
                  const key = `${window}:${target.cacheHitRate}`;
                  const insufficient = !Number.isFinite(target.fullWindowTokens);
                  const open = detailKey === key;
                  return (
                    <button key={key} type="button" disabled={insufficient} aria-expanded={open}
                      className="rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                      onClick={() => setDetailKey(open ? null : key)}>
                      <div className="t-caption"><RateBasis rate={`${rate}%`} t={t} /></div>
                      <div className={cn("num mt-0.5", insufficient ? "t-caption" : "t-strong")}>
                        {insufficient ? t("capacityInsufficient") : fmtTokens(target.fullWindowTokens)}
                      </div>
                    </button>
                  );
                })}
              </div>
              {detailTarget && (
                <div className="t-caption ml-1 mt-2 space-y-1 border-l border-border/60 pl-3">
                  <div>{t(methodKey(detailTarget.method))} · {fill(t("capacitySamples"), { n: detailTarget.sampleCount })} · {t(`capacityConfidence${detailTarget.confidence.charAt(0).toUpperCase()}${detailTarget.confidence.slice(1)}`)}</div>
                  {detailTarget.outlierCount > 0 && <div>{fill(t("capacityOutliers"), { n: detailTarget.outlierCount })}</div>}
                  {Number.isFinite(detailTarget.low) && Number.isFinite(detailTarget.high) && <div>{t("capacityRange")}: {fmtTokens(detailTarget.low)} – {fmtTokens(detailTarget.high)}</div>}
                  {detailMaximum && <div>{t("capacityMax")}: {fmtTokens(detailMaximum.fullWindowTokens)} · {formatCny(detailMaximum.fullWindowCostCny, locale)} · {formatDate(detailMaximum.createdAt, locale)}</div>}
                  <div>{t("capacityInterval")}: {formatDate(detailTarget.dataRange?.start, locale)} → {formatDate(detailTarget.dataRange?.end, locale)}</div>
                </div>
              )}
              {expanded && <HistoryList window={window} estimateKind="standard" capacity={capacity} locale={locale} t={t} />}
              {expanded && <CalibrationControls window={window} capacity={capacity} locale={locale} t={t} onChanged={onChanged} />}
            </div>
          );
        })}
      </div>
      {capacity.usageScope === "kimi-code-only" && <div className="mt-3 text-[11px] text-warning">{t("capacityScopeWarning")}</div>}
    </section>
  );
}

function HomeCapacityGroup({ title, targets, locale, t }) {
  return (
    <div>
      <div className="t-label">{title}</div>
      {[0.95].map((rate) => {
        const target = targets.find((item) => item.cacheHitRate === rate);
        return target ? <div key={rate}>
          <CapacityRateLine target={target} locale={locale} t={t} />
          <div className="t-caption">{t("capacityLatestHigh")}: {formatDate(target.createdAt, locale)}</div>
        </div> : null;
      })}
    </div>
  );
}

function HomeCapacity({ capacity, locale, t }) {
  const [highConfidenceTargets, setHighConfidenceTargets] = useState(null);
  const minConfidenceScore = capacity?.tool === "codex" ? 80 : 95;

  useEffect(() => {
    let active = true;
    if (!capacity) {
      setHighConfidenceTargets([]);
      return () => { active = false; };
    }
    setHighConfidenceTargets(null);
    Promise.all(["session", "weekly"].map(async (window) => {
      const data = await fetchQuotaCapacityHistory({
        tool: capacity.tool,
        accountKey: capacity.accountKey,
        scope: capacity.usageScope,
        window,
        cacheHitRate: 0.95,
        estimateKind: "standard",
        minConfidenceScore,
        limit: 1,
        offset: 0,
      });
      return (data.history || []).find((target) => Number(target.confidenceScore) >= minConfidenceScore && Number.isFinite(target.fullWindowTokens)) || null;
    })).then((targets) => {
      if (active) setHighConfidenceTargets(targets.filter(Boolean));
    }).catch(() => {
      if (active) setHighConfidenceTargets([]);
    });
    return () => { active = false; };
  }, [capacity?.tool, capacity?.accountKey, capacity?.usageScope, capacity?.generatedAt]);

  if (!capacity) return null;
  return (
    <section className="mt-4 space-y-3 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("capacityTitle")}</h3>
        <a href="/quota" className="rounded-sm text-[11px] text-muted-foreground underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring">{t("capacityDetails")}</a>
      </div>
      {highConfidenceTargets === null ? <p className="text-xs text-muted-foreground">{t("loading")}</p> : highConfidenceTargets.length ? (
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {["session", "weekly"].map((window) => {
            const targets = highConfidenceTargets.filter((target) => target.window === window);
            return targets.length ? (
              <HomeCapacityGroup key={window} title={window === "session" ? t("quota5h") : t("quotaWeekly")} targets={targets} locale={locale} t={t} />
            ) : (
              <div key={window} className="text-[11px] text-muted-foreground">
                <div className="mb-1 text-xs font-medium">{window === "session" ? t("quota5h") : t("quotaWeekly")}</div>
                {fill(t("capacityHighInsufficient"), { score: minConfidenceScore })}
              </div>
            );
          })}
        </div>
      ) : <p className="text-xs text-muted-foreground">{fill(t("capacityHighInsufficient"), { score: minConfidenceScore })}</p>}
    </section>
  );
}

export function QuotaCard({ t, locale, refreshSignal, tool = "kimi-code", detail = false, accountKey = null, accountLabel = null, onSettingsChanged }) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scope, setScope] = useState("all-clients");
  const [hiddenQuotaCards, setHiddenQuotaCards] = useState([]);
  const [homeSaving, setHomeSaving] = useState(false);
  const [, forceTick] = useState(0);
  const requestSeq = useRef(0);
  const cardId = `${tool}:${accountKey || "default"}`;
  const showOnHome = !hiddenQuotaCards.includes(cardId);

  useEffect(() => {
    fetchSettings().then((settings) => {
      setScope(tool === "codex"
        ? settings.quotaEstimation?.codexOnly ? "codex-only" : "all-clients"
        : settings.quotaEstimation?.kimiCodeOnly ? "kimi-code-only" : "all-clients");
      setHiddenQuotaCards(settings.dashboard?.hiddenQuotaCards || []);
    }).catch(() => {});
  }, [tool]);

  const load = useCallback(async (refresh = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await fetchQuota(refresh, tool, scope, accountKey);
      if (seq === requestSeq.current) setQuota(d);
    } catch (e) {
      if (seq === requestSeq.current) setError(e.message || t("quotaLoadFailed"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [tool, scope, accountKey, t]);

  const previousRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    const refresh = refreshSignal !== previousRefreshSignal.current;
    previousRefreshSignal.current = refreshSignal;
    load(refresh);
  }, [load, refreshSignal]);
  useEffect(() => {
    const timer = setInterval(() => forceTick((x) => x + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const changeScope = async (next) => {
    const previous = scope;
    setScope(next);
    try {
      await saveSettings({ quotaEstimation: tool === "codex" ? { codexOnly: next === "codex-only" } : { kimiCodeOnly: next === "kimi-code-only" } });
    } catch (e) {
      setScope(previous);
      setError(e.message || t("settingsSaveFailed"));
    }
  };

  const changeHomeVisibility = async (visible) => {
    const previous = hiddenQuotaCards;
    const hidden = visible ? previous.filter((id) => id !== cardId) : [...new Set([...previous, cardId])];
    setHiddenQuotaCards(hidden);
    setHomeSaving(true);
    setError(null);
    try {
      const saved = await saveSettings({ dashboard: { hiddenQuotaCards: hidden } });
      setHiddenQuotaCards(saved.dashboard?.hiddenQuotaCards || []);
      onSettingsChanged?.(saved);
    } catch (e) {
      setHiddenQuotaCards(previous);
      setError(e.message || t("settingsSaveFailed"));
    } finally {
      setHomeSaving(false);
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
            <CardTitle>{t(i18n.title)}{accountLabel && <span className="ml-2 text-xs font-normal text-muted-foreground">· {accountLabel}</span>}</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {detail && (tool === "kimi-code" || tool === "codex") && (
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-[11px]"
                value={scope}
                onChange={(event) => changeScope(event.target.value)}
                aria-label={t("capacityScope")}
              >
                <option value="all-clients">{t("capacityScopeAll")}</option>
                {tool === "codex"
                  ? <option value="codex-only">{t("capacityScopeCodex")}</option>
                  : <option value="kimi-code-only">{t("capacityScopeKimiCode")}</option>}
              </select>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" disabled={loading} onClick={() => load(true)} aria-label={t("refresh")}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "icon-spin")} />
            </Button>
          </div>
        </div>
        <div className="flex items-start justify-between gap-3">
          <CardDescription>{t(i18n.hint)}</CardDescription>
          {detail && (
            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={showOnHome}
                disabled={homeSaving}
                onChange={(event) => changeHomeVisibility(event.target.checked)}
              />
              {t("quotaShowOnHome")}
            </label>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => load(true)}>{t("retry")}</Button>
        </div>}
        {loading && !quota ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label={t("loading")}>
            {[0, 1].map((item) => <div key={item} className="h-[88px] animate-pulse rounded-lg border border-border/60 bg-secondary/30" />)}
          </div>
        ) : !quota ? (
          <div className="py-2 text-sm text-muted-foreground">{t("quotaNoUsage")}</div>
        ) : !quota.available ? (
          <div className="py-2 text-sm text-muted-foreground">{fill(t("quotaUnavailable"), { reason: reasonText })}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {[...windows].sort((a, b) => (a.kind === "session" ? 0 : 1) - (b.kind === "session" ? 0 : 1)).map((w) => {
              const used = Math.round(w.usedPercent);
              const remainingPercent = Math.max(0, Math.min(100, 100 - used));
              const remaining = countdown(w.resetsAt, Date.now());
              const barColor = remainingPercent <= 20 ? "bg-destructive" : remainingPercent <= 50 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <div key={w.kind} className="space-y-2 rounded-lg border border-border/60 bg-secondary/20 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{w.kind === "session" ? t("quota5h") : w.label || t("quotaWeekly")}</span>
                    <span className="text-sm font-semibold num">{remainingPercent}% {t("quotaRemaining")}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label={w.kind === "session" ? t("quota5h") : w.label || t("quotaWeekly")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remainingPercent}>
                    <div className={cn("h-full rounded-full transition-[width] duration-200", barColor)} style={{ width: `${remainingPercent}%` }} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">{w.resetsAt ? fill(t("quotaResetsIn"), { t: remaining || "—" }) : "\u00a0"}</div>
                </div>
              );
            })}
          </div>
        )}
        {!detail && quota && <HomeCapacity capacity={quota.capacity} locale={locale} t={t} />}
        {detail && quota?.available && <QuotaSampleHistory quota={quota} locale={locale} t={t} />}
        {detail && quota && <CapacitySection capacity={quota.capacity} locale={locale} t={t} onChanged={() => load(false)} />}
      </CardContent>
    </Card>
  );
}

export function QuotaToolCards(props) {
  const { tool = "kimi-code", hiddenQuotaCards = [] } = props;
  const [accounts, setAccounts] = useState(null);
  useEffect(() => {
    let active = true;
    setAccounts(null);
    fetchQuotaAccounts(tool).then((data) => {
      if (active) setAccounts(data.accounts || []);
    }).catch(() => {
      if (active) setAccounts([]);
    });
    return () => { active = false; };
  }, [tool]);
  if (accounts === null) return <Card aria-busy="true"><CardContent className="p-5"><div className="h-24 animate-pulse rounded-lg bg-secondary/30" /></CardContent></Card>;
  const visibleAccounts = props.detail ? accounts : accounts.filter((account) => !hiddenQuotaCards.includes(`${tool}:${account.accountKey || "default"}`));
  if (!visibleAccounts.length) return null;
  if (visibleAccounts.length <= 1) return <QuotaCard {...props} accountKey={visibleAccounts[0]?.accountKey || null} />;
  return (
    <div className="space-y-5">
      {visibleAccounts.map((account) => (
        <QuotaCard key={account.accountKey} {...props} accountKey={account.accountKey} accountLabel={account.label} />
      ))}
    </div>
  );
}

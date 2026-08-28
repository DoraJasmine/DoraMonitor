import React, { useCallback, useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchQuota } from "@/lib/backend";
import { fill } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Kimi quota card — 5-hour rolling window + weekly quota, each with a used
 * meter and the exact reset time reported by the usages API.
 *
 * Kimi's quota model has no monthly window: the weekly quota refreshes every
 * 7 days from the subscription date, the 5-hour window rolls continuously.
 */
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

export function QuotaCard({ t, locale, refreshSignal }) {
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(false);
  const [, forceTick] = useState(0);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const d = await fetchQuota(refresh);
      setQuota(d);
    } catch {
      setQuota(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load, refreshSignal]);

  // Re-render every minute so countdowns stay honest without refetching.
  useEffect(() => {
    const timer = setInterval(() => forceTick((x) => x + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const windows = quota?.windows || [];
  const reasonKey = REASON_KEY[quota?.reason];
  const reasonText = reasonKey
    ? t(reasonKey)
    : (quota?.reason || "").startsWith("http_")
      ? `HTTP ${quota.reason.slice(5)}`
      : quota?.reason || "—";

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle>{t("quotaTitle")}</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            disabled={loading}
            onClick={() => load(true)}
            aria-label={t("refresh")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "icon-spin")} />
          </Button>
        </div>
        <CardDescription>{t("quotaHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!quota ? (
          <div className="py-2 text-sm text-muted-foreground">{t("quotaNoUsage")}</div>
        ) : !quota.available ? (
          <div className="py-2 text-sm text-muted-foreground">
            {fill(t("quotaUnavailable"), { reason: reasonText })}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {windows.map((w) => {
              const used = Math.round(w.usedPercent);
              const level =
                used >= 100
                  ? "bg-red-500"
                  : used >= 70
                    ? "bg-orange-400"
                    : "bg-emerald-500";
              const remaining = countdown(w.resetsAt, Date.now());
              return (
                <div key={w.kind} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {w.kind === "session" ? t("quota5h") : w.label || t("quotaWeekly")}
                    </span>
                    <span className="text-sm font-semibold num">{used}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn("h-full rounded-full transition-all", level)}
                      style={{ width: `${Math.min(100, used)}%` }}
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {w.resetsAt
                      ? fill(t("quotaResetsIn"), { t: remaining || "—" })
                      : "\u00a0"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

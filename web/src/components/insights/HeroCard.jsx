import React from "react";
import { Activity, Coins, Gauge } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { fmtInt, fmtPct, fmtTokens, fmtMoney } from "@/format";
import { cn } from "@/lib/utils";

/**
 * Hero summary card (R1): one dominant total, two satellite metrics, and a
 * cache-hit-rate accent — replacing the flat 8-card KPI strip head.
 */
export function HeroCard({ totals, moneyCfg, locale, t, loading }) {
  const dim = loading ? "opacity-70" : "opacity-100";
  return (
    <Card className="mb-5">
      <CardContent className="grid gap-4 p-5 sm:grid-cols-[1.6fr_1fr_1fr]">
        <div className="flex items-center gap-4 sm:border-r sm:border-border/60 sm:pr-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <Activity className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t("heroTotalTokens")}</div>
            <div className={cn("text-3xl font-semibold tracking-tight num sm:text-4xl", dim)}>
              {fmtTokens(totals.totalTokens || 0)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground num">
              {fmtInt(totals.totalTokens || 0, locale)} · {t("heroTotalHint")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Coins className="h-4.5 w-4.5" aria-hidden />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t("requests")}</div>
            <div className={cn("text-xl font-semibold num tracking-tight", dim)}>
              {fmtInt(totals.requests || 0, locale)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
            <Gauge className="h-4.5 w-4.5" aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">
              {t("estCost")} ({moneyCfg?.symbol || "¥"})
            </div>
            <div className={cn("text-xl font-semibold num tracking-tight text-success", dim)}>
              {fmtMoney(totals.cost || 0, moneyCfg)}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t("cacheHitRate")}{" "}
              <span className="num text-foreground/85">{fmtPct(totals.cacheHitRate || 0)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

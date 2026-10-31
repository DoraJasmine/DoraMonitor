import React, { useMemo, useState } from "react";
import { ChartPie } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { fmtInt, fmtPct, fmtTokens, fmtMoney, fmtCredits } from "@/format";
import { modelLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

const PIE_COLORS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#e2e8f0"];

function mergeRows(models, keyFn, labelFn) {
  const map = new Map();
  for (const m of models) {
    const key = keyFn(m);
    if (!map.has(key)) {
      map.set(key, { key, model: key, modelDisplay: labelFn(m), tool: m.tool, requests: 0, totalTokens: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, cost: 0, costCny: 0, credits: 0, count: 0 });
    }
    const row = map.get(key);
    row.requests += m.requests || 0;
    row.totalTokens += m.totalTokens || 0;
    row.cost += m.cost || 0;
    row.costCny += m.costCny || 0;
    row.credits += m.credits || 0;
    row.count += 1;
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** SVG donut — zero-dependency, matching the hand-drawn chart style. */
function Donut({ slices, centerLabel, centerValue }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="relative h-[150px] w-[150px] shrink-0">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" strokeWidth="20" className="stroke-secondary" />
        {slices.map((s, i) => {
          const frac = s.value / total;
          const dash = `${Math.max(0, frac * C - 1.5)} ${C - Math.max(0, frac * C - 1.5)}`;
          const el = (
            <circle
              key={s.key}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              strokeWidth="20"
              stroke={s.color}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            />
          );
          offset += frac * C;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-lg font-semibold num tracking-tight">{centerValue}</div>
        <div className="text-[10px] text-muted-foreground">{centerLabel}</div>
      </div>
    </div>
  );
}

/**
 * FR-12 模型用量明细:环形占比 + 三态切换(混合 / 按模型 / 按供应商),
 * 点击行打开单模型明细弹层。
 */
export function ModelInsights({ models, t, locale, moneyCfg, onSelectModel, showToolColumn, toolById, loading }) {
  const [mode, setMode] = useState("mixed");

  const rows = useMemo(() => {
    if (!models?.length) return [];
    if (mode === "byModel") {
      return mergeRows(models, (m) => m.modelResolved || m.model, (m) => m.modelDisplay || m.modelResolved || m.model);
    }
    if (mode === "byProvider") {
      return mergeRows(models, (m) => m.modelProvider || "__unknown__", (m) => m.modelProvider || t("providerUnknown"));
    }
    return models.map((m) => ({ ...m, key: `${m.tool}\u0000${m.model}` }));
  }, [models, mode, t]);

  const totalTokens = rows.reduce((s, m) => s + (m.totalTokens || 0), 0) || 1;
  const top = rows.slice(0, 8);
  const others = rows.slice(8);
  const slices = top.map((m, i) => ({ key: m.key, label: modelLabel(m), value: m.totalTokens || 0, color: PIE_COLORS[i % (PIE_COLORS.length - 1)] }));
  if (others.length) {
    slices.push({
      key: "__others__",
      label: `${t("others")} (${others.length})`,
      value: others.reduce((s, m) => s + (m.totalTokens || 0), 0),
      color: PIE_COLORS[PIE_COLORS.length - 1],
    });
  }

  return (
    <Card className="mb-5">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ChartPie className="h-4 w-4 text-primary" aria-hidden />
            {t("modelUsageDetail")}
          </CardTitle>
          <CardDescription className="mt-1">{t("modelUsageHint")}</CardDescription>
        </div>
        <Tabs value={mode} onValueChange={setMode}>
          <TabsList aria-label={t("modelViewMode")}>
            <TabsTrigger value="mixed">{t("viewMixed")}</TabsTrigger>
            <TabsTrigger value="byModel">{t("viewModelMode")}</TabsTrigger>
            <TabsTrigger value="byProvider">{t("viewProvider")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {!rows.length ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{loading ? "…" : t("noData")}</div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[150px_1fr]">
            <div className="flex justify-center">
              <Donut slices={slices} centerValue={fmtTokens(rows.reduce((s, m) => s + (m.totalTokens || 0), 0))} centerLabel="Token" />
            </div>
            <div>
              <div className="space-y-1.5">
                {slices.map((s) => {
                  const share = s.value / totalTokens;
                  return (
                    <div key={s.key} className="flex items-center gap-2 text-sm">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                      <span className="num text-xs text-muted-foreground">{fmtTokens(s.value)}</span>
                      <span className="num w-12 text-right text-xs text-muted-foreground">{(share * 100).toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 max-h-[300px] overflow-auto thin-scroll border-t border-border/60 pt-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1.5 font-medium">{t("model")}</th>
                      {showToolColumn && mode === "mixed" ? <th className="py-1.5 font-medium">{t("tool")}</th> : null}
                      <th className="py-1.5 text-right font-medium">{t("requests")}</th>
                      <th className="py-1.5 text-right font-medium">{t("tokens")}</th>
                      <th className="py-1.5 text-right font-medium">{t("cacheHitRate")}</th>
                      <th className="py-1.5 text-right font-medium">{t("cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr
                        key={m.key}
                        tabIndex={0}
                        role="button"
                        aria-label={modelLabel(m)}
                        className="cursor-pointer border-t border-border/40 transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            if (mode === "mixed") onSelectModel?.(m);
                          }
                        }}
                        onClick={() => {
                          if (mode === "mixed") onSelectModel?.(m);
                        }}
                      >
                        <td className="max-w-[220px] py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium" title={m.model}>
                              {modelLabel(m)}
                            </span>
                            {m.costEstimated ? <Badge variant="warn">{t("estimated")}</Badge> : m.priceId ? <Badge variant="success">{t("official")}</Badge> : null}
                          </div>
                        </td>
                        {showToolColumn && mode === "mixed" ? (
                          <td className="py-1.5 text-[11px] text-muted-foreground">{toolById?.get(m.tool)?.label || m.tool}</td>
                        ) : null}
                        <td className="py-1.5 text-right num">{fmtInt(m.requests, locale)}</td>
                        <td className="py-1.5 text-right num">{fmtTokens(m.totalTokens)}</td>
                        <td className="py-1.5 text-right num">{fmtPct(m.cacheHitRate || 0)}</td>
                        <td className="py-1.5 text-right num">{m.credits > 0 ? `${fmtCredits(m.credits)} cr` : fmtMoney(m.cost || m.costCny, moneyCfg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {mode !== "mixed" ? (
                  <div className="pt-2 text-[11px] text-muted-foreground">{t("modelMergeHint")}</div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

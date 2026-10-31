import React, { useMemo } from "react";
import { ChartPie } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtInt, fmtPct, fmtTokens, fmtMoney, fmtCredits } from "@/format";
import { modelLabel } from "@/lib/labels";

const PIE_COLORS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#e2e8f0"];

function hitRate(row) {
  const denom = (row.inputOther || 0) + (row.inputCacheRead || 0) + (row.inputCacheCreation || 0);
  return denom > 0 ? (row.inputCacheRead || 0) / denom : 0;
}

/**
 * 按模型合并(跨工具同名计价身份 modelResolved),累积全部 token 分项与
 * 缓存命中率;点击行打开单模型明细弹层(resolved 键查询)。
 */
function mergeByResolved(models) {
  const map = new Map();
  for (const m of models) {
    const key = m.modelResolved || m.model || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        key,
        model: key,
        modelDisplay: m.modelDisplay || m.modelResolved || m.model,
        requests: 0,
        totalTokens: 0,
        inputOther: 0,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        cost: 0,
        costCny: 0,
        credits: 0,
        priceId: m.priceId || null,
        costEstimated: false,
        count: 0,
      });
    }
    const row = map.get(key);
    row.requests += m.requests || 0;
    row.totalTokens += m.totalTokens || 0;
    row.inputOther += m.inputOther || 0;
    row.output += m.output || 0;
    row.inputCacheRead += m.inputCacheRead || 0;
    row.inputCacheCreation += m.inputCacheCreation || 0;
    row.cost += m.cost || 0;
    row.costCny += m.costCny || 0;
    row.credits += m.credits || 0;
    row.count += 1;
    if (m.costEstimated) row.costEstimated = true;
    if (!row.priceId && m.priceId) row.priceId = m.priceId;
  }
  for (const row of map.values()) row.cacheHitRate = hitRate(row);
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** SVG donut — zero-dependency, matching the hand-drawn chart style. */
function Donut({ slices, centerValue }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="relative h-[150px] w-[150px] shrink-0">
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" strokeWidth="20" className="stroke-secondary" />
        {slices.map((s) => {
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
        <div className="text-[10px] text-muted-foreground">Token</div>
      </div>
    </div>
  );
}

export function ModelInsights({ models, t, locale, moneyCfg, onSelectModel, loading, note }) {
  const rows = useMemo(() => mergeByResolved(models || []), [models]);
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartPie className="h-4 w-4 text-primary" aria-hidden />
          {t("modelUsageDetail")}
        </CardTitle>
        <CardDescription className="mt-1">{t("modelUsageHint")}</CardDescription>
        {note ? <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-warning">{note}</div> : null}
      </CardHeader>
      <CardContent>
        {!rows.length ? (
          <div className="py-8 text-center text-sm text-muted-foreground">{loading ? "…" : t("noData")}</div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[150px_1fr]">
            <div className="flex justify-center">
              <Donut slices={slices} centerValue={fmtTokens(rows.reduce((s, m) => s + (m.totalTokens || 0), 0))} />
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
                            onSelectModel?.(m);
                          }
                        }}
                        onClick={() => onSelectModel?.(m)}
                      >
                        <td className="max-w-[260px] py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium" title={m.key}>
                              {modelLabel(m)}
                            </span>
                            {m.costEstimated ? <Badge variant="warn">{t("estimated")}</Badge> : m.priceId ? <Badge variant="success">{t("official")}</Badge> : null}
                          </div>
                        </td>
                        <td className="py-1.5 text-right num">{fmtInt(m.requests, locale)}</td>
                        <td className="py-1.5 text-right num">{fmtTokens(m.totalTokens)}</td>
                        <td className="py-1.5 text-right num">{fmtPct(m.cacheHitRate || 0)}</td>
                        <td className="py-1.5 text-right num">{m.credits > 0 ? `${fmtCredits(m.credits)} cr` : fmtMoney(m.cost || m.costCny, moneyCfg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="pt-2 text-[11px] text-muted-foreground">{t("modelMergeHint")}</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

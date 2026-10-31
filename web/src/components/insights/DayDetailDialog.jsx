import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { fetchUsageQuery, fetchUsageRecords } from "@/lib/backend";
import { fmtInt, fmtMoney, fmtPct, fmtTime, fmtTokens } from "@/format";
import { modelLabel } from "@/lib/labels";

const dayStartMs = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

/**
 * FR-11 当日明细弹层:点击趋势/热力图数据点后打开。
 * 内容:日汇总 → 小时分布 → 按模型/工作区分项 → 逐请求列表(全历史)。
 */
export function DayDetailDialog({ day, tool = "all", workspace = "all", model = "all", open, onOpenChange, t, locale, moneyCfg, toolById, showToolColumn }) {
  const [query, setQuery] = useState(null);
  const [records, setRecords] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !day) return;
    let alive = true;
    setQuery(null);
    setRecords(null);
    setError(null);
    const params = { day, tool, workspace, model };
    fetchUsageQuery(params)
      .then((d) => alive && setQuery(d))
      .catch((e) => alive && setError(e.message || String(e)));
    const from = dayStartMs(day);
    fetchUsageRecords({ from, to: from + 86400_000, tool, workspace, model, limit: 200, offset: 0 })
      .then((d) => alive && setRecords(d))
      .catch((e) => alive && setError(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, [open, day, tool, workspace, model]);

  const totals = query?.totals || null;
  const maxHour = Math.max(0, ...(query?.hourly || []).map((h) => h.totalTokens || 0));
  const hourMap = new Map((query?.hourly || []).map((h) => [h.hour, h]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(52rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {t("dayDetail")} · <span className="num">{day}</span>
          </DialogTitle>
          <DialogDescription>{t("dayDetailHint")}</DialogDescription>
        </DialogHeader>

        {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}

        {totals ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [t("requests"), fmtInt(totals.requests || 0, locale)],
              [t("inputOther"), fmtTokens(totals.inputOther || 0)],
              [t("output"), fmtTokens(totals.output || 0)],
              [t("cacheRead"), fmtTokens(totals.inputCacheRead || 0)],
              [t("cacheCreate"), fmtTokens(totals.inputCacheCreation || 0)],
              [t("totalTokens"), fmtTokens(totals.totalTokens || 0)],
              [t("estCost"), fmtMoney(totals.cost ?? (totals.costCny || 0), moneyCfg)],
              [t("cacheHitRate"), fmtPct(totals.cacheHitRate || 0)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="mt-0.5 text-sm font-semibold num">{value}</div>
              </div>
            ))}
          </div>
        ) : !error ? (
          <div className="py-6 text-center text-sm text-muted-foreground">…</div>
        ) : null}

        {query?.hourly?.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("hourlyDistribution")}</div>
            <div className="flex h-16 items-end gap-[2px]">
              {Array.from({ length: 24 }, (_, h) => {
                const row = hourMap.get(h);
                const v = row?.totalTokens || 0;
                return (
                  <div key={h} className="group relative flex-1" title={`${String(h).padStart(2, "0")}:00 · ${fmtTokens(v)}${row ? ` · ${fmtMoney(row.cost ?? (row.costCny || 0), moneyCfg)}` : ""}`}>
                    <div
                      className="w-full rounded-t-[2px] bg-primary/70 transition-colors group-hover:bg-primary"
                      style={{ height: `${maxHour > 0 ? Math.max(2, (v / maxHour) * 60) : 2}px` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground num">
              <span>00</span>
              <span>06</span>
              <span>12</span>
              <span>18</span>
              <span>23</span>
            </div>
          </div>
        ) : null}

        {query?.models?.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("modelStats")}</div>
            <div className="max-h-[160px] overflow-auto thin-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("model")}</TableHead>
                    <TableHead className="text-right">{t("requests")}</TableHead>
                    <TableHead className="text-right">{t("tokens")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.models.map((m) => (
                    <TableRow key={`${m.tool}-${m.model}`}>
                      <TableCell className="max-w-[220px] truncate font-medium" title={m.model}>
                        {modelLabel(m)}
                      </TableCell>
                      <TableCell className="text-right num">{fmtInt(m.requests, locale)}</TableCell>
                      <TableCell className="text-right num">{fmtTokens(m.totalTokens)}</TableCell>
                      <TableCell className="text-right num">{fmtMoney(m.cost ?? (m.costCny || 0), moneyCfg)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}

        {query?.workspaces?.length > 1 ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("workspaceStats")}</div>
            <div className="flex flex-wrap gap-1.5">
              {query.workspaces.map((w) => (
                <span key={w.workspaceKey} className="rounded-full border border-border/60 px-2 py-0.5 text-[11px]">
                  {w.workspaceName} · <span className="num">{fmtTokens(w.totalTokens)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {records ? (
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {t("dayRecords")}
              <Badge variant="secondary">{fmtInt(records.total, locale)}</Badge>
            </div>
            <div className="max-h-[220px] overflow-auto thin-scroll">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="w-[120px]">{t("time")}</TableHead>
                    {showToolColumn ? <TableHead>{t("tool")}</TableHead> : null}
                    <TableHead>{t("model")}</TableHead>
                    <TableHead className="text-right">{t("inputOther")}</TableHead>
                    <TableHead className="text-right">{t("output")}</TableHead>
                    <TableHead className="text-right">{t("cacheRead")}</TableHead>
                    <TableHead className="text-right">{t("cacheCreate")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={showToolColumn ? 8 : 7} className="text-center text-muted-foreground">
                        {t("noData")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    records.rows.map((r, i) => (
                      <TableRow key={`${r.time}-${r.model}-${i}`}>
                        <TableCell className="num whitespace-nowrap text-muted-foreground">{fmtTime(r.time, locale)}</TableCell>
                        {showToolColumn ? <TableCell className="text-[11px] text-muted-foreground">{toolById?.get(r.tool)?.label || r.tool}</TableCell> : null}
                        <TableCell className="max-w-[180px] truncate" title={r.model}>{modelLabel(r)}</TableCell>
                        <TableCell className="text-right num">{fmtTokens(r.inputOther)}</TableCell>
                        <TableCell className="text-right num">{fmtTokens(r.output)}</TableCell>
                        <TableCell className="text-right num">{fmtTokens(r.inputCacheRead)}</TableCell>
                        <TableCell className="text-right num">{fmtTokens(r.inputCacheCreation)}</TableCell>
                        <TableCell className="text-right num">{r.credits > 0 ? `${r.credits} cr` : "—"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

/**
 * FR-12 单模型明细弹层:当前范围内该模型的汇总、按日趋势与全历史逐请求分页。
 */
export function ModelDetailDialog({ model, resolved = null, range = "all", tool = "all", workspace = "all", open, onOpenChange, t, locale, moneyCfg, showToolColumn, toolById, note }) {
  const [query, setQuery] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const PAGE = 50;

  // 合并行用 model_resolved 查询;原始单模型回退到 model 精确匹配。
  const modelParams = resolved ? { resolved } : { model };
  const rangeParams = { range: range || "all", ...modelParams };

  useEffect(() => {
    if (!open || !model) return;
    let alive = true;
    setQuery(null);
    setRows([]);
    setTotal(0);
    setOffset(0);
    setError(null);
    fetchUsageQuery({ ...rangeParams, tool, workspace })
      .then((d) => alive && setQuery(d))
      .catch((e) => alive && setError(e.message || String(e)));
    fetchUsageRecords({ tool, workspace, ...modelParams, limit: PAGE, offset: 0 })
      .then((d) => {
        if (!alive) return;
        setRows(d.rows || []);
        setTotal(d.total || 0);
      })
      .catch((e) => alive && setError(e.message || String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model, resolved, tool, workspace, range]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await fetchUsageRecords({ tool, workspace, ...modelParams, limit: PAGE, offset: offset + PAGE });
      setRows((prev) => [...prev, ...(next.rows || [])]);
      setTotal(next.total || total);
      setOffset((o) => o + PAGE);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const totals = query?.totals;
  const daily = query?.daily || [];
  const maxDaily = Math.max(0, ...daily.map((d) => d.totalTokens || 0));
  const row = query?.models?.[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(52rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("modelDetail")} · <span className="truncate">{model}</span>
            {row?.costEstimated ? <Badge variant="warn">{t("estimated")}</Badge> : row?.priceId ? <Badge variant="success">{t("official")}</Badge> : null}
          </DialogTitle>
          <DialogDescription>{t("modelDetailHint")}</DialogDescription>
        {note ? <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-warning">{note}</div> : null}
        </DialogHeader>

        {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}

        {totals ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [t("requests"), fmtInt(totals.requests || 0, locale)],
              [t("totalTokens"), fmtTokens(totals.totalTokens || 0)],
              [t("estCost"), fmtMoney(row?.cost ?? totals.cost ?? 0, moneyCfg)],
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

        {daily.length ? (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t("dailyTrend")}</div>
            <div className="flex h-14 items-end gap-[2px]">
              {daily.map((d) => (
                <div key={d.date} className="group relative flex-1" title={`${d.date} · ${fmtTokens(d.totalTokens || 0)}`}>
                  <div
                    className="w-full rounded-t-[2px] bg-primary/70 transition-colors group-hover:bg-primary"
                    style={{ height: `${maxDaily > 0 ? Math.max(2, ((d.totalTokens || 0) / maxDaily) * 52) : 2}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            {t("dayRecords")}
            <Badge variant="secondary">{fmtInt(total, locale)}</Badge>
          </div>
          <div className="max-h-[240px] overflow-auto thin-scroll">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-[130px]">{t("time")}</TableHead>
                  {showToolColumn ? <TableHead>{t("tool")}</TableHead> : null}
                  <TableHead>{t("session")}</TableHead>
                  <TableHead className="text-right">{t("inputOther")}</TableHead>
                  <TableHead className="text-right">{t("output")}</TableHead>
                  <TableHead className="text-right">{t("cacheRead")}</TableHead>
                  <TableHead className="text-right">{t("cacheCreate")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={showToolColumn ? 7 : 6} className="text-center text-muted-foreground">
                      {t("noData")}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r, i) => (
                    <TableRow key={`${r.time}-${i}`}>
                      <TableCell className="num whitespace-nowrap text-muted-foreground">{fmtTime(r.time, locale)}</TableCell>
                      {showToolColumn ? <TableCell className="text-[11px] text-muted-foreground">{toolById?.get(r.tool)?.label || r.tool}</TableCell> : null}
                      <TableCell className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={r.session || ""}>
                        {r.workspaceName || r.session || "—"}
                      </TableCell>
                      <TableCell className="text-right num">{fmtTokens(r.inputOther)}</TableCell>
                      <TableCell className="text-right num">{fmtTokens(r.output)}</TableCell>
                      <TableCell className="text-right num">{fmtTokens(r.inputCacheRead)}</TableCell>
                      <TableCell className="text-right num">{fmtTokens(r.inputCacheCreation)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {rows.length < total ? (
            <div className="mt-2 text-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? t("loading") : t("loadMore")}
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

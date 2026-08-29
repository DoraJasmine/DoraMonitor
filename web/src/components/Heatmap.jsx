import React, { useMemo } from "react";
import { fmtPct, fmtTokens, fmtMoney } from "@/format";
import { cn } from "@/lib/utils";

const LEVEL_CLASS = {
  0: "bg-heat-0",
  1: "bg-heat-1",
  2: "bg-heat-2",
  3: "bg-heat-3",
  4: "bg-heat-4",
};

const DOW_LABELS_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const DOW_LABELS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * GitHub-style heatmap.
 *
 * Perf note: one cell per day × 53 weeks ≈ 370 cells. Wrapping each in a
 * Radix Tooltip + framer-motion div (740 heavy instances) caused visible
 * scroll jank, so cells are plain divs with a native `title` tooltip and a
 * CSS hover scale. Visual behaviour stays the same; mount cost drops ~50×.
 */
export function Heatmap({ heatmap, locale = "zh", t }) {
  const cells = heatmap?.cells || [];
  const weekCount = useMemo(() => {
    if (!cells.length) return 0;
    return Math.max(...cells.map((c) => c.weekIndex)) + 1;
  }, [cells]);

  const grid = useMemo(() => {
    // columns = weeks, rows = 0..6 (Sun..Sat)
    const cols = Array.from({ length: weekCount }, () => Array(7).fill(null));
    for (const c of cells) {
      if (c.weekIndex >= 0 && c.weekIndex < weekCount) {
        cols[c.weekIndex][c.dow] = c;
      }
    }
    return cols;
  }, [cells, weekCount]);

  const monthLabels = heatmap?.monthLabels || [];
  const dowLabels = locale === "zh" ? DOW_LABELS_ZH : DOW_LABELS_EN;

  if (!cells.length) {
    return (
      <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
        {t("noData")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto thin-scroll pb-1">
        <div className="inline-block min-w-full">
          {/* month labels */}
          <div
            className="mb-1 grid gap-[3px]"
            style={{
              gridTemplateColumns: `28px repeat(${weekCount}, 12px)`,
            }}
          >
            <div />
            {Array.from({ length: weekCount }, (_, wi) => {
              const label = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="text-[10px] leading-none text-muted-foreground"
                >
                  {label ? label.label : ""}
                </div>
              );
            })}
          </div>

          <div className="flex gap-[3px]">
            {/* dow labels */}
            <div className="flex w-7 flex-col gap-[3px] pr-1">
              {dowLabels.map((d, i) => (
                <div
                  key={d}
                  className={cn(
                    "flex h-3 items-center text-[10px] text-muted-foreground",
                    i % 2 === 1 ? "opacity-100" : "opacity-0"
                  )}
                >
                  {d}
                </div>
              ))}
            </div>

            {/* cells */}
            <div className="flex gap-[3px]">
              {grid.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[3px]">
                  {week.map((cell, di) => {
                    if (!cell) {
                      return (
                        <div
                          key={`${wi}-${di}`}
                          className="h-3 w-3 rounded-[3px] bg-transparent"
                        />
                      );
                    }
                    const level = cell.level ?? 0;
                    const title = `${cell.date} · ${fmtTokens(cell.totalTokens)} · ${cell.requests} ${t("requests")} · ${fmtMoney(cell.costUsd)} · ${t("cacheHitRate")} ${fmtPct(cell.cacheHitRate)}`;
                    return (
                      <div
                        key={cell.date}
                        title={title}
                        className={cn(
                          "h-3 w-3 rounded-[3px] ring-1 ring-inset ring-white/5",
                          "transition-transform duration-100 hover:scale-125",
                          LEVEL_CLASS[level] || LEVEL_CLASS[0]
                        )}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {heatmap.start} → {heatmap.end}
        </span>
        <div className="flex items-center gap-1.5">
          <span>{t("heatLess")}</span>
          {[0, 1, 2, 3, 4].map((lv) => (
            <div
              key={lv}
              className={cn(
                "h-3 w-3 rounded-[3px] ring-1 ring-inset ring-white/5",
                LEVEL_CLASS[lv]
              )}
            />
          ))}
          <span>{t("heatMore")}</span>
        </div>
      </div>
    </div>
  );
}

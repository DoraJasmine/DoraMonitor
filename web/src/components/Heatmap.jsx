import React, { useMemo } from "react";
import { motion } from "framer-motion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtPct, fmtTokens, fmtUsd } from "@/format";
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

export function Heatmap({ heatmap, locale = "zh", t, reducedMotion = false }) {
  const cells = heatmap?.cells || [];
  // Animate cell entrance only on first mount; refresh should not re-stagger.
  const enteredRef = React.useRef(false);
  React.useEffect(() => {
    enteredRef.current = true;
  }, []);
  const skipEnter = reducedMotion || enteredRef.current;
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
    <TooltipProvider delayDuration={120}>
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
                      const tile = (
                        <motion.div
                          className={cn(
                            "h-3 w-3 rounded-[3px] ring-1 ring-inset ring-white/5",
                            LEVEL_CLASS[level] || LEVEL_CLASS[0]
                          )}
                          initial={
                            skipEnter ? false : { opacity: 0, scale: 0.6 }
                          }
                          animate={{ opacity: 1, scale: 1 }}
                          transition={
                            skipEnter
                              ? { duration: 0 }
                              : {
                                  delay: Math.min(wi * 0.012 + di * 0.004, 0.6),
                                  duration: 0.25,
                                  ease: [0.22, 1, 0.36, 1],
                                }
                          }
                          whileHover={
                            reducedMotion ? undefined : { scale: 1.35 }
                          }
                        />
                      );
                      return (
                        <Tooltip key={cell.date}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="block p-0 border-0 bg-transparent cursor-default"
                              aria-label={cell.date}
                            >
                              {tile}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="space-y-0.5">
                            <div className="font-medium">{cell.date}</div>
                            <div className="text-muted-foreground">
                              {fmtTokens(cell.totalTokens)} ·{" "}
                              {fmtUsd(cell.costUsd)} · {cell.requests}{" "}
                              {t("requests")}
                            </div>
                            <div className="text-muted-foreground">
                              {t("cacheHitRate")}: {fmtPct(cell.cacheHitRate)}
                            </div>
                          </TooltipContent>
                        </Tooltip>
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
    </TooltipProvider>
  );
}

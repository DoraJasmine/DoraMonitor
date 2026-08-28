import React, { useMemo, useRef, useState } from "react";
import { fmtPct, fmtTokens, fmtUsd } from "@/format";
import { cn } from "@/lib/utils";

/** Distinct series colors for dark UI */
const SERIES_COLORS = [
  "#2dd4bf",
  "#60a5fa",
  "#a78bfa",
  "#f472b6",
  "#fbbf24",
  "#34d399",
  "#fb923c",
  "#94a3b8",
];

const TOTAL_COLOR = "rgba(45, 212, 191, 0.35)";

function shortModel(name) {
  if (!name) return "—";
  const s = String(name);
  if (s.length <= 22) return s;
  const bare = s.includes("/") ? s.split("/").pop() : s;
  return bare.length <= 22 ? bare : bare.slice(0, 20) + "…";
}

/** Monotone-ish cubic path through points [{x,y}] */
function smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function areaPath(points, baselineY) {
  if (!points.length) return "";
  const line = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

/**
 * Daily multi-series line chart.
 * Prefers stats.dailyByModel (continuous days + per-model series);
 * falls back to stats.daily totals only.
 */
export function DailyBars({ daily, dailyByModel, t, reducedMotion = false }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null); // index
  const [hidden, setHidden] = useState(() => new Set());

  const chart = useMemo(() => {
    if (dailyByModel?.dates?.length) {
      return {
        dates: dailyByModel.dates,
        totals: dailyByModel.totals || [],
        series: dailyByModel.series || [],
      };
    }
    // Fallback: sparse daily totals only
    if (!daily?.length) return null;
    return {
      dates: daily.map((d) => d.date),
      totals: daily.map((d) => ({
        date: d.date,
        totalTokens: d.totalTokens || 0,
        costUsd: d.costUsd || 0,
        requests: d.requests || 0,
        cacheHitRate: d.cacheHitRate || 0,
      })),
      series: [],
    };
  }, [daily, dailyByModel]);

  // All hooks must run unconditionally — do NOT early-return before them.
  const { dates = [], totals = [], series = [] } = chart || {};
  const n = dates.length;
  const W = 640;
  const H = 200;
  const pad = { top: 12, right: 12, bottom: 28, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  // Geometry is memoized so hover updates (setHover per mousemove) do not
  // recompute path curves for hundreds of days × series.
  const visibleSeries = useMemo(
    () => series.filter((s) => !hidden.has(s.key)),
    [series, hidden]
  );

  const maxVal = useMemo(
    () =>
      Math.max(
        1,
        ...totals.map((t) => t.totalTokens || 0),
        ...visibleSeries.flatMap((s) => s.values || [])
      ),
    [totals, visibleSeries]
  );

  const geometry = useMemo(() => {
    const xAt = (i) =>
      pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yAt = (v) => pad.top + innerH - (v / maxVal) * innerH;
    const totalPoints = totals.map((row, i) => ({
      x: xAt(i),
      y: yAt(row.totalTokens || 0),
    }));
    const modelPaths = visibleSeries.map((s) => {
      const pts = (s.values || []).map((v, i) => ({
        x: xAt(i),
        y: yAt(v || 0),
      }));
      return smoothPath(pts);
    });
    return { xAt, yAt, totalPoints, modelPaths };
  }, [n, maxVal, totals, visibleSeries]);

  const { xAt, yAt, totalPoints, modelPaths } = geometry;

  if (!chart) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        {t("noData")}
      </div>
    );
  }

  const labelStep = Math.max(1, Math.ceil(n / 8));

  const onMove = (e) => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, x / rect.width));
    const idx = Math.round(ratio * (n - 1));
    setHover(idx);
  };

  // Keyboard navigation: ←/→ move the readout, Enter/Home/Escape reset.
  const onKeyDown = (e) => {
    if (n === 0) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((h) => (h == null ? n - 1 : Math.max(0, h - 1)));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => (h == null ? 0 : Math.min(n - 1, h + 1)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === "Escape" || e.key === "Enter") {
      setHover(null);
    }
  };

  const toggle = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // keep at least one series or total visible — allow all model lines off
      return next;
    });
  };

  const hi = hover != null ? hover : null;
  const tip = hi != null ? totals[hi] : null;

  return (
    <div className="space-y-3">
      {series.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setHidden(new Set())}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              hidden.size === 0
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:border-border"
            )}
          >
            <span
              className="inline-block h-1.5 w-3 rounded-full"
              style={{ background: "#2dd4bf" }}
            />
            {t("dailyTotal") || "Total"}
          </button>
          {series.map((s, i) => {
            const color =
              s.isOthers
                ? SERIES_COLORS[SERIES_COLORS.length - 1]
                : SERIES_COLORS[i % SERIES_COLORS.length];
            const off = hidden.has(s.key);
            const label =
              s.isOthers
                ? t("dailyOthers") || "Others"
                : shortModel(s.label || s.modelDisplay);
            return (
              <button
                key={s.key}
                type="button"
                title={s.label || s.modelDisplay}
                onClick={() => toggle(s.key)}
                className={cn(
                  "inline-flex max-w-[160px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  off
                    ? "border-border/40 text-muted-foreground/50 line-through"
                    : "border-border/60 text-foreground/90 hover:border-border"
                )}
              >
                <span
                  className="inline-block h-1.5 w-3 shrink-0 rounded-full"
                  style={{ background: color, opacity: off ? 0.35 : 1 }}
                />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={wrapRef}
        className="relative w-full select-none"
        tabIndex={0}
        role="group"
        aria-label={`${t("dailyTrend")}${tip ? ` — ${tip.date}` : ""}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-52 w-full overflow-visible"
          role="img"
          aria-label={t("dailyTrend")}
        >
          {/* grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((r) => {
            const y = pad.top + innerH * (1 - r);
            return (
              <g key={r}>
                <line
                  x1={pad.left}
                  x2={W - pad.right}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border/40"
                  strokeWidth={1}
                />
                {r > 0 && (
                  <text
                    x={pad.left - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground"
                    style={{ fontSize: 9 }}
                  >
                    {fmtTokens(maxVal * r)}
                  </text>
                )}
              </g>
            );
          })}

          {/* total soft area */}
          <path
            d={areaPath(totalPoints, pad.top + innerH)}
            fill={TOTAL_COLOR}
            opacity={reducedMotion ? 0.5 : 0.55}
          />
          <path
            d={smoothPath(totalPoints)}
            fill="none"
            stroke="#2dd4bf"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.9}
          />

          {/* model series */}
          {series.map((s, si) => {
            if (hidden.has(s.key)) return null;
            const color =
              s.isOthers
                ? SERIES_COLORS[SERIES_COLORS.length - 1]
                : SERIES_COLORS[si % SERIES_COLORS.length];
            const pathIdx = visibleSeries.findIndex((v) => v.key === s.key);
            return (
              <path
                key={s.key}
                d={modelPaths[pathIdx] || ""}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.95}
              />
            );
          })}

          {/* hover guide */}
          {hi != null && (
            <g>
              <line
                x1={xAt(hi)}
                x2={xAt(hi)}
                y1={pad.top}
                y2={pad.top + innerH}
                stroke="currentColor"
                className="text-foreground/30"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={xAt(hi)}
                cy={yAt(tip?.totalTokens || 0)}
                r={3.5}
                fill="#2dd4bf"
                stroke="#0f172a"
                strokeWidth={1.5}
              />
            </g>
          )}

          {/* x labels */}
          {dates.map((date, i) => {
            if (i % labelStep !== 0 && i !== n - 1) return null;
            return (
              <text
                key={date}
                x={xAt(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {date.slice(5)}
              </text>
            );
          })}
        </svg>

        {tip && hi != null && (
          <div
            className="pointer-events-none absolute z-20 min-w-[168px] max-w-[260px] rounded-lg border border-border px-2.5 py-2 text-xs text-foreground shadow-xl"
            role="status"
            aria-live="polite"
            style={{
              left: `${(hi / Math.max(n - 1, 1)) * 100}%`,
              top: 8,
              // Solid card surface — avoid see-through over chart lines
              backgroundColor: "hsl(220 12% 9%)",
              boxShadow:
                "0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)",
              transform:
                hi > n * 0.65
                  ? "translateX(-100%)"
                  : hi < n * 0.15
                    ? "translateX(0)"
                    : "translateX(-50%)",
            }}
          >
            <div className="mb-1 font-medium text-foreground">{tip.date}</div>
            <div className="text-muted-foreground">
              {t("dailyTotal") || "Total"} · {fmtTokens(tip.totalTokens)} ·{" "}
              {fmtUsd(tip.costUsd)}
              {tip.cacheHitRate != null
                ? ` · hit ${fmtPct(tip.cacheHitRate)}`
                : ""}
            </div>
            {series.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
                {series.map((s, si) => {
                  if (hidden.has(s.key)) return null;
                  const v = s.values?.[hi] || 0;
                  if (!v) return null;
                  const color =
                    s.isOthers
                      ? SERIES_COLORS[SERIES_COLORS.length - 1]
                      : SERIES_COLORS[si % SERIES_COLORS.length];
                  return (
                    <li
                      key={s.key}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground/90">
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: color }}
                        />
                        <span className="truncate">
                          {s.isOthers
                            ? t("dailyOthers") || "Others"
                            : shortModel(s.label)}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {fmtTokens(v)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

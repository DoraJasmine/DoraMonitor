export function fmtInt(n, locale = "en") {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(
    Math.round(Number(n) || 0)
  );
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

export function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  if (v < 1) return "$" + v.toFixed(3);
  return "$" + v.toFixed(2);
}

export function fmtPct(n) {
  return ((Number(n) || 0) * 100).toFixed(1) + "%";
}

export function fmtTime(ms, locale = "en") {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Compact table timestamp (no seconds) — fits narrow columns. */
export function fmtTimeShort(ms, locale = "en") {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

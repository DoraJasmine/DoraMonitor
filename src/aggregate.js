"use strict";

/**
 * Build dashboard stats for a period.
 * ranges: today | 7d | 30d | all
 * tool: "all" or a provider id ("kimi-code", "zcode", ...).
 */
function aggregate(records, range = "30d", nowMs = Date.now(), tool = "all") {
  const scoped = tool !== "all" ? records.filter((r) => r.tool === tool) : records;
  const filtered = filterByRange(scoped, range, nowMs);
  const totals = emptyTotals();
  const byDay = new Map();
  const byModel = new Map();
  /** @type {Map<string, Map<string, number>>} day -> modelKey -> tokens */
  const byDayModel = new Map();

  for (const r of filtered) {
    addTo(totals, r);
    const day = dayKey(r.time);
    if (!byDay.has(day)) byDay.set(day, emptyTotals());
    addTo(byDay.get(day), r);

    // A model id can exist under more than one tool/provider.  Keeping the
    // provider in the grouping key prevents their requests and costs from
    // being merged while the UI shows only whichever tool appeared first.
    const mk = modelKey(r);
    if (!byModel.has(mk)) {
      byModel.set(mk, {
        model: r.model,
        modelDisplay: r.modelDisplay || r.model,
        modelResolved: r.modelResolved,
        priceId: r.priceId,
        costEstimated: r.costEstimated,
        tool: r.tool,
        credits: 0,
        ...emptyTotals(),
      });
    }
    const m = byModel.get(mk);
    addTo(m, r);
    if (r.costEstimated) m.costEstimated = true;

    if (!byDayModel.has(day)) byDayModel.set(day, new Map());
    const dayModels = byDayModel.get(day);
    if (!dayModels.has(mk)) dayModels.set(mk, 0);
    dayModels.set(
      mk,
      dayModels.get(mk) +
        (r.inputOther || 0) +
        (r.output || 0) +
        (r.inputCacheRead || 0) +
        (r.inputCacheCreation || 0)
    );
  }

  const totalInput = totals.inputOther + totals.inputCacheRead + totals.inputCacheCreation;
  const cacheHitRate = totalInput > 0 ? totals.inputCacheRead / totalInput : 0;

  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, t]) => ({ date, ...t, cacheHitRate: hitRate(t) }));

  const models = [...byModel.values()]
    .map((m) => ({ ...m, cacheHitRate: hitRate(m) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyByModel = buildDailyByModel(daily, models, byDayModel);

  // Keep a generous recent window for UI pagination/scroll (not just top 50).
  // RECENT_LIMIT hoisted to module level below.
  const recent = filtered.slice(0, RECENT_LIMIT).map((r) => ({
    time: r.time,
    tool: r.tool,
    model: r.model,
    modelDisplay: r.modelDisplay,
    modelResolved: r.modelResolved,
    inputOther: r.inputOther,
    output: r.output,
    inputCacheRead: r.inputCacheRead,
    inputCacheCreation: r.inputCacheCreation,
    totalTokens:
      r.inputOther + r.output + r.inputCacheRead + r.inputCacheCreation,
    costCny: r.costCny,
    credits: r.credits,
    costEstimated: r.costEstimated,
    priceId: r.priceId,
    project: r.project,
    session: r.session,
    sessionHint: r.sessionHint,
    fromEnv: r.fromEnv,
  }));

  return {
    range,
    tool,
    totals: {
      ...totals,
      cacheHitRate,
      totalTokens: totals.inputOther + totals.output + totals.inputCacheRead + totals.inputCacheCreation,
    },
    daily,
    dailyByModel,
    models,
    recent,
    recentTotal: filtered.length,
    recentLimit: RECENT_LIMIT,
  };
}

function filterByRange(records, range, nowMs) {
  if (range === "all") return records;
  const start = rangeStart(range, nowMs);
  return records.filter((r) => r.time >= start);
}

function rangeStart(range, nowMs) {
  const d = new Date(nowMs);
  if (range === "today") {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

function emptyTotals() {
  return {
    requests: 0,
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    costCny: 0,
    credits: 0,
    totalTokens: 0,
  };
}

function addTo(t, r) {
  t.requests += requestCount(r);
  t.inputOther += r.inputOther;
  t.output += r.output;
  t.inputCacheRead += r.inputCacheRead;
  t.inputCacheCreation += r.inputCacheCreation;
  t.costCny += r.costCny || 0;
  t.credits += r.credits || 0;
  t.totalTokens =
    t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
}

/** A synced daily record represents many original requests; local records one. */
function requestCount(r) {
  const n = Number(r && r.requests);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function hitRate(t) {
  const denom = t.inputOther + t.inputCacheRead + t.inputCacheCreation;
  return denom > 0 ? t.inputCacheRead / denom : 0;
}

/** Max model series lines on the daily chart (plus optional "others"). */
const DAILY_MODEL_SERIES = 6;

/**
 * Continuous calendar days from first..last activity, with top-N model token series.
 * Fills missing days with zeros so the chart can draw a continuous curve.
 */
function buildDailyByModel(daily, models, byDayModel) {
  if (!daily.length) {
    return { dates: [], series: [], totals: [] };
  }

  const top = models.slice(0, DAILY_MODEL_SERIES);
  const topKeys = new Set(top.map(modelKey));
  const hasOthers = models.length > top.length;

  const start = parseDay(daily[0].date);
  const end = parseDay(daily[daily.length - 1].date);
  const spanDays = Math.round((end - start) / (24 * 3600_000)) + 1;

  let dates;
  if (spanDays <= 93) {
    // Fill calendar gaps so the curve is continuous within ~3 months.
    dates = [];
    const cursor = new Date(start);
    const endDate = new Date(end);
    while (cursor.getTime() <= endDate.getTime()) {
      dates.push(dayKey(cursor.getTime()));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    // Long "all" ranges: keep activity days only (still a smooth polyline).
    dates = daily.map((d) => d.date);
  }

  const dayLookup = new Map(daily.map((d) => [d.date, d]));
  const totals = dates.map((date) => {
    const row = dayLookup.get(date);
    return {
      date,
      totalTokens: row ? row.totalTokens || 0 : 0,
      costCny: row ? row.costCny || 0 : 0,
      requests: row ? row.requests || 0 : 0,
      cacheHitRate: row ? row.cacheHitRate || 0 : 0,
    };
  });

  const series = top.map((m) => {
    const key = modelKey(m);
    return {
      key,
      label: m.model || m.modelDisplay || key,
      modelDisplay: m.modelDisplay || m.model || key,
      values: dates.map((date) => {
        const dm = byDayModel.get(date);
        return dm && dm.has(key) ? dm.get(key) : 0;
      }),
    };
  });

  if (hasOthers) {
    series.push({
      key: "__others__",
      label: "others",
      modelDisplay: "others",
      isOthers: true,
      values: dates.map((date) => {
        const dm = byDayModel.get(date);
        if (!dm) return 0;
        let sum = 0;
        for (const [k, v] of dm.entries()) {
          if (!topKeys.has(k)) sum += v;
        }
        return sum;
      }),
    });
  }

  return { dates, series, totals };
}

function modelKey(record) {
  const tool = record && record.tool ? record.tool : "";
  const model = record && (record.model || record.modelDisplay) ? record.model || record.modelDisplay : "unknown";
  return tool ? `${tool}\u0000${model}` : model;
}

function parseDay(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function summaryAllRanges(records, nowMs = Date.now(), tool = "all") {
  const ranges = ["today", "7d", "30d", "all"];
  const out = {};
  for (const r of ranges) {
    out[r] = aggregate(records, r, nowMs, tool);
  }
  return out;
}

/**
 * Per-tool totals for a range — drives the tool switcher badges.
 * Returns [{id, label, color, requests, totalTokens, costCny, credits}].
 */
function aggregateByTool(records, range, toolMeta, nowMs = Date.now()) {
  const filtered = filterByRange(records, range, nowMs);
  const byTool = new Map();
  for (const r of filtered) {
    const id = r.tool || "unknown";
    if (!byTool.has(id)) {
      const meta = toolMeta(id);
      byTool.set(id, {
        id,
        label: meta.label,
        color: meta.color,
        requests: 0,
        inputOther: 0,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        costCny: 0,
        credits: 0,
        totalTokens: 0,
      });
    }
    const t = byTool.get(id);
    t.requests += requestCount(r);
    t.inputOther += r.inputOther;
    t.output += r.output;
    t.inputCacheRead += r.inputCacheRead;
    t.inputCacheCreation += r.inputCacheCreation;
    t.costCny += r.costCny || 0;
    t.credits += r.credits || 0;
    t.totalTokens =
      t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
  }
  return [...byTool.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * GitHub-style contribution heatmap for the last `weeks` weeks (default 53).
 * Cells are local calendar days with totalTokens / cost / requests.
 */
function buildHeatmap(records, nowMs = Date.now(), weeks = 53, tool = "all") {
  const scoped = tool !== "all" ? records.filter((r) => r.tool === tool) : records;
  const byDay = new Map();
  for (const r of scoped) {
    if (!r.time) continue;
    const key = dayKey(r.time);
    if (!byDay.has(key)) byDay.set(key, emptyTotals());
    addTo(byDay.get(key), r);
  }

  const end = new Date(nowMs);
  end.setHours(0, 0, 0, 0);
  // Align end to local week end (Saturday) so grid is complete
  // Columns = weeks, rows = Sun..Sat (0..6)
  const endDow = end.getDay(); // 0 Sun
  // start = end - (weeks*7 - 1) days, then snap start to Sunday of that week
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const cells = [];
  const cursor = new Date(start);
  let maxTokens = 0;
  while (cursor.getTime() <= end.getTime() + 24 * 3600_000 - 1) {
    const key = dayKey(cursor.getTime());
    const t = byDay.get(key) || emptyTotals();
    const totalTokens =
      t.totalTokens ||
      t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
    if (totalTokens > maxTokens) maxTokens = totalTokens;
    cells.push({
      date: key,
      dow: cursor.getDay(),
      weekIndex: Math.floor((cursor.getTime() - start.getTime()) / (7 * 24 * 3600_000)),
      requests: t.requests || 0,
      totalTokens,
      costCny: t.costCny || 0,
      cacheHitRate: hitRate(t),
    });
    cursor.setDate(cursor.getDate() + 1);
    if (cells.length > weeks * 7 + 7) break;
  }

  // Intensity levels 0-4
  const levels = cells.map((c) => {
    if (!c.totalTokens || maxTokens <= 0) return { ...c, level: 0 };
    const ratio = c.totalTokens / maxTokens;
    let level = 1;
    if (ratio > 0.75) level = 4;
    else if (ratio > 0.5) level = 3;
    else if (ratio > 0.25) level = 2;
    else level = 1;
    return { ...c, level };
  });

  const monthLabels = [];
  let lastMonth = "";
  for (const c of levels) {
    const m = c.date.slice(0, 7);
    if (m !== lastMonth) {
      monthLabels.push({ weekIndex: c.weekIndex, label: c.date.slice(5, 7) });
      lastMonth = m;
    }
  }

  return {
    weeks,
    start: dayKey(start.getTime()),
    end: dayKey(end.getTime()),
    maxTokens,
    cells: levels,
    monthLabels,
  };
}

/**
 * Tool-call event counts (WebSearch / FetchURL / ...) for a range.
 * events: [{time, eventName, tool}] emitted by providers.
 * Returns { byName: {WebSearch: n, ...}, total }.
 */
function aggregateToolEvents(events, range, nowMs = Date.now(), tool = "all") {
  // rangeStart() returns ~now for "all"; "all" must not filter at all.
  const start = range === "all" ? 0 : rangeStart(range, nowMs);
  const byName = {};
  let total = 0;
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (tool !== "all" && ev.tool !== tool) continue;
      if (start && (!ev.time || ev.time < start)) continue;
      const name = ev.eventName || ev.model || "unknown";
      byName[name] = (byName[name] || 0) + 1;
      total += 1;
    }
  }
  return { byName, total };
}

// ---------------------------------------------------------------------------
// Phase 3: day-bucket aggregation (see docs/plan-phase3-day-bucket.md).
// Buckets carry day×tool×model×rateKey integer token counts; costs are
// computed HERE, at query time, from the current price table — so a price
// update retroactively applies to all history with zero bucket invalidation.
// The 7d/30d ranges are CALENDAR-day windows (last N local days incl.
// today); today/all keep their exact current semantics.
// ---------------------------------------------------------------------------

/** First local day of a calendar range; null for "all" (no filtering). */
function calendarStartDay(range, nowMs) {
  if (range === "all") return null;
  if (range === "today") return dayKey(nowMs);
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  if (!days) return null;
  return dayKey(nowMs - (days - 1) * 24 * 3600_000);
}

const { RATE_KEYS, priceForCell } = require("./pricing");

function cellCost(cell, price) {
  return (
    (cell.i / 1e6) * price.input +
    (cell.cr / 1e6) * price.cacheHit +
    (cell.cc / 1e6) * (price.cacheWrite ?? price.input) +
    (cell.o / 1e6) * price.output
  );
}

/**
 * Aggregate day-buckets into the same shape aggregate() returns, minus
 * `recent` (the caller injects it from the raw-record window — buckets
 * carry no per-request detail by design).
 *
 * options: { range, nowMs, tool, fxRate, customPrices }
 */
function aggregateFromBuckets(buckets, options = {}) {
  const { range = "30d", nowMs = Date.now(), tool = "all", fxRate, customPrices } = options;
  const startDay = calendarStartDay(range, nowMs);

  // (model, rateKey) → multiplied CNY price, computed once per cell class.
  const priceCache = new Map();
  const priceFor = (model, key) => {
    const k = `${model}\u0000${key}`;
    if (!priceCache.has(k)) {
      priceCache.set(k, priceForCell(model, key, { fxRate, customPrices }));
    }
    return priceCache.get(k);
  };

  const totals = emptyTotals();
  const byDay = new Map();
  const byModel = new Map();
  /** day -> (tool\0model) -> tokens */
  const byDayModel = new Map();

  const dayIn = (day) => startDay === null || day >= startDay;

  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [day, tools] of Object.entries(bucket.usageDays || {})) {
      if (!dayIn(day)) continue;
      for (const [toolId, models] of Object.entries(tools || {})) {
        if (tool !== "all" && toolId !== tool) continue;
        for (const [model, entry] of Object.entries(models || {})) {
          const mk = `${toolId}\u0000${model}`;
          if (!byModel.has(mk)) {
            byModel.set(mk, {
              model,
              modelDisplay: entry.display || model,
              modelResolved: entry.pricingKey || model,
              priceId: null,
              costEstimated: false,
              tool: toolId,
              credits: 0,
              ...emptyTotals(),
            });
          }
          const m = byModel.get(mk);
          if (!byDay.has(day)) byDay.set(day, emptyTotals());
          if (!byDayModel.has(day)) byDayModel.set(day, new Map());
          const dayModels = byDayModel.get(day);
          if (!dayModels.has(mk)) dayModels.set(mk, 0);

          let modelEstReq = 0;
          let modelPriceEstimated = false;
          for (const rateKey of RATE_KEYS) {
            const cell = entry[rateKey];
            if (!cell) continue;
            // Price on the PRICING KEY — routing codes like qfmodel have no
            // price row of their own and would hit the fallback estimate.
            const price = priceFor(entry.pricingKey || model, rateKey);
            const cost = cellCost(cell, price);
            if (price.estimated) modelPriceEstimated = true;

            totals.requests += cell.req || 0;
            totals.inputOther += cell.i || 0;
            totals.output += cell.o || 0;
            totals.inputCacheRead += cell.cr || 0;
            totals.inputCacheCreation += cell.cc || 0;
            totals.costCny += cost;
            totals.credits += cell.credits || 0;

            const dayRow = byDay.get(day);
            dayRow.requests += cell.req || 0;
            dayRow.inputOther += cell.i || 0;
            dayRow.output += cell.o || 0;
            dayRow.inputCacheRead += cell.cr || 0;
            dayRow.inputCacheCreation += cell.cc || 0;
            dayRow.costCny += cost;
            dayRow.credits += cell.credits || 0;

            m.requests += cell.req || 0;
            m.inputOther += cell.i || 0;
            m.output += cell.o || 0;
            m.inputCacheRead += cell.cr || 0;
            m.inputCacheCreation += cell.cc || 0;
            m.costCny += cost;
            m.credits += cell.credits || 0;
            modelEstReq += cell.estReq || 0;
            if (!m.priceId && price.id) m.priceId = price.id;

            dayModels.set(
              mk,
              (dayModels.get(mk) || 0) + (cell.i || 0) + (cell.o || 0) + (cell.cr || 0) + (cell.cc || 0)
            );
          }
          // totalTokens are derived sums; keep every row consistent.
          for (const t of [totals, m, byDay.get(day)]) {
            t.totalTokens =
              t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
          }
          if (modelEstReq > 0 || modelPriceEstimated) m.costEstimated = true;
        }
      }
    }
  }

  totals.totalTokens =
    totals.inputOther + totals.output + totals.inputCacheRead + totals.inputCacheCreation;

  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, t]) => ({ date, ...t, cacheHitRate: hitRate(t) }));

  const models = [...byModel.values()]
    .map((m) => ({ ...m, cacheHitRate: hitRate(m) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyByModel = buildDailyByModel(daily, models, byDayModel);

  return {
    range,
    tool,
    totals,
    daily,
    dailyByModel,
    models,
    // Buckets carry no per-request rows; the caller injects these from the
    // raw-record window (recentFromRecords).
    recent: [],
    recentTotal: 0,
    recentLimit: RECENT_LIMIT,
  };
}

/**
 * GitHub-style heatmap built from pre-aggregated daily rows (bucket path).
 * Same grid/level semantics as buildHeatmap, but the by-day totals (with
 * query-time costs) come from aggregateFromBuckets instead of raw records.
 */
function buildHeatmapFromDaily(dayTotals, nowMs = Date.now(), weeks = 53) {
  const byDay = dayTotals; // Map(date -> totals-like {requests, totalTokens, costCny, ...})
  const end = new Date(nowMs);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const cells = [];
  const cursor = new Date(start);
  let maxTokens = 0;
  while (cursor.getTime() <= end.getTime() + 24 * 3600_000 - 1) {
    const key = dayKey(cursor.getTime());
    const t = byDay.get(key) || emptyTotals();
    const totalTokens =
      t.totalTokens ||
      t.inputOther + t.output + t.inputCacheRead + t.inputCacheCreation;
    if (totalTokens > maxTokens) maxTokens = totalTokens;
    cells.push({
      date: key,
      dow: cursor.getDay(),
      weekIndex: Math.floor((cursor.getTime() - start.getTime()) / (7 * 24 * 3600_000)),
      requests: t.requests || 0,
      totalTokens,
      costCny: t.costCny || 0,
      cacheHitRate: hitRate(t),
    });
    cursor.setDate(cursor.getDate() + 1);
    if (cells.length > weeks * 7 + 7) break;
  }

  const levels = cells.map((c) => {
    if (!c.totalTokens || maxTokens <= 0) return { ...c, level: 0 };
    const ratio = c.totalTokens / maxTokens;
    let level = 1;
    if (ratio > 0.75) level = 4;
    else if (ratio > 0.5) level = 3;
    else if (ratio > 0.25) level = 2;
    return { ...c, level };
  });

  const monthLabels = [];
  let lastMonth = "";
  for (const c of levels) {
    const m = c.date.slice(0, 7);
    if (m !== lastMonth) {
      monthLabels.push({ weekIndex: c.weekIndex, label: c.date.slice(5, 7) });
      lastMonth = m;
    }
  }

  return {
    weeks,
    start: dayKey(start.getTime()),
    end: dayKey(end.getTime()),
    maxTokens,
    cells: levels,
    monthLabels,
  };
}

/** Tool-call event counts from merged eventDays (bucket path).
 *  eventDays: day → tool → name → count (see buckets.js). */
function toolEventsFromBuckets(eventDays, range, nowMs = Date.now(), tool = "all") {
  const startDay = calendarStartDay(range, nowMs);
  const byName = {};
  let total = 0;
  for (const [day, tools] of Object.entries(eventDays || {})) {
    if (startDay !== null && day < startDay) continue;
    for (const [toolId, names] of Object.entries(tools || {})) {
      if (tool !== "all" && toolId !== tool) continue;
      for (const [name, count] of Object.entries(names || {})) {
        byName[name] = (byName[name] || 0) + (count || 0);
        total += count || 0;
      }
    }
  }
  return { byName, total };
}

/** Per-tool totals from buckets (the bucket twin of aggregateByTool). */
function byToolFromBuckets(buckets, range, toolMeta, nowMs = Date.now()) {
  const startDay = calendarStartDay(range, nowMs);
  const { priceForCell: pfc } = require("./pricing");
  const byTool = new Map();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [day, tools] of Object.entries(bucket.usageDays || {})) {
      if (startDay !== null && day < startDay) continue;
      for (const [toolId, models] of Object.entries(tools || {})) {
        if (!byTool.has(toolId)) {
          const meta = toolMeta(toolId) || {};
          byTool.set(toolId, {
            id: toolId,
            label: meta.label || toolId,
            color: meta.color || "#94a3b8",
            ...emptyTotals(),
          });
        }
        const row = byTool.get(toolId);
        for (const [model, entry] of Object.entries(models || {})) {
          for (const rateKey of RATE_KEYS) {
            const cell = entry[rateKey];
            if (!cell) continue;
            const price = pfc(entry.pricingKey || model, rateKey);
            row.requests += cell.req || 0;
            row.inputOther += cell.i || 0;
            row.output += cell.o || 0;
            row.inputCacheRead += cell.cr || 0;
            row.inputCacheCreation += cell.cc || 0;
            row.costCny += cellCost(cell, price);
            row.credits += cell.credits || 0;
          }
        }
      }
    }
  }
  const rows = [...byTool.values()];
  for (const r of rows) {
    r.totalTokens = r.inputOther + r.output + r.inputCacheRead + r.inputCacheCreation;
  }
  return rows.sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Recent-requests rows from the raw-record window (the only consumer of
 * raw records). Same field whitelist as aggregate()'s recent.
 */
function recentFromRecords(records, range, nowMs = Date.now(), tool = "all", limit = RECENT_LIMIT) {
  const filtered = filterByRange(
    tool !== "all" ? records.filter((r) => r.tool === tool) : records,
    range,
    nowMs
  );
  return {
    recent: filtered.slice(0, limit).map((r) => ({
      time: r.time,
      tool: r.tool,
      model: r.model,
      modelDisplay: r.modelDisplay,
      modelResolved: r.modelResolved,
      inputOther: r.inputOther,
      output: r.output,
      inputCacheRead: r.inputCacheRead,
      inputCacheCreation: r.inputCacheCreation,
      totalTokens:
        (r.inputOther || 0) + (r.output || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0),
      costCny: r.costCny,
      credits: r.credits,
      costEstimated: r.costEstimated,
      priceId: r.priceId,
      project: r.project,
      session: r.session,
      sessionHint: r.sessionHint,
      fromEnv: r.fromEnv,
    })),
    recentTotal: filtered.length,
    recentLimit: limit,
  };
}

const RECENT_LIMIT = 500;

module.exports = {
  aggregateFromBuckets,
  buildHeatmapFromDaily,
  toolEventsFromBuckets,
  byToolFromBuckets,
  recentFromRecords,
  aggregate,
  filterByRange,
  summaryAllRanges,
  aggregateByTool,
  aggregateToolEvents,
  buildHeatmap,
  dayKey,
  rangeStart,
};

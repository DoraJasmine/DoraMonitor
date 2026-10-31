import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Gauge,
  Github,
  Languages,
  LayoutDashboard,
  Monitor,
  Moon,
  Network,
  RefreshCw,
  Sun,
  Tags,
} from "lucide-react";
import AppLogo from "@/components/AppLogo";
import { PricesPage } from "@/pages/PricesPage";
import QuotaDetailsPage from "@/pages/QuotaDetailsPage";
import SyncSettingsPage from "@/pages/SyncSettingsPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DailyBars } from "@/components/DailyBars";
import { Heatmap } from "@/components/Heatmap";
import { QuotaToolCards } from "@/components/QuotaCard";
import { fmtInt, fmtPct, fmtTime, fmtTokens, fmtMoney, fmtCredits } from "@/format";
import { detectBrowserLocale, fill, messages } from "@/i18n";
import { fetchPaths, fetchPeerWorkspaces, fetchSummary, fetchSettings, fetchUsageQuery, fetchWorkspaceAliases, openExternal, saveSettings, syncNow } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { HeroCard } from "@/components/insights/HeroCard";
import { WorkspacePanel } from "@/components/insights/WorkspacePanel";
import { ModelInsights } from "@/components/insights/ModelInsights";
import { DayDetailDialog } from "@/components/insights/DayDetailDialog";
import { ModelDetailDialog } from "@/components/insights/ModelDetailDialog";
import { downloadCsv } from "@/components/insights/csv";

const GITHUB_URL = "https://github.com/DoraJasmine/DoraMonitor";
const DEFAULT_DASHBOARD = { hiddenQuotaCards: [], heatmapRange: "1y", dailyRange: "30d" };

const RANGE_KEYS = [
  { value: "today", labelKey: "rangeToday" },
  { value: "7d", labelKey: "range7d" },
  { value: "30d", labelKey: "range30d" },
  { value: "all", labelKey: "rangeAll" },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/**
 * Label shown as the model's primary name.
 *
 * Optimised for readability: when a provider can resolve a display name
 * (dsh records another vendor's routing code such as "dfmodel", QoderCN
 * resolves it to "DeepSeek-V4.1-Flash"), that name wins. The raw id is still
 * rendered underneath in smaller type and used in the tooltip, so
 * traceability is preserved — but the raw code never stands in for a name we
 * actually know. Falls back to the raw id when no mapping exists.
 */
function modelLabel(row) {
  return row?.modelDisplay || row?.model || "unknown";
}

function useLocale() {
  const [locale, setLocale] = useState(
    () => localStorage.getItem("kcd_locale") || detectBrowserLocale()
  );
  const t = useCallback(
    (key) => {
      const pack = messages[locale] || messages.en;
      return pack[key] || messages.en[key] || key;
    },
    [locale]
  );
  const changeLocale = (next) => {
    setLocale(next);
    localStorage.setItem("kcd_locale", next);
    if (typeof document !== "undefined") {
      document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    }
  };
  // Sync <html lang> with the active locale (incl. initial render).
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    }
  }, [locale]);
  return { locale, t, changeLocale };
}

const THEME_OPTIONS = [
  { value: "dark", labelKey: "themeDark" },
  { value: "light", labelKey: "themeLight" },
  { value: "system", labelKey: "themeSystem" },
];

function themeIsLight(mode) {
  if (mode === "light") return true;
  if (mode === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  }
  return false;
}

function useTheme() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("kcd_theme") || "system"
  );
  const applyTheme = useCallback((mode) => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("light", themeIsLight(mode));
    }
  }, []);
  const changeTheme = (next) => {
    setTheme(next);
    localStorage.setItem("kcd_theme", next);
    applyTheme(next);
  };
  // Keep <html class> in sync; in system mode also follow OS changes.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof window === "undefined") return undefined;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, applyTheme]);
  return { theme, changeTheme };
}

export default function App() {
  const { locale, t, changeLocale } = useLocale();
  const { theme, changeTheme } = useTheme();
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const [home, setHome] = useState(() => localStorage.getItem("kcd_home") || "");
  const [range, setRange] = useState(
    () => localStorage.getItem("kcd_range") || "all"
  );
  const [tool, setTool] = useState(
    () => localStorage.getItem("aum_tool") || "all"
  );
  const [device, setDevice] = useState(
    () => localStorage.getItem("aum_device") || "all"
  );
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [settings, setSettings] = useState({
    currency: "CNY",
    currencySymbol: "¥",
    fxRate: 7.2,
    dashboard: DEFAULT_DASHBOARD,
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(false);
  const [quotaRefreshSignal, setQuotaRefreshSignal] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [recentPage, setRecentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [modelFilter, setModelFilter] = useState("all");
  const [wsFilter, setWsFilter] = useState(() => localStorage.getItem("kcd_ws") || "all");
  const [aliases, setAliases] = useState({});
  const [usageData, setUsageData] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [dayDetail, setDayDetail] = useState(null); // "YYYY-MM-DD"
  const [modelDetail, setModelDetail] = useState(null); // { model, modelDisplay, ... }
  const [page, setPage] = useState(() => {
    if (typeof window !== "undefined") {
      const p = window.location.pathname;
      if (p.startsWith("/quota")) return "quota";
      if (p.startsWith("/prices")) return "prices";
      if (p.startsWith("/sync")) return "sync";
    }
    return localStorage.getItem("kcd_page") || "usage";
  });
  const rangeReady = useRef(false);
  const loadingRef = useRef(false);
  const loadSeq = useRef(0);
  const dashboardSettingsSeq = useRef(0);
  const flashTimer = useRef(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const goPage = (next) => {
    setPage(next);
    localStorage.setItem("kcd_page", next);
    if (typeof window !== "undefined") {
      const path = next === "quota" ? "/quota" : next === "prices" ? "/prices" : next === "sync" ? "/sync" : "/";
      window.history.replaceState({}, "", path);
    }
  };

  const loadSummary = useCallback(
    async (opts = {}) => {
      const {
        refresh = false,
        nextHome = home,
        nextRange = range,
        nextTool = tool,
        nextDevice = device,
      } = opts;
      // Ignore double-clicks while a refresh is in flight
      if (loadingRef.current && refresh) return;
      loadingRef.current = true;
      setLoading(true);
      setRefreshing(refresh);
      setRefreshFlash(false);
      setError(null);
      const started = Date.now();
      // Sequence guard: range/tool/device switches fire concurrent loads and
      // responses can resolve out of order — only the newest request may
      // apply its result, or a stale response overwrites the newer choice.
      const seq = ++loadSeq.current;
      try {
        const summary = await fetchSummary(nextHome, nextRange, refresh, nextTool, nextDevice);
        if (seq !== loadSeq.current) return;
        setData(summary);
        setHome(summary.home || nextHome);
        localStorage.setItem("kcd_home", summary.home || nextHome || "");
        if (refresh) {
          setRefreshFlash(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setRefreshFlash(false), 1200);
        }
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setData(null);
        setError(e.data?.message || e.message || t("homeInvalid"));
      } finally {
        if (seq !== loadSeq.current) return; // superseded — the newer request owns the UI state
        // Keep spinner visible briefly so fast cache hits still feel intentional
        const minMs = refresh ? 320 : 0;
        const wait = Math.max(0, minMs - (Date.now() - started));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        loadingRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [home, range, tool, device, t]
  );

  useEffect(() => {
    fetchSettings()
      .then((saved) => setSettings({ ...saved, dashboard: { ...DEFAULT_DASHBOARD, ...saved.dashboard } }))
      .catch(() => {});
    fetchPaths()
      .then((d) => {
        if (!home) {
          setHome(d.current || "");
        }
      })
      .catch(() => {});
    // refresh:false — the backend keeps a 15s scan cache and per-file
    // incremental caches; forcing a full rescan on every page mount made
    // load time grow linearly with history size. The refresh button still
    // forces (refresh:true).
    loadSummary({ refresh: false }).finally(() => {
      rangeReady.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("kcd_range", range);
    if (!rangeReady.current) return;
    setRecentPage(1);
    // Keep modelFilter if user intentionally jumped via openModelHistory;
    // only reset when range changes from the tabs themselves would be ideal,
    // but we preserve filter across range changes for discoverability.
    loadSummary({ refresh: false, nextRange: range });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    localStorage.setItem("aum_tool", tool);
    if (!rangeReady.current) return;
    setRecentPage(1);
    loadSummary({ refresh: false, nextTool: tool });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  useEffect(() => {
    localStorage.setItem("aum_device", device);
    if (!rangeReady.current) return;
    setRecentPage(1);
    loadSummary({ refresh: false, nextDevice: device });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  useEffect(() => {
    localStorage.setItem("kcd_ws", wsFilter);
  }, [wsFilter]);

  const storeEnabled = !!data?.storeEnabled;
  // 洞察数据只覆盖本机(store 行存);对端设备没有工作区/模型明细,
  // 选择 peer 设备时全部保持 summary 口径,避免数字错配。
  const wsActive = wsFilter !== "all";
  const peerSelected = wsFilter.startsWith("peer:");
  const modelActive = modelFilter !== "all";
  const insightsActive = storeEnabled && (device === "all" || device === "local");
  const hasPeers = (data?.sync?.peers || 0) > 0;
  const heroFromUsage = insightsActive && (wsActive || modelActive);

  // Workspace aliases are display-only and never synced; load once when the
  // store is confirmed available (FR-10).
  useEffect(() => {
    if (!storeEnabled) return;
    fetchWorkspaceAliases()
      .then((d) => setAliases(d.aliases || {}))
      .catch(() => {});
  }, [storeEnabled]);

  // Usage-insight aggregates for the current range × tool × workspace × model
  // filter (FR-10/FR-12). Rides the same scan generation as the summary so
  // both refresh together; failures degrade to "sections hidden".
  const usageSeq = useRef(0);
  useEffect(() => {
    if (!insightsActive || peerSelected) {
      setUsageData(null);
      return undefined;
    }
    const seq = ++usageSeq.current;
    setUsageLoading(true);
    fetchUsageQuery({ range, tool, workspace: wsFilter, model: modelFilter, perRange: 1 })
      .then((d) => {
        if (seq === usageSeq.current) setUsageData(d);
      })
      .catch(() => {
        if (seq === usageSeq.current) setUsageData(null);
      })
      .finally(() => {
        if (seq === usageSeq.current) setUsageLoading(false);
      });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insightsActive, peerSelected, range, tool, wsFilter, modelFilter, data?.scannedAt]);

  // FP-06:对端工作区日汇总(哈希键),驱动工作区面板与对端筛选口径。
  const [wsAllData, setWsAllData] = useState(null);
  const [peerWs, setPeerWs] = useState(null);
  useEffect(() => {
    if (!storeEnabled) {
      setPeerWs(null);
      return undefined;
    }
    let alive = true;
    fetchPeerWorkspaces(device)
      .then((d) => alive && setPeerWs(d.rows || []))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeEnabled, device, data?.scannedAt]);

  const fmtDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const toDisplayCost = (cny) => (settings.currency === "USD" ? cny / (Number(settings.fxRate) || 6.67) : cny);
  const sumAcc = () => ({ requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, cost: 0, credits: 0, totalTokens: 0 });
  const addCell = (acc, i, o, cr, cc, req, credits, costCny) => {
    acc.requests += req || 0;
    acc.inputOther += i || 0;
    acc.output += o || 0;
    acc.inputCacheRead += cr || 0;
    acc.inputCacheCreation += cc || 0;
    acc.credits += credits || 0;
    acc.costCny += costCny || 0;
    acc.cost += toDisplayCost(costCny || 0);
    acc.totalTokens += (i || 0) + (o || 0) + (cr || 0) + (cc || 0);
  };
  const finishAcc = (acc) => {
    const denom = acc.inputOther + acc.inputCacheRead + acc.inputCacheCreation;
    acc.cacheHitRate = denom > 0 ? acc.inputCacheRead / denom : 0;
    return acc;
  };

  // 选中对端工作区 → 该工作区的 perRange 口径(全部来自对端 wsDaily)
  const peerPer = useMemo(() => {
    if (!peerSelected) return null;
    const row = (peerWs || []).find((r) => r.key === wsFilter);
    const nowMs = Date.now();
    const sum = (startDay) => {
      const acc = sumAcc();
      for (const [day, c] of Object.entries(row?.daily || {})) {
        if (startDay && day < startDay) continue;
        addCell(acc, c.i, c.o, c.cr, c.cc, c.req, c.credits, c.c);
      }
      return finishAcc(acc);
    };
    return {
      today: sum(fmtDay(nowMs)),
      "7d": sum(fmtDay(nowMs - 6 * 86400000)),
      "30d": sum(fmtDay(nowMs - 29 * 86400000)),
      all: sum(null),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerSelected, peerWs, wsFilter, settings.currency, settings.fxRate]);

  // 合并/对端设备 + 仅模型筛选 → summary 的 rangeModels(按设备聚合)客户端求和
  const modelMerged = useMemo(() => {
    if (!modelActive) return null;
    const out = {};
    for (const [key, rows] of Object.entries(data?.rangeModels || {})) {
      const acc = sumAcc();
      for (const m of rows.filter((x) => x.model === modelFilter)) {
        addCell(acc, m.inputOther, m.output, m.inputCacheRead, m.inputCacheCreation, m.requests, m.credits, m.costCny ?? 0);
      }
      out[key] = finishAcc(acc);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelActive, modelFilter, data?.rangeModels, settings.currency, settings.fxRate]);

  // 对端工作区行(合并视图 = 本机 + 对端;单对端设备 = 仅对端)
  const peerRows = useMemo(() => (peerWs || []).map((r) => ({
    workspaceKey: r.key,
    workspaceName: r.key === "peer:unknown"
      ? t("peerUnknownWs")
      : r.workspaceName || r.key.slice(5, 13),
    devices: r.devices || [],
    tools: r.tools || [],
    totalTokens: r.totalTokens,
    requests: r.requests,
    scope: "peer",
  })), [peerWs, t]);
  const panelWorkspaces = useMemo(() => {
    const local = (wsAllData?.workspaces || []).map((w) => ({ ...w, scope: "local" }));
    if (device === "local") return local;
    if (device === "all") return [...local, ...peerRows].sort((a, b) => b.totalTokens - a.totalTokens);
    return peerRows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsAllData, peerRows, device]);

  // 工作区面板始终展示全历史口径的所有工作区(与当前时间范围解耦)。
  useEffect(() => {
    if (!storeEnabled) {
      setWsAllData(null);
      return undefined;
    }
    let alive = true;
    fetchUsageQuery({ range: "all", tool, workspace: "all", model: "all" })
      .then((d) => alive && setWsAllData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeEnabled, tool, data?.scannedAt]);

  const switchTool = (next) => {
    setTool(next);
  };

  const applySavedSettings = useCallback((saved) => {
    setSettings({ ...saved, dashboard: { ...DEFAULT_DASHBOARD, ...saved.dashboard } });
  }, []);

  const handlePricingSaved = useCallback(async () => {
    applySavedSettings(await fetchSettings());
    await loadSummary({ refresh: true });
  }, [applySavedSettings, loadSummary]);

  const handleDashboardChange = useCallback(async (patch) => {
    const seq = ++dashboardSettingsSeq.current;
    const previous = settings;
    setSettings({ ...settings, dashboard: { ...settings.dashboard, ...patch } });
    setError(null);
    try {
      const saved = await saveSettings({ dashboard: patch });
      if (seq === dashboardSettingsSeq.current) applySavedSettings(saved);
    } catch (e) {
      if (seq === dashboardSettingsSeq.current) {
        setSettings(previous);
        setError(e.message || t("settingsSaveFailed"));
      }
    }
  }, [settings, applySavedSettings, t]);

  const handleSyncSaved = useCallback((saved) => {
    applySavedSettings(saved);
    loadSummary({ refresh: false });
  }, [applySavedSettings, loadSummary]);

  const totals = data?.stats?.totals || {};
  const stats = data?.stats || { daily: [], models: [], recent: [] };
  const rangeTotals = data?.rangeTotals || {};
  // 筛选激活时的口径优先级:对端工作区 → 本机 usage-query → 合并模型求和 → summary。
  const viewTotals = (() => {
    if (peerSelected) return peerPer?.all || totals;
    if (wsActive && insightsActive) return usageData?.totals || totals;
    if (modelActive && modelMerged) return modelMerged[range] || totals;
    return totals;
  })();
  const viewRangeTotals = (() => {
    if (peerSelected && peerPer) return peerPer;
    if (wsActive && insightsActive && usageData?.perRange) return usageData.perRange;
    if (modelActive && modelMerged) return modelMerged;
    return rangeTotals;
  })();

  const meta = data?.meta || {};
  const dashboard = settings.dashboard || DEFAULT_DASHBOARD;
  const heatmap = data?.heatmaps?.[dashboard.heatmapRange] || data?.heatmap || null;
  const peerDailyTrend = useMemo(() => {
    if (!peerSelected) return null;
    const row = (peerWs || []).find((r) => r.key === wsFilter);
    if (!row) return null;
    const daily = Object.entries(row.daily || {})
      .map(([date, c]) => {
        const acc = sumAcc();
        addCell(acc, c.i, c.o, c.cr, c.cc, c.req, c.credits, c.c);
        return { date, ...acc, cacheHitRate: finishAcc(acc).cacheHitRate };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    return { daily, dailyByModel: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerSelected, peerWs, wsFilter, settings.currency, settings.fxRate]);
  const dailyTrend = peerDailyTrend
    || (wsActive && usageData?.daily
      ? { daily: usageData.daily, dailyByModel: null } // 本机筛选模式无按模型序列,用总量曲线
      : data?.dailyTrends?.[dashboard.dailyRange] || stats);
  const allModels = data?.allModels || [];
  const allModelCount = data?.allModelCount ?? allModels.length;
  const rangeModelCount = (stats.models || []).length;
  const toolsList = data?.tools || [];
  const availableTools = toolsList.filter((x) => x.available);
  const byTool = data?.byTool || [];
  const devices = data?.devices || [];
  const syncInfo = data?.sync || { enabled: false };
  const toolEvents = data?.toolEvents || null;
  const byToolMap = useMemo(() => {
    const m = new Map();
    for (const b of byTool) m.set(b.id, b);
    return m;
  }, [byTool]);
  const showToolColumn = tool === "all" && availableTools.length > 1;
  const toolById = useMemo(() => {
    const m = new Map();
    for (const x of toolsList) m.set(x.id, x);
    return m;
  }, [toolsList]);
  // Tools that bill in credits only (no token detail in their logs).
  const activeTool = tool === "all" ? null : toolById.get(tool);
  const creditsOnlyTool = activeTool?.creditsOnly ? activeTool : null;
  const moneyCfg = useMemo(
    () => ({
      currency: settings.currency,
      symbol: settings.currencySymbol,
      fxRate: settings.fxRate,
    }),
    [settings.currency, settings.currencySymbol, settings.fxRate]
  );
  const rangeLabelKey =
    RANGE_KEYS.find((r) => r.value === range)?.labelKey || "rangeAll";

  // Data freshness: time since last scan (backend caches up to 15s).
  const scannedAgo = useMemo(() => {
    const at = Number(data?.scannedAt) || 0;
    if (!at) return "—";
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 60) return t("scannedAgoSec", {}).replace("{s}", String(secs));
    const mins = Math.round(secs / 60);
    if (mins < 60) return t("scannedAgoMin").replace("{m}", String(mins));
    const hrs = Math.round(mins / 60);
    return t("scannedAgoHour").replace("{h}", String(hrs));
  }, [data?.scannedAt, t]);

  const modelOptions = useMemo(() => {
    // Prefer full history roster so filter is never limited to today's models
    if (allModels.length) {
      return allModels.map((m) => m.model).filter(Boolean);
    }
    const set = new Set();
    for (const m of stats.models || []) {
      if (m.model) set.add(m.model);
    }
    for (const r of stats.recent || []) {
      if (r.model) set.add(r.model);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allModels, stats.models, stats.recent]);

  const openModelHistory = (modelId) => {
    // FR-12: with the row store available a model click opens the dedicated
    // detail dialog (full history); the legacy fallback narrows the recent table.
    if (storeEnabled && modelId) {
      setModelDetail({ model: modelId });
      return;
    }
    setRange("all");
    setModelFilter(modelId || "all");
    setRecentPage(1);
  };

  const wsOptions = data?.storeWorkspaces || [];
  const wsName = (key) => aliases[key] || wsOptions.find((w) => w.workspaceKey === key)?.workspaceName || key;

  const exportModelsCsv = () => {
    const rows = usageData?.models || [];
    if (!rows.length) return;
    downloadCsv(
      `doramonitor-models-${range}${wsFilter !== "all" ? "-ws" : ""}.csv`,
      rows.map((m) => ({
        model: m.model,
        display: m.modelDisplay || m.model,
        resolved: m.modelResolved || "",
        provider: m.modelProvider || "",
        tool: m.tool,
        requests: m.requests || 0,
        totalTokens: m.totalTokens || 0,
        inputOther: m.inputOther || 0,
        output: m.output || 0,
        cacheRead: m.inputCacheRead || 0,
        cacheCreate: m.inputCacheCreation || 0,
        cost: m.cost ?? m.costCny ?? 0,
      })),
      [
        { key: "model", label: "model" },
        { key: "display", label: "display" },
        { key: "resolved", label: "resolved" },
        { key: "provider", label: "provider" },
        { key: "tool", label: "tool" },
        { key: "requests", label: "requests" },
        { key: "totalTokens", label: "total_tokens" },
        { key: "inputOther", label: "input" },
        { key: "output", label: "output" },
        { key: "cacheRead", label: "cache_read" },
        { key: "cacheCreate", label: "cache_write" },
        { key: "cost", label: `cost_${(settings.currency || "CNY").toLowerCase()}` },
      ]
    );
  };

  const filteredRecent = useMemo(() => {
    const list = stats.recent || [];
    if (modelFilter === "all") return list;
    return list.filter((r) => r.model === modelFilter);
  }, [stats.recent, modelFilter]);

  const recentPages = Math.max(1, Math.ceil(filteredRecent.length / pageSize));
  const safePage = Math.min(recentPage, recentPages);
  const pageSlice = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRecent.slice(start, start + pageSize);
  }, [filteredRecent, safePage, pageSize]);

  useEffect(() => {
    if (recentPage > recentPages) setRecentPage(recentPages);
  }, [recentPage, recentPages]);

  const kpiItems = useMemo(() => {
    const items = [
      {
        title: t("inputOther"),
        value: fmtTokens(viewTotals.inputOther),
        sub: fmtInt(viewTotals.inputOther, locale),
      },
      {
        title: t("output"),
        value: fmtTokens(viewTotals.output),
        sub: fmtInt(viewTotals.output, locale),
      },
      {
        title: t("cacheRead"),
        value: fmtTokens(viewTotals.inputCacheRead),
        sub: fmtInt(viewTotals.inputCacheRead, locale),
      },
      {
        title: t("cacheCreate"),
        value: fmtTokens(viewTotals.inputCacheCreation),
        sub: fmtInt(viewTotals.inputCacheCreation, locale),
      },
    ];
    if ((viewTotals.credits || 0) > 0) {
      items.push({
        title: t("credits"),
        value: fmtCredits(viewTotals.credits),
      });
    }
    const byName = (toolEvents && toolEvents.byName) || {};
    if ((byName.WebSearch || 0) > 0 || (byName.FetchURL || 0) > 0) {
      items.push({
        title: t("webSearchCount"),
        value: fmtInt(byName.WebSearch || 0, locale),
      });
      items.push({
        title: t("fetchUrlCount"),
        value: fmtInt(byName.FetchURL || 0, locale),
      });
    }
    return items;
  }, [viewTotals, t, locale]);

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 pb-16 sm:px-6">
      {/* Header */}
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <AppLogo size={40} className="shrink-0 rounded-[9px] shadow-panel ring-1 ring-white/10" />
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <div className="flex items-end gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                {t("appTitle")}
              </h1>
              <span className="mb-0.5 shrink-0 text-[11px] leading-none text-muted-foreground/85 tabular-nums">
                {fill(t("appVersionBy"), {
                  version: "1.0.0",
                  author: "DoraJasmine",
                })}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-border bg-secondary/50 p-1">
            <Button
              size="sm"
              variant={page === "usage" ? "default" : "ghost"}
              className="gap-1.5"
              onClick={() => goPage("usage")}
            >
              <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
              {t("navUsage")}
            </Button>
            <Button
              size="sm"
              variant={page === "quota" ? "default" : "ghost"}
              className="gap-1.5"
              onClick={() => goPage("quota")}
            >
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              {t("navQuota")}
            </Button>
            <Button
              size="sm"
              variant={page === "prices" ? "default" : "ghost"}
              className="gap-1.5"
              onClick={() => goPage("prices")}
            >
              <Tags className="h-3.5 w-3.5" aria-hidden />
              {t("navPrices")}
            </Button>
            <Button
              size="sm"
              variant={page === "sync" ? "default" : "ghost"}
              className="gap-1.5"
              onClick={() => goPage("sync")}
            >
              <Network className="h-3.5 w-3.5" aria-hidden />
              {t("navSync")}
            </Button>
          </div>
          <Select value={locale} onValueChange={changeLocale}>
            <SelectTrigger className="w-[120px] text-xs font-medium" aria-label={t("language")}>
              <Languages className="mr-1 h-3.5 w-3.5 opacity-70" aria-hidden />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Select value={theme} onValueChange={changeTheme}>
            <SelectTrigger className="w-[128px] text-xs font-medium" aria-label={t("appearance")}>
              <ThemeIcon className="mr-1 h-3.5 w-3.5 opacity-70" aria-hidden />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("githubLink")}
            title={t("githubLink")}
            className="h-9 w-9 shrink-0 rounded-lg border border-border bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => openExternal(GITHUB_URL)}
          >
            <Github className="h-4 w-4" aria-hidden />
          </Button>
          {page === "usage" ? (
            <Button
              onClick={() => {
                setQuotaRefreshSignal((value) => value + 1);
                loadSummary({ refresh: true });
              }}
              disabled={refreshing}
              aria-busy={refreshing}
              className={cn(
                "gap-1.5 text-xs font-medium",
                refreshFlash &&
                  !refreshing &&
                  "ring-1 ring-white/35 bg-primary/90"
              )}
              title={
                refreshing
                  ? t("refreshing")
                  : refreshFlash
                    ? t("refreshed")
                    : t("refresh")
              }
            >
              <RefreshCw
                className={cn(
                  "h-4 w-4 shrink-0 text-current",
                  refreshing && "icon-spin"
                )}
                aria-hidden
              />
              <span>
                {refreshing
                  ? t("refreshing")
                  : refreshFlash
                    ? t("refreshed")
                    : t("refresh")}
              </span>
            </Button>
          ) : <span className="inline-block h-9 w-[84px]" aria-hidden />}
        </div>
      </header>

      {error && page === "usage" ? (
        <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {page === "quota" ? <QuotaDetailsPage t={t} locale={locale} onSettingsChanged={applySavedSettings} /> : null}

      {page === "prices" ? <PricesPage t={t} locale={locale} onSaved={handlePricingSaved} /> : null}

      {page === "sync" ? <SyncSettingsPage t={t} locale={locale} onSaved={handleSyncSaved} onSynced={handleSyncSaved} /> : null}

      {page === "usage" ? (
      <>
      {/* Tool switcher */}
      {availableTools.length > 0 ? (
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={tool} onValueChange={switchTool}>
              <TabsList>
                {availableTools.length > 1 ? (
                  <TabsTrigger value="all">{t("toolAll")}</TabsTrigger>
                ) : null}
                {availableTools.map((x) => {
                  const b = byToolMap.get(x.id);
                  return (
                    <TabsTrigger key={x.id} value={x.id} title={x.home || x.label}>
                      <span
                        className="mr-1.5 inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: x.color }}
                        aria-hidden
                      />
                      {x.label}
                      {b && b.totalTokens > 0 ? (
                        <span className="ml-1.5 text-[10px] text-muted-foreground num">
                          {fmtTokens(b.totalTokens)}
                        </span>
                      ) : b && b.credits > 0 ? (
                        <span className="ml-1.5 text-[10px] text-muted-foreground num">
                          {fmtCredits(b.credits)} cr
                        </span>
                      ) : null}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>
        </div>
      ) : null}

      {creditsOnlyTool ? (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-warning">
          {t("toolNoTokenNote")}
        </div>
      ) : null}

      {/* Device tabs (visible when sync brings peers) */}
      {syncInfo.enabled && devices.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("device")}:</span>
          <Tabs value={device} onValueChange={setDevice}>
            <TabsList>
              <TabsTrigger value="all">{t("deviceMerged")}</TabsTrigger>
              <TabsTrigger value="local">{t("deviceLocal")}</TabsTrigger>
              {devices
                .filter((d) => d.peer)
                .map((d) => (
                  <TabsTrigger key={d.id} value={d.id}>
                    {d.label}
                  </TabsTrigger>
                ))}
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncMessage(null);
              try {
                const result = await syncNow();
                const problem = result.uploadError || result.error;
                setSyncMessage(problem
                  ? { kind: "error", text: fill(t("syncFailed"), { reason: problem }) }
                  : { kind: "success", text: fill(t("syncComplete"), { n: (result.peers || []).length }) });
                await loadSummary({ refresh: true });
              } catch (e) {
                setSyncMessage({ kind: "error", text: fill(t("syncFailed"), { reason: e.message || String(e) }) });
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? t("syncing") : t("syncNow")}
          </Button>
          {syncMessage && <div role="status" className={cn("w-full text-xs", syncMessage.kind === "error" ? "text-destructive" : "text-success")}>{syncMessage.text}</div>}
        </div>
      ) : null}

      {/* Range tabs + unified filter bar (R1) */}
      <div className="mb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={range} onValueChange={setRange}>
            <TabsList>
              {RANGE_KEYS.map((r) => (
                <TabsTrigger key={r.value} value={r.value}>
                  {t(r.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {range !== "all" ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start text-muted-foreground"
              onClick={() => setRange("all")}
            >
              {t("viewAllHistory")}
            </Button>
          ) : null}
        </div>
        {storeEnabled ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              value={wsFilter}
              onValueChange={setWsFilter}
            >
              <SelectTrigger className="w-[220px]" aria-label={t("filterWorkspace")}>
                <SelectValue placeholder={t("filterWorkspace")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("wsAll")}</SelectItem>
                {wsOptions.map((w) => (
                  <SelectItem key={w.workspaceKey} value={w.workspaceKey}>
                    {wsName(w.workspaceKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={modelFilter}
              onValueChange={setModelFilter}
            >
              <SelectTrigger className="w-[220px]" aria-label={t("filterModel")}>
                <SelectValue placeholder={t("filterModel")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allModels")}</SelectItem>
                {modelOptions.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {wsFilter !== "all" || modelFilter !== "all" ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setWsFilter("all");
                  setModelFilter("all");
                }}
              >
                {t("clearFilters")}
              </Button>
            ) : null}
            <div className="flex-1" />
            <Button
              variant="secondary"
              size="sm"
              className="text-xs"
              disabled={!usageData?.models?.length}
              onClick={exportModelsCsv}
            >
              {t("exportCsv")}
            </Button>
          </div>
        ) : null}
        {range !== "all" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("rangeScopedHint")}{" "}
            <span className="text-foreground/80">
              {fill(t("modelsInRange"), { n: rangeModelCount })} ·{" "}
              {fill(t("modelsAllTime"), { n: allModelCount })}
            </span>
          </p>
        ) : null}
      </div>

      {/* Range overview cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {RANGE_KEYS.map((r) => {
          const tot = viewRangeTotals[r.value] || {};
          const active = range === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => setRange(r.value)}
              className={cn(
                "rounded-lg border bg-card p-4 text-left shadow-panel transition-colors",
                active
                  ? "border-primary/50 ring-1 ring-primary/30"
                  : "border-border hover:border-border/80 hover:bg-secondary/30"
              )}
            >
              <div className="text-xs text-muted-foreground">{t(r.labelKey)}</div>
              <div className="mt-1 text-lg font-semibold num tracking-tight">
                {fmtTokens(tot.totalTokens || 0)}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground num">
                {fmtInt(tot.requests || 0, locale)} · {fmtMoney(tot.cost || 0, moneyCfg)} ·{" "}
                {fmtPct(tot.cacheHitRate || 0)}
              </div>
            </button>
          );
        })}
      </div>

      {/* Hero summary (R1) + token breakdown KPI strip */}
      <HeroCard totals={viewTotals} moneyCfg={moneyCfg} locale={locale} t={t} loading={loading} />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpiItems.map((item) => (
          <div key={item.title}>
            <Card className="h-full">
              <CardContent className="p-3.5">
                <div className="text-[11px] text-muted-foreground">{item.title}</div>
                <div
                  className={cn(
                    "mt-1 text-lg font-semibold num tracking-tight transition-opacity",
                    loading && data ? "opacity-70" : "opacity-100"
                  )}
                >
                  {loading && !data ? "…" : item.value}
                </div>
                {item.sub ? (
                  <div className="mt-0.5 text-[11px] text-muted-foreground num">
                    {item.sub}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>

      {/* Kimi quota (5-hour + weekly windows) */}
      {(tool === "all" || tool === "kimi-code") &&
      availableTools.some((x) => x.id === "kimi-code") ? (
        <div className="mb-5">
          <QuotaToolCards t={t} locale={locale} refreshSignal={quotaRefreshSignal} hiddenQuotaCards={dashboard.hiddenQuotaCards} />
        </div>
      ) : null}

      {/* Codex quota (rate_limits from rollout files: 5h + weekly) */}
      {(tool === "all" || tool === "codex") &&
      availableTools.some((x) => x.id === "codex") ? (
        <div className="mb-5">
          <QuotaToolCards t={t} locale={locale} refreshSignal={quotaRefreshSignal} tool="codex" hiddenQuotaCards={dashboard.hiddenQuotaCards} />
        </div>
      ) : null}

      {/* Workspace usage (FR-10, store-backed) */}
      {storeEnabled ? (
        <WorkspacePanel
          workspaces={panelWorkspaces}
          activeKey={wsFilter}
          onSelect={setWsFilter}
          t={t}
          locale={locale}
          aliases={aliases}
          onAliasesChanged={setAliases}
          toolById={toolById}
          deviceView={device}
        />
      ) : null}

      {/* Heatmap — click a cell for the day detail (FR-11) */}
      <div className="mb-5">
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t("heatmap")}</CardTitle>
              <CardDescription className="mt-1">{t("heatmapHint")}</CardDescription>
            </div>
            <Tabs value={dashboard.heatmapRange} onValueChange={(heatmapRange) => handleDashboardChange({ heatmapRange })}>
              <TabsList aria-label={t("heatmapRange")}>
                <TabsTrigger value="7d">{t("range7d")}</TabsTrigger>
                <TabsTrigger value="30d">{t("range30d")}</TabsTrigger>
                <TabsTrigger value="1y">{t("range1y")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <Heatmap
              heatmap={heatmap}
              locale={locale}
              t={t}
              moneyCfg={moneyCfg}
              onDayClick={storeEnabled ? (cell) => setDayDetail(cell.date) : undefined}
            />
          </CardContent>
        </Card>
      </div>

      {/* Charts + models (model card is replaced by ModelInsights when the row store is on) */}
      <div className={storeEnabled ? "mb-5" : "mb-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]"}>
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>{t("dailyTrend")}</CardTitle>
              <CardDescription className="mt-1">{t("dailyTrendHint")}</CardDescription>
            </div>
            <Tabs value={dashboard.dailyRange} onValueChange={(dailyRange) => handleDashboardChange({ dailyRange })}>
              <TabsList aria-label={t("dailyTrendRange")}>
                <TabsTrigger value="7d">{t("range7d")}</TabsTrigger>
                <TabsTrigger value="30d">{t("range30d")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <DailyBars
              daily={dailyTrend.daily}
              dailyByModel={dailyTrend.dailyByModel}
              t={t}
              moneyCfg={moneyCfg}
              onDayClick={storeEnabled ? (d) => setDayDetail(d.date) : undefined}
            />
          </CardContent>
        </Card>

        {!storeEnabled ? (
        <Card>
          <CardHeader className="space-y-2">
            <div className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>{t("modelStats")}</CardTitle>
                <CardDescription className="mt-1">
                  {fill(t("modelsInRange"), { n: rangeModelCount })}
                  {allModelCount > rangeModelCount
                    ? ` · ${fill(t("modelsAllTime"), { n: allModelCount })}`
                    : ""}
                  {" · "}
                  {t(rangeLabelKey)}
                </CardDescription>
              </div>
              {range !== "all" && allModelCount > rangeModelCount ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setRange("all")}
                >
                  {t("viewAllHistory")}
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <div className="max-h-[360px] overflow-auto thin-scroll">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>{t("model")}</TableHead>
                    {showToolColumn ? <TableHead>{t("tool")}</TableHead> : null}
                    <TableHead className="text-right">{t("requests")}</TableHead>
                    <TableHead className="text-right">{t("tokens")}</TableHead>
                    <TableHead className="text-right">{t("cacheHitRate")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(stats.models || []).length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={showToolColumn ? 6 : 5}
                        className="text-center text-muted-foreground"
                      >
                        {t("noData")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    (stats.models || []).map((m) => (
                      <TableRow
                        key={`${m.tool}-${m.model}`}
                        className="cursor-pointer"
                        tabIndex={0}
                        role="button"
                        aria-label={fill(t("viewModelHistory"), { model: modelLabel(m) })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openModelHistory(m.model);
                          }
                        }}
                        onClick={() => openModelHistory(m.model)}
                      >
                        <TableCell className="max-w-[240px]">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span
                              className="truncate font-medium"
                              title={m.model}
                            >
                              {modelLabel(m)}
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                              {m.modelDisplay && m.modelDisplay !== m.model ? (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {m.model}
                                </span>
                              ) : null}
                              {m.costEstimated ? (
                                <Badge variant="warn">{t("estimated")}</Badge>
                              ) : m.priceId ? (
                                <Badge variant="success">{t("official")}</Badge>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        {showToolColumn ? (
                          <TableCell>
                            <span
                              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                              title={toolById.get(m.tool)?.label || m.tool}
                            >
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: toolById.get(m.tool)?.color }}
                                aria-hidden
                              />
                              {toolById.get(m.tool)?.label || m.tool}
                            </span>
                          </TableCell>
                        ) : null}
                        <TableCell className="text-right num">
                          {fmtInt(m.requests, locale)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtTokens(m.totalTokens)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtPct(m.cacheHitRate)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {m.credits > 0
                            ? `${fmtCredits(m.credits)} cr`
                            : fmtMoney(m.cost, moneyCfg)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        ) : null}
      </div>

      {/* Model usage detail (FR-12, store-backed) */}
      {storeEnabled ? (
        <ModelInsights
          models={peerSelected ? [] : wsActive ? usageData?.models || [] : (stats.models || []).filter((m) => !modelActive || m.model === modelFilter)}
          t={t}
          locale={locale}
          moneyCfg={moneyCfg}
          showToolColumn={showToolColumn}
          toolById={toolById}
          loading={usageLoading}
          note={peerSelected ? t("peerWsNoModels") : wsActive && hasPeers ? t("wsLocalNote") : null}
          onSelectModel={(m) => setModelDetail({ model: m.modelDisplay || m.model, resolved: m.key })}
        />
      ) : null}

      {/* All-time model roster (only on the legacy no-store path) */}
      {!storeEnabled && allModels.length > 0 && range !== "all" ? (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>{t("allModelsTitle")}</CardTitle>
            <CardDescription>{t("allModelsHint")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <div className="max-h-[280px] overflow-auto thin-scroll">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead>{t("model")}</TableHead>
                    <TableHead className="text-right">{t("requests")}</TableHead>
                    <TableHead className="text-right">{t("tokens")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allModels.map((m) => (
                    <TableRow
                      key={`all-${m.model}`}
                      className="cursor-pointer"
                      tabIndex={0}
                      role="button"
                      aria-label={fill(t("viewModelHistory"), { model: modelLabel(m) })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openModelHistory(m.model);
                        }
                      }}
                      onClick={() => openModelHistory(m.model)}
                    >
                      <TableCell className="max-w-[280px]">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate font-medium" title={m.model}>
                            {modelLabel(m)}
                          </span>
                          {m.modelDisplay && m.modelDisplay !== m.model ? (
                            <span className="truncate text-[11px] text-muted-foreground">
                              {m.model}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right num">
                        {fmtInt(m.requests, locale)}
                      </TableCell>
                      <TableCell className="text-right num">
                        {fmtTokens(m.totalTokens)}
                      </TableCell>
                      <TableCell className="text-right num">
                        {fmtMoney(m.cost, moneyCfg)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Recent */}
      <Card className="mb-5">
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>{t("recent")}</CardTitle>
              <CardDescription className="mt-1">
                {fill(t("showing"), {
                  from:
                    filteredRecent.length === 0
                      ? 0
                      : (safePage - 1) * pageSize + 1,
                  to: Math.min(safePage * pageSize, filteredRecent.length),
                  total: filteredRecent.length,
                })}
                {stats.recentTotal && stats.recentTotal > filteredRecent.length
                  ? ` · ${fmtInt(stats.recentTotal, locale)} ${t("records")}`
                  : ""}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={modelFilter}
                onValueChange={(v) => {
                  setModelFilter(v);
                  setRecentPage(1);
                }}
              >
                <SelectTrigger className="w-[220px]" aria-label={t("filterModel")}>
                  <SelectValue placeholder={t("filterModel")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allModels")}</SelectItem>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setRecentPage(1);
                }}
              >
                <SelectTrigger className="w-[110px]" aria-label={t("rowsPerPage")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {t("rowsPerPage")} {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-3">
          <div className="max-h-[420px] overflow-auto thin-scroll border-y border-border/60">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="w-[170px]">{t("time")}</TableHead>
                    {showToolColumn ? <TableHead>{t("tool")}</TableHead> : null}
                    <TableHead>{t("model")}</TableHead>
                    <TableHead>{t("session")}</TableHead>
                    <TableHead className="text-right">{t("inputOther")}</TableHead>
                    <TableHead className="text-right">{t("output")}</TableHead>
                    <TableHead className="text-right">{t("cacheRead")}</TableHead>
                    <TableHead className="text-right">{t("cacheCreate")}</TableHead>
                    <TableHead className="text-right">{t("cost")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageSlice.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={showToolColumn ? 9 : 8}
                        className="text-center text-muted-foreground"
                      >
                        {t("noData")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    pageSlice.map((r, i) => (
                      <TableRow key={`${r.tool}-${r.time}-${r.model}-${i}`}>
                        <TableCell className="num whitespace-nowrap text-muted-foreground">
                          {fmtTime(r.time, locale)}
                        </TableCell>
                        {showToolColumn ? (
                          <TableCell>
                            <span
                              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                              title={toolById.get(r.tool)?.label || r.tool}
                            >
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: toolById.get(r.tool)?.color }}
                                aria-hidden
                              />
                              {toolById.get(r.tool)?.label || r.tool}
                            </span>
                          </TableCell>
                        ) : null}
                        <TableCell className="max-w-[200px]">
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate font-medium" title={r.model}>
                              {modelLabel(r)}
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                              {r.modelDisplay && r.modelDisplay !== r.model ? (
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {r.model}
                                </span>
                              ) : null}
                              {r.costEstimated ? (
                                <Badge variant="warn">{t("estimated")}</Badge>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[160px]">
                          <span
                            className="block truncate text-[11px] text-muted-foreground"
                            title={
                              [r.project, r.session]
                                .filter(Boolean)
                                .join("/") ||
                              (typeof r.sessionHint === "string"
                                ? r.sessionHint
                                : [r.sessionHint?.workspace, r.sessionHint?.session]
                                    .filter(Boolean)
                                    .join("/") || "—")
                            }
                          >
                            {[r.project, r.session]
                              .filter(Boolean)
                              .join("/") ||
                              (typeof r.sessionHint === "string"
                                ? r.sessionHint
                                : [r.sessionHint?.workspace, r.sessionHint?.session]
                                    .filter(Boolean)
                                    .join("/") || "—")}
                          </span>
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtTokens(r.inputOther)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtTokens(r.output)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtTokens(r.inputCacheRead)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {fmtTokens(r.inputCacheCreation)}
                        </TableCell>
                        <TableCell className="text-right num">
                          {r.credits > 0
                            ? `${fmtCredits(r.credits)} cr`
                            : fmtMoney(r.cost, moneyCfg)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
          </div>
          <div className="flex flex-col gap-2 px-4 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-muted-foreground">
              {fill(t("pageOf"), { page: safePage, pages: recentPages })}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setRecentPage((p) => Math.max(1, p - 1))}
              >
                {t("pagePrev")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={safePage >= recentPages}
                onClick={() =>
                  setRecentPage((p) => Math.min(recentPages, p + 1))
                }
              >
                {t("pageNext")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* FR-11 day drill-down + FR-12 model detail dialogs */}
      <DayDetailDialog
        day={dayDetail}
        open={!!dayDetail}
        onOpenChange={(v) => !v && setDayDetail(null)}
        tool={tool}
        workspace={wsFilter}
        model={modelFilter}
        t={t}
        locale={locale}
        moneyCfg={moneyCfg}
        toolById={toolById}
        showToolColumn={showToolColumn}
      />
      <ModelDetailDialog
        model={modelDetail?.model || null}
        resolved={modelDetail?.resolved || null}
        note={hasPeers && device === "all" ? t("detailLocalNote") : null}
        range={range}
        tool={tool}
        workspace={wsFilter}
        open={!!modelDetail}
        onOpenChange={(v) => !v && setModelDetail(null)}
        t={t}
        locale={locale}
        moneyCfg={moneyCfg}
        showToolColumn={showToolColumn}
        toolById={toolById}
      />

      <footer className="text-xs text-muted-foreground">
        {[
          (() => {
            // Aggregate scan metadata across tools
            const metas = Object.values(meta || {});
            const files = metas.reduce((s, m) => s + (m.filesScanned || 0), 0);
            const lines = metas.reduce((s, m) => s + (m.linesSeen || 0), 0);
            const recs = metas.reduce((s, m) => s + (m.recordCount || 0), 0);
            const errs = metas.reduce((s, m) => s + ((m.errors && m.errors.length) || 0), 0);
            return [
              `${t("filesScanned")}: ${files}`,
              `${t("linesScanned")}: ${lines}`,
              `${t("records")}: ${recs}`,
              errs ? `${t("parseErrors")}: ${errs}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
          })(),
          data?.scannedAt
            ? `${t("lastScan")}: ${fmtTime(data.scannedAt, locale)} (${scannedAgo})`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {(() => {
          const errs = Object.values(meta || {})
            .flatMap((m) => m.errors || [])
            .slice(0, 5);
          return errs.length > 0 ? (
            <div className="mt-1 max-w-[720px] truncate text-warning" title={errs.map((e) => `${e.file || ""} ${e.message || e}`).join("\n")}>
              {errs[0]?.message || errs[0]}
              {errs.length > 1 ? ` (+${errs.length - 1})` : ""}
            </div>
          ) : null;
        })()}
      </footer>
      </>
      ) : null}
    </div>
  );
}

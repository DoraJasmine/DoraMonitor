import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  FolderOpen,
  Github,
  Languages,
  LayoutDashboard,
  Loader2,
  MessagesSquare,
  Monitor,
  Moon,
  RefreshCw,
  ScanSearch,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import AppLogo from "@/components/AppLogo";
import SessionsPage from "@/pages/SessionsPage";
import ModelsPage from "@/pages/ModelsPage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { QuotaCard } from "@/components/QuotaCard";
import { fmtInt, fmtPct, fmtTime, fmtTokens, fmtMoney, fmtCredits } from "@/format";
import { detectBrowserLocale, fill, messages } from "@/i18n";
import { fetchPaths, fetchPrices, fetchSummary, fetchQuota, fetchSettings, openExternal } from "@/lib/backend";
import { cn } from "@/lib/utils";

const GITHUB_URL = "https://github.com/DoraJasmine/DoraMonitor";

const RANGE_KEYS = [
  { value: "today", labelKey: "rangeToday" },
  { value: "7d", labelKey: "range7d" },
  { value: "30d", labelKey: "range30d" },
  { value: "all", labelKey: "rangeAll" },
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/** Prefer raw model id so provider variants stay distinct in the UI. */
function modelLabel(row) {
  return row?.model || row?.modelDisplay || "unknown";
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

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] },
  }),
};

export default function App() {
  const { locale, t, changeLocale } = useLocale();
  const { theme, changeTheme } = useTheme();
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const reduceMotion = useReducedMotion();
  const [home, setHome] = useState(() => localStorage.getItem("kcd_home") || "");
  const [homeInput, setHomeInput] = useState(home);
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
  const [settings, setSettings] = useState({
    currency: "CNY",
    currencySymbol: "¥",
    fxRate: 7.2,
  });
  const [loading, setLoading] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(false);
  const [data, setData] = useState(null);
  const [prices, setPrices] = useState([]);
  const [error, setError] = useState(null);
  const [recentPage, setRecentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [modelFilter, setModelFilter] = useState("all");
  const [page, setPage] = useState(() => {
    if (typeof window !== "undefined") {
      const p = window.location.pathname;
      if (p.startsWith("/sessions")) return "sessions";
      if (p.startsWith("/models")) return "models";
    }
    return localStorage.getItem("kcd_page") || "usage";
  });
  const rangeReady = useRef(false);
  // Play entrance motion only once — refresh must not re-trigger fade/stagger.
  const entered = useRef(false);
  const loadingRef = useRef(false);
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
      const path =
        next === "sessions" ? "/sessions" : next === "models" ? "/models" : "/";
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
      setRefreshFlash(false);
      setError(null);
      const started = Date.now();
      try {
        const summary = await fetchSummary(nextHome, nextRange, refresh, nextTool, nextDevice);
        setData(summary);
        setHome(summary.home || nextHome);
        setHomeInput(summary.home || nextHome);
        localStorage.setItem("kcd_home", summary.home || nextHome || "");
        if (refresh) {
          setRefreshFlash(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setRefreshFlash(false), 1200);
        }
      } catch (e) {
        setData(null);
        setError(e.data?.message || e.message || t("homeInvalid"));
      } finally {
        // Keep spinner visible briefly so fast cache hits still feel intentional
        const minMs = refresh ? 320 : 0;
        const wait = Math.max(0, minMs - (Date.now() - started));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        loadingRef.current = false;
        setLoading(false);
        entered.current = true;
      }
    },
    [home, range, tool, device, t]
  );

  useEffect(() => {
    fetchPrices()
      .then((d) => setPrices(d.prices || []))
      .catch(() => setPrices([]));
    fetchSettings()
      .then((s) =>
        setSettings({
          currency: s.currency || "CNY",
          currencySymbol: s.currencySymbol || "¥",
          fxRate: Number(s.fxRate) || 7.2,
        })
      )
      .catch(() => {});
    fetchPaths()
      .then((d) => {
        if (!home) {
          setHome(d.current || "");
          setHomeInput(d.current || "");
        }
      })
      .catch(() => {});
    loadSummary({ refresh: true }).finally(() => {
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

  const switchTool = (next) => {
    setTool(next);
  };

  const handlePricingSaved = useCallback(async () => {
    const [priceData, savedSettings] = await Promise.all([
      fetchPrices(),
      fetchSettings(),
    ]);
    setPrices(priceData.prices || []);
    setSettings({
      currency: savedSettings.currency || "CNY",
      currencySymbol: savedSettings.currencySymbol || "¥",
      fxRate: Number(savedSettings.fxRate) || 7.2,
    });
    await loadSummary({ refresh: true });
  }, [loadSummary]);

  const totals = data?.stats?.totals || {};
  const stats = data?.stats || { daily: [], models: [], recent: [] };
  const rangeTotals = data?.rangeTotals || {};
  const meta = data?.meta || {};
  const heatmap = data?.heatmap || null;
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
    setRange("all");
    setModelFilter(modelId || "all");
    setRecentPage(1);
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
      { title: t("requests"), value: fmtInt(totals.requests, locale) },
      {
        title: t("inputOther"),
        value: fmtTokens(totals.inputOther),
        sub: fmtInt(totals.inputOther, locale),
      },
      {
        title: t("output"),
        value: fmtTokens(totals.output),
        sub: fmtInt(totals.output, locale),
      },
      {
        title: t("cacheRead"),
        value: fmtTokens(totals.inputCacheRead),
        sub: fmtInt(totals.inputCacheRead, locale),
      },
      {
        title: t("cacheCreate"),
        value: fmtTokens(totals.inputCacheCreation),
        sub: fmtInt(totals.inputCacheCreation, locale),
      },
      { title: t("cacheHitRate"), value: fmtPct(totals.cacheHitRate) },
      {
        title: t("totalTokens"),
        value: fmtTokens(totals.totalTokens),
        sub: fmtInt(totals.totalTokens, locale),
      },
      { title: `${t("estCost")} (${settings.currencySymbol})`, value: fmtMoney(totals.cost, moneyCfg) },
    ];
    if ((totals.credits || 0) > 0) {
      items.push({
        title: t("credits"),
        value: fmtCredits(totals.credits),
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
  }, [totals, t, locale]);

  const applyHome = () => {
    const next = homeInput.trim();
    setHome(next);
    localStorage.setItem("kcd_home", next);
    loadSummary({ refresh: true, nextHome: next });
  };

  const autoDetect = async () => {
    try {
      const d = await fetchPaths();
      const next = d.current || "";
      setHome(next);
      setHomeInput(next);
      localStorage.removeItem("kcd_home");
      loadSummary({ refresh: true, nextHome: next });
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 pb-16 sm:px-6">
      {/* Header */}
      <motion.header
        className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        initial={reduceMotion || entered.current ? false : "hidden"}
        animate="show"
        variants={fadeUp}
      >
        <div className="flex items-center gap-3">
          <AppLogo size={40} className="shrink-0 rounded-[9px] shadow-panel ring-1 ring-white/10" />
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t("brandEyebrow")}
            </div>
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
          <div className="inline-flex rounded-lg border border-border bg-secondary/50 p-1">
            <Button
              size="sm"
              variant={page === "usage" ? "default" : "ghost"}
              onClick={() => goPage("usage")}
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
              {t("navUsage")}
            </Button>
            <Button
              size="sm"
              variant={page === "sessions" ? "default" : "ghost"}
              onClick={() => goPage("sessions")}
            >
              <MessagesSquare className="h-3.5 w-3.5" />
              {t("navSessions")}
            </Button>
            <Button
              size="sm"
              variant={page === "models" ? "default" : "ghost"}
              onClick={() => goPage("models")}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t("navModels")}
            </Button>
          </div>
          <Select value={locale} onValueChange={changeLocale}>
            <SelectTrigger className="w-[120px]" aria-label={t("language")}>
              <Languages className="mr-1 h-3.5 w-3.5 opacity-70" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <Select value={theme} onValueChange={changeTheme}>
            <SelectTrigger className="w-[128px]" aria-label={t("appearance")}>
              <ThemeIcon className="mr-1 h-3.5 w-3.5 opacity-70" />
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
              onClick={() => loadSummary({ refresh: true })}
              disabled={loading}
              aria-busy={loading}
              className={cn(
                refreshFlash &&
                  !loading &&
                  "ring-1 ring-white/35 bg-primary/90"
              )}
              title={
                loading
                  ? t("refreshing")
                  : refreshFlash
                    ? t("refreshed")
                    : t("refresh")
              }
            >
              <RefreshCw
                className={cn(
                  "h-4 w-4 shrink-0 text-current",
                  loading && "icon-spin"
                )}
                aria-hidden
              />
              <span>
                {loading
                  ? t("refreshing")
                  : refreshFlash
                    ? t("refreshed")
                    : t("refresh")}
              </span>
            </Button>
          ) : null}
        </div>
      </motion.header>

      {/* Path bar — kimi 会话/模型管理专用（用量统计不依赖此目录） */}
      {page !== "usage" ? (
      <motion.div
        custom={1}
        initial={reduceMotion || entered.current ? false : "hidden"}
        animate="show"
        variants={fadeUp}
      >
        <Card className="mb-5">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("dataDir")}（{t("dataDirKimiOnly")}）
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <FolderOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={homeInput}
                  placeholder={t("dirPlaceholder")}
                  onChange={(e) => setHomeInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyHome()}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={applyHome}>{t("applyDir")}</Button>
                <Button variant="secondary" onClick={autoDetect}>
                  <ScanSearch />
                  {t("autoDetect")}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {home || "—"}
            </p>
            <p className="text-xs text-muted-foreground/80">{t("privacy")}</p>
          </CardContent>
        </Card>
      </motion.div>
      ) : null}

      {error && page === "usage" ? (
        <div className="mb-5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {page === "sessions" ? (
        <SessionsPage home={home} t={t} locale={locale} />
      ) : null}

      {page === "models" ? <ModelsPage home={home} t={t} onPricingSaved={handlePricingSaved} /> : null}

      {page === "usage" ? (
      <>
      {/* Tool switcher */}
      {availableTools.length > 0 ? (
        <motion.div
          className="mb-4"
          custom={1}
          initial={reduceMotion || entered.current ? false : "hidden"}
          animate="show"
          variants={fadeUp}
        >
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
        </motion.div>
      ) : null}

      {creditsOnlyTool ? (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
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
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              try {
                await fetch("/api/sync", { method: "POST" });
                await loadSummary({ refresh: true });
              } catch {
                // keep the UI alive on sync failure
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? t("syncing") : t("syncNow")}
          </button>
        </div>
      ) : null}

      {/* Range tabs */}
      <motion.div
        className="mb-4"
        custom={2}
        initial={reduceMotion || entered.current ? false : "hidden"}
        animate="show"
        variants={fadeUp}
      >
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
        {range !== "all" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("rangeScopedHint")}{" "}
            <span className="text-foreground/80">
              {fill(t("modelsInRange"), { n: rangeModelCount })} ·{" "}
              {fill(t("modelsAllTime"), { n: allModelCount })}
            </span>
          </p>
        ) : null}
      </motion.div>

      {/* Range overview cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {RANGE_KEYS.map((r, i) => {
          const tot = rangeTotals[r.value] || {};
          const active = range === r.value;
          return (
            <motion.button
              key={r.value}
              type="button"
              custom={i}
              initial={reduceMotion || entered.current ? false : "hidden"}
              animate="show"
              variants={fadeUp}
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
            </motion.button>
          );
        })}
      </div>

      {/* KPI strip — first screen before heatmap */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {kpiItems.map((item, i) => (
          <motion.div
            key={item.title}
            custom={i}
            initial={reduceMotion || entered.current ? false : "hidden"}
            animate="show"
            variants={fadeUp}
          >
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
          </motion.div>
        ))}
      </div>

      {/* Kimi quota (5-hour + weekly windows) */}
      {(tool === "all" || tool === "kimi-code") &&
      availableTools.some((x) => x.id === "kimi-code") ? (
        <motion.div
          className="mb-5"
          custom={3}
          initial={reduceMotion || entered.current ? false : "hidden"}
          animate="show"
          variants={fadeUp}
        >
          <QuotaCard t={t} locale={locale} refreshSignal={data?.scannedAt} />
        </motion.div>
      ) : null}

      {/* Codex quota (rate_limits from rollout files: 5h + weekly) */}
      {(tool === "all" || tool === "codex") &&
      availableTools.some((x) => x.id === "codex") ? (
        <motion.div
          className="mb-5"
          custom={3}
          initial={reduceMotion || entered.current ? false : "hidden"}
          animate="show"
          variants={fadeUp}
        >
          <QuotaCard t={t} locale={locale} refreshSignal={data?.scannedAt} tool="codex" />
        </motion.div>
      ) : null}

      {/* Heatmap */}
      <motion.div
        custom={3}
        initial={reduceMotion || entered.current ? false : "hidden"}
        animate="show"
        variants={fadeUp}
        className="mb-5"
      >
        <Card>
          <CardHeader>
            <CardTitle>{t("heatmap")}</CardTitle>
            <CardDescription>{t("heatmapHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Heatmap heatmap={heatmap} locale={locale} t={t} moneyCfg={moneyCfg} />
          </CardContent>
        </Card>
      </motion.div>

      {/* Charts + models */}
      <div className="mb-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t("dailyTrend")}</CardTitle>
            <CardDescription>
              {t("dailyTrendHint") ||
                "Continuous token curve · top models by usage"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyBars
              daily={stats.daily}
              dailyByModel={stats.dailyByModel}
              t={t}
              reducedMotion={!!reduceMotion}
              moneyCfg={moneyCfg}
            />
          </CardContent>
        </Card>

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
                                  {m.modelDisplay}
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
      </div>

      {/* All-time model roster (always visible when more models exist outside range) */}
      {allModels.length > 0 && range !== "all" ? (
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
                              {m.modelDisplay}
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
                                  {r.modelDisplay}
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

      {/* Prices */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>{t("priceTable")}</CardTitle>
          <CardDescription>{t("pricingNote")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("model")}</TableHead>
                <TableHead>{t("nativeCurrency")}</TableHead>
                <TableHead>{t("pricePeriod")}</TableHead>
                <TableHead className="text-right">{t("cacheHit")}</TableHead>
                <TableHead className="text-right">{t("cacheWrite")}</TableHead>
                <TableHead className="text-right">{t("inputPrice")}</TableHead>
                <TableHead className="text-right">{t("outputPrice")}</TableHead>
                <TableHead className="text-right">{t("context")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.map((p) => (
                <TableRow key={`${p.id}-${p.period || "standard"}`}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {p.id}
                      {p.estimated ? <Badge variant="warn">{t("estimated")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>{p.nativeCurrency || "—"}</TableCell>
                  <TableCell>{p.period ? t(`price${p.period[0].toUpperCase()}${p.period.slice(1)}`) : "—"}</TableCell>
                  <TableCell className="text-right num">
                    {fmtMoney(p.display?.cacheHit ?? p.cacheHit, moneyCfg)}
                  </TableCell>
                  <TableCell className="text-right num">
                    {fmtMoney(p.display?.cacheWrite ?? p.cacheWrite, moneyCfg)}
                  </TableCell>
                  <TableCell className="text-right num">
                    {fmtMoney(p.display?.input ?? p.input, moneyCfg)}
                  </TableCell>
                  <TableCell className="text-right num">
                    {fmtMoney(p.display?.output ?? p.output, moneyCfg)}
                  </TableCell>
                  <TableCell className="text-right num">
                    {fmtInt(p.context, locale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <footer className="text-xs text-muted-foreground">
        {[
          (() => {
            // Aggregate scan metadata across providers
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
            <div className="mt-1 max-w-[720px] truncate text-amber-400/90" title={errs.map((e) => `${e.file || ""} ${e.message || e}`).join("\n")}>
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

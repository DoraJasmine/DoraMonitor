import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, Loader2, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
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
import { fetchCatalogPrices, fetchPrices, fetchSettings, saveSettings } from "@/lib/backend";
import { fmtInt, fmtMoney } from "@/format";
import { fill } from "@/i18n";

/**
 * Price page (phase: 待办 3) — the single place to manage model pricing.
 *
 * - Official list: the built-in price tables, as served by /api/prices.
 * - Custom prices: manual overrides (matched case-insensitively, exact
 *   first, then substring, longest pattern wins; blank components inherit
 *   the official row).
 * - Online update: search the models.dev catalog (7584 priced entries) and
 *   import any entry as a custom price row. Catalog costs are USD per 1M
 *   tokens at each provider ENTRY — the provider column says which.
 */

const EMPTY_ROW = { model: "", input: "", cacheHit: "", output: "", currency: "CNY" };

function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export function PricesPage({ t, locale, onSaved }) {
  // --- currency + custom rows (moved from ModelsPage's pricing tab) ---
  const [currency, setCurrency] = useState("CNY");
  const [fxRate, setFxRate] = useState("6.67");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [error, setError] = useState(null);

  // --- official table ---
  const [prices, setPrices] = useState([]);

  // --- online catalog import ---
  const [query, setQuery] = useState("");
  const [catalogRows, setCatalogRows] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogSource, setCatalogSource] = useState(null);
  const [catalogError, setCatalogError] = useState(null);
  const [importedNote, setImportedNote] = useState(false);

  const settings = useMemo(() => ({ fxRate: Number(fxRate) || 6.67 }), [fxRate]);
  const moneyCfg = useMemo(() => ({ currency, symbol: currency === "USD" ? "$" : "¥" }), [currency]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, p] = await Promise.all([fetchSettings(), fetchPrices()]);
      setCurrency(s.currency || "CNY");
      setFxRate(String(s.fxRate || 6.67));
      setRows(
        (s.customPrices || []).map((x) => ({
          model: x.model || "",
          input: x.input ?? "",
          cacheHit: x.cacheHit ?? "",
          output: x.output ?? "",
          currency: x.currency || "CNY",
        }))
      );
      setPrices(p.prices || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Online catalog: NEVER on first paint.
   *
   * The catalog endpoint goes out to the network (measured ~5 s cold), so
   * firing it with the page would hold the price table hostage to a remote
   * fetch. Instead the page renders entirely from local data, then asks for
   * the catalog once the browser is idle — after the first frame, and only
   * when the tab is actually visible. A failure here is silent: the local
   * table is already usable, so an offline machine sees no error banner.
   */
  const catalogRequested = useRef(false);
  const catalogRequestId = useRef(0);
  const autoSearchCatalog = useCallback(async () => {
    if (catalogRequested.current) return;
    catalogRequested.current = true;
    const requestId = ++catalogRequestId.current;
    setCatalogLoading(true);
    try {
      const data = await fetchCatalogPrices("");
      if (requestId !== catalogRequestId.current) return;
      setCatalogRows(data.prices || []);
      setCatalogSource({ source: data.source, count: (data.prices || []).length });
    } catch {
      // Offline or upstream down: leave the table empty rather than showing
      // an error the user did not ask for. The Search button reports errors.
      if (requestId === catalogRequestId.current) setCatalogRows(null);
    } finally {
      if (requestId === catalogRequestId.current) setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    // requestIdleCallback is not in Safari; the timeout fallback covers it.
    const hasIdle = typeof window !== "undefined" && typeof window.requestIdleCallback === "function";
    let handle = null;
    let timer = null;
    const kick = () => {
      if (document.visibilityState === "hidden") return;
      autoSearchCatalog();
    };
    document.addEventListener("visibilitychange", kick);
    if (hasIdle) handle = window.requestIdleCallback(kick, { timeout: 4000 });
    else timer = setTimeout(kick, 1200);
    return () => {
      document.removeEventListener("visibilitychange", kick);
      if (handle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(handle);
      }
      if (timer) clearTimeout(timer);
    };
  }, [autoSearchCatalog]);

  const updateRow = (idx, key, value) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  };

  const addRow = () => setRows((rs) => [...rs, { ...EMPTY_ROW, currency }]);

  const removeRow = (idx) => setRows((rs) => rs.filter((_, i) => i !== idx));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const fx = Number(fxRate);
      if (!Number.isFinite(fx) || fx <= 0) {
        throw new Error(t("fxRateLabel") + ": invalid");
      }
      const customPrices = [];
      for (const r of rows) {
        const model = String(r.model || "").trim();
        if (!model) continue;
        const input = toNum(r.input);
        const cacheHit = toNum(r.cacheHit);
        const output = toNum(r.output);
        if (Number.isNaN(input) || Number.isNaN(cacheHit) || Number.isNaN(output)) {
          throw new Error(`${model}: ${t("invalidPrice")}`);
        }
        if (input === null && cacheHit === null && output === null) continue;
        customPrices.push({ model, input, cacheHit, output, currency: r.currency });
      }
      await saveSettings({ currency, fxRate: fx, customPrices });
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 2500);
      if (onSaved) onSaved();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const searchCatalog = async (refresh = false) => {
    catalogRequested.current = true;
    const requestId = ++catalogRequestId.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set("q", query.trim());
      if (refresh) qs.set("refresh", "1");
      const data = await fetchCatalogPrices(qs.toString());
      if (requestId !== catalogRequestId.current) return;
      setCatalogRows(data.prices || []);
      setCatalogSource({ source: data.source, count: (data.prices || []).length });
    } catch (e) {
      if (requestId !== catalogRequestId.current) return;
      setCatalogError(e.message || String(e));
      setCatalogRows(null);
    } finally {
      if (requestId === catalogRequestId.current) setCatalogLoading(false);
    }
  };

  const importRow = (entry) => {
    setRows((rs) => {
      // Replace an existing row with the same model key instead of stacking.
      const kept = rs.filter((r) => r.model !== entry.modelId);
      return [
        ...kept,
        {
          model: entry.modelId,
          input: entry.input,
          cacheHit: entry.cacheRead,
          output: entry.output,
          currency: "USD",
        },
      ];
    });
    setImportedNote(true);
    setTimeout(() => setImportedNote(false), 2500);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t("scanning")}
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-8">
      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {/* Currency */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t("currencyTitle")}</CardTitle>
          <CardDescription>{t("currencyHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="w-[200px] space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("currencyLabel")}
            </span>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger aria-label={t("currencyLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USD">USD ($)</SelectItem>
                <SelectItem value="CNY">CNY (¥)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-[220px] space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("fxRateLabel")}
            </span>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Online import */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{t("onlinePricesTitle")}</CardTitle>
              <CardDescription className="mt-1">
                {t("onlinePricesHint")}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {catalogSource ? (
                <Badge variant="secondary">
                  {catalogSource.source === "remote" ? t("sourceRemote") : catalogSource.source === "cached" ? t("sourceCached") : t("sourceBuiltin")} · {catalogSource.count}
                </Badge>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => searchCatalog(true)}
                disabled={catalogLoading}
                aria-busy={catalogLoading}
              >
                {catalogLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                {t("onlineRefresh")}
              </Button>
              <Button size="sm" onClick={() => searchCatalog(false)} disabled={catalogLoading}>
                <Search className="h-4 w-4" aria-hidden />
                {t("onlineSearch")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pb-2">
          <Input
            value={query}
            placeholder={t("onlinePricesPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") searchCatalog(false);
            }}
          />
          {catalogError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
              {catalogError}
            </div>
          ) : null}
          {importedNote ? (
            <div className="text-xs text-emerald-300">{t("importedNote")}</div>
          ) : null}
          {catalogRows && catalogRows.length > 0 ? (
            <div className="max-h-[360px] overflow-auto thin-scroll rounded-lg border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/40">
                    <TableHead>{t("onlineModel")}</TableHead>
                    <TableHead>{t("onlineProvider")}</TableHead>
                    <TableHead className="text-right">{t("priceInput")}</TableHead>
                    <TableHead className="text-right">{t("onlineCacheRead")}</TableHead>
                    <TableHead className="text-right">{t("priceOutput")}</TableHead>
                    <TableHead className="w-[90px]" aria-label="" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {catalogRows.map((p) => (
                    <TableRow key={`${p.providerId}/${p.modelId}`}>
                      <TableCell className="font-mono text-xs">{p.modelId}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.providerName}
                      </TableCell>
                      <TableCell className="text-right num">{fmtMoney(p.input, { currency: "USD", symbol: "$" })}</TableCell>
                      <TableCell className="text-right num">{fmtMoney(p.cacheRead, { currency: "USD", symbol: "$" })}</TableCell>
                      <TableCell className="text-right num">{fmtMoney(p.output, { currency: "USD", symbol: "$" })}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => importRow(p)}
                          aria-label={`${t("onlineImport")} ${p.modelId}`}
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden />
                          {t("onlineImport")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : catalogRows ? (
            <div className="text-sm text-muted-foreground">{t("onlineNoResults")}</div>
          ) : null}
        </CardContent>
      </Card>

      {/* Custom prices */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{t("customPricesTitle")}</CardTitle>
              <CardDescription className="mt-1">{t("customPricesHint")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {savedNote ? (
                <span className="text-xs text-emerald-300">{t("pricingSaved")}</span>
              ) : null}
              <Button variant="secondary" size="sm" onClick={addRow} disabled={saving}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("addPriceRow")}
              </Button>
              <Button size="sm" onClick={save} disabled={saving} aria-busy={saving}>
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="h-4 w-4" aria-hidden />
                )}
                {t("savePricing")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {rows.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">{t("noCustomPrices")}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("priceModel")}</TableHead>
                  <TableHead className="w-[130px]">{t("priceCurrency")}</TableHead>
                  <TableHead className="text-right">{t("priceInput")}</TableHead>
                  <TableHead className="text-right">{t("priceCacheHit")}</TableHead>
                  <TableHead className="text-right">{t("priceOutput")}</TableHead>
                  <TableHead className="w-[60px]" aria-label="" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, idx) => (
                  <TableRow key={idx}>
                    <TableCell>
                      <Input
                        value={r.model}
                        placeholder="glm-5.3"
                        onChange={(e) => updateRow(idx, "model", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Select value={r.currency} onValueChange={(v) => updateRow(idx, "currency", v)}>
                        <SelectTrigger aria-label={t("priceCurrency")}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="CNY">CNY</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        className="text-right"
                        value={r.input}
                        placeholder="—"
                        onChange={(e) => updateRow(idx, "input", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        className="text-right"
                        value={r.cacheHit}
                        placeholder="—"
                        onChange={(e) => updateRow(idx, "cacheHit", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        className="text-right"
                        value={r.output}
                        placeholder="—"
                        onChange={(e) => updateRow(idx, "output", e.target.value)}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-red-300"
                        onClick={() => removeRow(idx)}
                        aria-label={t("deletePriceRow")}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="px-6 pt-2">
            <Badge variant="secondary">{t("priceUnitHint")}</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Official table */}
      <Card>
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
                      <a
                        href={p.sourceUrl || p.source}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm underline-offset-4 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={fill(t("officialSourceLink"), { model: p.id })}
                      >
                        {p.id}<ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                      </a>
                      {p.estimated ? <Badge variant="warn">{t("estimated")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>{p.nativeCurrency || "—"}</TableCell>
                  <TableCell>
                    {p.period
                      ? t(`price${p.period[0].toUpperCase()}${p.period.slice(1)}`)
                      : "—"}
                  </TableCell>
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
    </div>
  );
}

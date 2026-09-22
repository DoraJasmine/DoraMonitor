import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
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
import { fetchSettings, saveSettings } from "@/lib/backend";

/**
 * Pricing & currency settings tab.
 *
 * - Display currency: USD (native price table) or CNY (converted at fxRate).
 * - Custom model prices: matched case-insensitively (exact first, then
 *   substring, longest pattern wins) and entered in either currency; the
 *   backend converts to USD internally and recalculates all costs on save.
 */

const EMPTY_ROW = { model: "", input: "", cacheHit: "", output: "", currency: "CNY" };

function toNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export function PricingTab({ t, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [error, setError] = useState(null);
  const [currency, setCurrency] = useState("USD");
  const [fxRate, setFxRate] = useState("7.2");
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchSettings();
      setCurrency(s.currency || "USD");
      setFxRate(String(s.fxRate || 7.2));
      setRows(
        (s.customPrices || []).map((p) => ({
          model: p.model || "",
          input: p.input ?? "",
          cacheHit: p.cacheHit ?? "",
          output: p.output ?? "",
          currency: p.currency || "USD",
        }))
      );
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        {t("scanning")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

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
          {currency === "CNY" ? (
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
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>{t("customPricesTitle")}</CardTitle>
              <CardDescription className="mt-1">
                {t("customPricesHint")}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {savedNote ? (
                <span className="text-xs text-emerald-300">{t("pricingSaved")}</span>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={addRow}
                disabled={saving}
              >
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
            <div className="px-6 py-6 text-sm text-muted-foreground">
              {t("noCustomPrices")}
            </div>
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
                      <Select
                        value={r.currency}
                        onValueChange={(v) => updateRow(idx, "currency", v)}
                      >
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
    </div>
  );
}

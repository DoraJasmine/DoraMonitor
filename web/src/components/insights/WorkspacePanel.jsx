import React, { useState } from "react";
import { ChevronDown, ChevronUp, FolderOpen, Pencil } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { saveWorkspaceAlias } from "@/lib/backend";
import { fmtInt, fmtTokens } from "@/format";
import { cn } from "@/lib/utils";

const WS_COLORS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#94a3b8"];
/** Collapsed view shows this many workspace rows; 展开全部 reveals the rest. */
const COLLAPSED_COUNT = 6;

/**
 * FR-10 工作区用量(全历史口径):彩色圆点行 + 占比条,点击行设置全局工作区
 * 筛选,行内可编辑本机别名(仅本地展示,不同步)。工作区多时默认收缩。
 */
export function WorkspacePanel({ workspaces, activeKey, onSelect, t, locale, onAliasesChanged, aliases, note, toolById, deviceView }) {
  const [editing, setEditing] = useState(null); // { key, name, value }
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (!workspaces || !workspaces.length) return null;
  const totalTokens = workspaces.reduce((s, w) => s + (w.totalTokens || 0), 0) || 1;
  const rows = expanded ? workspaces : workspaces.slice(0, COLLAPSED_COUNT);
  const hiddenCount = workspaces.length - rows.length;
  const colorFor = (i) => WS_COLORS[i % WS_COLORS.length];
  const nameOf = (w) => aliases?.[w.workspaceKey] || w.workspaceName || w.workspaceKey;
  const machineOf = (w) => (w.scope === "peer" ? `${t("peerScope")}（${(w.devices || []).join("/") || "?"}）` : t("wsScopeLocal"));
  const toolNamesOf = (w) => {
    const list = w.tools || [];
    if (!list.length) return "";
    return list.slice(0, 3).map((x) => toolById?.get(x.tool)?.label || x.tool).join("、") + (list.length > 3 ? ` +${list.length - 3}` : "");
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await saveWorkspaceAlias(editing.key, editing.value.trim());
      onAliasesChanged?.(res.aliases || {});
      setEditing(null);
    } catch {
      /* keep dialog open on failure */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-5">
      <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-primary" aria-hidden />
            {t("workspaceStats")}
          </CardTitle>
          <CardDescription className="mt-1">{t("workspaceHint")}</CardDescription>
          {note ? <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-warning">{note}</div> : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map((w, i) => {
            const share = (w.totalTokens || 0) / totalTokens;
            const active = activeKey === w.workspaceKey;
            return (
              <div
                key={w.workspaceKey}
                className={cn(
                  "group rounded-lg border px-3 py-2.5 transition-colors",
                  active ? "border-primary/50 ring-1 ring-primary/30" : "border-border/60 hover:border-border"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => onSelect(active ? "all" : w.workspaceKey)}
                    title={w.workspaceKey}
                  >
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(i) }} aria-hidden />
                    <span className="truncate text-sm font-medium">{nameOf(w)}</span>
                    {w.workspaceKey === "__unknown__" ? <span className="shrink-0 text-[10px] text-muted-foreground">{t("unknownWsNote")}</span> : null}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="num text-xs text-muted-foreground">{fmtTokens(w.totalTokens)}</span>
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      aria-label={t("aliasEdit")}
                      onClick={() => setEditing({ key: w.workspaceKey, name: nameOf(w), value: aliases?.[w.workspaceKey] || "" })}
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(1, share * 100)}%`, backgroundColor: colorFor(i) }} />
                </div>
                <div className="mt-1 flex justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {machineOf(w)}
                    {toolNamesOf(w) ? ` · ${toolNamesOf(w)}` : ""}
                  </span>
                  <span className="shrink-0 num">
                    {fmtInt(w.requests || 0, locale)} {t("requestsCount")} · {(share * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {workspaces.length > COLLAPSED_COUNT ? (
          <div className="mt-3 text-center">
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
              {expanded ? t("collapseAll") : `${t("expandAll")} (${workspaces.length})`}
            </Button>
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <div className="mt-1 text-center text-[11px] text-muted-foreground">
            {t("hiddenWorkspaces").replace("{n}", String(hiddenCount))}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="w-[min(24rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{t("aliasEdit")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="truncate text-[11px] text-muted-foreground" title={editing?.key}>
              {editing?.key}
            </div>
            <Input
              value={editing?.value || ""}
              placeholder={editing?.name || ""}
              onChange={(e) => setEditing((prev) => (prev ? { ...prev, value: e.target.value } : prev))}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <div className="text-[11px] text-muted-foreground">{t("aliasHint")}</div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button size="sm" disabled={saving} onClick={save}>
              {saving ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Compact workspace table (rows for the stat sheet view). */
export function WorkspaceTable({ workspaces, t, locale, aliases }) {
  if (!workspaces?.length) return null;
  const nameOf = (w) => aliases?.[w.workspaceKey] || w.workspaceName || w.workspaceKey;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("workspace")}</TableHead>
          <TableHead className="text-right">{t("requests")}</TableHead>
          <TableHead className="text-right">{t("tokens")}</TableHead>
          <TableHead className="text-right">{t("inputOther")}</TableHead>
          <TableHead className="text-right">{t("output")}</TableHead>
          <TableHead className="text-right">{t("cacheRead")}</TableHead>
          <TableHead className="text-right">{t("cacheCreate")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {workspaces.map((w) => (
          <TableRow key={w.workspaceKey}>
            <TableCell className="max-w-[280px]">
              <span className="block truncate font-medium" title={w.workspaceKey}>
                {nameOf(w)}
              </span>
            </TableCell>
            <TableCell className="text-right num">{fmtInt(w.requests || 0, locale)}</TableCell>
            <TableCell className="text-right num">{fmtTokens(w.totalTokens)}</TableCell>
            <TableCell className="text-right num">{fmtTokens(w.inputOther || 0)}</TableCell>
            <TableCell className="text-right num">{fmtTokens(w.output || 0)}</TableCell>
            <TableCell className="text-right num">{fmtTokens(w.inputCacheRead || 0)}</TableCell>
            <TableCell className="text-right num">{fmtTokens(w.inputCacheCreation || 0)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

import React, { useState } from "react";
import { FolderOpen, Pencil } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { saveWorkspaceAlias } from "@/lib/backend";
import { fmtInt, fmtTokens } from "@/format";
import { cn } from "@/lib/utils";

const WS_COLORS = ["#2dd4bf", "#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#fb923c", "#94a3b8"];

/**
 * FR-10 工作区用量:Top N 彩色圆点行 + 占比条,点击行设置全局工作区筛选,
 * 行内可编辑本机别名(仅本地展示,不同步)。
 */
export function WorkspacePanel({ workspaces, activeKey, onSelect, t, locale, moneyCfg, onAliasesChanged, aliases }) {
  const [editing, setEditing] = useState(null); // { key, name, value }
  const [saving, setSaving] = useState(false);

  if (!workspaces || !workspaces.length) return null;
  const totalTokens = workspaces.reduce((s, w) => s + (w.totalTokens || 0), 0) || 1;
  const top = workspaces.slice(0, 8);
  const rest = workspaces.slice(8);
  const colorFor = (i) => WS_COLORS[i % WS_COLORS.length];
  const nameOf = (w) => aliases?.[w.workspaceKey] || w.workspaceName || w.workspaceKey;

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
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2">
          {top.map((w, i) => {
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
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground num">
                  <span>{fmtInt(w.requests || 0, locale)} {t("requestsUnit")}</span>
                  <span>{(share * 100).toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
        </div>
        {rest.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {rest.map((w) => (
              <button
                key={w.workspaceKey}
                type="button"
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  activeKey === w.workspaceKey ? "border-primary/50 bg-primary/10" : "border-border/60 text-muted-foreground hover:border-border"
                )}
                onClick={() => onSelect(activeKey === w.workspaceKey ? "all" : w.workspaceKey)}
                title={w.workspaceKey}
              >
                {nameOf(w)} · <span className="num">{fmtTokens(w.totalTokens)}</span>
              </button>
            ))}
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

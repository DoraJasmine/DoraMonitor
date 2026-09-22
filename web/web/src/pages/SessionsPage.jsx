import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { fmtInt, fmtTime, fmtTimeShort } from "@/format";
import {
  archiveSession,
  deleteSession,
  deleteWorkspace,
  fetchSessionPreview,
  fetchSessions,
  unarchiveSession,
} from "@/lib/backend";
import { cn } from "@/lib/utils";

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function SessionsPage({ home, t, locale }) {
  const [status, setStatus] = useState("active");
  const [workspace, setWorkspace] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(false);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // { mode: 'one'|'bulk'|'workspace', row?, rows?, workspace? }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { loading, error, data, row }
  const [previewOpen, setPreviewOpen] = useState(false);
  const loadingRef = useRef(false);
  const flashTimer = useRef(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const load = useCallback(
    async (opts = {}) => {
      const manual = opts.manual === true;
      if (loadingRef.current && manual) return;
      loadingRef.current = true;
      setLoading(true);
      setRefreshFlash(false);
      setError(null);
      const started = Date.now();
      try {
        const ws = opts.workspace !== undefined ? opts.workspace : workspace;
        const res = await fetchSessions(
          home,
          opts.status || status,
          ws && ws !== "all" ? ws : null
        );
        setData(res);
        setSelected(new Set());
        if (manual) {
          setRefreshFlash(true);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setRefreshFlash(false), 1200);
        }
      } catch (e) {
        setData(null);
        setError(e.message);
      } finally {
        const minMs = manual ? 320 : 0;
        const wait = Math.max(0, minMs - (Date.now() - started));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [home, status, workspace]
  );

  useEffect(() => {
    load({ status, workspace });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, status, workspace]);

  const workspaces = data?.workspaces || [];
  const sessions = data?.sessions || [];

  const workspaceMap = useMemo(() => {
    const m = new Map();
    for (const w of workspaces) m.set(w.id, w);
    return m;
  }, [workspaces]);

  const onArchive = async (row) => {
    const key = `${row.workspaceId}/${row.id}`;
    setBusyId(key);
    try {
      await archiveSession(home, row.workspaceId, row.id);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const onUnarchive = async (row) => {
    const key = `${row.workspaceId}/${row.id}`;
    setBusyId(key);
    try {
      await unarchiveSession(home, row.workspaceId, row.id);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (row) => {
    setConfirm({ mode: "one", row });
  };

  const onDeleteWorkspace = (w) => {
    setConfirm({ mode: "workspace", workspace: w });
  };

  const openPreview = async (row) => {
    setPreviewOpen(true);
    setPreview({ loading: true, error: null, data: null, row });
    try {
      const data = await fetchSessionPreview(
        home,
        row.workspaceId,
        row.id,
        row.status
      );
      setPreview({ loading: false, error: null, data, row });
    } catch (e) {
      setPreview({ loading: false, error: e.message, data: null, row });
    }
  };

  const runDeleteWorkspace = async (w) => {
    setConfirmBusy(true);
    try {
      await deleteWorkspace(home, w.id);
      setConfirm(null);
      if (workspace === w.id) setWorkspace("all");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const runDeleteOne = async (row) => {
    const key = `${row.workspaceId}/${row.id}`;
    setBusyId(key);
    setConfirmBusy(true);
    try {
      await deleteSession(home, row.workspaceId, row.id, row.status);
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
      setConfirmBusy(false);
    }
  };

  const rowKey = (row) => `${row.workspaceId}/${row.id}`;

  // Search filter: title / id / workDir / workspaceId
  const [query, setQuery] = useState("");
  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.title, s.id, s.workDir, s.workspaceId].some((v) =>
        v ? String(v).toLowerCase().includes(q) : false
      )
    );
  }, [sessions, query]);

  const allKeys = useMemo(
    () => filteredSessions.map((s) => rowKey(s)),
    [filteredSessions]
  );

  const allSelected =
    allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected =
    allKeys.some((k) => selected.has(k)) && !allSelected;

  const toggleSelect = (row) => {
    const key = rowKey(row);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(allKeys));
  };

  const bulkArchive = async () => {
    const rows = sessions.filter((s) => selected.has(rowKey(s)));
    for (const row of rows) {
      if (row.status !== "active") continue;
      try {
        await archiveSession(home, row.workspaceId, row.id);
      } catch (e) {
        setError(e.message);
        break;
      }
    }
    await load();
  };

  const bulkDelete = () => {
    const rows = sessions.filter((s) => selected.has(rowKey(s)));
    if (!rows.length) return;
    setConfirm({ mode: "bulk", rows });
  };

  const runBulkDelete = async (rows) => {
    setConfirmBusy(true);
    try {
      for (const row of rows) {
        await deleteSession(home, row.workspaceId, row.id, row.status);
      }
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmOpen = !!confirm;
  const confirmTitle =
    confirm?.mode === "bulk"
      ? t("confirmBulkTitle")
      : confirm?.mode === "workspace"
        ? t("confirmDeleteWorkspaceTitle")
        : t("confirmDeleteTitle");
  // Keep description short — never inject long session titles into prose.
  const confirmDesc =
    confirm?.mode === "bulk"
      ? t("confirmBulkDelete").replace(
          "{n}",
          String(confirm?.rows?.length || 0)
        )
      : confirm?.mode === "workspace"
        ? t("confirmDeleteWorkspace")
        : t("confirmDeleteSession");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {t("sessionsTitle")}
          </h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
            {t("sessionsSubtitle")}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => load({ manual: true })}
          disabled={loading}
          aria-busy={loading}
          className={cn(
            refreshFlash && !loading && "ring-1 ring-primary/50 text-primary"
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
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {/* Shared panel height so left rail matches right table area; both scroll inside */}
      <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:h-[min(640px,calc(100vh-220px))] lg:min-h-[480px]">
        <Card className="flex min-h-0 flex-col overflow-hidden">
          <CardHeader className="shrink-0 pb-2">
            <CardTitle className="text-sm">{t("workspaces")}</CardTitle>
            <CardDescription>{t("workspaceIsolatedHint")}</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col space-y-1 overflow-hidden p-2 pt-0">
            <button
              type="button"
              onClick={() => setWorkspace("all")}
              className={cn(
                "flex w-full shrink-0 items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                workspace === "all"
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              )}
            >
              <span>{t("allWorkspaces")}</span>
              <span className="num text-xs">
                {fmtInt(
                  workspaces.reduce(
                    (a, w) => a + (w.activeCount || 0) + (w.archivedCount || 0),
                    0
                  ),
                  locale
                )}
              </span>
            </button>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto thin-scroll">
              {workspaces.map((w) => {
                const total = (w.activeCount || 0) + (w.archivedCount || 0);
                const isEmpty = total === 0 || w.empty;
                return (
                  <div
                    key={w.id}
                    className={cn(
                      "group flex items-start gap-1 rounded-md",
                      workspace === w.id ? "bg-primary/15" : "hover:bg-secondary/60"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setWorkspace(w.id)}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left transition-colors",
                        workspace === w.id
                          ? "text-foreground"
                          : "text-muted-foreground group-hover:text-foreground"
                      )}
                      title={w.root || w.id}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {w.name || w.id}
                        </span>
                        <span className="num shrink-0 text-[11px]">
                          {isEmpty ? (
                            <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                              {t("emptyWorkspace")}
                            </Badge>
                          ) : (
                            <>
                              {w.activeCount || 0}
                              {w.archivedCount ? `/${w.archivedCount}` : ""}
                            </>
                          )}
                        </span>
                      </div>
                      {w.root ? (
                        <span className="truncate font-mono text-[10px] opacity-70">
                          {w.root}
                        </span>
                      ) : null}
                      {w.createdAt || w.lastOpenedAt ? (
                        <span className="truncate text-[10px] opacity-60">
                          {w.createdAt
                            ? `${t("created")} ${fmtTime(Date.parse(w.createdAt), locale)}`
                            : ""}
                          {w.createdAt && w.lastOpenedAt ? " · " : ""}
                          {w.lastOpenedAt
                            ? `${t("lastOpened")} ${fmtTime(Date.parse(w.lastOpenedAt), locale)}`
                            : ""}
                        </span>
                      ) : null}
                    </button>
                    {isEmpty ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1 mr-1 h-7 w-7 shrink-0 p-0 text-red-300/80 opacity-70 hover:text-red-200 group-hover:opacity-100"
                        title={t("deleteWorkspace")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteWorkspace(w);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                );
              })}
              {!workspaces.length && !loading ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("noSessions")}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col space-y-3 overflow-hidden">
          {/* Toolbar row 1: status tabs + workspace select */}
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={status}
              onValueChange={(v) => {
                setStatus(v);
              }}
            >
              <TabsList>
                <TabsTrigger value="active">{t("statusActive")}</TabsTrigger>
                <TabsTrigger value="archived">{t("statusArchived")}</TabsTrigger>
                <TabsTrigger value="all">{t("statusAll")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <Select
              value={workspace}
              onValueChange={setWorkspace}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t("workspaces")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allWorkspaces")}</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name || w.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Toolbar row 2: search + bulk actions (never squeezes row 1) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="relative flex w-full min-w-[140px] items-center overflow-visible sm:w-[220px] sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchPlaceholder")}
                aria-label={t("searchSessions")}
                className="h-8 w-full pl-8 pr-2 text-xs"
              />
            </div>
            {sessions.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleSelectAll}
                disabled={!filteredSessions.length}
              >
                {allSelected ? t("deselectAll") : t("selectAll")}
              </Button>
            ) : null}
            {selected.size > 0 ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {t("selectedCount").replace("{n}", String(selected.size))}
                </span>
                {status !== "archived" ? (
                  <Button size="sm" variant="secondary" onClick={bulkArchive}>
                    <Archive className="h-3.5 w-3.5" />
                    {t("archive")}
                  </Button>
                ) : null}
                {status !== "active" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      const rows = sessions.filter(
                        (s) =>
                          selected.has(rowKey(s)) && s.status === "archived"
                      );
                      for (const row of rows) {
                        try {
                          await unarchiveSession(
                            home,
                            row.workspaceId,
                            row.id
                          );
                        } catch (e) {
                          setError(e.message);
                          break;
                        }
                      }
                      await load();
                    }}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    {t("unarchive")}
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={bulkDelete}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("delete")}
                </Button>
              </>
            ) : null}
          </div>

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader className="shrink-0 pb-2">
              <CardTitle className="text-sm">
                {workspace === "all"
                  ? t("allWorkspaces")
                  : workspaceMap.get(workspace)?.name || workspace}
              </CardTitle>
              <CardDescription>
                {t("sessionsInView").replace(
                  "{n}",
                  String(filteredSessions.length)
                )}
                {query.trim()
                  ? ` · ${t("searchResults").replace("{n}", String(filteredSessions.length))}`
                  : ""}
                {workspace !== "all"
                  ? ` · ${t("isolatedToWorkspace")}`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col px-0 pb-2">
              <div className="min-h-0 flex-1 overflow-auto thin-scroll border-y border-border/60">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow className="[&>th]:px-2">
                      <TableHead className="w-10">
                        <input
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          type="checkbox"
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                          checked={allSelected}
                          disabled={!sessions.length}
                          onChange={toggleSelectAll}
                          aria-label={t("selectAll")}
                          title={allSelected ? t("deselectAll") : t("selectAll")}
                        />
                      </TableHead>
                      <TableHead>{t("sessionTitle")}</TableHead>
                      <TableHead>{t("workspace")}</TableHead>
                      <TableHead>{t("status")}</TableHead>
                      <TableHead className="text-right">{t("size")}</TableHead>
                      <TableHead>{t("created")}</TableHead>
                      <TableHead>{t("updated")}</TableHead>
                      <TableHead className="text-right">{t("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSessions.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className="py-10 text-center text-muted-foreground"
                        >
                          {loading
                            ? t("scanning")
                            : query.trim()
                              ? t("noMatches")
                              : t("noSessions")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSessions.map((row) => {
                        const key = `${row.workspaceId}/${row.id}`;
                        const ws = workspaceMap.get(row.workspaceId);
                        const busy = busyId === key;
                        return (
                          <TableRow key={key} className="[&>td]:px-2">
                            <TableCell>
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-[hsl(var(--primary))]"
                                checked={selected.has(key)}
                                onChange={() => toggleSelect(row)}
                                aria-label={row.title}
                              />
                            </TableCell>
                            <TableCell className="min-w-[170px] max-w-[240px]">
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <button
                                  type="button"
                                  className="truncate text-left font-medium text-foreground hover:text-primary hover:underline"
                                  title={row.title || t("openPreview")}
                                  onClick={() => openPreview(row)}
                                >
                                  {row.title || row.id}
                                </button>
                                <span
                                  className="truncate font-mono text-[10px] text-muted-foreground"
                                  title={row.id}
                                >
                                  {row.id}
                                </span>
                                {row.workDir ? (
                                  <span
                                    className="truncate font-mono text-[10px] text-muted-foreground/80"
                                    title={row.workDir}
                                  >
                                    <FolderOpen className="mr-1 inline h-3 w-3" />
                                    {row.workDir}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="min-w-[150px] max-w-[220px]">
                              <span className="block truncate text-sm" title={ws?.name || row.workspaceId}>
                                {ws?.name || row.workspaceId}
                              </span>
                            </TableCell>
                            <TableCell className="whitespace-nowrap">
                              {row.status === "archived" ? (
                                <Badge
                                  variant="warn"
                                  className="rounded-md px-2 py-0.5 whitespace-nowrap"
                                >
                                  {t("statusArchived")}
                                </Badge>
                              ) : (
                                <Badge
                                  variant="success"
                                  className="rounded-md px-2 py-0.5 whitespace-nowrap"
                                >
                                  {t("statusActive")}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right num text-muted-foreground">
                              <div className="flex flex-col items-end gap-0.5">
                                <span>{fmtBytes(row.bytes)}</span>
                                {row.files != null ? (
                                  <span className="text-[10px] opacity-75">
                                    {fmtInt(row.files, locale)} {t("files")}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="num whitespace-nowrap text-muted-foreground">
                              {fmtTimeShort(
                                row.createdAt ? Date.parse(row.createdAt) : null,
                                locale
                              )}
                            </TableCell>
                            <TableCell className="num whitespace-nowrap text-muted-foreground">
                              {fmtTimeShort(
                                row.updatedAt
                                  ? Date.parse(row.updatedAt)
                                  : null,
                                locale
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                {row.status === "active" ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => onArchive(row)}
                                    title={t("archive")}
                                  >
                                    {busy ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Archive className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => onUnarchive(row)}
                                    title={t("unarchive")}
                                  >
                                    {busy ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <ArchiveRestore className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => onDelete(row)}
                                  title={t("delete")}
                                  className="text-red-300 hover:text-red-200"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirm(null);
        }}
      >
        <DialogContent showClose={!confirmBusy} className="gap-0 p-0">
          <div className="space-y-3 p-5 pb-4 pr-12">
            <DialogHeader className="pr-0">
              <DialogTitle>{confirmTitle}</DialogTitle>
              <DialogDescription>{confirmDesc}</DialogDescription>
            </DialogHeader>
            {confirm?.mode === "one" && confirm.row ? (
              <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5">
                <div
                  className="truncate text-sm font-medium text-foreground"
                  title={confirm.row.title || confirm.row.id}
                >
                  {confirm.row.title || confirm.row.id}
                </div>
                <div
                  className="mt-1 break-all font-mono text-[11px] leading-snug text-muted-foreground"
                  title={confirm.row.id}
                >
                  {confirm.row.id}
                </div>
              </div>
            ) : null}
            {confirm?.mode === "bulk" ? (
              <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5 text-sm text-muted-foreground">
                {t("selectedCount").replace(
                  "{n}",
                  String(confirm.rows?.length || 0)
                )}
              </div>
            ) : null}
            {confirm?.mode === "workspace" && confirm.workspace ? (
              <div className="rounded-md border border-border bg-secondary/50 px-3 py-2.5">
                <div className="truncate text-sm font-medium text-foreground">
                  {confirm.workspace.name || confirm.workspace.id}
                </div>
                {confirm.workspace.root ? (
                  <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                    {confirm.workspace.root}
                  </div>
                ) : null}
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                  {confirm.workspace.id}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter className="bg-secondary/20 px-5 py-4">
            <Button
              variant="secondary"
              disabled={confirmBusy}
              onClick={() => setConfirm(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-500"
              disabled={confirmBusy}
              onClick={() => {
                if (confirm?.mode === "bulk") runBulkDelete(confirm.rows || []);
                else if (confirm?.mode === "workspace" && confirm.workspace) {
                  runDeleteWorkspace(confirm.workspace);
                } else if (confirm?.row) runDeleteOne(confirm.row);
              }}
            >
              {confirmBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {confirm?.mode === "workspace"
                ? t("deleteWorkspace")
                : t("deleteForever")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) setPreview(null);
        }}
      >
        <DialogContent
          className="gap-0 p-0 w-[min(40rem,calc(100vw-2rem))] max-w-2xl"
          showClose
          closeLabel={t("close")}
        >
          <div className="space-y-2 border-b border-border/60 p-5 pr-12">
            <DialogHeader className="pr-0">
              <DialogTitle>{t("previewTitle")}</DialogTitle>
              <DialogDescription>{t("previewHint")}</DialogDescription>
            </DialogHeader>
            {preview?.row ? (
              <div className="text-xs text-muted-foreground">
                <div className="truncate font-medium text-foreground">
                  {preview.row.title || preview.row.id}
                </div>
                <div className="mt-0.5 break-all font-mono opacity-80">
                  {preview.row.id}
                </div>
                {preview.data?.messageCount != null ? (
                  <div className="mt-0.5 num">
                    {fmtInt(preview.data.messageCount, locale)}{" "}
                    {t("messages")}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="max-h-[min(60vh,28rem)] space-y-3 overflow-y-auto thin-scroll p-5">
            {preview?.loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("scanning")}
              </div>
            ) : null}
            {preview?.error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-red-200">
                {preview.error}
              </div>
            ) : null}
            {!preview?.loading &&
            !preview?.error &&
            !(preview?.data?.messages || []).length ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {t("previewEmpty")}
              </div>
            ) : null}
            {(preview?.data?.messages || []).map((m, i) => {
              const roleLabel =
                m.role === "user"
                  ? t("roleUser")
                  : m.role === "assistant"
                    ? t("roleAssistant")
                    : m.role === "system"
                      ? t("roleSystem")
                      : m.role;
              return (
                <div
                  key={`${m.role}-${i}`}
                  className={cn(
                    "rounded-lg border border-border/70 px-3 py-2.5",
                    m.role === "user"
                      ? "bg-primary/10"
                      : m.role === "assistant"
                        ? "bg-secondary/50"
                        : "bg-card"
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/90">
                      {roleLabel}
                    </span>
                    {m.time ? (
                      <span className="num">
                        {fmtTime(
                          typeof m.time === "number" ? m.time : Date.parse(m.time),
                          locale
                        )}
                      </span>
                    ) : null}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
                    {m.text}
                  </pre>
                </div>
              );
            })}
            {preview?.data?.truncated ? (
              <div className="text-center text-xs text-muted-foreground">
                {t("previewTruncated")}
              </div>
            ) : null}
          </div>
          <DialogFooter className="bg-secondary/20 px-5 py-3">
            <Button variant="secondary" onClick={() => setPreviewOpen(false)}>
              {t("cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyUpdate, fetchUpdateStatus, openExternal } from "@/lib/backend";
import { fill } from "@/i18n";

const PHASE_LABEL_KEY = {
  running: "updating",
  fetching: "updatePhaseFetching",
  installing: "updatePhaseInstalling",
  building: "updatePhaseBuilding",
  restarting: "updatePhaseRestarting",
  done: "updateDone",
  error: "updateFailed",
};

const ACTIVE_PHASES = new Set(["running", "fetching", "installing", "building", "restarting"]);

/**
 * 一键更新对话框:检测到新版本后,以脱离进程方式执行
 * (预检 → 停服务 → 拉取/安装 → 构建 → 重启),此处轮询进度直至完成。
 */
export function UpdateDialog({ open, onOpenChange, targetVersion, currentVersion, mode, t, locale }) {
  const [phase, setPhase] = useState(null); // null = 未开始
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [finished, setFinished] = useState(false);
  const timerRef = useRef(null);
  const aliveRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback(() => {
    clearTimer();
    if (!aliveRef.current) return;
    timerRef.current = setTimeout(async () => {
      if (!aliveRef.current) return;
      try {
        const res = await fetchUpdateStatus();
        if (!aliveRef.current) return;
        const st = res.status;
        if (st && st.phase === "done") {
          setPhase("done");
          setProgress(100);
          setFinished(true);
          return;
        }
        if (st && st.phase === "error") {
          setPhase("error");
          setError(st.error || t("updateFailed"));
          return;
        }
        setPhase(st && ACTIVE_PHASES.has(st.phase) ? st.phase : "running");
        setProgress(st?.progress || 0);
      } catch {
        // 服务重启中,请求失败是预期行为
      }
      if (aliveRef.current) schedulePoll();
    }, 3000);
  }, [clearTimer, t]);

  // 弹窗关闭时清理轮询并复位非进行中状态;再次打开时若后台仍在更新则自动续接进度。
  useEffect(() => {
    aliveRef.current = open;
    if (!open) {
      clearTimer();
      setPhase(null);
      setProgress(0);
      setError(null);
      setFinished(false);
      return undefined;
    }
    let cancelled = false;
    fetchUpdateStatus()
      .then((res) => {
        if (cancelled || !aliveRef.current) return;
        const st = res.status;
        if (st && ACTIVE_PHASES.has(st.phase)) {
          setPhase(st.phase);
          setProgress(st.progress || 0);
          schedulePoll();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      aliveRef.current = false;
      clearTimer();
    };
  }, [open, clearTimer, schedulePoll]);

  const start = async () => {
    setError(null);
    setFinished(false);
    setProgress(0);
    try {
      const res = await applyUpdate();
      if (!res.started) {
        if (String(res.error || "").includes("正在进行")) {
          setPhase("running");
          schedulePoll();
          return;
        }
        setError(res.error || t("updateFailed"));
        return;
      }
      setPhase("running");
      setProgress(1);
      schedulePoll();
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const phaseText = (p) => {
    if (p === "running") return t("updating");
    const key = PHASE_LABEL_KEY[p];
    return `${key ? t(key) : p}…`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !finished && onOpenChange(v)}>
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {fill(t("updateDialogTitle"), { v: targetVersion || currentVersion || "" })}
          </DialogTitle>
          <DialogDescription>{mode === "npm" ? t("updateModeNpm") : t("updateModeSource")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-warning">
          {t("updateOfflineWarn")}
        </div>

        {error ? (
          <div className="space-y-2">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {t("updateFailed")} {error}
            </div>
            <div className="text-center">
              <Button variant="secondary" size="sm" onClick={start}>
                {t("retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {phase ? (
          <div className="text-sm">
            {finished ? (
              <div className="flex items-center justify-between gap-2">
                <span className="text-success">{t("updateDone")}</span>
                <Button size="sm" onClick={() => window.location.reload()}>
                  {t("refresh")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
                  <span className="text-muted-foreground">{phaseText(phase)}</span>
                  <span className="ml-auto num text-xs text-muted-foreground">{progress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{ width: `${Math.max(3, progress)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => openExternal("https://github.com/DoraJasmine/DoraMonitor/releases")}>
                {t("releaseNotes")}
              </Button>
              <Button size="sm" onClick={start}>
                {t("applyUpdate")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import React, { useEffect, useRef, useState } from "react";
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

const PHASE_LABEL = {
  running: "准备中",
  fetching: "拉取最新代码",
  installing: "安装依赖",
  building: "构建前端",
  restarting: "重启服务",
  done: "完成",
  error: "失败",
};

/**
 * 一键更新对话框:检测到新版本后,以脱离进程方式执行
 * (停服务 → 拉取 → 构建 → 重启),此处轮询进度直至完成。
 */
export function UpdateDialog({ open, onOpenChange, targetVersion, currentVersion, mode, t, locale }) {
  const [phase, setPhase] = useState(null); // null = 未开始
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [finished, setFinished] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const start = async () => {
    setError(null);
    try {
      const res = await applyUpdate();
      if (!res.started) {
        setError(res.error || t("updateFailed"));
        return;
      }
      setPhase("running");
      poll();
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const poll = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetchUpdateStatus();
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
        setPhase(st ? st.phase : "running");
        setProgress(st?.progress || 0);
      } catch {
        // 服务重启中,请求失败是预期行为
      }
      poll();
    }, 3000);
  };

  const phaseText = (p) => (p === "running" ? t("updating") : `${PHASE_LABEL[p] || p}…`);

  return (
    <Dialog open={open} onOpenChange={(v) => !finished && onOpenChange(v)}>
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{fill(t("updateDialogTitle"), { v: targetVersion })}</DialogTitle>
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

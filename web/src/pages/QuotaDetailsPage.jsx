import React from "react";
import { QuotaToolCards } from "@/components/QuotaCard";

export default function QuotaDetailsPage({ t, locale }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t("quotaDetailsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("quotaDetailsSubtitle")}</p>
      </div>
      <QuotaToolCards t={t} locale={locale} detail />
      <QuotaToolCards t={t} locale={locale} tool="codex" detail />
    </div>
  );
}

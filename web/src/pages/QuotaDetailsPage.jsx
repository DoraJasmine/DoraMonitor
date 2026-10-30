import React from "react";
import { QuotaCard } from "@/components/QuotaCard";

export default function QuotaDetailsPage({ t, locale }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{t("quotaDetailsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("quotaDetailsSubtitle")}</p>
      </div>
      <QuotaCard t={t} locale={locale} detail />
      <QuotaCard t={t} locale={locale} tool="codex" detail />
      <QuotaCard t={t} locale={locale} tool="zcode" detail />
    </div>
  );
}

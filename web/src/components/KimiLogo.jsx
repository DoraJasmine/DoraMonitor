import React from "react";

/** Kimi logo from local desktop icon asset. */
export default function KimiLogo({ size = 44, className }) {
  return (
    <span className={className} style={{ display: "inline-flex", lineHeight: 0 }}>
      <img
        src="/kimi-logo.png"
        alt="Kimi"
        width={size}
        height={size}
        style={{ objectFit: "contain", borderRadius: Math.max(6, Math.round(size * 0.18)) }}
        draggable={false}
      />
    </span>
  );
}

import React from "react";

/** App icon — renders the same glyph as /favicon.svg (single source). */
export default function AppLogo({ size = 40, className }) {
  return (
    <img
      src="/favicon.svg"
      alt="AI Usage Monitor"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: "contain" }}
      draggable={false}
    />
  );
}

/** Shared display-name helper (moved out of App.jsx for reuse in dialogs). */

/**
 * Label shown as the model's primary name: a resolved display name wins
 * (dsh records another vendor's routing code such as "dfmodel"); the raw id
 * stays visible underneath for traceability.
 */
export function modelLabel(row) {
  return row?.modelDisplay || row?.model || "unknown";
}

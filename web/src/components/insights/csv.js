/** Minimal CSV export (client-side, user-triggered). Values are raw numbers;
 *  UTF-8 BOM keeps Excel happy with CJK headers. */

export function downloadCsv(filename, rows, cols) {
  const esc = (v) => {
    let s = v == null ? "" : String(v);
    // 公式注入防护:电子表格会把 =/+/-/@ 开头的单元格当公式执行
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    cols.map((c) => esc(c.label)).join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(",")),
  ];
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

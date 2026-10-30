/** Escapes one CSV cell, neutralizing spreadsheet formula injection (cells starting with = + - @ tab CR). */
export function escapeCsvCell(value: unknown): string {
  let s = cellText(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(escapeCsvCell).join(",")).join("\r\n");
}

function cellText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return value.toString();
    case "object":
      return value === null ? "" : JSON.stringify(value);
    default:
      return "";
  }
}

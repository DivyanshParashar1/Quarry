export interface Column<T> {
  header: string;
  value: (row: T) => string;
  max?: number;
}

/** Plain fixed-width table for terminal output. */
export function table<T>(rows: T[], columns: Column<T>[]): string {
  const cells = rows.map((r) => columns.map((c) => truncate(c.value(r), c.max ?? 60)));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.header)), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '';
}

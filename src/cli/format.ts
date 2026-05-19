/** Format milliseconds as `hh:mm:ss`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3_600))}:${pad(Math.floor((total % 3_600) / 60))}:${pad(total % 60)}`;
}

/** Truncate or pad `text` to exactly `width` characters. */
export function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}~`;
}

/** Column of a {@link renderTable} table. */
export interface Column<Row> {
  readonly header: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
  readonly value: (row: Row) => string;
}

/**
 * Render rows as a fixed-width text table. When more rows exist than `maxRows`, the remainder is
 * summarised in a final line.
 */
export function renderTable<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  maxRows = Infinity,
): string {
  const cell = (column: Column<Row>, text: string): string =>
    column.align === 'right'
      ? fit(text, column.width).trimEnd().padStart(column.width)
      : fit(text, column.width);
  const lines = [
    columns
      .map((column) => cell(column, column.header))
      .join('  ')
      .trimEnd(),
  ];
  lines.push(columns.map((column) => '-'.repeat(column.width)).join('  '));
  const visible = rows.slice(0, maxRows);
  for (const row of visible) {
    lines.push(
      columns
        .map((column) => cell(column, column.value(row)))
        .join('  ')
        .trimEnd(),
    );
  }
  if (rows.length > visible.length) lines.push(`... ${rows.length - visible.length} more`);
  return lines.join('\n');
}

/** Compact number formatting with a fixed number of decimals. */
export function formatNumber(value: number, decimals = 1): string {
  return value.toFixed(decimals);
}

/**
 * Resolve when the process receives SIGINT/SIGTERM or `signal` aborts, removing the listeners
 * afterwards so repeated invocations (e.g. in tests) do not leak them.
 */
export function untilInterrupted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    if (signal?.aborted) {
      resolve();
      return;
    }
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

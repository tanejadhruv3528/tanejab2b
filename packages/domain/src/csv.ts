/**
 * Minimal RFC 4180 CSV parser: comma separated, double-quoted fields, "" escapes, CRLF or LF rows.
 * Returns rows of raw string cells. Throws on an unterminated quote.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip Excel's BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        cell += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error('CSV has an unterminated quoted field');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop fully blank lines.
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parses CSV with a header row into objects keyed by normalised header (lowercase, spaces to underscores). */
export function parseCsvRecords(text: string): { headers: string[]; records: Record<string, string>[] } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { headers: [], records: [] };
  const headers = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const records = body.map((cells) => Object.fromEntries(headers.map((h, idx) => [h, (cells[idx] ?? '').trim()])));
  return { headers, records };
}

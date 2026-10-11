import ExcelJS from 'exceljs';
import { parseCsvRows } from '../csv.js';

// Read a spreadsheet into plain string grids, one per sheet. Merged cells
// carry the master cell's text into every cell of the range (so a merged
// group header labels each column under it); hyperlinks keep their target
// when the visible text isn't itself a URL/email ("LinkedIn" → the profile URL).

export interface SheetGrid {
  name: string;
  /** rows[i] is the sheet's row i + 1; blank rows are kept so reported row numbers match the file. */
  rows: string[][];
  /** "A1:B1"-style merged ranges, for the EDA report. */
  merged: string[];
}

export class UnsupportedFileError extends Error {}

export async function readSpreadsheet(data: Uint8Array | Buffer, filename: string): Promise<SheetGrid[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xls')) {
    throw new UnsupportedFileError('.xls (Excel 97-2003) is not supported: open it in Excel/Numbers/Sheets and Save As .xlsx (or export CSV)');
  }
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const text = Buffer.from(data).toString('utf8');
    const rows = lower.endsWith('.tsv') ? text.split(/\r?\n/).map((l) => l.split('\t')) : parseCsvRows(text);
    while (rows.length && rows.at(-1)!.every((c) => !c.trim())) rows.pop();
    return [{ name: filename.replace(/^.*[\\/]/, ''), rows: rows.map((r) => r.map(clean)), merged: [] }];
  }
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) throw new UnsupportedFileError(`unsupported file type: ${filename} (use .xlsx or .csv)`);

  const wb = new ExcelJS.Workbook();
  // exceljs' types predate Node's generic Buffer; the runtime accepts any Buffer.
  await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
  const out: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const merged: string[] = ((ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? []).slice();
    const rows: string[][] = [];
    const width = ws.actualColumnCount || ws.columnCount;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c)));
      while (rows.length < rowNumber - 1) rows.push([]);
      rows.push(cells);
    });
    out.push({ name: ws.name, rows, merged });
  });
  return out;
}

function cellText(cell: ExcelJS.Cell): string {
  const target = cell.isMerged && cell.master !== cell ? cell.master : cell;
  const v = target.value as unknown;
  let text = '';
  try {
    text = target.text ?? '';
  } catch {
    text = '';
  }
  if (v && typeof v === 'object' && 'hyperlink' in (v as Record<string, unknown>)) {
    const link = String((v as { hyperlink?: unknown }).hyperlink ?? '');
    if (/^mailto:/i.test(link) && !/@/.test(text)) text = link.replace(/^mailto:/i, '');
    else if (/^https?:\/\//i.test(link) && !/^https?:\/\//i.test(text)) text = link;
  } else if (v instanceof Date) {
    text = v.toISOString().slice(0, 10);
  }
  return clean(text);
}

function clean(s: string): string {
  return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

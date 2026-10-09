// pdf-parse is CommonJS and ships a top-level test harness that reads a local file
// when imported bare; we go via the module entry to avoid that. Types live at the
// package root, so we take the type from there and the implementation from the
// inner entry point.
import type _pdfParse from 'pdf-parse';
// @ts-expect-error pdf-parse ships no types for the inner entry; we borrow the root's.
import pdfParseImpl from 'pdf-parse/lib/pdf-parse.js';

const pdfParse = pdfParseImpl as typeof _pdfParse;

export interface PdfText {
  text: string;
  pages: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width?: number;
}
interface PageData {
  getTextContent(opts: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<{ items: TextItem[] }>;
}

/**
 * Like pdf-parse's default renderer, but puts a space between items on the
 * same line when there is a horizontal gap (an \hfill'd date, a table cell),
 * the way position-aware ATS parsers do. The default glues them together
 * ("Computer ScienceAug 2019").
 */
async function renderPage(page: PageData): Promise<string> {
  const { items } = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let text = '';
  let lastY: number | undefined;
  let lastEnd: number | undefined;
  for (const item of items) {
    const x = item.transform[4]!;
    const y = item.transform[5]!;
    if (lastY === undefined) {
      // first item
    } else if (Math.abs(y - lastY) > 2) {
      text += '\n';
    } else if (lastEnd !== undefined && x - lastEnd > 1 && !/\s$/.test(text) && !/^\s/.test(item.str)) {
      text += ' ';
    }
    text += item.str;
    lastY = y;
    lastEnd = x + (item.width ?? 0);
  }
  return text;
}

/** Text as an ATS parser would see it (pdf.js extraction, no OCR). */
export async function extractPdfText(pdf: Uint8Array | Buffer): Promise<PdfText> {
  const r = await pdfParse(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf), { pagerender: renderPage as never });
  return { text: dehyphenate(r.text), pages: r.numpages };
}

/** Re-join words LaTeX hyphenated across a line break ("Kuber-\nnetes" → "Kubernetes"), as ATS parsers do. */
export function dehyphenate(text: string): string {
  return text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');
}

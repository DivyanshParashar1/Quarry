Contact-import fixtures (synthetic people; shapes copied from real files).

- `Connections.csv` — the exact layout of LinkedIn's "Get a copy of your data → Connections" export:
  a "Notes:" preamble, a blank line, then `First Name,Last Name,URL,Email Address,Company,Position,Connected On`.
  Includes a row with no company and a duplicate row.
- The messy `.xlsx` is built in `contact-import.test.ts` with exceljs (title row, merged group headers,
  hyperlink-only LinkedIn cells, "LAST, FIRST" names, bad emails, duplicates, blank rows, an unknown column).

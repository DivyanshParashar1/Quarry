Real pdflatex output (TeX Live 2026), regenerated with `pdflatex <name>.tex`.

- `clean-cm.pdf` — Computer Modern Type 1 fonts; pdf.js maps ligatures back to "fi"/"ffi".
- `broken-ligatures.pdf` — `\usepackage[T1]{fontenc}` without cm-super, so the EC fonts are
  bitmap (Type 3): ligatures extract as control characters and inter-word spaces vanish.
  This is what an ATS sees from such a PDF.

// Parse checks on the text an ATS would extract from the PDF. ATS-independent;
// the per-ATS profiles weight them differently.

export type ParseCheckId =
  | 'extractable'
  | 'encoding'
  | 'spacing'
  | 'sections'
  | 'contact'
  | 'dates'
  | 'reading_order'
  | 'columns';

export interface ParseCheck {
  id: ParseCheckId;
  /** 0..1 */
  score: number;
  pass: boolean;
  detail: string;
}

export interface ParseReport {
  checks: ParseCheck[];
  /** Recognised section headers, in the order they appear. */
  sections: string[];
}

const SECTION_HEADERS: Record<string, RegExp> = {
  education: /^(education|academic background|academics)$/i,
  experience: /^((work|professional|relevant) )?experience$|^employment( history)?$|^work history$/i,
  projects: /^(personal |academic |selected )?projects$/i,
  skills: /^(technical |core )?skills$|^technical skills (and|&) tools$|^skills (and|&) tools$/i,
  summary: /^(summary|profile|objective|professional summary)$/i,
  certifications: /^certifications?( (and|&) licenses)?$/i,
  achievements: /^(achievements|awards|honou?rs|awards (and|&) achievements)$/i,
  extracurriculars: /^(extracurriculars?|extra-curricular activities|activities|leadership)$/i,
  publications: /^publications$/i,
};
const CORE_SECTIONS = ['education', 'experience', 'skills'] as const;

const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\\.?';
const DATE_TOKEN = `(${MONTH}\\s*\\d{4}|\\d{1,2}/\\d{4}|\\d{4}-\\d{2}|\\d{4})`;
const DATE_RANGE = new RegExp(`${DATE_TOKEN}\\s*(-|–|—|to)\\s*(${DATE_TOKEN}|present|current|now|ongoing)`, 'gi');
const SINGLE_DATE = new RegExp(`(${MONTH}\\s*\\d{4}|\\d{1,2}/\\d{4})`, 'gi');

export function analyzeResumeText(text: string): ParseReport {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const checks: ParseCheck[] = [];

  // extractable: a scanned/image PDF yields almost nothing.
  checks.push(check('extractable', letters >= 300 ? 1 : letters / 300, `${letters} letters of text extracted`));

  // encoding: ligature/cid breakage shows up as control chars, U+FFFD, ligature codepoints or (cid:N).
  const bad =
    // eslint-disable-next-line no-control-regex -- control characters are exactly what we look for
    (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd\ufb00-\ufb06]/g) ?? []).length +
    (text.match(/\(cid:\d+\)/g) ?? []).length;
  const badPer1k = letters ? (bad / letters) * 1000 : 0;
  checks.push(
    check(
      'encoding',
      bad === 0 ? 1 : Math.max(0, 1 - badPer1k / 10),
      bad === 0 ? 'no broken glyphs' : `${bad} broken glyph(s) (ligatures or unmapped characters) — "fi"/"fl" words won't match keywords`,
    ),
  );

  // spacing: words run together when the PDF has no real spaces.
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  const runOn = words.filter((w) => w.replace(/[^A-Za-z]/g, '').length > 22 && !/^(https?:\/\/|www\.)\S+$|^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(w)).length;
  const runOnRate = words.length ? runOn / words.length : 0;
  checks.push(
    check(
      'spacing',
      runOnRate <= 0.01 ? 1 : Math.max(0, 1 - runOnRate * 10),
      runOn ? `${runOn} run-together word(s) — spaces are missing in the extracted text` : 'word spacing intact',
    ),
  );

  // sections: standard headers on their own line.
  const sections: string[] = [];
  const counts = new Map<string, number>();
  for (const l of lines) {
    const plain = l.replace(/[:|]+$/, '').trim();
    if (plain.length > 45) continue;
    for (const [name, re] of Object.entries(SECTION_HEADERS)) {
      if (re.test(plain)) {
        sections.push(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  const coreFound = CORE_SECTIONS.filter((s) => counts.has(s));
  const coreMissing = CORE_SECTIONS.filter((s) => !counts.has(s));
  checks.push(
    check(
      'sections',
      coreFound.length / CORE_SECTIONS.length,
      coreMissing.length ? `standard header(s) not found: ${coreMissing.join(', ')}` : `found ${[...new Set(sections)].join(', ')}`,
    ),
  );

  // contact: email + phone are what every ATS autofills first.
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
  const phone = /(\+?\d[\d\s().-]{8,}\d)/.test(text);
  const linkedin = /linkedin\.com\/in\/|\blinkedin\b/i.test(text);
  const contactMissing = [!email && 'email', !phone && 'phone'].filter(Boolean) as string[];
  checks.push(
    check(
      'contact',
      (Number(email) + Number(phone)) / 2,
      contactMissing.length ? `not parsed: ${contactMissing.join(', ')}` : `email, phone${linkedin ? ', LinkedIn' : ''} parsed`,
    ),
  );

  // dates: years that sit inside a recognisable month-year / range pattern.
  const ranges = text.match(DATE_RANGE) ?? [];
  const yearMentions = (text.match(/\b(19|20)\d{2}\b/g) ?? []).length;
  const coveredYears = [...ranges, ...(text.replace(DATE_RANGE, ' ').match(SINGLE_DATE) ?? [])].reduce(
    (n, s) => n + (s.match(/\b(19|20)\d{2}\b/g) ?? []).length,
    0,
  );
  const dateScore = yearMentions === 0 ? 0 : Math.min(1, coveredYears / yearMentions);
  checks.push(
    check(
      'dates',
      ranges.length === 0 ? Math.min(dateScore, 0.5) : dateScore,
      ranges.length === 0
        ? 'no date ranges recognised (e.g. "Jun 2024 – Aug 2024")'
        : `${ranges.length} date range(s); ${coveredYears}/${yearMentions} years in a parseable format`,
    ),
  );

  // reading order: contact near the top, each section header once, core sections not interleaved.
  const emailAt = text.search(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const contactTop = emailAt >= 0 && emailAt <= Math.max(400, text.length * 0.15);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([s]) => s);
  const orderIssues = [!contactTop && 'contact details are not at the top', dupes.length && `repeated header(s): ${dupes.join(', ')}`].filter(
    Boolean,
  ) as string[];
  checks.push(check('reading_order', 1 - orderIssues.length * 0.5, orderIssues.length ? orderIssues.join('; ') : 'top-to-bottom order looks sane'));

  // columns: table cells concatenated without a space ("InternJun 2024", "IndiaMay 2023").
  const merged =
    (text.match(/[a-z)](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{4}/g) ?? []).length +
    (text.match(/[a-z]\d{4}\s*(-|–)/g) ?? []).length;
  checks.push(
    check(
      'columns',
      merged === 0 ? 1 : Math.max(0, 1 - merged * 0.25),
      merged ? `${merged} place(s) where side-by-side columns ran together (title + date)` : 'no column run-ins',
    ),
  );

  return { checks, sections };
}

function check(id: ParseCheckId, score: number, detail: string): ParseCheck {
  const s = Math.max(0, Math.min(1, score));
  return { id, score: Math.round(s * 100) / 100, pass: s >= 0.8, detail };
}

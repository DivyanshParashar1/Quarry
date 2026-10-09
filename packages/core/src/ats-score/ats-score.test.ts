import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeResumeText,
  atsProfileFor,
  dehyphenate,
  buildDictionary,
  buildIdf,
  extractJdKeywords,
  extractPdfText,
  findTerms,
  scoreAllAts,
  scoreResume,
  sectionLines,
  topPhrases,
} from './index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Shaped like pdf-parse output of a one-page Jake's-template resume.
const RESUME = `Divyansh Parashar
+91 7976398973 divyanshdp1212@gmail.com linkedin.com/in/divyansh1212 github.com/DivyanshParashar1
Education
Rajiv Gandhi Institute of Petroleum Technology Nov 2022 – May 2026
B.Tech in Computer Science and Design Amethi, India
Experience
Founding Engineer Intern Jun 2025 – Aug 2025
Screenify Remote
Built a multi-agent screening backend on Google Cloud Run with Docker, JWT auth and RBAC.
Software Engineer Intern Jan 2025 – Apr 2025
Orangecat Remote
Shipped REST APIs in TypeScript and Node.js with PostgreSQL; streamed LLM output to a React UI.
Projects
FlashSeat | TypeScript, Fastify, PostgreSQL, Redis, Docker, k6
Built a ticketing backend handling 5,000 concurrent bookings with row-level locking.
CRDT Collaborative Editor | TypeScript, Node.js, WebSockets
Implemented a CRDT engine with Lamport clocks and a WebSocket sync layer.
Technical Skills
Languages: JavaScript, TypeScript, Python, Java, SQL
Frameworks: React, Vue 3, Node.js, Express.js, Fastify, FastAPI
Databases & Cloud: PostgreSQL, Redis, MongoDB, Google Cloud (Cloud Run), AWS
Developer Tools: Git, Docker, k6, REST APIs
`;

const JD = `## About the role
We are a fast-growing fintech. Our team builds payment APIs.

## Requirements
- 1+ years with TypeScript or Python
- Hands-on Kubernetes experience
- PostgreSQL and Redis

## Nice to have
- Rust
- Experience with Kafka

## Benefits
- Free Docker stickers
`;

describe('keyword extraction', () => {
  const dict = buildDictionary(['Fastify', 'k6']);

  it('tiers keywords by JD section and ignores benefits/about', () => {
    const { keywords } = extractJdKeywords(JD, { dictionary: dict });
    const tier = Object.fromEntries(keywords.map((k) => [k.term, k.tier]));
    expect(tier).toMatchObject({ TypeScript: 'hard', Python: 'hard', Kubernetes: 'hard', PostgreSQL: 'hard', Redis: 'hard', Rust: 'soft', Kafka: 'soft' });
    expect(tier.Docker).toBeUndefined();
  });

  it('treats inline "required" / "is a plus" as hard / soft', () => {
    const lines = sectionLines('Go is required.\nGraphQL is a plus.');
    expect(lines.map((l) => l.section)).toEqual(['hard', 'soft']);
  });

  it('matches tech tokens on the right boundaries', () => {
    expect(findTerms('We use C++ and Node.js', dict)).toEqual(new Set(['C++', 'Node.js']));
    expect(findTerms('Series C funding; go to market; express interest', dict).size).toBe(0);
    expect(findTerms('Write Go services on Express', dict)).toEqual(new Set(['Go', 'Express']));
    expect(findTerms('Languages: C, C++, R', dict)).toEqual(new Set(['C', 'C++', 'R']));
    expect(findTerms('C/C++ and (R)', dict)).toEqual(new Set(['C', 'C++', 'R']));
    expect(findTerms('Postgres, k8s, scikit learn', dict)).toEqual(new Set(['PostgreSQL', 'Kubernetes', 'Scikit-learn']));
  });

  it('adds TF-IDF phrases that are rare in the corpus', () => {
    const corpus = [
      'payment reconciliation ledger systems for banks',
      'ledger systems and payment reconciliation at scale',
      'frontend design systems',
      'we hire engineers',
      'we hire designers',
      'great team culture',
    ];
    const idf = buildIdf(corpus);
    expect(topPhrases('Own payment reconciliation and the ledger.', idf, 3)).toContain('payment reconciliation');
    const { keywords } = extractJdKeywords('## Requirements\nOwn payment reconciliation in TypeScript.', { dictionary: dict, idf });
    expect(keywords).toContainEqual({ term: 'payment reconciliation', tier: 'phrase' });
  });
});

describe('scoreResume', () => {
  const dict = buildDictionary(['Fastify', 'k6']);
  const jd = extractJdKeywords(JD, { dictionary: dict });

  it('flags a missing hard requirement', () => {
    const s = scoreResume({ resumeText: RESUME, parse: analyzeResumeText(RESUME), jd, dictionary: dict, atsType: 'greenhouse' });
    expect(s.keywords.hardMissing).toEqual(['Kubernetes']);
    expect(s.keywords.missing).toEqual(expect.arrayContaining(['Kubernetes', 'Rust', 'Kafka']));
    expect(s.notes).toContain('Missing hard requirement: Kubernetes');
    expect(s.parse.checks.every((c) => c.pass)).toBe(true);
    expect(s.score).toBeGreaterThan(60);
  });

  it('weights layout problems far more for Workday/Taleo than Greenhouse', () => {
    const messy = RESUME.replace('Experience\n', "Where I've worked\n")
      .replace('Education\n', 'Schooling\n')
      .replace('Founding Engineer Intern Jun 2025', 'Founding Engineer InternJun 2025')
      .replace(/Nov 2022 – May 2026/, 'since 2022');
    const all = scoreAllAts({ resumeText: messy, parse: analyzeResumeText(messy), jd, dictionary: dict });
    const clean = scoreAllAts({ resumeText: RESUME, parse: analyzeResumeText(RESUME), jd, dictionary: dict });
    const drop = (t: keyof typeof all) => clean[t].score - all[t].score;
    expect(drop('workday')).toBeGreaterThan(drop('greenhouse'));
    expect(drop('taleo')).toBeGreaterThan(drop('lever'));
    expect(all.workday.notes.join('\n')).toMatch(/standard header\(s\) not found: education, experience/);
    expect(all.workday.notes.join('\n')).toMatch(/columns ran together/);
  });

  it('caps an unreadable PDF', () => {
    const s = scoreResume({ resumeText: '  ', parse: analyzeResumeText('  '), jd, dictionary: dict, atsType: 'generic' });
    expect(s.score).toBeLessThanOrEqual(10);
  });

  it('re-joins words hyphenated across a line break', () => {
    expect(dehyphenate('Redis, Kuber-\nnetes and end-to-end\nCI/CD')).toBe('Redis, Kubernetes and end-to-end\nCI/CD');
  });

  it('maps company_sources.ats to a profile', () => {
    expect(atsProfileFor('workday')).toBe('workday');
    expect(atsProfileFor('careers_page')).toBe('generic');
    expect(atsProfileFor(null)).toBe('generic');
  });
});

describe('PDF fixtures (pdflatex output)', () => {
  // clean-cm.pdf: Computer Modern Type 1 fonts → ligatures map back to "fi"/"ffi".
  // broken-ligatures.pdf: T1 bitmap (Type 3) fonts → ligatures become control chars, spaces vanish.
  it('reads the clean PDF intact', async () => {
    const { text, pages } = await extractPdfText(await readFile(join(FIXTURES, 'clean-cm.pdf')));
    expect(pages).toBe(1);
    expect(text).toContain("jane.doe@example.com");
    expect(text).toContain('efficient workflow for financial filings');
    const parse = analyzeResumeText(text);
    expect(parse.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
  });

  it('flags the broken-ligature PDF', async () => {
    const { text } = await extractPdfText(await readFile(join(FIXTURES, 'broken-ligatures.pdf')));
    const parse = analyzeResumeText(text);
    const encoding = parse.checks.find((c) => c.id === 'encoding')!;
    expect(encoding.pass).toBe(false);
    expect(encoding.detail).toMatch(/broken glyph/);
    // Bad kerning splits "Exp erience", so the header is lost too.
    expect(parse.checks.find((c) => c.id === 'sections')!.detail).toMatch(/not found: experience/);

    const dict = buildDictionary();
    const jd = extractJdKeywords('## Requirements\n- TypeScript and Python\n- PostgreSQL', { dictionary: dict });
    const clean = await extractPdfText(await readFile(join(FIXTURES, 'clean-cm.pdf')));
    const brokenScore = scoreResume({ resumeText: text, parse, jd, dictionary: dict, atsType: 'taleo' });
    const cleanScore = scoreResume({ resumeText: clean.text, parse: analyzeResumeText(clean.text), jd, dictionary: dict, atsType: 'taleo' });
    expect(cleanScore.keywords.hardMissing).toEqual([]);
    expect(brokenScore.keywords.hardMissing).toEqual(['TypeScript']);
    expect(brokenScore.score).toBeLessThan(cleanScore.score - 20);
    expect(brokenScore.notes.join('\n')).toMatch(/Taleo is the strictest parser/);
  });
});

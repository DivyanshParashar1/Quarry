import type { ParseCheckId } from './parse-checks.js';

// Per-ATS weighting. There is no public ground truth for these parsers; the
// weights encode the widely reported behaviour:
//   - Greenhouse / Lever / Ashby store the PDF and let recruiters keyword-search
//     it, so keyword coverage dominates and layout barely matters.
//   - Workday / SuccessFactors / Taleo parse the resume to pre-fill structured
//     forms (work history, education, dates), so standard section names, parseable
//     dates and single-column layout matter much more.
//   - SmartRecruiters parses for profile fields (contact first) but recruiters
//     still search by keyword.

export const ATS_PROFILES = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'successfactors', 'taleo', 'generic'] as const;
export type AtsProfileType = (typeof ATS_PROFILES)[number];

export interface AtsProfile {
  type: AtsProfileType;
  /** Share of the score from parse checks; the rest is keyword coverage. */
  parseWeight: number;
  checkWeights: Record<ParseCheckId, number>;
  /** Shown when the matching check fails. */
  notes: Partial<Record<ParseCheckId, string>>;
}

const BASE: Record<ParseCheckId, number> = {
  extractable: 3,
  encoding: 2,
  spacing: 2,
  sections: 1,
  contact: 1,
  dates: 1,
  reading_order: 1,
  columns: 1,
};

const PARSE_AND_FILL_NOTES: Partial<Record<ParseCheckId, string>> = {
  sections: 'parse-and-fill ATS: non-standard section names leave work history/education empty in the form',
  dates: 'parse-and-fill ATS: unparseable dates become manual fixes in the work-history step',
  columns: 'parse-and-fill ATS: columns/tables scramble job titles and dates',
  contact: 'contact fields are auto-filled from the resume',
};

export const PROFILES: Record<AtsProfileType, AtsProfile> = {
  greenhouse: { type: 'greenhouse', parseWeight: 0.3, checkWeights: { ...BASE, sections: 0.5, dates: 0.5, columns: 0.5 }, notes: {} },
  lever: { type: 'lever', parseWeight: 0.3, checkWeights: { ...BASE, sections: 0.5, dates: 0.5, columns: 0.5 }, notes: {} },
  ashby: { type: 'ashby', parseWeight: 0.3, checkWeights: { ...BASE, sections: 0.5, dates: 0.5, columns: 0.5 }, notes: {} },
  smartrecruiters: {
    type: 'smartrecruiters',
    parseWeight: 0.4,
    checkWeights: { ...BASE, contact: 2, sections: 1.5 },
    notes: { contact: 'SmartRecruiters builds the candidate profile from parsed contact fields' },
  },
  workday: {
    type: 'workday',
    parseWeight: 0.5,
    checkWeights: { ...BASE, sections: 3, dates: 3, columns: 2.5, contact: 2 },
    notes: PARSE_AND_FILL_NOTES,
  },
  successfactors: {
    type: 'successfactors',
    parseWeight: 0.5,
    checkWeights: { ...BASE, sections: 2.5, dates: 2.5, columns: 2, contact: 2 },
    notes: PARSE_AND_FILL_NOTES,
  },
  taleo: {
    type: 'taleo',
    parseWeight: 0.55,
    checkWeights: { ...BASE, encoding: 3, sections: 3, dates: 3, columns: 3, contact: 2 },
    notes: { ...PARSE_AND_FILL_NOTES, encoding: 'Taleo is the strictest parser: broken glyphs drop whole words' },
  },
  generic: { type: 'generic', parseWeight: 0.4, checkWeights: BASE, notes: {} },
};

/** company_sources.ats → profile (careers_page / other / unknown → generic). */
export function atsProfileFor(ats: string | null | undefined): AtsProfileType {
  return (ATS_PROFILES as readonly string[]).includes(ats ?? '') ? (ats as AtsProfileType) : 'generic';
}

/** Every ATS a company board can be on. Mirrors the db's ats_type enum (a db test keeps them equal). */
export const ATS_TYPES = [
  'greenhouse',
  'lever',
  'ashby',
  'careers_page',
  'other',
  // Phase 6/7: GCC-heavy ATSs.
  'workday',
  'smartrecruiters',
  'successfactors',
  'taleo',
] as const;
export type AtsType = (typeof ATS_TYPES)[number];

/** Which source plugin serves each ATS type. */
export const SOURCE_PLUGIN_FOR_ATS: Partial<Record<AtsType, string>> = {
  greenhouse: 'source-greenhouse',
  lever: 'source-lever',
  ashby: 'source-ashby',
  workday: 'source-workday',
  smartrecruiters: 'source-smartrecruiters',
  successfactors: 'source-successfactors',
  taleo: 'source-taleo',
};

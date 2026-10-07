import type { AlertParser } from '../cards.js';

/** Wellfound (AngelList Talent) weekly digest. Cards: "Title" link, then "Company · Location · Salary". */
export const wellfound: AlertParser = {
  id: 'wellfound',
  label: 'Wellfound Weekly',
  senders: ['wellfound.com', 'angel.co'],
  jobUrl: /(?:wellfound\.com|angel\.co)\/(?:company\/[^/]+\/)?jobs\/(\d{4,})/i,
  canonicalUrl: (id) => `https://wellfound.com/jobs/${id}`,
  alertMarker: /jobs?|startups?|roles?/i,
};

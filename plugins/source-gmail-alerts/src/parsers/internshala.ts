import type { AlertParser } from '../cards.js';

/** Internshala internship/job alerts. Cards: title link, company, location, stipend. */
export const internshala: AlertParser = {
  id: 'internshala',
  label: 'Internshala',
  senders: ['internshala.com'],
  // https://internshala.com/internship/detail/software-development-internship-in-bangalore-at-acme1728371234
  jobUrl: /internshala\.com\/(?:internship|job)\/details?\/[a-z0-9-]*?(\d{6,})(?:[?#/]|$)/i,
  canonicalUrl: (_id, href) => href.split(/[?#]/)[0]!,
  alertMarker: /internships?|jobs?/i,
};

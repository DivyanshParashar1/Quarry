import { defaultMeta, isNoise, type AlertParser } from '../cards.js';

/** Naukri job alerts. Cards: title link, company, then experience / salary / location lines. */
export const naukri: AlertParser = {
  id: 'naukri',
  label: 'Naukri Job Alerts',
  senders: ['naukri.com'],
  // e.g. https://www.naukri.com/job-listings-software-engineer-acme-bengaluru-0-to-2-years-071025012345
  jobUrl: /naukri\.com\/job-listings-[^?#]*?-(\d{9,})(?:[?#/]|$)/i,
  canonicalUrl: (_id, href) => href.split(/[?#]/)[0]!,
  meta(lines) {
    // Naukri puts the location after experience/salary, so pick the first line that looks like places.
    const company = defaultMeta(lines).company;
    const loc = lines.find((l) => l !== company && !isNoise(l) && /^[A-Z][A-Za-z .()/-]+(,\s*[A-Z][A-Za-z .()/-]+)*$/.test(l) && l.length < 80);
    return { company, location: loc ?? null };
  },
  alertMarker: /job alert|jobs? (for you|matching|recommended)|naukri/i,
};

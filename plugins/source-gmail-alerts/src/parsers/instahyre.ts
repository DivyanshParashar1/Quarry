import type { AlertParser } from '../cards.js';

/** Instahyre opportunities email. Cards: title link, "Company", "Location", experience. */
export const instahyre: AlertParser = {
  id: 'instahyre',
  label: 'Instahyre',
  senders: ['instahyre.com'],
  jobUrl: /instahyre\.com\/job-(\d+)/i,
  canonicalUrl: (id, href) => href.split(/[?#]/)[0] ?? `https://www.instahyre.com/job-${id}`,
  alertMarker: /opportunit|jobs?|hiring/i,
};

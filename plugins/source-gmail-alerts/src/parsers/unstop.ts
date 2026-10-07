import type { AlertParser } from '../cards.js';

/** Unstop (formerly Dare2Compete) job/internship alerts. */
export const unstop: AlertParser = {
  id: 'unstop',
  label: 'Unstop',
  senders: ['unstop.com', 'dare2compete.com'],
  // https://unstop.com/jobs/software-engineer-acme-1234567 or /internships/...-1234567
  jobUrl: /unstop\.com\/(?:jobs|internships|o)\/[a-z0-9-]*?-(\d{5,})(?:[?#/]|$)/i,
  canonicalUrl: (_id, href) => href.split(/[?#]/)[0]!,
  alertMarker: /jobs?|internships?|opportunit|hiring/i,
};

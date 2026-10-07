import type { AlertParser } from '../cards.js';

/** LinkedIn Job Alerts ("jobalerts-noreply@linkedin.com"). Cards: title link, then "Company · Location". */
export const linkedin: AlertParser = {
  id: 'linkedin',
  label: 'LinkedIn Job Alerts',
  senders: ['jobalerts-noreply@linkedin.com', 'jobs-listings@linkedin.com', 'jobs-noreply@linkedin.com'],
  jobUrl: /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i,
  canonicalUrl: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
  alertMarker: /jobs? (alert|match|you might)|new jobs?|your job alert/i,
};

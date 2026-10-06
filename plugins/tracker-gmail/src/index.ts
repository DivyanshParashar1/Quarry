import { z } from 'zod';
import { defineTrackerPlugin, type GmailMessageMeta, type GmailTrackEvent } from '@jobforge/plugin-sdk';

export const configSchema = z
  .object({
    /** Max inbox messages inspected per poll. */
    maxMessages: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export type TrackerConfig = z.infer<typeof configSchema>;

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (sub)?system)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|could not be delivered|address not found)/i;
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|ooo\b|away from|on leave)/i;

export type Classification = 'reply' | 'bounce' | 'auto_reply';

/** Decide what an inbound message on a thread means, from headers only. */
export function classify(m: GmailMessageMeta): Classification {
  const h = m.headers;
  const from = h.from ?? '';
  const subject = h.subject ?? '';
  if (h['x-failed-recipients'] || BOUNCE_FROM.test(from) || (BOUNCE_SUBJECT.test(subject) && /daemon|postmaster|google|microsoft/i.test(from))) {
    return 'bounce';
  }
  const auto = (h['auto-submitted'] ?? '').toLowerCase();
  if ((auto && auto !== 'no') || AUTO_SUBJECT.test(subject.trim())) return 'auto_reply';
  return 'reply';
}

/**
 * Read-only: lists inbox messages since the cursor that were not sent by the
 * user, and reports replies and bounces. The core keeps only those on threads
 * it started; out-of-office auto-replies are ignored.
 */
export default defineTrackerPlugin<TrackerConfig>({
  manifest: {
    id: 'tracker-gmail',
    version: '0.1.0',
    stage: 'tracker',
    description: 'Watches your Gmail inbox for replies and bounces on outreach threads (read-only).',
    configSchema,
    permissions: { domains: [], gmail: ['read'] },
    sideEffects: 'none',
  },

  async *poll(ctx, since) {
    const gmail = ctx.gmail!;
    const after = Math.floor(since.getTime() / 1000);
    const refs = await gmail.search!(`in:inbox after:${after} -from:me`, ctx.config.maxMessages);
    for (const ref of refs) {
      const m = await gmail.getMessage!(ref.id);
      const kind = classify(m);
      if (kind === 'auto_reply') continue;
      const event: GmailTrackEvent = {
        kind,
        at: m.internalDate,
        data: {
          gmailThreadId: m.threadId,
          gmailMessageId: m.id,
          from: m.headers.from ?? '',
          subject: m.headers.subject ?? '',
          snippet: m.snippet.slice(0, 200),
        },
      };
      const failed = m.headers['x-failed-recipients'];
      yield { ...event, data: { ...event.data, ...(failed ? { failedRecipients: failed } : {}) } };
    }
  },
});

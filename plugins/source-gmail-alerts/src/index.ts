import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import { defineSourcePlugin, type GmailHandle, type PluginContext, type RawPosting } from '@jobforge/plugin-sdk';
import { parseCards, type AlertParser, type AlertPosting } from './cards.js';
import { tokenize, tokenizeText } from './html.js';
import { PARSERS, PARSER_IDS } from './parsers/index.js';

export { PARSERS, PARSER_IDS } from './parsers/index.js';
export { parseCards, defaultMeta, type AlertParser, type AlertPosting } from './cards.js';
export { tokenize, tokenizeText } from './html.js';

export const configSchema = z
  .object({
    /** Which senders to read (default: all supported). */
    senders: z.array(z.enum(PARSER_IDS)).default([...PARSER_IDS]),
    /** First run (no cursor yet): how far back to read. */
    lookbackDays: z.number().int().min(1).max(90).default(14),
    /** Max messages per sender per run. */
    maxMessagesPerSender: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type GmailAlertsConfig = z.infer<typeof configSchema>;

/** The board token the core uses for this source (it isn't tied to one company). */
export const INBOX_TARGET = 'inbox';

export interface ParsedAlert {
  parser: AlertParser;
  postings: AlertPosting[];
}

/** Parse one message with the given sender's parser. Exported for tests and the CLI. */
export function parseAlertMessage(
  parser: AlertParser,
  msg: { subject: string; html: string | null; text: string | null },
): AlertPosting[] {
  const tokens = msg.html ? tokenize(msg.html) : msg.text ? tokenizeText(msg.text) : [];
  return parseCards(parser, tokens, msg.subject);
}

export function toRawPosting(p: AlertPosting, meta: { parser: string; messageId: string; receivedAt: Date }): RawPosting {
  return {
    externalId: p.externalId,
    url: p.url,
    applyUrl: p.url,
    title: p.title,
    locations: p.location ? [p.location] : [],
    remotePolicy: p.remote,
    department: null,
    // Alerts carry no description; matching works on the title until an ATS source merges in.
    descriptionHtml: null,
    postedAt: null,
    companyName: p.company,
    payload: { alert: meta.parser, gmailMessageId: meta.messageId, receivedAt: meta.receivedAt.toISOString(), company: p.company, location: p.location },
  };
}

async function messagesFor(gmail: GmailHandle, parser: AlertParser, after: number, max: number): Promise<string[]> {
  const ids = new Set<string>();
  for (const sender of parser.senders) {
    for (const ref of await gmail.search!(`from:${sender} after:${after}`, max)) ids.add(ref.id);
  }
  return [...ids];
}

async function* readInbox(ctx: PluginContext<GmailAlertsConfig>, since: Date): AsyncGenerator<RawPosting> {
  const gmail = ctx.gmail;
  if (!gmail?.search || !gmail.getMessage || !gmail.getMessageBody) {
    throw new PluginError('Gmail (read scope) is not connected; run `jf gmail auth`');
  }
  const after = Math.floor(since.getTime() / 1000);
  const seen = new Set<string>();
  for (const parser of PARSERS.filter((p) => ctx.config.senders.includes(p.id))) {
    const ids = await messagesFor(gmail, parser, after, ctx.config.maxMessagesPerSender);
    let parsed = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      let subject = '';
      try {
        const meta = await gmail.getMessage(id);
        subject = meta.headers.subject ?? '';
        const body = await gmail.getMessageBody(id);
        const text = `${subject}\n${body.text ?? ''}\n${body.html ? body.html.slice(0, 20_000) : ''}`;
        if (parser.alertMarker && !parser.alertMarker.test(text)) continue; // not an alert (account mail etc.)
        const postings = parseAlertMessage(parser, { subject, html: body.html, text: body.text });
        if (!postings.length) {
          ctx.emit?.('parse_empty', { parser: parser.id, gmailMessageId: id, subject: subject.slice(0, 200) });
          ctx.log.info({ parser: parser.id, id, subject }, 'alert email had no recognisable jobs');
          continue;
        }
        parsed++;
        for (const p of postings) yield toRawPosting(p, { parser: parser.id, messageId: id, receivedAt: meta.internalDate });
      } catch (err) {
        // A broken template must never stop the other senders (PLAN Phase 7).
        ctx.emit?.('parse_failed', { parser: parser.id, gmailMessageId: id, subject: subject.slice(0, 200), error: (err as Error).message });
        ctx.log.warn({ parser: parser.id, id, err: (err as Error).message }, 'alert parse failed; skipped');
      }
    }
    ctx.log.debug({ parser: parser.id, messages: ids.length, parsed }, 'alert sender read');
  }
}

export default defineSourcePlugin<GmailAlertsConfig>({
  manifest: {
    id: 'source-gmail-alerts',
    version: '0.1.0',
    stage: 'source',
    description: 'Parses job-alert emails (LinkedIn, Naukri, Wellfound, YC, Instahyre, Internshala, Unstop) in your Gmail into postings.',
    configSchema,
    permissions: { domains: [], gmail: ['read'] },
    sideEffects: 'none',
  },

  fetch(ctx, target) {
    const sinceOpt = target.options?.since;
    const since =
      typeof sinceOpt === 'string' && !Number.isNaN(Date.parse(sinceOpt))
        ? new Date(sinceOpt)
        : new Date(Date.now() - ctx.config.lookbackDays * 24 * 3600_000);
    return readInbox(ctx, since);
  },
});

import { z } from 'zod';
import { defineEnricherPlugin, type CompanyEnrichment } from '@jobforge/plugin-sdk';
import { applyPattern, choosePattern, normalizeDomain, type PatternEvidence } from './patterns.js';

export * from './patterns.js';

export const configSchema = z
  .object({
    /** Force a pattern per company domain when you already know it, e.g. { "acme.com": "{first}" }. */
    knownPatterns: z.record(z.string(), z.string().regex(/\{(first|last|f|l)\}/)).default({}),
  })
  .strict();
export type PatternEnricherConfig = z.infer<typeof configSchema>;

const MAIL_PROVIDERS: [RegExp, string][] = [
  [/(google|googlemail)\.com\.?$/i, 'Google Workspace'],
  [/(outlook|protection\.outlook)\.com\.?$/i, 'Microsoft 365'],
  [/zoho\./i, 'Zoho'],
];

export default defineEnricherPlugin<PatternEnricherConfig, CompanyEnrichment>({
  manifest: {
    id: 'enricher-contacts-pattern',
    version: '0.1.0',
    stage: 'enricher',
    description: 'Infers contact emails from the company address pattern, gated on MX records. No SMTP probing.',
    configSchema,
    permissions: { domains: [], dns: true },
    sideEffects: 'none',
  },

  async enrich(ctx, _job, company): Promise<CompanyEnrichment> {
    const notes: string[] = [];
    const domain = normalizeDomain(company.emailDomain) ?? normalizeDomain(company.domain);
    const out: CompanyEnrichment = { emailDomain: domain, mxHosts: [], pattern: null, patternConfidence: null, contacts: [], notes };
    if (!domain) {
      notes.push(`No domain for ${company.name}; add one (jf contacts add --domain, or the companies CSV).`);
      return out;
    }
    const mx = await ctx.dns!.resolveMx(domain);
    out.mxHosts = mx.map((m) => m.exchange);
    if (!mx.length) {
      notes.push(`${domain} has no MX records, so it cannot receive email.`);
      return out;
    }
    const provider = MAIL_PROVIDERS.find(([re]) => re.test(mx[0]!.exchange))?.[1];
    if (provider) notes.push(`Mail is hosted on ${provider}.`);

    // Evidence: addresses at this domain we trust (manual/provider) and ones that bounced.
    const evidence: PatternEvidence[] = company.contacts
      .filter((c) => c.email && c.email.toLowerCase().endsWith(`@${domain}`))
      .filter((c) => c.status === 'bounced' || (c.emailSource !== null && !c.emailSource.startsWith('pattern:')))
      .map((c) => ({ name: c.name, email: c.email!, delivered: c.status !== 'bounced' }));
    const choice = choosePattern(evidence, ctx.config.knownPatterns[domain]);
    out.pattern = choice.pattern;
    out.patternConfidence = choice.confidence;
    notes.push(
      choice.basis === 'known_addresses'
        ? `Pattern ${choice.pattern} inferred from ${choice.samples} known address(es).`
        : choice.basis === 'configured'
          ? `Pattern ${choice.pattern} from config.`
          : `No known addresses at ${domain}; ${choice.pattern} is a guess from common patterns.`,
    );

    for (const c of company.contacts) {
      if (c.status !== 'active') continue;
      if (c.emailSource && !c.emailSource.startsWith('pattern:')) continue; // never override known addresses
      const local = applyPattern(choice.pattern, c.name);
      if (!local) {
        notes.push(`Can't apply ${choice.pattern} to "${c.name}" (needs a last name).`);
        continue;
      }
      out.contacts.push({ contactId: c.id, email: `${local}@${domain}`, confidence: choice.confidence, source: `pattern:${choice.pattern}` });
    }
    ctx.log.debug({ domain, pattern: choice.pattern, contacts: out.contacts.length }, 'contacts enriched');
    return out;
  },
});

import type { Logger } from '@jobforge/shared';
import type { Company, CompanyEnrichment, ContactRef } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  finishPluginRun,
  getCompany,
  listContacts,
  setCompanyEmailInfo,
  setContactHints,
  setInferredEmail,
  startPluginRun,
  type CompanyRow,
  type ContactRow,
  type DB,
} from '@jobforge/db';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

export function toContactRef(c: ContactRow): ContactRef {
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    email: c.email,
    emailConfidence: c.emailConfidence,
    emailSource: c.emailSource,
    status: c.status,
    roleHint: c.roleHint,
    department: c.department,
    linkedinUrl: c.linkedinUrl,
  };
}

export function toCompanyRef(c: CompanyRow, contacts: ContactRow[]): Company {
  return {
    id: c.id,
    name: c.name,
    domain: c.domain,
    tags: c.tags,
    emailDomain: c.emailDomain,
    emailPattern: c.emailPattern,
    contacts: contacts.map(toContactRef),
    linkedinId: c.linkedinId,
    linkedinSlug: c.linkedinSlug,
  };
}

export async function loadCompanyRef(db: DB, companyId: string): Promise<Company | null> {
  const c = await getCompany(db, companyId);
  if (!c) return null;
  return toCompanyRef(c, await listContacts(db, { companyId }));
}

export interface EnrichDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
}

export interface CompanyEnrichSummary {
  companyId: string;
  company: string;
  emailDomain: string | null;
  pattern: string | null;
  patternConfidence: number | null;
  emailsSet: number;
  notes: string[];
  error?: string;
}

/**
 * Run the contacts enricher over every company that has contacts (or one
 * company), persisting the mail domain, pattern, and inferred addresses.
 * One company's failure doesn't stop the rest.
 */
export async function enrichContacts(
  deps: EnrichDeps,
  opts: { pluginId?: string; companyId?: string } = {},
): Promise<CompanyEnrichSummary[]> {
  const pluginId = opts.pluginId ?? 'enricher-contacts-pattern';
  const loaded = deps.registry.enricher(pluginId);
  const all = await listContacts(deps.db, opts.companyId ? { companyId: opts.companyId } : {});
  const companyIds = [...new Set(all.map((c) => c.companyId))];
  const out: CompanyEnrichSummary[] = [];

  for (const companyId of companyIds) {
    const company = await loadCompanyRef(deps.db, companyId);
    if (!company) continue;
    const runId = await startPluginRun(deps.db, { pluginId, stage: 'enricher', targetKey: `company:${companyId}` });
    const log = deps.log.child({ plugin: pluginId, company: company.name });
    const ctx = buildContext(loaded, { ...deps, log, signal: AbortSignal.timeout(60_000) });
    const summary: CompanyEnrichSummary = {
      companyId,
      company: company.name,
      emailDomain: null,
      pattern: null,
      patternConfidence: null,
      emailsSet: 0,
      notes: [],
    };
    try {
      const e = (await loaded.plugin.enrich(ctx, null, company)) as CompanyEnrichment;
      Object.assign(summary, { emailDomain: e.emailDomain, pattern: e.pattern, patternConfidence: e.patternConfidence, notes: e.notes });
      await setCompanyEmailInfo(deps.db, companyId, {
        emailDomain: e.emailDomain,
        mxHosts: e.mxHosts,
        pattern: e.pattern,
        patternConfidence: e.patternConfidence,
      });
      const known = new Set(company.contacts.map((c) => c.id));
      for (const c of e.contacts) {
        if (!known.has(c.contactId)) continue; // plugins may only touch this company's contacts
        if (await setInferredEmail(deps.db, c.contactId, { email: c.email, confidence: c.confidence, source: c.source })) summary.emailsSet++;
        if (c.candidates?.length) await setContactHints(deps.db, c.contactId, { emailCandidates: c.candidates });
      }
      await finishPluginRun(deps.db, runId, { status: 'succeeded', itemsIn: company.contacts.length, itemsOut: summary.emailsSet, meta: { pattern: e.pattern } });
      await appendEvent(deps.db, { kind: 'contacts.enriched', subjectType: 'company', subjectId: companyId, payload: { runId, pattern: e.pattern, emailsSet: summary.emailsSet } });
    } catch (err) {
      summary.error = err instanceof Error ? err.message : String(err);
      await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: company.contacts.length, itemsOut: 0, error: summary.error });
      log.warn({ err: summary.error }, 'enrichment failed');
    }
    out.push(summary);
  }
  return out;
}

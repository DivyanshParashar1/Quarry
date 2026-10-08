import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig, Env, Logger } from '@jobforge/shared';
import {
  findCompanyByName,
  getReviewItem,
  listContacts,
  listReviewItems,
  listThreads,
  resolveIdPrefix,
  upsertCompany,
  upsertContact,
  AmbiguousContactError,
  type DB,
  type ReviewListRow,
} from '@jobforge/db';
import {
  approveReviewItem,
  draftDueFollowups,
  draftOutreach,
  editDraft,
  enrichContacts,
  pollTracker,
  rejectReviewItem,
  runSendTick,
  type SendTickResult,
} from '@jobforge/core';
import { fmtDate, table } from './format.js';
import { outreachDeps } from './runtime.js';

export interface CmdValues {
  company?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  email?: string | undefined;
  linkedin?: string | undefined;
  domain?: string | undefined;
  contact?: string | undefined;
  job?: string | undefined;
  subject?: string | undefined;
  'body-file'?: string | undefined;
  to?: string | undefined;
  reason?: string | undefined;
  'override-company-cap'?: boolean | undefined;
  live?: boolean | undefined;
  watch?: boolean | undefined;
  force?: boolean | undefined;
  all?: boolean | undefined;
}

export interface CmdCtx {
  env: Env;
  config: AppConfig;
  db: DB;
  log: Logger;
  out: (s: string) => void;
}

export class CmdError extends Error {}

const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 100)}%`);

export async function contactsCommand(sub: string | undefined, v: CmdValues, c: CmdCtx): Promise<number> {
  if (sub === 'add') {
    if (!v.company || !v.name) throw new CmdError('usage: jf contacts add --company <name> --name <full name> [--role] [--email] [--linkedin] [--domain]');
    let company = await findCompanyByName(c.db, v.company);
    if (!company && !v.domain) throw new CmdError(`unknown company "${v.company}"; pass --domain to create it`);
    if (!company || v.domain) {
      await upsertCompany(c.db, { name: company?.name ?? v.company, domain: v.domain ?? null });
      company = await findCompanyByName(c.db, v.company);
    }
    const { contact, created } = await upsertContact(c.db, {
      companyId: company!.id,
      name: v.name,
      role: v.role,
      email: v.email,
      linkedinUrl: v.linkedin,
    }).catch((err: unknown) => {
      throw err instanceof AmbiguousContactError ? new CmdError(err.message) : err;
    });
    c.out(`${created ? 'added' : 'updated'} ${contact.name} at ${company!.name} (${contact.id.slice(0, 8)})${contact.email ? ` <${contact.email}>` : ''}`);
    if (!contact.email) c.out('No email yet: run `jf contacts enrich` to infer one.');
    return 0;
  }
  if (sub === 'list') {
    const rows = await listContacts(c.db, v.company ? { company: v.company } : {});
    c.out(
      table(rows, [
        { header: 'COMPANY', value: (r) => r.companyName, max: 20 },
        { header: 'NAME', value: (r) => r.name, max: 24 },
        { header: 'ROLE', value: (r) => r.role ?? '', max: 24 },
        { header: 'EMAIL', value: (r) => r.email ?? '' },
        { header: 'CONF', value: (r) => pct(r.emailConfidence) },
        { header: 'SOURCE', value: (r) => r.emailSource ?? '' },
        { header: 'STATUS', value: (r) => (r.status === 'active' ? '' : r.status) },
        { header: 'ID', value: (r) => r.id.slice(0, 8) },
      ]),
    );
    return 0;
  }
  if (sub === 'enrich') {
    const deps = await outreachDeps({ ...c });
    const company = v.company ? await findCompanyByName(c.db, v.company) : null;
    if (v.company && !company) throw new CmdError(`unknown company "${v.company}"`);
    const res = await enrichContacts(deps, company ? { companyId: company.id } : {});
    for (const r of res) {
      c.out(`${r.company}: ${r.error ? `FAILED ${r.error}` : `${r.emailDomain ?? 'no domain'} · ${r.pattern ?? '-'} (${pct(r.patternConfidence)}) · ${r.emailsSet} email(s) set`}`);
      for (const n of r.notes) c.out(`  - ${n}`);
    }
    if (!res.length) c.out('No contacts yet. Add some with `jf contacts add`.');
    return 0;
  }
  throw new CmdError(`unknown command: contacts ${sub ?? ''}`);
}

function reviewTable(rows: ReviewListRow[]): string {
  return table(rows, [
    { header: 'ID', value: (r) => r.id.slice(0, 8) },
    { header: 'KIND', value: (r) => r.kind },
    { header: 'STATUS', value: (r) => r.status },
    { header: 'TO', value: (r) => `${r.contactName ?? ''} <${(r.draft as { to?: string; profileUrl?: string }).to ?? (r.draft as { profileUrl?: string }).profileUrl ?? ''}>`, max: 40 },
    { header: 'CONF', value: (r) => pct(r.contactEmailConfidence) },
    { header: 'COMPANY', value: (r) => r.companyName ?? '', max: 18 },
    { header: 'SUBJECT', value: (r) => (r.draft as { subject?: string; note?: string; title?: string }).subject ?? (r.draft as { title?: string }).title ?? (r.draft as { note?: string }).note ?? '', max: 40 },
    { header: 'NOTE', value: (r) => r.error ?? r.decisionNote ?? '', max: 40 },
  ]);
}

export async function reviewCommand(sub: string | undefined, arg: string | undefined, v: CmdValues, c: CmdCtx): Promise<number> {
  if (sub === 'list' || sub === undefined) {
    const rows = await listReviewItems(c.db, v.all ? {} : { status: ['pending', 'approved'] });
    c.out(rows.length ? reviewTable(rows) : 'Review queue is empty.');
    return 0;
  }
  if (!arg) throw new CmdError(`usage: jf review ${sub} <id>`);
  const id = await resolveIdPrefix(c.db, 'review_items', arg);
  if (sub === 'show') {
    const item = (await getReviewItem(c.db, id))!;
    const head = `${item.kind} · ${item.status}${item.error ? ` · ${item.error}` : ''}`;
    const raw = item.draft as Record<string, unknown>;
    if (raw.channel === 'linkedin') {
      const d = raw as { toName: string; profileUrl: string; note: string; jobUrl: string | null };
      c.out(`${head}\nLinkedIn: ${d.toName} <${d.profileUrl}>\nJob: ${d.jobUrl ?? '-'}\n\n${d.note}`);
    } else if (item.kind === 'attention') {
      c.out(`${head}\n${String(raw.title)}\n\n${String(raw.message)}`);
    } else {
      const d = raw as { to: string; toName: string; subject: string; body: string; factIds: string[] };
      c.out(`${head}\nTo: ${d.toName} <${d.to}>\nSubject: ${d.subject}\nFacts: ${d.factIds.join(', ') || '-'}\n\n${d.body}`);
    }
    return 0;
  }
  if (sub === 'edit') {
    const patch: Record<string, string> = {};
    if (v.subject) patch.subject = v.subject;
    if (v.to) patch.to = v.to;
    if (v['body-file']) patch.body = readFileSync(resolve(v['body-file']), 'utf8');
    if (!Object.keys(patch).length) throw new CmdError('nothing to edit: pass --subject, --to, or --body-file');
    await editDraft(c.db, id, patch);
    c.out(`edited ${Object.keys(patch).join(', ')}`);
    return 0;
  }
  if (sub === 'approve') {
    const item = await approveReviewItem(c.db, c.config.outreach, id, { overrideCompanyCap: !!v['override-company-cap'] });
    c.out(`approved ${item.id.slice(0, 8)}. It is sent by \`jf outreach send --live\` (or the server in MODE=live).`);
    return 0;
  }
  if (sub === 'reject') {
    await rejectReviewItem(c.db, id, v.reason ?? null);
    c.out('rejected');
    return 0;
  }
  throw new CmdError(`unknown command: review ${sub}`);
}

function printTick(r: SendTickResult, out: (s: string) => void): void {
  if (r.skipped) return out('Another send loop is running; skipped.');
  for (const o of r.outcomes) {
    out(`${r.mode === 'dry_run' ? 'DRY RUN would send' : o.ok ? 'SENT' : 'FAILED'} → ${o.to} · "${o.subject}"${o.result?.deduplicated ? ' (already sent; not resent)' : ''}${o.error ? ` · ${o.error}` : ''}`);
  }
  for (const h of r.held) out(`held ${h.reviewItemId.slice(0, 8)}: ${h.reason}`);
  if (r.waitingUntil) out(`spacing: next send allowed at ${r.waitingUntil.toLocaleTimeString()}`);
  if (r.dailyCapReached) out(`daily cap reached (${r.sentLast24h} in the last 24h)`);
  if (!r.outcomes.length && !r.held.length && !r.waitingUntil && !r.dailyCapReached) out('Nothing approved to send.');
}

export async function outreachCommand(sub: string | undefined, v: CmdValues, c: CmdCtx): Promise<number> {
  if (sub === 'draft') {
    if (!v.contact) throw new CmdError('usage: jf outreach draft --contact <id> [--job <id>] [--force]');
    const deps = await outreachDeps({ ...c, llm: true });
    const contactId = await resolveIdPrefix(c.db, 'contacts', v.contact);
    const jobId = v.job ? await resolveIdPrefix(c.db, 'jobs', v.job) : null;
    const item = await draftOutreach(deps, { contactId, jobId, force: !!v.force });
    c.out(`drafted ${item.id.slice(0, 8)} for review:\n`);
    return reviewCommand('show', item.id, v, c);
  }
  if (sub === 'send') {
    const live = !!v.live || c.env.MODE === 'live';
    const deps = await outreachDeps({ ...c, live, gmail: live });
    if (!live) c.out('Dry run (pass --live or set MODE=live to send for real).');
    for (;;) {
      const r = await runSendTick(deps);
      printTick(r, c.out);
      const more = live && v.watch && !r.dailyCapReached && (r.waitingUntil || r.outcomes.length);
      if (!more) return r.outcomes.some((o) => !o.ok) ? 1 : 0;
      await new Promise((res) => setTimeout(res, 60_000));
    }
  }
  if (sub === 'followups') {
    const deps = await outreachDeps({ ...c, llm: true });
    const r = await draftDueFollowups(deps);
    c.out(`${r.drafted} follow-up(s) drafted for review`);
    for (const e of r.errors) c.out(`  error: ${e}`);
    return r.errors.length ? 1 : 0;
  }
  if (sub === 'track') {
    const deps = await outreachDeps({ ...c, gmail: true });
    const r = await pollTracker(deps);
    c.out(`inspected ${r.inspected} inbox message(s): ${r.replies} repl${r.replies === 1 ? 'y' : 'ies'}, ${r.bounces} bounce(s)`);
    return 0;
  }
  if (sub === 'threads') {
    const rows = await listThreads(c.db);
    c.out(
      table(rows, [
        { header: 'STATE', value: (r) => r.state },
        { header: 'TO', value: (r) => `${r.contactName} <${r.contactEmail ?? ''}>`, max: 40 },
        { header: 'COMPANY', value: (r) => r.companyName ?? '', max: 18 },
        { header: 'SUBJECT', value: (r) => r.subject, max: 40 },
        { header: 'SENT', value: (r) => fmtDate(r.sentAt) },
        { header: 'FUPS', value: (r) => String(r.followupsSent) },
        { header: 'NEXT', value: (r) => fmtDate(r.nextFollowupAt) },
      ]),
    );
    return 0;
  }
  throw new CmdError(`unknown command: outreach ${sub ?? ''}`);
}

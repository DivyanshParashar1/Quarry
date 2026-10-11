// Smoke test against a RUNNING server (`pnpm server`): every read endpoint, the
// dashboard's static app, and the safe operations (orchestrator pass, sweep
// status). Nothing here approves, sends or submits; POSTs are limited to
// /api/orchestrator/run (ops actions only) unless --no-ops.
//   pnpm smoke:api [--base http://127.0.0.1:3000] [--no-ops]
const args = process.argv.slice(2);
const base = (args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined) ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const ops = !args.includes('--no-ops');

interface Row {
  name: string;
  ok: boolean;
  status: number | string;
  ms: number;
  note: string;
}
const rows: Row[] = [];

async function call(name: string, path: string, o: { method?: 'GET' | 'POST'; expect?: number[]; check?: (body: unknown) => string | null; headers?: Record<string, string> } = {}): Promise<unknown> {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method: o.method ?? 'GET',
      headers: o.headers ?? { accept: 'application/json', ...(o.method === 'POST' ? { 'content-type': 'application/json', 'x-quarry': '1' } : {}) },
      ...(o.method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* html */
    }
    const okStatus = (o.expect ?? [200]).includes(res.status);
    const problem = okStatus ? (o.check?.(body) ?? null) : `unexpected ${res.status}: ${text.slice(0, 160)}`;
    rows.push({ name, ok: !problem, status: res.status, ms: Date.now() - started, note: problem ?? '' });
    return body;
  } catch (err) {
    rows.push({ name, ok: false, status: 'ERR', ms: Date.now() - started, note: (err as Error).message });
    return null;
  }
}

const has = (keys: string[]) => (b: unknown) => {
  const missing = keys.filter((k) => !(b && typeof b === 'object' && k in b));
  return missing.length ? `missing ${missing.join(', ')}` : null;
};

const health = await call('health', '/api/health', { check: has(['ok']) });
if (!health) {
  console.error(`Server not reachable at ${base}; start it with \`pnpm server\`.`);
  process.exit(2);
}
await call('stats', '/api/stats');
await call('pipeline', '/api/pipeline', { check: has(['review']) });
const jobs = (await call('jobs (ranked)', '/api/jobs', { check: has(['rows', 'total']) })) as { rows?: { id: string }[] } | null;
await call('jobs (paged, filtered)', '/api/jobs?limit=5&offset=5&remote=remote,hybrid');
const jobId = jobs?.rows?.[0]?.id;
if (jobId) {
  await call('job detail', `/api/jobs/${jobId}`);
  await call('job outreach', `/api/jobs/${jobId}/outreach`);
  await call('job resume variants', `/api/jobs/${jobId}/resume-variants`);
  await call('job referrals', `/api/jobs/${jobId}/referrals`);
  await call('job timeline', `/api/applications/${jobId}/timeline`);
}
await call('companies', '/api/companies');
await call('companies discovered', '/api/companies/discovered');
const contacts = (await call('contacts', '/api/contacts')) as { contacts?: { id: string }[] } | null;
if (contacts?.contacts?.[0]) await call('contact detail', `/api/contacts/${contacts.contacts[0].id}`);
await call('contact imports', '/api/contacts/imports');
await call('profile', '/api/profile');
await call('profile (full)', '/api/profile/full');
await call('answer bank', '/api/answers');
await call('applications', '/api/applications', { check: has(['counts']) });
await call('resume (editor)', '/api/resume', { expect: [200, 503] });
await call('resume library', '/api/resumes/library');
await call('resume library run', '/api/resumes/library/run');
const review = (await call('review queue', '/api/review')) as { items?: { id: string }[] } | null;
if (review?.items?.[0]) await call('review item', `/api/review/${review.items[0].id}`);
await call('outreach threads', '/api/outreach/threads');
await call('linkedin drafts', '/api/linkedin/drafts');
await call('linkedin status', '/api/linkedin/status');
await call('sweep status', '/api/sweep');
await call('orchestrator status', '/api/orchestrator', { check: has(['llm', 'incidents']) });
await call('incidents', '/api/incidents', { check: has(['incidents']) });
await call('dashboard (built SPA)', '/', { expect: [200, 404], check: (b) => (typeof b === 'string' && b.includes('<div id="root"') ? null : typeof b === 'string' ? null : 'not HTML') });
await call('unknown API route → 404', '/api/does-not-exist', { expect: [404] });
await call('POST without x-quarry is refused', '/api/orchestrator/run', { method: 'POST', expect: [403], headers: { 'content-type': 'application/json' } });
await call('cross-origin POST is refused', '/api/orchestrator/run', { method: 'POST', expect: [403], headers: { 'content-type': 'application/json', 'x-quarry': '1', origin: 'https://evil.example' } });
if (ops) await call('orchestrator pass (ops actions only)', '/api/orchestrator/run', { method: 'POST', expect: [200, 503], check: has(['findings']) });

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(w)}  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)} ms  ${r.note}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed against ${base}`);
process.exit(failed ? 1 : 0);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, type ApiClient } from './api-client.js';

// MCP tools (PLAN.md §6). The agent can look, prepare, and recommend; only the
// user approves. `approve` is the single path to an external side effect.

const SOURCE_ATS: Record<string, string> = {
  'source-greenhouse': 'greenhouse',
  'source-lever': 'lever',
  'source-ashby': 'ashby',
};

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: msg }] });

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err instanceof ApiError ? `JobForge API ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err));
  }
}

interface DraftLike {
  id: string;
  status: string;
  kind: string;
  draft: { to: string; toName: string; subject: string; body: string };
  contactEmailConfidence?: number | null;
}

export function createJobForgeMcp(api: ApiClient, opts: { version?: string } = {}): McpServer {
  const server = new McpServer({ name: 'jobforge', version: opts.version ?? '0.3.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'pipeline_status',
    { title: 'Pipeline status', description: 'Counts per stage (jobs, matches, review queue, outreach threads), the last run of each plugin, and failing boards.', annotations: readOnly },
    () => run(async () => ({ ...(await api.get<object>('/api/pipeline')), stats: await api.get('/api/stats') })),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Search canonical jobs, ranked by match score for the active profile. view: ranked (LLM-scored), all, unscored, excluded.',
      inputSchema: {
        q: z.string().optional().describe('Title contains'),
        company: z.string().optional(),
        location: z.string().optional(),
        remote: z.array(z.enum(['remote', 'hybrid', 'onsite'])).optional(),
        view: z.enum(['ranked', 'all', 'unscored', 'excluded']).default('ranked'),
        minScore: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnly,
    },
    (a) =>
      run(() =>
        api.get('/api/jobs', {
          q: a.q,
          company: a.company,
          location: a.location,
          remote: a.remote?.join(','),
          method: { ranked: 'llm', all: undefined, unscored: 'unscored', excluded: 'filtered,prefilter' }[a.view],
          minScore: a.minScore,
          limit: a.limit,
        }),
      ),
  );

  server.registerTool(
    'get_job',
    { title: 'Get job', description: 'Full job: description, match reasoning, contacts at the company, drafts, and outreach threads.', inputSchema: { id: z.string().uuid() }, annotations: readOnly },
    ({ id }) => run(async () => ({ ...(await api.get<object>(`/api/jobs/${id}`)), outreach: await api.get(`/api/jobs/${id}/outreach`) })),
  );

  server.registerTool(
    'run_source',
    {
      title: 'Run source',
      description: 'Queue a fetch of job boards. pluginId: source-greenhouse | source-lever | source-ashby (omit for all); company narrows to one company.',
      inputSchema: { pluginId: z.enum(['source-greenhouse', 'source-lever', 'source-ashby']).optional(), company: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => api.send('POST', '/api/sources/run', { ...(a.pluginId ? { atsType: SOURCE_ATS[a.pluginId] } : {}), ...(a.company ? { company: a.company } : {}) })),
  );

  server.registerTool(
    'review_queue',
    {
      title: 'Review queue',
      description: 'Drafts waiting for the user: pending (needs a decision) and approved (queued to send). Each has the full email text.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(50), status: z.array(z.enum(['pending', 'approved', 'failed', 'executed', 'rejected', 'cancelled'])).optional() },
      annotations: readOnly,
    },
    (a) => run(() => api.get('/api/review', { limit: a.limit, status: a.status?.join(',') })),
  );

  server.registerTool(
    'edit_draft',
    {
      title: 'Edit draft',
      description: 'Change a pending draft before the user reviews it (subject, body, recipient). Never invent experience: keep claims to the profile facts.',
      inputSchema: { id: z.string().uuid(), subject: z.string().min(1).optional(), body: z.string().min(1).optional(), to: z.string().email().optional(), toName: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, ...patch }) => run(() => api.send('PATCH', `/api/review/${id}`, patch)),
  );

  server.registerTool(
    'approve',
    {
      title: 'Approve (sends email)',
      description:
        'Approve a pending draft so it will be SENT from the user\'s Gmail. This is the only action with an external side effect. ' +
        'Only call it when the user has explicitly told you to approve this specific draft in this conversation; never on your own initiative. ' +
        'The user is asked to confirm. overrideCompanyCap bypasses the 2-people-per-company-per-week limit and needs the user\'s explicit request.',
      inputSchema: { id: z.string().uuid(), overrideCompanyCap: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id, overrideCompanyCap }) => {
      let item: DraftLike;
      try {
        item = await api.get<DraftLike>(`/api/review/${id}`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      if (item.status !== 'pending') return fail(`This draft is ${item.status}, not pending.`);
      // Ask the human directly when the client supports it; the tool-call
      // permission prompt is the confirmation otherwise.
      if (server.server.getClientCapabilities()?.elicitation) {
        const d = item.draft;
        const res = await server.server.elicitInput({
          message:
            `Send this email from your Gmail?\n\nTo: ${d.toName} <${d.to}>${item.contactEmailConfidence != null && item.contactEmailConfidence < 1 ? ` (address ${Math.round(item.contactEmailConfidence * 100)}% sure)` : ''}\n` +
            `Subject: ${d.subject}\n\n${d.body}${overrideCompanyCap ? '\n\n(Overrides the per-company weekly limit.)' : ''}`,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: 'Approve and queue for sending' } },
            required: ['confirm'],
          },
        });
        if (res.action !== 'accept' || res.content?.confirm !== true) return ok({ approved: false, reason: `user ${res.action === 'accept' ? 'did not confirm' : res.action}` });
      }
      return run(() => api.send('POST', `/api/review/${id}/approve`, { overrideCompanyCap }));
    },
  );

  server.registerTool(
    'reject',
    {
      title: 'Reject draft',
      description: 'Reject a pending draft, or cancel an approved one before it is sent.',
      inputSchema: { id: z.string().uuid(), reason: z.string().max(500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, reason }) => run(() => api.send('POST', `/api/review/${id}/reject`, reason ? { reason } : {})),
  );

  server.registerTool(
    'add_company',
    {
      title: 'Add company',
      description: 'Add a company and (optionally) its job board. atsType + boardToken, e.g. greenhouse/airbnb, lever/netflix, ashby/linear.',
      inputSchema: {
        name: z.string().min(1),
        atsType: z.enum(['greenhouse', 'lever', 'ashby', 'careers_page', 'other']).optional(),
        boardToken: z.string().min(1).optional(),
        domain: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(() => api.send('POST', '/api/companies', a)),
  );

  server.registerTool(
    'add_contact',
    {
      title: 'Add contact',
      description: 'Add a person at a company (e.g. the hiring manager). Email optional; it can be inferred with find_emails.',
      inputSchema: { company: z.string().min(1), name: z.string().min(1), role: z.string().optional(), email: z.string().email().optional(), domain: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (a) => run(() => api.send('POST', '/api/contacts', a)),
  );

  server.registerTool(
    'find_emails',
    {
      title: 'Find emails',
      description: "Infer contacts' emails from the company's address pattern (MX-checked, no SMTP probing). Returns confidence per address.",
      inputSchema: { companyId: z.string().uuid().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (a) => run(() => api.send('POST', '/api/contacts/enrich', a)),
  );

  server.registerTool(
    'draft_outreach',
    {
      title: 'Draft outreach email',
      description: 'Draft a job-specific email to a contact into the review queue. Sends nothing; the user reviews and approves.',
      inputSchema: { contactId: z.string().uuid(), jobId: z.string().uuid().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => api.send('POST', '/api/outreach/draft', a)),
  );

  server.registerTool(
    'profile_get',
    { title: 'Get profile', description: 'The active profile: preferences and the fact bank (ids, kinds, content).', annotations: readOnly },
    () => run(() => api.get('/api/profile')),
  );

  server.registerTool(
    'run_autopilot',
    {
      title: 'Run autopilot',
      description:
        'LLM-in-the-loop: walk top-ranked jobs, tailor + draft, auto-approve high-confidence ones. Low-confidence items are left pending in the review queue for the human. Honors the server\'s dryRun mode: only MODE=live actually sends.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => api.send('POST', '/api/autopilot/run', { ...(a.limit ? { limit: a.limit } : {}) })),
  );

  server.registerTool(
    'tailor_resume',
    {
      title: 'Tailor resume for a job',
      description:
        'Produce a grounded, one-page resume PDF for a job: LLM selects + rephrases facts; validator drops any bullet that invents experience. Returns the variant row (with validation report).',
      inputSchema: { jobId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ jobId }) => run(() => api.send('POST', `/api/jobs/${jobId}/tailor`)),
  );

  server.registerTool(
    'list_resume_variants',
    {
      title: 'List resume variants for a job',
      description: 'All tailored resume variants for the job, newest first (with validation report and PDF availability).',
      inputSchema: { jobId: z.string().uuid() },
      annotations: readOnly,
    },
    ({ jobId }) => run(() => api.get(`/api/jobs/${jobId}/resume-variants`)),
  );

  server.registerTool(
    'profile_update_fact',
    {
      title: 'Update profile fact',
      description:
        'Create or edit one fact in profile/facts.yaml (comments are kept) and reload the profile. Only record facts the user has stated; never embellish.',
      inputSchema: {
        id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/),
        kind: z.enum(['project', 'experience', 'education', 'skill', 'achievement']).optional(),
        content: z.string().min(1).optional(),
        metrics: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ id, ...patch }) => run(() => api.send('PUT', `/api/profile/facts/${encodeURIComponent(id)}`, patch)),
  );

  return server;
}

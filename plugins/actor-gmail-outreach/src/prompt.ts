import { z } from 'zod';
import type { OutreachActionInput } from '@jobforge/plugin-sdk';

export const PLACEHOLDER_RE = /\[[A-Z][^\]]{0,40}\]|\{\{[^}]*\}\}|<(?:name|company|role)>/i;

/** Follow-ups keep the thread's "Re:" subject, so the model's subject is optional there. */
export function outreachSchema(maxWords: number, followup = false) {
  const subject = z.string().trim().min(3).max(120);
  return z.object({
    subject: followup ? subject.optional().catch(undefined) : subject,
    body: z
      .string()
      .trim()
      .min(40)
      .refine((b) => !PLACEHOLDER_RE.test(b), 'contains a placeholder like [Name]; write the real text')
      .refine((b) => wordCount(b) <= Math.ceil(maxWords * 1.25), `longer than ${maxWords} words`),
    fact_ids: z.array(z.string()).max(8).describe('ids of the candidate facts the email relies on'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('How confident you are this email should be sent as-is, 0..1. The autopilot escalates <0.8 to human review.'),
  });
}
export type OutreachOutput = z.infer<ReturnType<typeof outreachSchema>>;

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export const SYSTEM_PROMPT = `You write short, specific cold emails from a job candidate to someone at a company that is hiring.

Rules:
- Use ONLY the candidate facts provided. Never invent experience, numbers, employers, or skills. Every claim about the candidate must come from a listed fact; return the ids of the facts you used.
- One clear, low-effort ask (a 15-minute chat, or who the right person is, or a referral) tied to the specific role.
- Mention one concrete thing about the role or team from the posting.
- Plain text. No markdown, no emojis, no flattery, no "I hope this email finds you well".
- Do not include a greeting line other than "Hi <first name>," and do not include a signature; it is appended automatically.
- Never use placeholders such as [Name] or {{company}}; write the real words.

Also return a self-reported "confidence" 0..1 that this email is ready to send: 1 = send now, <0.8 = the system escalates to a human reviewer. Be honest.`;

export function outreachPrompt(input: OutreachActionInput, maxWords: number, descriptionChars = 2500): string {
  const { job, company, contact, profile } = input;
  const facts = profile.facts.map((f) => `- [${f.id}] (${f.kind}) ${f.content}`).join('\n') || '- (no facts)';
  const lines = [
    `# Recipient`,
    `${contact.name}${contact.role ? `, ${contact.role}` : ''} at ${company.name}`,
    '',
    `# Candidate facts`,
    facts,
    '',
    `# Candidate preferences`,
    `Target roles: ${profile.preferences.roles.join(', ') || 'n/a'}`,
  ];
  if (job) {
    const d = (job.descriptionMd ?? '').slice(0, descriptionChars);
    lines.push('', `# Role: ${job.title}`, job.locations.length ? `Location: ${job.locations.join('; ')}` : '', d);
  } else {
    lines.push('', '# Role', 'No specific posting; ask about relevant openings on their team.');
  }
  if (input.kind === 'followup' && input.previous) {
    lines.push(
      '',
      `# Previous email (sent ${input.previous.sentAt.toDateString()}, no reply yet)`,
      `Subject: ${input.previous.subject}`,
      input.previous.body,
      '',
      `Write follow-up #${input.previous.followupNumber}: a brief, polite nudge in the same thread that adds one new relevant fact or angle. Do not repeat the first email. At most ${maxWords} words. Keep the subject as "Re: ${input.previous.subject}".`,
    );
  } else {
    lines.push('', `Write the first email. At most ${maxWords} words. Subject under 8 words, specific to the role.`);
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

// ---------------------------------------------------------------------------
// Phase 8: referral asks
// ---------------------------------------------------------------------------

export const REFERRAL_SYSTEM_PROMPT = `You write a very short email from a job candidate to an employee at a company, asking whether they would refer the candidate for one specific open role.

Rules:
- Ask for a referral for exactly the role given, and include the posting URL exactly as provided.
- Cite exactly ONE of the provided resume bullets: the one most relevant to the recipient's team or role. Paraphrase it faithfully; never add numbers, technologies or claims that aren't in that bullet. Return its id as bullet_id.
- Make it easy to say yes: offer to send the resume and a two-line blurb they can forward.
- Plain text, warm but brief. No flattery, no markdown, no emojis, no "hope you're well".
- Greeting "Hi <first name>," only; no signature (it is appended automatically).
- Never use placeholders such as [Name] or {{company}}.

Also return a self-reported "confidence" 0..1 that this email is ready to send as-is. Be honest.`;

export function referralSchema(maxWords: number, bulletIds: string[]) {
  const ids = new Set(bulletIds);
  return z.object({
    subject: z.string().trim().min(3).max(90),
    body: z
      .string()
      .trim()
      .min(30)
      .refine((b) => !PLACEHOLDER_RE.test(b), 'contains a placeholder like [Name]; write the real text')
      .refine((b) => wordCount(b) <= Math.ceil(maxWords * 1.25), `longer than ${maxWords} words`),
    bullet_id: z
      .string()
      .refine((id) => !ids.size || ids.has(id), 'bullet_id must be one of the provided bullet ids')
      .describe('id of the single resume bullet the email cites'),
    confidence: z.number().min(0).max(1),
  });
}

export function referralPrompt(input: OutreachActionInput, maxWords: number, descriptionChars = 1200): string {
  const { job, company, contact } = input;
  const bullets = (input.resumeBullets ?? []).map((b) => `- [${b.id}] ${b.text}`).join('\n') || '- (none)';
  const recipient = [contact.name, contact.role, contact.department ? `team: ${contact.department}` : null].filter(Boolean).join(', ');
  return [
    '# Recipient',
    `${recipient} at ${company.name}${contact.roleHint ? ` (${contact.roleHint})` : ''}`,
    '',
    '# Role to be referred for',
    job ? `${job.title}${job.locations.length ? ` — ${job.locations.join('; ')}` : ''}` : '(unknown role)',
    job?.applyUrl ? `Posting URL: ${job.applyUrl}` : '',
    (job?.descriptionMd ?? '').slice(0, descriptionChars),
    '',
    '# Resume bullets (cite exactly one)',
    bullets,
    '',
    `Write the referral ask. At most ${maxWords} words. Subject under 7 words, naming the role.`,
  ].join('\n');
}

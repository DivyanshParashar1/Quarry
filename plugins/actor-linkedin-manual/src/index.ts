import { z } from 'zod';
import {
  defineActorPlugin,
  LINKEDIN_MESSAGE_MAX,
  LINKEDIN_NOTE_MAX,
  linkedinManualDraftSchema,
  type LinkedInManualDraft,
  type OutreachActionInput,
} from '@quarry/plugin-sdk';

// Phase 17: LinkedIn outreach is manual. This actor only drafts: a full referral
// message for a 1st-degree connection (from the user's Connections export), or a
// ≤300-char connection-request note for anyone else with a profile URL. The user
// copies it into LinkedIn and marks it sent in the dashboard; nothing here ever
// opens LinkedIn, so execute() refuses to run.

export const PLUGIN_ID = 'actor-linkedin-manual';

export const configSchema = z
  .object({
    /** Target length of a full message, in words. */
    messageWords: z.number().int().min(40).max(250).default(110),
  })
  .strict();
export type LinkedInManualConfig = z.infer<typeof configSchema>;

const PLACEHOLDER_RE = /\[[A-Z][^\]]{0,40}\]|\{\{[^}]*\}\}|<(?:name|company|role)>/i;

export const MESSAGE_SYSTEM_PROMPT = `You write a LinkedIn direct message from a job candidate to one of their own LinkedIn connections, asking whether they would refer the candidate for one specific open role at their company.

Rules:
- Start with "Hi <first name>,". If context about how they know each other is given, open with one short line that uses it; never invent a shared history.
- Name the role and include the posting URL exactly as provided.
- Cite exactly ONE of the provided resume bullets, the one most relevant to the recipient's team or role. Paraphrase it faithfully; never add numbers, technologies or claims that aren't in it. Return its id as bullet_id.
- Say the resume is attached, and make it easy to say yes (they can forward it, or point to the right person).
- Plain text, warm, direct, no flattery, no emojis, no markdown, no "hope you're well".
- End with the sign-off name given (or no sign-off when none is given). Never use placeholders such as [Name].

Also return "confidence" 0..1 that the message is ready to send as-is. Be honest.`;

export const NOTE_SYSTEM_PROMPT = `You write a LinkedIn connection-request note (at most ${LINKEDIN_NOTE_MAX} characters, including spaces) from a job candidate to an employee they are not yet connected to, asking whether they'd be open to referring the candidate for one specific role.

Rules:
- Start with "Hi <first name>,". Name the role. Mention exactly ONE of the provided resume bullets, paraphrased faithfully (no new numbers or claims); return its id as bullet_id.
- Friendly, direct, no flattery, no emojis, no links, no placeholders, no signature.

Also return "confidence" 0..1 that the note is ready to send as-is.`;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export const FOLLOWUP_SYSTEM_PROMPT = `You write a short LinkedIn follow-up from a job candidate to someone they messaged about a referral a day ago and who hasn't replied.

Rules:
- Start with "Hi <first name>,". One or two sentences: a polite, low-pressure nudge about the same role; offer the easy path (forward the resume, or point to the right person).
- Don't repeat the first message, add no new claims or numbers, no guilt-tripping, no emojis, no placeholders.
- End with the sign-off name given (or none).

Also return "confidence" 0..1 that it is ready to send as-is.`;

export function followupSchema() {
  return z.object({
    text: z
      .string()
      .trim()
      .min(30)
      .max(600)
      .refine((t) => !PLACEHOLDER_RE.test(t), 'contains a placeholder like [Name]; write the real text'),
    confidence: z.number().min(0).max(1),
  });
}

export function followupPrompt(input: OutreachActionInput): string {
  const signOff = input.profile.preferences.application?.first_name ?? null;
  return [
    `# Recipient: ${input.contact.name} at ${input.company.name}`,
    `# Role: ${input.job?.title ?? '(the role from the first message)'}`,
    '',
    `# The message sent ${input.previous?.sentAt.toDateString() ?? 'yesterday'} (no reply yet)`,
    input.previous?.body ?? '',
    '',
    `Write the follow-up.${signOff ? ` Sign off as "${signOff}".` : ''}`,
  ].join('\n');
}

export function messageSchema(maxWords: number, bulletIds: string[]) {
  const ids = new Set(bulletIds);
  return z.object({
    text: z
      .string()
      .trim()
      .min(60)
      .max(LINKEDIN_MESSAGE_MAX)
      .refine((t) => !PLACEHOLDER_RE.test(t), 'contains a placeholder like [Name]; write the real text')
      .refine((t) => wordCount(t) <= Math.ceil(maxWords * 1.25), `longer than ${maxWords} words`),
    bullet_id: z.string().refine((id) => !ids.size || ids.has(id), 'bullet_id must be one of the provided ids'),
    confidence: z.number().min(0).max(1),
  });
}

export function noteSchema(bulletIds: string[]) {
  const ids = new Set(bulletIds);
  return z.object({
    text: z
      .string()
      .trim()
      .min(40)
      .max(LINKEDIN_NOTE_MAX, `must be at most ${LINKEDIN_NOTE_MAX} characters`)
      .refine((t) => !PLACEHOLDER_RE.test(t), 'contains a placeholder like [Name]; write the real text'),
    bullet_id: z.string().refine((id) => !ids.size || ids.has(id), 'bullet_id must be one of the provided ids'),
    confidence: z.number().min(0).max(1),
  });
}

export function draftPrompt(input: OutreachActionInput, kind: 'message' | 'note', maxWords: number): string {
  const { job, company, contact, profile } = input;
  const signOff = profile.preferences.application?.first_name ?? null;
  const recipient = [contact.name, contact.role, contact.department ? `team: ${contact.department}` : null].filter(Boolean).join(', ');
  return [
    '# Recipient',
    `${recipient} at ${company.name}${contact.roleHint ? ` (${contact.roleHint})` : ''}`,
    kind === 'message' ? `Relationship: a 1st-degree LinkedIn connection of the candidate${contact.notes ? `; context: ${contact.notes}` : ''}` : 'Relationship: not connected yet',
    '',
    '# Role to be referred for',
    job ? `${job.title}${job.locations.length ? ` — ${job.locations.join('; ')}` : ''}` : '(unknown role)',
    kind === 'message' && job?.applyUrl ? `Posting URL: ${job.applyUrl}` : '',
    kind === 'message' ? (job?.descriptionMd ?? '').slice(0, 1200) : '',
    '',
    '# Resume bullets (cite exactly one)',
    (input.resumeBullets ?? []).map((b) => `- [${b.id}] ${b.text}`).join('\n') || '- (none)',
    '',
    kind === 'message'
      ? `Write the message. At most ${maxWords} words.${signOff ? ` Sign off as "${signOff}".` : ''}`
      : `Write the note. Hard limit: ${LINKEDIN_NOTE_MAX} characters.`,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

/** Connections get a full message; anyone else gets a connection-request note. */
export function draftKind(contact: OutreachActionInput['contact']): 'message' | 'note' {
  return contact.linkedinDegree === 1 ? 'message' : 'note';
}

export default defineActorPlugin<LinkedInManualConfig, OutreachActionInput, LinkedInManualDraft, never>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Drafts a LinkedIn referral message (connections) or connection note (others) for you to send by hand. Never opens LinkedIn.',
    configSchema,
    permissions: { domains: [], llm: true },
    sideEffects: 'external',
  },

  // No side effects: an LLM call and validation only.
  async prepare(ctx, input) {
    if (!input.contact.linkedinUrl) throw new Error(`${input.contact.name} has no LinkedIn profile URL`);
    if (input.kind === 'followup') {
      const res = await ctx.llm!.generate({
        task: 'outreach',
        system: FOLLOWUP_SYSTEM_PROMPT,
        prompt: followupPrompt(input),
        schema: followupSchema(),
        maxTokens: 300,
        signal: ctx.signal,
      });
      return linkedinManualDraftSchema.parse({
        channel: 'linkedin_manual',
        kind: 'message',
        purpose: 'followup',
        profileUrl: input.contact.linkedinUrl,
        toName: input.contact.name,
        text: res.data.text,
        jobTitle: input.job?.title ?? null,
        jobUrl: input.job?.applyUrl ?? null,
        confidence: res.data.confidence,
      });
    }
    const kind = draftKind(input.contact);
    const bullets = input.resumeBullets ?? [];
    const ids = bullets.map((b) => b.id);
    const res =
      kind === 'message'
        ? await ctx.llm!.generate({
            task: 'outreach',
            system: MESSAGE_SYSTEM_PROMPT,
            prompt: draftPrompt(input, kind, ctx.config.messageWords),
            schema: messageSchema(ctx.config.messageWords, ids),
            maxTokens: 700,
            signal: ctx.signal,
          })
        : await ctx.llm!.generate({
            task: 'outreach',
            system: NOTE_SYSTEM_PROMPT,
            prompt: draftPrompt(input, kind, ctx.config.messageWords),
            schema: noteSchema(ids),
            maxTokens: 400,
            signal: ctx.signal,
          });
    const resume = (input.attachments ?? [])[0];
    return linkedinManualDraftSchema.parse({
      channel: 'linkedin_manual',
      kind,
      profileUrl: input.contact.linkedinUrl,
      toName: input.contact.name,
      text: res.data.text,
      jobTitle: input.job?.title ?? null,
      jobUrl: input.job?.applyUrl ?? null,
      resumeVariantId: kind === 'message' ? (resume?.resumeVariantId ?? null) : null,
      resumeBulletId: bullets.some((b) => b.id === res.data.bullet_id) ? res.data.bullet_id : null,
      confidence: res.data.confidence,
    });
  },

  async execute() {
    throw new Error(`${PLUGIN_ID} is manual: send the message yourself, then mark it sent in the dashboard (or \`quarry linkedin sent <id>\`)`);
  },
});

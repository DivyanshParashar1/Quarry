import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  assertNotBlocked,
  defineActorPlugin,
  LINKEDIN_HOST,
  LINKEDIN_NOTE_MAX,
  linkedinNoteDraftSchema,
  SessionBlockedError,
  type BrowserPage,
  type LinkedInNoteDraft,
  type LinkedInSendResult,
  type OutreachActionInput,
} from '@jobforge/plugin-sdk';

export const PLUGIN_ID = 'actor-linkedin-referral';

export const configSchema = z
  .object({
    /** Where pre/post screenshots go (the audit trail). */
    screenshotDir: z.string().default('data/screenshots/linkedin'),
    /** Keystroke delay range (ms) when typing the note. */
    typingDelayMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([40, 140]),
  })
  .strict();
export type LinkedInActorConfig = z.infer<typeof configSchema>;

// Selectors for LinkedIn's profile page (2024-25 markup). Kept together so a
// layout change is a one-place fix.
export const SEL = {
  connect: 'main button:has-text("Connect")',
  more: 'main button[aria-label="More actions"]',
  moreConnect: 'div[role="button"]:has-text("Connect")',
  addNote: 'button:has-text("Add a note")',
  note: 'textarea[name="message"]',
  send: 'button[aria-label="Send invitation"]',
  sendFallback: 'button:has-text("Send")',
} as const;

const PENDING = /aria-label="Pending,|>\s*Pending\s*</i;
const FIRST_DEGREE = /\b1st\b[^<]{0,40}degree connection|•\s*1st\b/i;

export const NOTE_SYSTEM_PROMPT = `You write a LinkedIn connection-request note (at most ${LINKEDIN_NOTE_MAX} characters, including spaces) from a job candidate to an employee, asking whether they'd be open to referring the candidate for one specific role.

Rules:
- Name the role. Mention exactly ONE of the provided resume bullets (the most relevant to the recipient's team), paraphrased faithfully; no new numbers or claims. Return its id as bullet_id.
- Friendly, direct, no flattery, no emojis, no links (LinkedIn notes can't carry a long URL well), no placeholders.
- Start with "Hi <first name>," and end without a signature.

Also return "confidence" 0..1 that the note is ready to send as-is.`;

export function noteSchema(bulletIds: string[]) {
  const ids = new Set(bulletIds);
  return z.object({
    note: z.string().trim().min(40).max(LINKEDIN_NOTE_MAX, `must be at most ${LINKEDIN_NOTE_MAX} characters`),
    bullet_id: z.string().refine((id) => !ids.size || ids.has(id), 'bullet_id must be one of the provided ids'),
    confidence: z.number().min(0).max(1),
  });
}

export function notePrompt(input: OutreachActionInput): string {
  const { job, company, contact } = input;
  return [
    `# Recipient: ${contact.name}${contact.role ? `, ${contact.role}` : ''} at ${company.name}${contact.department ? ` (team: ${contact.department})` : ''}`,
    `# Role: ${job?.title ?? 'an open role'}${job?.locations.length ? ` — ${job.locations.join('; ')}` : ''}`,
    '',
    '# Resume bullets (cite exactly one)',
    ...(input.resumeBullets ?? []).map((b) => `- [${b.id}] ${b.text}`),
    '',
    `Write the note. Hard limit: ${LINKEDIN_NOTE_MAX} characters.`,
  ].join('\n');
}

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

async function jitter(page: BrowserPage): Promise<void> {
  await page.mouse.move(rand(300, 900), rand(200, 600), { steps: Math.round(rand(8, 20)) });
  await page.waitForTimeout(Math.round(rand(600, 1600)));
}

async function check(page: BrowserPage): Promise<string> {
  const html = await page.content();
  assertNotBlocked(page.url(), html, await page.title());
  return html;
}

export default defineActorPlugin<LinkedInActorConfig, OutreachActionInput, LinkedInNoteDraft, LinkedInSendResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Sends a LinkedIn connection request with a short referral note from your dedicated LinkedIn account, after approval.',
    configSchema,
    permissions: { domains: [LINKEDIN_HOST], llm: true, browser: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 15_000 } },
    sideEffects: 'external',
  },

  // No side effects: an LLM call and validation only.
  async prepare(ctx, input) {
    if (!input.contact.linkedinUrl) throw new Error(`${input.contact.name} has no LinkedIn profile URL`);
    const bullets = input.resumeBullets ?? [];
    const res = await ctx.llm!.generate({
      task: 'outreach',
      system: NOTE_SYSTEM_PROMPT,
      prompt: notePrompt(input),
      schema: noteSchema(bullets.map((b) => b.id)),
      maxTokens: 400,
      signal: ctx.signal,
    });
    return linkedinNoteDraftSchema.parse({
      channel: 'linkedin',
      profileUrl: input.contact.linkedinUrl,
      toName: input.contact.name,
      note: res.data.note,
      jobUrl: input.job?.applyUrl ?? null,
      resumeBulletId: bullets.some((b) => b.id === res.data.bullet_id) ? res.data.bullet_id : null,
      confidence: res.data.confidence,
    });
  },

  async execute(ctx, approved, idempotencyKey) {
    const draft = linkedinNoteDraftSchema.parse(approved.draft);
    const sentAt = new Date().toISOString();
    if (ctx.dryRun) {
      ctx.log.info({ to: draft.profileUrl, chars: draft.note.length }, 'DRY RUN: would send LinkedIn connection request');
      return { dryRun: true, outcome: 'dry_run', profileUrl: draft.profileUrl, sentAt, screenshots: [] };
    }
    const dir = resolve(ctx.config.screenshotDir);
    await mkdir(dir, { recursive: true });
    const shot = (name: string) => join(dir, `${idempotencyKey.replace(/[^a-z0-9-]+/gi, '_')}-${name}.png`);
    const screenshots: string[] = [];
    const page = await ctx.browser!.newPage();
    try {
      await page.goto(draft.profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      let html = await check(page);
      screenshots.push(shot('pre'));
      await page.screenshot({ path: screenshots.at(-1)!, fullPage: false });
      // A retry after a crash, or a request sent by hand: never send twice.
      if (PENDING.test(html)) return { dryRun: false, outcome: 'already_pending', profileUrl: draft.profileUrl, sentAt, screenshots };
      if (FIRST_DEGREE.test(html)) return { dryRun: false, outcome: 'already_connected', profileUrl: draft.profileUrl, sentAt, screenshots };

      await jitter(page);
      if (await page.isVisible(SEL.connect)) {
        await page.click(SEL.connect);
      } else if (await page.isVisible(SEL.more)) {
        await page.click(SEL.more);
        await page.waitForTimeout(Math.round(rand(400, 900)));
        if (!(await page.isVisible(SEL.moreConnect))) throw new Error('no Connect action on this profile (following-only or restricted)');
        await page.click(SEL.moreConnect);
      } else {
        throw new Error('no Connect button on this profile');
      }
      await check(page);
      await jitter(page);
      await page.waitForSelector(SEL.addNote, { timeout: 10_000 });
      await page.click(SEL.addNote);
      await page.waitForSelector(SEL.note, { timeout: 10_000 });
      const [lo, hi] = ctx.config.typingDelayMs;
      await page.pressSequentially(SEL.note, draft.note, { delay: Math.round(rand(lo, hi)) });
      await jitter(page);
      await page.click((await page.isVisible(SEL.send)) ? SEL.send : SEL.sendFallback);
      await page.waitForTimeout(Math.round(rand(1500, 3000)));
      html = await check(page); // the weekly-limit notice appears here
      screenshots.push(shot('post'));
      await page.screenshot({ path: screenshots.at(-1)!, fullPage: false });
      if (!PENDING.test(html)) ctx.log.warn({ profile: draft.profileUrl }, 'sent, but the profile does not show Pending yet');
      ctx.log.info({ profile: draft.profileUrl }, 'LinkedIn connection request sent');
      return { dryRun: false, outcome: 'sent', profileUrl: draft.profileUrl, sentAt, screenshots };
    } catch (err) {
      if (!(err instanceof SessionBlockedError)) {
        screenshots.push(shot('error'));
        await page.screenshot({ path: screenshots.at(-1)!, fullPage: true }).catch(() => {});
      }
      throw err;
    } finally {
      await page.close();
    }
  },
});

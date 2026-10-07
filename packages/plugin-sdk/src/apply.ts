import { z } from 'zod';
import type { ApplicationProfile } from '@jobforge/shared';
import type { Job, Profile } from './types.js';
import { SessionBlockedError, type BrowserPage } from './browser.js';

// Phase 11: ATS auto-apply. Shared by actor-apply-greenhouse / -lever / -ashby.
// The actor reads the form's questions (public API or page, no side effects),
// answers them only from the user's own preferences.yaml `application`
// section, and submits only with a core-built ApprovedDraft.

export type ApplyAts = 'greenhouse' | 'lever' | 'ashby';

/** What the core hands an apply actor's prepare(). */
export interface ApplyInput {
  job: Job;
  ats: ApplyAts;
  /** Board token / company slug of the source. */
  boardToken: string;
  /** The ATS's own posting id. */
  postingId: string;
  applyUrl: string;
  profile: Profile;
  applicant: ApplicationProfile;
  resume: { path: string; resumeVariantId: string | null };
}

export type FieldKind = 'text' | 'textarea' | 'file' | 'select' | 'multiselect' | 'checkbox' | 'radio';

/** One question on an application form, as the actor discovered it. */
export interface FormQuestion {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Choice labels for select/radio/checkbox questions. */
  options?: string[];
  /** CSS selectors to try, in order. */
  selectors: string[];
  /** compliance/EEO questions answer from `application.eeo` only. */
  eeo?: keyof ApplicationProfile['eeo'];
}

export const answerSourceEnum = z.enum(['profile', 'resume', 'answers', 'eeo', 'human']);

export const applicationFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum(['text', 'textarea', 'file', 'select', 'multiselect', 'checkbox', 'radio']),
    required: z.boolean(),
    selectors: z.array(z.string()).min(1),
    options: z.array(z.string()).optional(),
    /** null = unanswered (left blank). */
    value: z.string().nullable(),
    source: answerSourceEnum.nullable(),
  })
  .strict();
export type ApplicationField = z.infer<typeof applicationFieldSchema>;

export const applicationDraftSchema = z
  .object({
    channel: z.literal('apply'),
    ats: z.enum(['greenhouse', 'lever', 'ashby']),
    title: z.string(),
    company: z.string(),
    jobUrl: z.string().url(),
    applyUrl: z.string().url(),
    resumePath: z.string().min(1),
    resumeVariantId: z.string().nullable(),
    fields: z.array(applicationFieldSchema),
    /** Labels of required questions nothing answered; approval is refused until they're filled. */
    missingRequired: z.array(z.string()),
    /** Dry-run preview screenshots (filled, not submitted). */
    previewScreenshots: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).nullable().default(null),
    /** Profile version the answers came from; part of the idempotency key apply:{job}:{profile}. */
    profileVersion: z.string().nullable().default(null),
  })
  .strict();
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;

/** A reviewer may fill or change answers: { fields: [{ key, value }] }. */
export const applicationDraftPatchSchema = z
  .object({ fields: z.array(z.object({ key: z.string(), value: z.string().nullable() }).strict()).min(1) })
  .strict();

export interface ApplicationResult {
  [key: string]: unknown;
  dryRun: boolean;
  submitted: boolean;
  /** Confirmation text the ATS showed, when detected. */
  confirmation: string | null;
  screenshots: string[];
  at: string;
}

// ---------------------------------------------------------------------------
// Answer mapping (deterministic; never invents)
// ---------------------------------------------------------------------------

type Rule = [RegExp, (a: ApplicationProfile, input: ApplyInput) => string | null];

const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? 'Yes' : 'No');

const RULES: Rule[] = [
  [/^(legal )?first name|^given name|preferred first name/i, (a) => a.first_name],
  [/^(legal )?last name|^surname|^family name/i, (a) => a.last_name],
  [/^(full )?name$|^your name/i, (a) => [a.first_name, a.last_name].filter(Boolean).join(' ') || null],
  [/e-?mail/i, (a) => a.email],
  [/phone|mobile/i, (a) => a.phone],
  [/linkedin/i, (a) => a.linkedin_url],
  [/github/i, (a) => a.github_url],
  [/website|portfolio|personal (site|url)/i, (a) => a.website_url],
  [/current (company|employer)|^company$|^organi[sz]ation$/i, (a) => a.current_company],
  [/current (title|role|position)/i, (a) => a.current_title],
  [/school|university|college|institution/i, (a) => a.university],
  [/degree|qualification/i, (a) => a.degree],
  [/graduat(ion|e) (year|date)|year of graduation|batch/i, (_a, i) => (i.profile.preferences.graduation_year ? String(i.profile.preferences.graduation_year) : null)],
  [/(current )?location|city|where are you based/i, (a) => a.location],
  [/notice period/i, (a) => (a.notice_period_days === null ? null : a.notice_period_days === 0 ? 'Immediately' : `${a.notice_period_days} days`)],
  [/sponsor/i, (a) => yesNo(a.requires_sponsorship)],
];

/** Work-authorization questions: "Are you legally authorized to work in India?" → the India answer. */
function workAuth(label: string, a: ApplicationProfile): string | null {
  if (!/authori[sz]ed|work permit|eligible to work|right to work|legally (able|allowed)/i.test(label)) return null;
  for (const [country, ans] of Object.entries(a.work_authorization)) {
    if (new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(label)) return ans === 'yes' ? 'Yes' : 'No';
  }
  return null;
}

/** Pick the option a value refers to ("yes" → "Yes, I am authorized…"); null when nothing fits. */
export function chooseOption(value: string, options: string[]): string | null {
  const v = value.trim().toLowerCase();
  return (
    options.find((o) => o.trim().toLowerCase() === v) ??
    options.find((o) => o.trim().toLowerCase().startsWith(v)) ??
    options.find((o) => o.toLowerCase().includes(v)) ??
    null
  );
}

const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose)|i don.?t want/i;

/**
 * Answer each question from the applicant profile, custom answers, EEO
 * section, or the tailored resume (file uploads). Unanswerable questions stay
 * null; required ones are reported in `missingRequired`.
 */
export function mapAnswers(questions: FormQuestion[], input: ApplyInput): { fields: ApplicationField[]; missingRequired: string[] } {
  const a = input.applicant;
  const fields: ApplicationField[] = [];
  for (const q of questions) {
    let value: string | null = null;
    let source: ApplicationField['source'] = null;
    if (q.kind === 'file') {
      if (/resume|cv/i.test(q.label) || q.key === 'resume') {
        value = input.resume.path;
        source = 'resume';
      }
    } else if (q.eeo) {
      const v = a.eeo[q.eeo];
      if (v) {
        const opts = q.options ?? [];
        value = /^decline$/i.test(v) ? (opts.find((o) => DECLINE.test(o)) ?? null) : opts.length ? chooseOption(v, opts) : v;
        source = value ? 'eeo' : null;
      }
    } else {
      const custom = a.answers.find((x) => q.label.toLowerCase().includes(x.match.toLowerCase()));
      if (custom) {
        value = custom.answer;
        source = 'answers';
      } else {
        value = workAuth(q.label, a);
        if (value === null) {
          for (const [re, get] of RULES) {
            if (re.test(q.label)) {
              value = get(a, input);
              break;
            }
          }
        }
        source = value ? 'profile' : null;
      }
      if (value && q.options?.length && (q.kind === 'select' || q.kind === 'radio' || q.kind === 'multiselect')) {
        const opt = chooseOption(value, q.options);
        if (!opt) {
          value = null;
          source = null;
        } else value = opt;
      }
      if (value && q.kind === 'checkbox' && !/^(yes|true|no|false)$/i.test(value)) value = null;
    }
    fields.push({
      key: q.key,
      label: q.label,
      kind: q.kind,
      required: q.required,
      selectors: q.selectors,
      ...(q.options ? { options: q.options } : {}),
      value,
      source,
    });
  }
  return { fields, missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label) };
}

/** 1.0 when every required field is answered, scaled down by the share of required gaps. */
export function draftConfidence(fields: ApplicationField[]): number {
  const req = fields.filter((f) => f.required);
  if (!req.length) return 0.9;
  return Math.round((req.filter((f) => f.value).length / req.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Filling (shared by preview and execute)
// ---------------------------------------------------------------------------

async function firstVisible(page: BrowserPage, selectors: string[]): Promise<string | null> {
  for (const s of selectors) if (await page.isVisible(s)) return s;
  // File inputs are often visually hidden; fall back to the first selector for uploads.
  return null;
}

/**
 * Fill every answered field on the open form. Returns the labels it could not
 * place (selector not found), which the caller treats as a failed fill.
 */
export async function fillForm(page: BrowserPage, draft: ApplicationDraft, opts: { typingDelayMs?: number } = {}): Promise<string[]> {
  const notFound: string[] = [];
  for (const f of draft.fields) {
    if (!f.value) continue;
    if (f.kind === 'file') {
      // Hidden <input type=file> elements accept setInputFiles even when not visible.
      await page.setInputFiles(f.selectors[0]!, f.value);
      continue;
    }
    const sel = await firstVisible(page, f.selectors);
    if (!sel) {
      notFound.push(f.label);
      continue;
    }
    if (f.kind === 'select' || f.kind === 'multiselect') await page.selectOption(sel, f.value);
    else if (f.kind === 'checkbox') {
      if (/^(yes|true)$/i.test(f.value)) await page.check(sel);
    } else if (f.kind === 'radio') await page.click(sel.includes('%s') ? sel.replace('%s', f.value) : sel);
    else if (opts.typingDelayMs) await page.pressSequentially(sel, f.value, { delay: opts.typingDelayMs });
    else await page.fill(sel, f.value);
  }
  return notFound;
}

export interface ApplyFlowOptions {
  /** Submit button selectors, in order. */
  submit: string[];
  /** Text (or URL) that proves the ATS accepted the application. */
  confirmation: RegExp;
  /** Where screenshots go (absolute dir) and their file-name prefix. */
  screenshotDir: string;
  prefix: string;
  /** false = dry run: fill + screenshot, never click submit. */
  submitForReal: boolean;
  typingDelayMs?: number;
  /** How long to wait for the confirmation after submitting. */
  confirmTimeoutMs?: number;
}

const CAPTCHA = /g-recaptcha|hcaptcha|captcha-container|cf-challenge|verify you are human/i;

/**
 * Open the form, fill it, screenshot it; when `submitForReal`, click submit,
 * wait for the confirmation, screenshot again. A captcha or a form that
 * doesn't confirm throws — there is no captcha solving; a human applies.
 */
export async function runApplyFlow(page: BrowserPage, draft: ApplicationDraft, o: ApplyFlowOptions): Promise<ApplicationResult> {
  const shot = (name: string) => `${o.screenshotDir}/${o.prefix.replace(/[^a-z0-9-]+/gi, '_')}-${name}.png`;
  const screenshots: string[] = [];
  await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);
  const notFound = await fillForm(page, draft, o.typingDelayMs ? { typingDelayMs: o.typingDelayMs } : {});
  screenshots.push(shot('filled'));
  await page.screenshot({ path: screenshots.at(-1)!, fullPage: true });
  if (notFound.length) throw new Error(`could not find these fields on the form: ${notFound.join(', ')}`);
  const at = new Date().toISOString();
  if (!o.submitForReal) return { dryRun: true, submitted: false, confirmation: null, screenshots, at };

  let clicked = false;
  for (const s of o.submit) {
    if (await page.isVisible(s)) {
      await page.click(s);
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error('no submit button found');
  const deadline = Date.now() + (o.confirmTimeoutMs ?? 20_000);
  let html = '';
  for (;;) {
    await page.waitForTimeout(1000);
    html = await page.content();
    if (o.confirmation.test(html) || o.confirmation.test(page.url())) break;
    if (Date.now() > deadline) break;
  }
  screenshots.push(shot('after-submit'));
  await page.screenshot({ path: screenshots.at(-1)!, fullPage: true });
  const m = html.match(o.confirmation) ?? page.url().match(o.confirmation);
  if (!m) {
    if (CAPTCHA.test(html)) throw new SessionBlockedError('the form asked for a captcha; apply by hand', 'captcha', page.url());
    throw new Error('submitted, but no confirmation appeared; check the after-submit screenshot');
  }
  return { dryRun: false, submitted: true, confirmation: m[0].slice(0, 200), screenshots, at };
}

import { z } from 'zod';
import type { Job, Profile } from './types.js';

// Shapes shared by the core and the outreach plugins (enricher, actor, tracker).

/** A company as enrichers and actors see it, with its known contacts. */
export interface Company {
  id: string;
  name: string;
  domain: string | null;
  tags: string[];
  /** Mail domain if it differs from `domain` (filled by the enricher). */
  emailDomain: string | null;
  emailPattern: string | null;
  contacts: ContactRef[];
  /** Phase 8: LinkedIn company identity, once known. */
  linkedinId?: string | null;
  linkedinSlug?: string | null;
}

/** What the LinkedIn employee enricher returns for one company. */
export interface EmployeeEnrichment {
  linkedinId: string | null;
  linkedinSlug: string | null;
  profiles: {
    name: string;
    headline: string | null;
    location: string | null;
    profileUrl: string;
    roleHint: string;
    seniorityHint: string;
    department: string | null;
  }[];
  notes: string[];
}

export interface ContactRef {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  /** 0..1 */
  emailConfidence: number | null;
  /** manual | pattern:<pattern> | provider:<id> */
  emailSource: string | null;
  status: 'active' | 'bounced' | 'do_not_contact';
  /** Phase 8 targeting hints (engineer / manager / recruiter …), when known. */
  roleHint?: string | null;
  department?: string | null;
  linkedinUrl?: string | null;
  /** Phase 17: 1 = a connection of the user's own LinkedIn (from the Connections export); null = unknown. */
  linkedinDegree?: number | null;
  /** Phase 17: free-text context from an imported sheet ("college senior"). */
  notes?: string | null;
}

/** What a contacts enricher returns for one company. The core decides what to persist. */
export interface CompanyEnrichment {
  emailDomain: string | null;
  mxHosts: string[];
  /** e.g. "{first}.{last}" */
  pattern: string | null;
  patternConfidence: number | null;
  contacts: {
    contactId: string;
    email: string | null;
    confidence: number;
    source: string;
    /** Phase 8: ranked alternatives (best first, the chosen one included), for when the first bounces. */
    candidates?: { email: string; confidence: number; pattern: string }[];
  }[];
  /** Phase 8: every plausible pattern for the domain, best first. */
  patternCandidates?: { pattern: string; confidence: number }[];
  notes: string[];
}

export type Enrichment = CompanyEnrichment | Record<string, unknown>;

/** A plain-text resume bullet the actor may quote (from the job's tailored resume, or a profile fact). */
export interface ResumeBullet {
  id: string;
  text: string;
}

/** Input to an outreach actor's prepare(). Built by the core; no side effects allowed. */
export interface OutreachActionInput {
  /** referral_ask (Phase 8): a short, job-specific referral request to one person. */
  kind: 'outreach' | 'followup' | 'referral_ask';
  job: Job | null;
  company: Company;
  contact: ContactRef & { email: string };
  profile: Profile;
  /** Pre-resolved attachments the core wants on the outbound email (e.g. tailored resume). */
  attachments?: EmailAttachment[];
  /** referral_ask: bullets to pick the single most relevant one from. */
  resumeBullets?: ResumeBullet[];
  /** For follow-ups: the thread so far. */
  previous?: {
    subject: string;
    body: string;
    sentAt: Date;
    followupNumber: number;
    gmailThreadId: string;
    messageIds: string[];
  };
}

/** Files attached to an outbound email. The core resolves these at draft time. */
export const attachmentSchema = z
  .object({
    filename: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
    /** Absolute path on disk; actors read it at send time. */
    path: z.string().trim().min(1),
    /** For UI/traceability (e.g. the resume_variants row this attachment came from). */
    resumeVariantId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type EmailAttachment = z.infer<typeof attachmentSchema>;

export const emailDraftSchema = z
  .object({
    to: z.string().email(),
    toName: z.string(),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    /** Profile facts the draft relies on (grounding trail). */
    factIds: z.array(z.string()).default([]),
    /** Attachments picked up by the actor at send time (e.g. the tailored resume PDF). */
    attachments: z.array(attachmentSchema).max(5).default([]),
    /** Self-reported LLM confidence 0..1; the autopilot uses this to decide auto-approve vs. escalate. */
    confidence: z.number().min(0).max(1).nullable().default(null),
    /** referral_ask: the resume bullet the email cites. */
    resumeBulletId: z.string().nullable().default(null),
    /** Follow-ups reply into the original thread. */
    gmailThreadId: z.string().nullable().default(null),
    inReplyTo: z.string().nullable().default(null),
    references: z.array(z.string()).default([]),
    /** Phase 24 compose: what the mail is for (referral | intro | followup | thanks | chat); asks count toward the cooldown. */
    purpose: z.string().max(40).nullable().default(null),
    /**
     * Phase 24 scheduled send (ISO time): the actor saves a Gmail draft with an
     * `X-Quarry-Send-At` header instead of sending; the user's Apps Script sends it.
     */
    sendAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();
export type EmailDraft = z.infer<typeof emailDraftSchema>;

/** The fields a human may change while an email draft is pending review. */
export const emailDraftPatchSchema = z
  .object({
    to: z.string().email().optional(),
    toName: z.string().optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(10_000).optional(),
    /** Replace the attachment list (empty array removes attachments). */
    attachments: z.array(attachmentSchema).max(5).optional(),
  })
  .strict();
export type EmailDraftPatch = z.infer<typeof emailDraftPatchSchema>;

export interface EmailSendResult {
  [key: string]: unknown;
  dryRun: boolean;
  /** RFC 5322 Message-ID, derived from the idempotency key. */
  messageId: string;
  gmailId: string | null;
  gmailThreadId: string | null;
  sentAt: string;
  /** True when a retry found the message already in Sent instead of sending again. */
  deduplicated: boolean;
  /** Phase 24: saved as a Gmail draft for the Apps Script to send at `sendAt`. */
  scheduled?: boolean;
  gmailDraftId?: string | null;
  /** The From address used. */
  from?: string;
}

export type TrackEventKind = 'reply' | 'bounce';

export interface GmailTrackEvent {
  kind: TrackEventKind;
  at: Date;
  data: { gmailThreadId: string; gmailMessageId: string; from: string; subject: string; snippet: string };
}

// ---------------------------------------------------------------------------
// Phase 8/9: LinkedIn referral asks (connection request with a note)
// ---------------------------------------------------------------------------

/** LinkedIn caps connection notes at 300 characters. */
export const LINKEDIN_NOTE_MAX = 300;

export const linkedinNoteDraftSchema = z
  .object({
    channel: z.literal('linkedin'),
    profileUrl: z.string().url().refine((u) => /^https:\/\/(www\.)?linkedin\.com\/in\//.test(u), 'must be a linkedin.com/in/ profile URL'),
    toName: z.string().min(1),
    note: z.string().trim().min(20).max(LINKEDIN_NOTE_MAX),
    /** The job the ask is about (for the reviewer). */
    jobUrl: z.string().url().nullable().default(null),
    resumeBulletId: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();
export type LinkedInNoteDraft = z.infer<typeof linkedinNoteDraftSchema>;

export const linkedinNoteDraftPatchSchema = z.object({ note: z.string().trim().min(20).max(LINKEDIN_NOTE_MAX).optional() }).strict();

/**
 * Phase 17: a LinkedIn message the user sends by hand (no automation). `message`
 * goes to a 1st-degree connection; `note` is a ≤300-char connection-request note.
 */
export const LINKEDIN_MESSAGE_MAX = 1500;

export const linkedinManualDraftSchema = z
  .object({
    channel: z.literal('linkedin_manual'),
    kind: z.enum(['message', 'note']),
    /**
     * Phase 18: ask = the first contact; after_accept = the full message once a connection
     * note was accepted; followup = the 24 h nudge on a sent message.
     */
    purpose: z.enum(['ask', 'after_accept', 'followup']).default('ask'),
    profileUrl: z.string().url().refine((u) => /^https:\/\/(www\.)?linkedin\.com\/in\//.test(u), 'must be a linkedin.com/in/ profile URL'),
    toName: z.string().min(1),
    text: z.string().trim().min(20).max(LINKEDIN_MESSAGE_MAX),
    jobTitle: z.string().nullable().default(null),
    jobUrl: z.string().url().nullable().default(null),
    /** The tailored resume to attach by hand (messages only). */
    resumeVariantId: z.string().nullable().default(null),
    resumeBulletId: z.string().nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.kind === 'note' && d.text.length > LINKEDIN_NOTE_MAX) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: `a connection-request note is at most ${LINKEDIN_NOTE_MAX} characters` });
    }
  });
export type LinkedInManualDraft = z.infer<typeof linkedinManualDraftSchema>;

export const linkedinManualDraftPatchSchema = z.object({ text: z.string().trim().min(20).max(LINKEDIN_MESSAGE_MAX).optional() }).strict();

export interface LinkedInSendResult {
  [key: string]: unknown;
  dryRun: boolean;
  /** sent | already_connected | already_pending */
  outcome: 'sent' | 'already_connected' | 'already_pending' | 'dry_run';
  profileUrl: string;
  sentAt: string;
  screenshots: string[];
}

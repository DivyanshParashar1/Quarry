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
}

/** What a contacts enricher returns for one company. The core decides what to persist. */
export interface CompanyEnrichment {
  emailDomain: string | null;
  mxHosts: string[];
  /** e.g. "{first}.{last}" */
  pattern: string | null;
  patternConfidence: number | null;
  contacts: { contactId: string; email: string | null; confidence: number; source: string }[];
  notes: string[];
}

export type Enrichment = CompanyEnrichment | Record<string, unknown>;

/** Input to an outreach actor's prepare(). Built by the core; no side effects allowed. */
export interface OutreachActionInput {
  kind: 'outreach' | 'followup';
  job: Job | null;
  company: Company;
  contact: ContactRef & { email: string };
  profile: Profile;
  /** Pre-resolved attachments the core wants on the outbound email (e.g. tailored resume). */
  attachments?: EmailAttachment[];
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
    /** Follow-ups reply into the original thread. */
    gmailThreadId: z.string().nullable().default(null),
    inReplyTo: z.string().nullable().default(null),
    references: z.array(z.string()).default([]),
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
}

export type TrackEventKind = 'reply' | 'bounce';

export interface GmailTrackEvent {
  kind: TrackEventKind;
  at: Date;
  data: { gmailThreadId: string; gmailMessageId: string; from: string; subject: string; snippet: string };
}

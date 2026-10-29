// Capability handles the core injects into PluginContext (PLAN.md §4.2). Each
// is scoped to what the manifest declares; plugins never see credentials.

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** Requires `permissions.dns`. Lookups are cached and time-limited by the core. */
export interface DnsResolver {
  /** MX records for a domain; [] when the domain has none or doesn't exist. */
  resolveMx(domain: string): Promise<MxRecord[]>;
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: Date;
  snippet: string;
  /** Lower-cased header name -> first value. */
  headers: Record<string, string>;
}

/** Decoded bodies of a message (the first text/html and text/plain parts). */
export interface GmailMessageBody {
  html: string | null;
  text: string | null;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/**
 * The user's own Gmail account. Methods are present only for the scopes the
 * manifest declares: `send` needs gmail: ['send']; `search` and `getMessage`
 * need gmail: ['read'].
 */
export interface GmailHandle {
  /** The authenticated mailbox address (the From address). */
  readonly address: string;
  /** Send a base64url-encoded RFC 5322 message, optionally into an existing thread. */
  send?(raw: string, threadId?: string): Promise<GmailMessageRef>;
  /** Gmail search syntax, e.g. `rfc822msgid:<id>` or `in:inbox after:1700000000`. */
  search?(q: string, max?: number): Promise<GmailMessageRef[]>;
  getMessage?(id: string): Promise<GmailMessageMeta>;
  /** Full decoded body (read scope). Used by the job-alert source to parse alert emails. */
  getMessageBody?(id: string): Promise<GmailMessageBody>;
  /** Phase 24 (gmail: ['drafts']): save a base64url RFC 5322 message as a draft. */
  createDraft?(raw: string, threadId?: string): Promise<GmailMessageRef & { draftId: string }>;
  // Core-only (never handed to plugins): reconcile and cancel scheduled drafts.
  /** False once the draft was sent or deleted. */
  draftExists?(draftId: string): Promise<boolean>;
  deleteDraft?(draftId: string): Promise<void>;
  /** The newest sent (non-draft) message in a thread, or null. */
  sentMessageInThread?(threadId: string): Promise<(GmailMessageRef & { at: Date }) | null>;
}

/**
 * Requires `permissions.credentials` (Phase 20). Passwords for accounts the
 * plugin creates on third-party portals (one per Workday tenant). The core
 * keeps them in the OS keychain, namespaced by plugin id; they never reach the
 * DB, events or logs. Plugins must not log or emit what `get`/`create` return.
 */
export interface CredentialStore {
  /** The stored password for `account`, or null when none was created yet. */
  get(account: string): Promise<string | null>;
  /** Generate a strong password, store it, and return it. Throws when no keychain is available. */
  create(account: string): Promise<string>;
}

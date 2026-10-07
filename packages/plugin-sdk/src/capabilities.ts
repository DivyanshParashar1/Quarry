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
}

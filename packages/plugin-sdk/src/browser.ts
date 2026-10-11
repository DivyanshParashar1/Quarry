// Browser capability (Phase 8/9/11). A subset of Playwright's Page API, so the
// core can hand plugins a real Playwright page through a scoping wrapper and
// tests can use the scripted fake in ./testing.

export interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  title(): Promise<string>;
  click(selector: string, opts?: { timeout?: number; delay?: number }): Promise<void>;
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
  /** Type character by character (human-ish); `delay` ms between keys. */
  pressSequentially(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
  setInputFiles(selector: string, files: string | string[]): Promise<void>;
  selectOption(selector: string, values: string | string[]): Promise<string[]>;
  check(selector: string): Promise<void>;
  isVisible(selector: string): Promise<boolean>;
  waitForSelector(selector: string, opts?: { timeout?: number; state?: 'attached' | 'detached' | 'visible' | 'hidden' }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  close(): Promise<void>;
  /**
   * Phase 19: the visible form fields on the page, open shadow roots included
   * (web-component forms like SmartRecruiters'). Optional: read-only.
   */
  describeForm?(): Promise<DiscoveredField[]>;
}

export interface DiscoveredField {
  /** A CSS selector that reaches the element (Playwright CSS pierces open shadow DOM). */
  selector: string;
  label: string;
  kind: 'text' | 'textarea' | 'file' | 'select' | 'checkbox' | 'radio';
  required: boolean;
  options?: string[];
  maxLength?: number;
  /** Current value (prefilled fields). */
  value?: string;
}

/**
 * Requires `permissions.browser`. Pages may only navigate to the manifest's
 * domains (checked by the core on every goto and after clicks), and each
 * navigation waits on the plugin's per-domain rate limit.
 */
export interface BrowserHandle {
  readonly kind: 'browser';
  newPage(): Promise<BrowserPage>;
}

/** Signals that a site put up a login wall, captcha, or account warning. The core pauses and asks a human. */
export class SessionBlockedError extends Error {
  constructor(
    message: string,
    /** e.g. 'captcha' | 'checkpoint' | 'login' | 'restricted' | 'rate_limited' */
    readonly reason: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'SessionBlockedError';
  }
}

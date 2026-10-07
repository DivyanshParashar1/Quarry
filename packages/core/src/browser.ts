import { DomainNotAllowedError, hostAllowed, type BrowserHandle, type BrowserPage, type PluginManifest } from '@jobforge/plugin-sdk';
import type { Logger } from '@jobforge/shared';
import type { BrowserContextOptions } from 'playwright';
import type { DomainRateLimiter } from './rate-limiter.js';

/** An unscoped browser: what launchBrowser() returns and what tests fake. */
export interface RawBrowser {
  newPage(): Promise<BrowserPage>;
  /** Current cookies/localStorage (Playwright storageState), for saving the session. */
  storageState?(): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * Narrow a browser to one plugin: every navigation (goto, or a click that
 * navigates) must land on a host the manifest lists, and each goto waits on
 * the plugin's per-domain rate limit. Plugins never see the raw browser.
 */
export function scopeBrowser(raw: RawBrowser, manifest: PluginManifest, limiter: DomainRateLimiter, log: Logger, signal?: AbortSignal): BrowserHandle {
  const domains = manifest.permissions.domains;
  const rate = manifest.rateLimit?.perDomain;
  const check = (url: string) => {
    if (url === 'about:blank') return;
    const u = new URL(url);
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname, domains)) throw new DomainNotAllowedError(u.hostname, manifest.id);
  };
  return Object.freeze({
    kind: 'browser' as const,
    async newPage(): Promise<BrowserPage> {
      const page = await raw.newPage();
      const scoped: BrowserPage = {
        ...page,
        mouse: page.mouse,
        url: () => page.url(),
        content: () => page.content(),
        title: () => page.title(),
        async goto(url, opts) {
          check(url);
          await limiter.acquire(new URL(url).hostname, rate, signal);
          log.debug({ url }, 'browser goto');
          const r = await page.goto(url, opts);
          check(page.url());
          return r;
        },
        async click(selector, opts) {
          await page.click(selector, opts);
          check(page.url());
        },
        fill: (s, v, o) => page.fill(s, v, o),
        pressSequentially: (s, t, o) => page.pressSequentially(s, t, o),
        setInputFiles: (s, f) => page.setInputFiles(s, f),
        selectOption: (s, v) => page.selectOption(s, v),
        check: (s) => page.check(s),
        isVisible: (s) => page.isVisible(s),
        waitForSelector: (s, o) => page.waitForSelector(s, o),
        waitForTimeout: (ms) => page.waitForTimeout(ms),
        screenshot: (o) => page.screenshot(o),
        close: () => page.close(),
      };
      return scoped;
    },
  });
}

export interface LaunchOptions {
  headless?: boolean;
  /** Playwright storageState object (cookies + origins); never a path to plaintext on disk. */
  storageState?: unknown;
  /** Use a specific Chromium build (e.g. a preinstalled one) instead of Playwright's download. */
  executablePath?: string;
  /** Typical desktop viewport; LinkedIn serves a different layout to small windows. */
  viewport?: { width: number; height: number };
}

/** Launch Chromium via Playwright (loaded lazily so nothing else pays for it). */
export async function launchBrowser(o: LaunchOptions = {}): Promise<RawBrowser> {
  const { chromium } = await import('playwright');
  const executablePath = o.executablePath ?? process.env.BROWSER_EXECUTABLE_PATH ?? undefined;
  const browser = await chromium.launch({ headless: o.headless ?? true, ...(executablePath ? { executablePath } : {}) });
  const ctxOpts: BrowserContextOptions = { viewport: o.viewport ?? { width: 1366, height: 860 }, locale: 'en-US' };
  if (o.storageState) ctxOpts.storageState = o.storageState as NonNullable<BrowserContextOptions['storageState']>;
  const context = await browser.newContext(ctxOpts);
  return {
    async newPage(): Promise<BrowserPage> {
      const p = await context.newPage();
      return {
        goto: (url, opts) => p.goto(url, opts),
        url: () => p.url(),
        content: () => p.content(),
        title: () => p.title(),
        click: (s, opts) => p.click(s, opts),
        fill: (s, v, opts) => p.fill(s, v, opts),
        pressSequentially: (s, t, opts) => p.locator(s).first().pressSequentially(t, opts),
        setInputFiles: (s, f) => p.setInputFiles(s, f),
        selectOption: (s, v) => p.selectOption(s, v),
        check: (s) => p.check(s),
        isVisible: (s) => p.isVisible(s),
        waitForSelector: (s, opts) => p.waitForSelector(s, opts ?? {}),
        waitForTimeout: (ms) => p.waitForTimeout(ms),
        screenshot: (opts) => p.screenshot(opts),
        mouse: { move: (x, y, opts) => p.mouse.move(x, y, opts), wheel: (dx, dy) => p.mouse.wheel(dx, dy) },
        close: () => p.close(),
      };
    },
    storageState: () => context.storageState(),
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

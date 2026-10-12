import { applicationDraftSchema, fillForm, type BrowserPage } from '@quarry/plugin-sdk';
import { appendEvent, getReviewItem, type DB } from '@quarry/db';
import { OutreachError } from './outreach.js';

// "Open prefilled form": the real application page in a visible browser window
// on this machine, every answer filled (resume included), stopped before
// Submit. For what the bot must not do itself (a captcha), the person solves
// it and clicks Submit. Nothing here submits.

export interface PrefillDeps {
  db: DB;
  /** A visible (headed) browser; the window is left open for the person. */
  openVisibleBrowser: () => Promise<{ newPage(): Promise<BrowserPage> }>;
}

export async function openPrefilledForm(deps: PrefillDeps, reviewItemId: string): Promise<{ url: string; notFound: string[] }> {
  let item = await getReviewItem(deps.db, reviewItemId);
  // An attention item that hands an application over points at it.
  const handoff = (item?.draft as { applicationItemId?: string } | undefined)?.applicationItemId;
  if (item?.kind === 'attention' && handoff) item = await getReviewItem(deps.db, handoff);
  if (!item || item.kind !== 'application') throw new OutreachError('not an application', 'not_found');
  if (item.status === 'executed') throw new OutreachError('this application was already submitted', 'invalid_state');
  const draft = applicationDraftSchema.parse(item.draft);
  const page = await (await deps.openVisibleBrowser()).newPage();
  await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);
  const notFound = await fillForm(page, draft);
  await appendEvent(deps.db, { kind: 'application.prefilled', subjectType: 'review_item', subjectId: item.id, payload: { url: draft.applyUrl, notFound } });
  return { url: draft.applyUrl, notFound };
}

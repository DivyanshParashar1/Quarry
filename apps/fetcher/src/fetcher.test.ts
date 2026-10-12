import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainRateLimiter } from '@quarry/core/fetch';
import { preferencesSchema, type Preferences } from '@quarry/shared';
import { listBatchFiles, readBatch } from './batch.js';
import { loadBoards, parseBoardsCsv, parseBoardsJson, type Board } from './boards.js';
import { createSourceRegistry } from './registry.js';
import { fetchBoard, fetchBoards, type FetchDeps } from './run.js';
import { readState, writeState, type FetchState } from './state.js';

const airbnbFixture = fileURLToPath(new URL('../../../plugins/source-greenhouse/fixtures/airbnb-jobs.json', import.meta.url));
const airbnb: Board = { companyName: 'Airbnb', atsType: 'greenhouse', boardToken: 'airbnb' };
const prefs = (p: Record<string, unknown> = {}): Preferences => preferencesSchema.parse(p);

/** Serves the recorded Greenhouse board through the real scoped-http path; anything else 404s. */
function fixtureFetch(body: () => string = () => readFileSync(airbnbFixture, 'utf8')): typeof globalThis.fetch {
  return async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'boards-api.greenhouse.io' && url.pathname === '/v1/boards/airbnb/jobs') {
      return new Response(body(), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"status":404,"error":"Job not found"}', { status: 404 });
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quarry-fetcher-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(o: Partial<FetchDeps> = {}): FetchDeps {
  return {
    registry: createSourceRegistry(),
    log: pino({ level: 'silent' }),
    limiter: new DomainRateLimiter({ tokens: 100, intervalMs: 1 }),
    outbox: join(dir, 'outbox'),
    preferences: null,
    filterOptions: { experienceSlackYears: 2 },
    fetch: fixtureFetch(),
    httpRetries: 0,
    device: 'test-phone',
    ...o,
  };
}

describe('board list', () => {
  it('reads the companies CSV, folding the Workday columns and skipping what no plugin serves', () => {
    const { boards, skipped } = parseBoardsCsv(
      [
        'name,ats_type,board_token,tags,domain,location,notes,workday_tenant,workday_site,smartrecruiters_company_id',
        'Airbnb,greenhouse,airbnb,,,,,,,',
        'Airbnb again,greenhouse,airbnb,,,,,,,',
        'NVIDIA,,,gcc,nvidia.com,India,,nvidia.wd5,NVIDIAExternalCareerSite,',
        'Bosch,,,,,,,,,BoschGroup',
        'Somewhere,careers_page,https://example.com/careers,,,,,,,',
        'No board,,,,,,,,,',
      ].join('\n'),
    );
    expect(boards).toEqual([
      { companyName: 'Airbnb', atsType: 'greenhouse', boardToken: 'airbnb' },
      { companyName: 'NVIDIA', atsType: 'workday', boardToken: 'nvidia.wd5/NVIDIAExternalCareerSite' },
      { companyName: 'Bosch', atsType: 'smartrecruiters', boardToken: 'BoschGroup' },
    ]);
    expect(skipped).toEqual(['No board: no ATS board', 'Somewhere: no source plugin for careers_page']);
  });

  it('reads boards.json as a bare array or { boards }', () => {
    const list = [{ companyName: 'Airbnb', atsType: 'greenhouse', boardToken: 'airbnb', options: { x: 1 } }];
    expect(parseBoardsJson(JSON.stringify(list)).boards).toEqual(list);
    expect(parseBoardsJson(JSON.stringify({ boards: list })).boards).toEqual(list);
    expect(() => parseBoardsJson('[{"companyName":"A","atsType":"nope","boardToken":"a"}]')).toThrow(/atsType/);
    expect(() => parseBoardsJson('{')).toThrow(/not valid JSON/);
  });

  it('loads the repo seed CSV', () => {
    const seed = fileURLToPath(new URL('../../../data/companies.seed.csv', import.meta.url));
    const { boards } = loadBoards(seed);
    expect(boards.length).toBeGreaterThan(40);
    expect(boards.some((b) => b.atsType === 'workday')).toBe(true);
  });
});

describe('fetchBoard', () => {
  it('writes a batch with every posting, then only what changed', async () => {
    const state: FetchState = readState(join(dir, 'state.json'));
    const first = await fetchBoard(deps(), state, airbnb);
    expect(first).toMatchObject({ ok: true, postings: 6, sent: 6, unchanged: 0, filtered: 0 });

    const batch = readBatch(first.batchPath);
    expect(batch).toMatchObject({
      kind: 'quarry.fetch-batch',
      version: 1,
      device: 'test-phone',
      ok: true,
      board: { companyName: 'Airbnb', atsType: 'greenhouse', boardToken: 'airbnb', sourcePlugin: 'source-greenhouse' },
      filter: { applied: false, preferencesHash: null },
    });
    const p = batch.postings[0]!.posting;
    expect(p.externalId).toBe('8184174');
    expect(p.postedAt).toBeInstanceOf(Date); // dates survive the JSON round trip
    expect(p.postedAt?.toISOString()).toBe('2026-09-09T08:35:19.000Z');

    // Same board again: nothing new travels, but every posting is accounted for.
    const second = await fetchBoard(deps(), state, airbnb);
    expect(second).toMatchObject({ ok: true, postings: 6, sent: 0, unchanged: 6 });
    expect(readBatch(second.batchPath).unchanged).toContain('8184174');

    // One title changes: only that posting is resent.
    const changed = () => readFileSync(airbnbFixture, 'utf8').replace('Account Manager ', 'Senior Account Manager');
    const third = await fetchBoard(deps({ fetch: fixtureFetch(changed) }), state, airbnb);
    expect(third).toMatchObject({ sent: 1, unchanged: 5 });
    expect(readBatch(third.batchPath).postings[0]!.posting.title).toBe('Senior Account Manager');

    // --full resends everything.
    expect(await fetchBoard(deps({ full: true }), state, airbnb)).toMatchObject({ sent: 6, unchanged: 0 });
  });

  it("drops postings that fail the preferences' hard filters, with the reason", async () => {
    const state = readState(join(dir, 'state.json'));
    const r = await fetchBoard(deps({ preferences: prefs({ locations: ['London', 'Berlin'], remote_policy: ['hybrid', 'onsite'] }) }), state, airbnb);
    expect(r).toMatchObject({ ok: true, postings: 6, sent: 2, filtered: 4 });

    const batch = readBatch(r.batchPath);
    expect(batch.filter.applied).toBe(true);
    expect(batch.filter.preferencesHash).toMatch(/^[0-9a-f]{16}$/);
    expect(batch.postings.map((p) => p.posting.externalId).sort()).toEqual(['7995153', '8184174']);
    expect(batch.filtered).toContainEqual({
      externalId: '7789554',
      title: 'Associate Legal Counsel, Japan',
      reason: expect.stringMatching(/Location Tokyo, Japan is outside London\/Berlin/),
    });
    expect(batch.filtered.find((f) => f.externalId === '8231416')?.reason).toMatch(/Remote roles are not in hybrid\/onsite/);
    // Filtered postings aren't remembered: loosen the preferences and they arrive as new.
    expect(Object.keys(state.boards['greenhouse:airbnb']!)).toHaveLength(2);
  });

  it('records a failed fetch without touching the state', async () => {
    const state = readState(join(dir, 'state.json'));
    await fetchBoard(deps(), state, airbnb);
    const before = structuredClone(state.boards);

    const r = await fetchBoard(deps(), state, { ...airbnb, companyName: 'Gone', boardToken: 'gone' });
    expect(r.ok).toBe(false);
    const batch = readBatch(r.batchPath);
    expect(batch).toMatchObject({ ok: false, permanent: true, postings: [], unchanged: [] });
    expect(batch.error).toMatch(/404/);
    expect(state.boards).toEqual(before);
  });
});

describe('fetchBoards', () => {
  it('fetches every board, keeps batches in start order and persists the state', async () => {
    const state = readState(join(dir, 'state.json'));
    let t = Date.parse('2026-10-12T00:00:00Z');
    const results = await fetchBoards(
      deps({ now: () => new Date((t += 1000)) }),
      state,
      [airbnb, { companyName: 'Gone', atsType: 'greenhouse', boardToken: 'gone' }],
      { concurrency: 1 },
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(state.lastRunAt).not.toBeNull();

    const files = listBatchFiles(join(dir, 'outbox'));
    expect(files).toHaveLength(2);
    expect(files.map((f) => readBatch(f).board.boardToken)).toEqual(['airbnb', 'gone']);

    writeState(join(dir, 'state.json'), state);
    expect(readState(join(dir, 'state.json')).boards['greenhouse:airbnb']).toBeDefined();
  });

  it('treats a corrupt state file as empty (a full resend, not a crash)', () => {
    writeFileSync(join(dir, 'state.json'), '{"version":7}');
    expect(readState(join(dir, 'state.json'))).toEqual({ version: 1, boards: {}, lastRunAt: null });
  });
});

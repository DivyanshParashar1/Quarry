import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseCompaniesCsv } from '@quarry/plugin-sdk';
import { ATS_TYPES, ConfigError, SOURCE_PLUGIN_FOR_ATS, type AtsType } from '@quarry/shared';

/** One job board the phone fetches. The laptop's company_sources rows, minus the db ids. */
export const boardSchema = z.object({
  companyName: z.string().min(1),
  atsType: z.enum(ATS_TYPES),
  boardToken: z.string().min(1),
  options: z.record(z.unknown()).optional(),
});
export type Board = z.infer<typeof boardSchema>;

/** `boards.json`: either a bare array or `{ boards: [...] }` (what the laptop sends). */
const boardsFileSchema = z.preprocess((v) => (Array.isArray(v) ? { boards: v } : v), z.object({ boards: z.array(boardSchema) }));

export const boardKey = (b: Pick<Board, 'atsType' | 'boardToken'>) => `${b.atsType}:${b.boardToken}`;

export interface LoadedBoards {
  boards: Board[];
  /** Rows that can't be fetched (bad row, or an ATS with no source plugin, e.g. careers_page). */
  skipped: string[];
}

/** Read the board list from a `.json` board file or a companies CSV (`data/companies.seed.csv`). */
export function loadBoards(path: string): LoadedBoards {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`can't read board list ${path}: ${(err as Error).message}`);
  }
  return path.toLowerCase().endsWith('.json') ? parseBoardsJson(text, path) : parseBoardsCsv(text);
}

export function parseBoardsJson(text: string, path = 'boards.json'): LoadedBoards {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = boardsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return keepFetchable(parsed.data.boards, []);
}

export function parseBoardsCsv(text: string): LoadedBoards {
  const { rows, errors } = parseCompaniesCsv(text);
  const boards: Board[] = [];
  const skipped = [...errors];
  for (const r of rows) {
    if (r.ats_type && r.board_token) boards.push({ companyName: r.name, atsType: r.ats_type, boardToken: r.board_token });
    else skipped.push(`${r.name}: no ATS board`);
  }
  return keepFetchable(boards, skipped);
}

/** Drop boards no source plugin serves, and duplicates (same ATS + token). */
function keepFetchable(all: Board[], skipped: string[]): LoadedBoards {
  const seen = new Set<string>();
  const boards: Board[] = [];
  for (const b of all) {
    if (!SOURCE_PLUGIN_FOR_ATS[b.atsType as AtsType]) {
      skipped.push(`${b.companyName}: no source plugin for ${b.atsType}`);
      continue;
    }
    const key = boardKey(b);
    if (seen.has(key)) continue;
    seen.add(key);
    boards.push(b);
  }
  return { boards, skipped };
}

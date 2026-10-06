import {
  factHash,
  profileSummary,
  profileVersion,
  readProfileDir,
  type Preferences,
  type ProfileFact,
} from '@jobforge/shared';
import { appendEvent, syncProfile, type DB, type ProfileSyncResult } from '@jobforge/db';

/** Validate profile/*.yaml and make it the active profile. Idempotent for unchanged files. */
export async function loadProfile(db: DB, dir: string): Promise<ProfileSyncResult> {
  const { facts, preferences } = readProfileDir(dir);
  return loadProfileData(db, facts, preferences);
}

export async function loadProfileData(db: DB, facts: ProfileFact[], preferences: Preferences): Promise<ProfileSyncResult> {
  const version = profileVersion(facts, preferences);
  const res = await syncProfile(db, {
    version,
    facts: facts.map((f) => ({ ...f, contentHash: factHash(f) })),
    preferences,
    summary: profileSummary(facts, preferences),
  });
  await appendEvent(db, { kind: 'profile.loaded', subjectType: 'profile', subjectId: version, payload: res });
  return res;
}

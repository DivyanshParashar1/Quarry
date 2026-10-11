// Phase 18 event triggers: a stage that finishes announces it here, and the
// host (the server) turns that into the next stage's pg-boss job, so work moves
// as soon as its input is ready instead of waiting for the hourly sweep. The
// sweep re-derives the same work from DB state, so a lost trigger only costs
// latency. Nothing is emitted when no sink is installed (CLI, most tests).

export type StageEvent =
  /** A source fetch created new jobs → embed + match. */
  | { kind: 'jobs.new'; jobIds: string[] }
  /** Jobs were scored → admit the ones that pass the gates (resume → fan-out). */
  | { kind: 'job.matched'; jobIds: string[] }
  /** Something changed for a job in the pipeline (reply, deadline, resume ready) → advance it. */
  | { kind: 'job.advance'; jobId: string; reason: string };

export type StageSink = (e: StageEvent) => void | Promise<void>;

let sink: StageSink | null = null;

/** Install (or clear, with null) the handler that turns stage events into work. */
export function setStageSink(next: StageSink | null): void {
  sink = next;
}

/** Fire-and-forget: a trigger must never fail the stage that emitted it. */
export function emitStage(e: StageEvent): void {
  if (!sink) return;
  if ('jobIds' in e && !e.jobIds.length) return;
  try {
    const r = sink(e);
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
  } catch {
    /* the sweep catches up */
  }
}

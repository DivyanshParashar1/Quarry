// Phase 22: paths no automated change (orchestrator fix or chatbot change) may
// touch. A patch that modifies, adds or deletes one is refused before any gate
// runs. These are the safety rails of CLAUDE.md: review/approval gating and
// ApprovedDraft minting, dryRun/MODE handling, rate limiters and send caps,
// cooldowns, the LinkedIn gate/pause/health, the session store and secrets,
// robots.txt handling, consent gating, and the guardrails themselves.

export const PROTECTED_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/^CLAUDE\.md$/, 'agent working rules'],
  [/^\.env/, 'secrets'],
  [/^\.mcp\.json$|^\.claude\//, 'agent configuration'],
  [/^packages\/core\/src\/outreach\.ts$/, 'review approval and ApprovedDraft minting, send caps'],
  [/^packages\/core\/src\/(referrals|sequencer|autopilot)\.ts$/, 'cooldowns, referral caps, auto-approval budgets'],
  [/^packages\/core\/src\/rate-limiter\.ts$/, 'rate limiter'],
  [/^packages\/core\/src\/(session-store|keychain|credentials)\.ts$/, 'session store and secrets'],
  [/^packages\/core\/src\/(capabilities|browser|plugins|http|ops-state)\.ts$/, 'plugin capability scoping'],
  [/^packages\/core\/src\/linkedin[^/]*\.ts$/, 'LinkedIn gate, pause and health'],
  [/^packages\/core\/src\/discovery\/robots\.ts$/, 'robots.txt handling'],
  [/^packages\/core\/src\/apply\.ts$/, 'application approval and submission gating'],
  [/^packages\/shared\/src\/(config|app-config)\.ts$/, 'MODE/dryRun, env and caps'],
  [/^packages\/plugin-sdk\/src\/(manifest|capabilities|wizard)\.ts$/, 'plugin permissions and consent gating'],
  [/^packages\/db\/src\/outreach-repo\.ts$/, 'review item transitions'],
  [/^packages\/db\/migrations\//, 'database migrations'],
  [/^packages\/orchestrator\/src\/(protected|codefix|actions|tick)\.ts$/, 'orchestrator guardrails'],
  [/^apps\/server\/src\/(index|runtime|routes-outreach|chat[^/]*)\.ts$/, 'server wiring, approval routes and chatbot guardrails'],
  [/^apps\/mcp\//, 'MCP server (approval tool)'],
  [/^scripts\/supervise\.mjs$/, 'process supervisor'],
];

/** The protected paths among `files` (repo-relative, forward slashes), with why. */
export function protectedHits(files: readonly string[]): { file: string; why: string }[] {
  const out: { file: string; why: string }[] = [];
  for (const f of files) {
    const hit = PROTECTED_PATHS.find(([re]) => re.test(f.replace(/\\/g, '/').replace(/^\.\//, '')));
    if (hit) out.push({ file: f, why: hit[1] });
  }
  return out;
}

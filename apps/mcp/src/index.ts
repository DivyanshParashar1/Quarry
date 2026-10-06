// MCP server exposing JobForge to an interactive Claude Code session (stdio).
// Registered in the repo's .mcp.json; talks to the running server's HTTP API.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './api-client.js';
import { createJobForgeMcp } from './server.js';

export const MCP_VERSION = '0.3.0';

async function main() {
  const base = process.env.JOBFORGE_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const server = createJobForgeMcp(createApiClient(base), { version: MCP_VERSION });
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // stdout is the protocol channel; diagnostics go to stderr.
    process.stderr.write(`jobforge-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

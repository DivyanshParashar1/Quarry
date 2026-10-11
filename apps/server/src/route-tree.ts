// Test helper: the routes a Fastify app registered, from app.printRoutes({ commonPrefix: false }).

/** Fastify's printRoutes tree → "METHOD /full/path" for every route (HEAD and the catch-all left out). */
export function routesFromTree(tree: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.+?) \(([^)]+)\)\s*$/) ?? line.match(/^((?:│ {3}| {4})*)(?:├── |└── )(.+?)\s*$/);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const seg = m[2]!;
    stack.length = depth;
    const full = (stack.at(-1) ?? '') + seg;
    stack.push(full);
    if (!m[3] || seg === '*') continue;
    for (const method of m[3].split(',').map((x) => x.trim())) if (method !== 'HEAD') out.push(`${method} ${full}`);
  }
  return out;
}

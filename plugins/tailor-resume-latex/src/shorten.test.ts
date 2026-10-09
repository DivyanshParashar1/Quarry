import { describe, expect, it } from 'vitest';
import { termLike, validateShortening } from './shorten.js';

const ORIG =
  'Built a bidirectional \\textbf{WebSocket} sync layer sustaining \\textbf{50+ concurrent editors} at \\textbf{$<$100ms} end-to-end latency, with envelope-based \\textbf{protocol versioning} and a message queue that replays buffered operations on reconnect.';

describe('validateShortening', () => {
  it('accepts a shorter rewrite that only removes words', () => {
    const v = validateShortening('b', ORIG, 'Built a \\textbf{WebSocket} sync layer for \\textbf{50+ concurrent editors} at \\textbf{$<$100ms} latency, with \\textbf{protocol versioning}.');
    expect(v.issues).toEqual([]);
    expect(v).toMatchObject({ status: 'ok', reverted: false });
  });

  it('rejects an invented number', () => {
    const v = validateShortening('b', ORIG, 'Built a \\textbf{WebSocket} sync layer for \\textbf{500 concurrent editors}.');
    expect(v.reverted).toBe(true);
    expect(v.issues).toContainEqual({ kind: 'invented_number', detail: '500' });
  });

  it('rejects an invented proper noun or tech term', () => {
    const v = validateShortening('b', ORIG, 'Built a WebSocket sync layer on Kubernetes for 50+ editors via Socket.IO.');
    expect(v.reverted).toBe(true);
    const terms = v.issues.filter((i) => i.kind === 'invented_term').map((i) => i.detail);
    expect(terms).toEqual(expect.arrayContaining(['Kubernetes', 'Socket.IO']));
  });

  it('allows a different sentence-initial verb', () => {
    const v = validateShortening('b', ORIG, 'Shipped a WebSocket sync layer for 50+ concurrent editors.');
    expect(v.issues).toEqual([]);
  });

  it('rejects rewrites that are not shorter, empty, add commands, or break LaTeX', () => {
    expect(validateShortening('b', 'Short one.', 'A much longer one than before.').issues[0]!.kind).toBe('too_long');
    expect(validateShortening('b', ORIG, '  ').issues[0]!.kind).toBe('empty');
    expect(validateShortening('b', ORIG, 'Built a \\href{x}{WebSocket} layer.').issues.map((i) => i.detail)).toContain('LaTeX command \\href');
    expect(validateShortening('b', ORIG, 'Built a \\textbf{WebSocket layer.').issues.map((i) => i.detail)).toContain('unbalanced braces or $');
    expect(validateShortening('b', 'Cut costs 100\\% on many many things.', 'Cut costs 100% on things.').issues.map((i) => i.detail)).toContain('unescaped %');
  });
});

describe('termLike', () => {
  it('flags inner caps, acronyms, tech punctuation and mid-sentence capitals', () => {
    expect(termLike('Built TypeScript CRDT with Node.js and C++ for Lamport clocks.')).toEqual([
      'TypeScript', 'CRDT', 'Node.js', 'C++', 'Lamport',
    ]);
  });
});

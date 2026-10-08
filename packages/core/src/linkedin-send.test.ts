import { describe, expect, it } from 'vitest';
import { threadsByName } from './linkedin-send.js';

describe('threadsByName', () => {
  it('maps a name to its thread only when one contact has it', () => {
    const m = threadsByName([
      { threadId: 't1', contactId: 'a', contactName: 'Rahul Sharma' },
      { threadId: 't2', contactId: 'b', contactName: 'rahul sharma ' },
      { threadId: 't3', contactId: 'c', contactName: 'Priya Iyer' },
      { threadId: 't4', contactId: 'c', contactName: 'Priya Iyer' },
      { threadId: 't5', contactId: 'd', contactName: 'Rahul Sharma' },
    ]);
    expect(m.get('rahul sharma')).toBeNull();
    expect(m.get('priya iyer')?.threadId).toBe('t4');
    expect(m.get('nobody')).toBeUndefined();
  });
});

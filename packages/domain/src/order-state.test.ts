import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal } from './order-state.js';

describe('order state machine', () => {
  it('allows the normal happy path', () => {
    expect(canTransition('processing', 'pending')).toBe(true);
    expect(canTransition('pending', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'printing')).toBe(true);
    expect(canTransition('printing', 'completed')).toBe(true);
  });
  it('blocks completing a rejected order and reopening a completed one', () => {
    expect(canTransition('rejected', 'completed')).toBe(false);
    expect(canTransition('completed', 'pending')).toBe(false);
  });
  it('knows terminal states', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
  });
});

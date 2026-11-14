import { describe, expect, it } from 'vitest';
import { useAppStore } from '../src/store.ts';

describe('app store', () => {
  it('starts in plan mode and switches to walk', () => {
    expect(useAppStore.getState().mode).toBe('plan');
    useAppStore.getState().setMode('walk');
    expect(useAppStore.getState().mode).toBe('walk');
  });
});

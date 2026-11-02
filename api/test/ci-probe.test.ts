import { expect, it } from 'vitest';

it('fails on purpose to prove CI blocks a merge', () => {
  expect(1).toBe(2);
});

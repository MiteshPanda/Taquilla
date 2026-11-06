import { describe, expect, it } from 'vitest';
import { DEMO_FANS, demoFanEmail } from '../src/auth/demo.js';

describe('demoFanEmail', () => {
  it('picks among exactly the seeded fans, fan1 to fan1000', () => {
    expect(DEMO_FANS).toBe(1_000);
    expect(demoFanEmail(() => 0)).toBe('fan1@taquilla.test');
    expect(demoFanEmail(() => 0.5)).toBe('fan501@taquilla.test');
    expect(demoFanEmail(() => 1 - Number.EPSILON)).toBe('fan1000@taquilla.test');
  });

  it('uses Math.random when given nothing', () => {
    expect(demoFanEmail()).toMatch(/^fan([1-9]\d{0,2}|1000)@taquilla\.test$/);
  });
});

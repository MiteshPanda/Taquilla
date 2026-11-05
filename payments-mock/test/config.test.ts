import { describe, expect, it } from 'vitest';
import { parseConfig, parseMigrateConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseConfig({})).toEqual({
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      PAYMENTS_PORT: 4000,
      DECLINE_RATE: 0.05,
      LOST_RESPONSE_RATE: 0.02,
      LATENCY_MIN_MS: 100,
      LATENCY_MAX_MS: 800,
    });
  });

  it('converts numbers, and treats a blank value as not set', () => {
    const config = parseConfig({
      PAYMENTS_PORT: '4100',
      DECLINE_RATE: '0',
      LOST_RESPONSE_RATE: '1',
      LATENCY_MIN_MS: '',
      LATENCY_MAX_MS: '100',
    });

    expect(config).toMatchObject({
      PAYMENTS_PORT: 4100,
      DECLINE_RATE: 0,
      LOST_RESPONSE_RATE: 1,
      LATENCY_MIN_MS: 100,
      LATENCY_MAX_MS: 100,
    });
  });

  it("ignores the API's PORT, which shares the same .env", () => {
    expect(parseConfig({ PORT: '3000' }).PAYMENTS_PORT).toBe(4000);
  });

  it.each([
    ['DECLINE_RATE', '1.5'],
    ['DECLINE_RATE', 'often'],
    ['LOST_RESPONSE_RATE', '-0.1'],
    ['LATENCY_MIN_MS', '-1'],
    ['LATENCY_MAX_MS', '1.5'],
    ['LATENCY_MAX_MS', '60001'],
    ['PAYMENTS_PORT', '70000'],
    ['LOG_LEVEL', 'loud'],
    ['DATABASE_URL', 'mysql://localhost/taquilla'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it('rejects a maximum latency below the minimum, naming the maximum', () => {
    expect(() => parseConfig({ LATENCY_MIN_MS: '500', LATENCY_MAX_MS: '400' })).toThrow(
      /LATENCY_MAX_MS/,
    );
  });
});

describe('parseMigrateConfig', () => {
  it('needs only the database, so a bad fault setting cannot stop a migration', () => {
    expect(parseMigrateConfig({ DECLINE_RATE: '9', LOG_LEVEL: 'warn' })).toEqual({
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
    });
  });
});

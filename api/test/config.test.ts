import { describe, expect, it } from 'vitest';
import { parseConfig, parseMigrateConfig, parseResetConfig } from '../src/config.js';

const JWT_SECRET = 'a'.repeat(32);

describe('parseConfig', () => {
  it('applies the documented defaults', () => {
    expect(parseConfig({ JWT_SECRET })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      CORS_ORIGINS: ['http://localhost:5173'],
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      PORT: 3000,
      JWT_SECRET,
      BOOKING_STRATEGY: 'lock',
      HOLD_SECONDS: 300,
      SWEEP_INTERVAL_SECONDS: 10,
      PAYMENTS_URL: 'http://localhost:4000',
      DECLINE_RATE: 0.05,
      LOST_RESPONSE_RATE: 0.02,
      SEED_PASSWORD: 'taquilla-dev',
      RACE_DELAY_MS: 0,
    });
  });

  it('converts numbers and splits CORS_ORIGINS', () => {
    const config = parseConfig({
      JWT_SECRET,
      PORT: '8080',
      DECLINE_RATE: '0',
      CORS_ORIGINS: 'https://a.example, https://b.example:8443',
    });

    expect(config.PORT).toBe(8080);
    expect(config.DECLINE_RATE).toBe(0);
    expect(config.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example:8443']);
  });

  it('treats a blank value as not set', () => {
    expect(parseConfig({ JWT_SECRET, PORT: '' }).PORT).toBe(3000);
    expect(() => parseConfig({ JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
  });

  it.each([
    ['JWT_SECRET', undefined],
    ['JWT_SECRET', 'too-short'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
    ['BOOKING_STRATEGY', 'optimism'],
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['HOLD_SECONDS', '0'],
    ['HOLD_SECONDS', '1.5'],
    ['SWEEP_INTERVAL_SECONDS', '-1'],
    ['DECLINE_RATE', '1.5'],
    ['LOST_RESPONSE_RATE', '-0.1'],
    ['RACE_DELAY_MS', '-1'],
    ['DATABASE_URL', 'mysql://localhost/taquilla'],
    ['PAYMENTS_URL', 'not a url'],
    ['SEED_PASSWORD', 'short'],
    ['CORS_ORIGINS', 'https://a.example/'],
    ['CORS_ORIGINS', '*'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => parseConfig({ JWT_SECRET, [name]: value })).toThrow(new RegExp(name));
  });

  it('does not repeat a rejected secret in the error', () => {
    let message = '';
    try {
      parseConfig({ JWT_SECRET: 'hunter2' });
    } catch (err) {
      message = String(err);
    }

    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain('hunter2');
  });
});

describe('parseResetConfig', () => {
  it('needs no JWT_SECRET, and applies defaults', () => {
    expect(parseResetConfig({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      SEED_PASSWORD: 'taquilla-dev',
    });
  });

  it('rejects a SEED_PASSWORD that is too short', () => {
    expect(() => parseResetConfig({ SEED_PASSWORD: 'short' })).toThrow(/SEED_PASSWORD/);
  });
});

describe('parseMigrateConfig', () => {
  it('needs no JWT_SECRET, and applies defaults', () => {
    expect(parseMigrateConfig({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
    });
  });

  it('treats a blank value as unset', () => {
    expect(parseMigrateConfig({ NODE_ENV: '' }).NODE_ENV).toBe('development');
  });

  it('rejects a DATABASE_URL that is not Postgres', () => {
    expect(() => parseMigrateConfig({ DATABASE_URL: 'mysql://localhost/x' })).toThrow(
      /DATABASE_URL/,
    );
  });
});

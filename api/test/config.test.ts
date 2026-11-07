import { describe, expect, it } from 'vitest';
import {
  parseAuditConfig,
  parseConfig,
  parseMigrateConfig,
  parseResetConfig,
  parseSeedConfig,
  parseSweeperConfig,
  parseTokensConfig,
} from '../src/config.js';

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
      JWT_EXPIRES_IN: 3600,
      BOOKING_STRATEGY: 'lock',
      HOLD_SECONDS: 300,
      SWEEP_INTERVAL_SECONDS: 10,
      PAYMENTS_URL: 'http://localhost:4000',
      SEED_PASSWORD: 'taquilla-dev',
      RACE_DELAY_MS: 0,
    });
  });

  it.each([
    ['30s', 30],
    ['15m', 900],
    ['1h', 3600],
    ['7d', 604_800],
  ])('reads JWT_EXPIRES_IN=%s as %i seconds', (value, seconds) => {
    expect(parseConfig({ JWT_SECRET, JWT_EXPIRES_IN: value }).JWT_EXPIRES_IN).toBe(seconds);
  });

  it('converts numbers and splits CORS_ORIGINS', () => {
    const config = parseConfig({
      JWT_SECRET,
      PORT: '8080',
      HOLD_SECONDS: '2',
      CORS_ORIGINS: 'https://a.example, https://b.example:8443',
    });

    expect(config.PORT).toBe(8080);
    expect(config.HOLD_SECONDS).toBe(2);
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
    ['RACE_DELAY_MS', '-1'],
    ['DATABASE_URL', 'mysql://localhost/taquilla'],
    ['PAYMENTS_URL', 'not a url'],
    ['SEED_PASSWORD', 'short'],
    ['SEED_PASSWORD', 'é'.repeat(37)],
    ['JWT_EXPIRES_IN', '1 hour'],
    ['JWT_EXPIRES_IN', '0s'],
    ['JWT_EXPIRES_IN', '3600'],
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

describe('parseSweeperConfig', () => {
  it('needs no JWT_SECRET, and runs every 10 seconds by default', () => {
    expect(parseSweeperConfig({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      SWEEP_INTERVAL_SECONDS: 10,
    });
  });

  it('reads SWEEPER_HEARTBEAT_FILE, and treats a blank one as unset', () => {
    expect(parseSweeperConfig({ SWEEPER_HEARTBEAT_FILE: '/tmp/beat' }).SWEEPER_HEARTBEAT_FILE).toBe(
      '/tmp/beat',
    );
    expect(parseSweeperConfig({ SWEEPER_HEARTBEAT_FILE: '' })).not.toHaveProperty(
      'SWEEPER_HEARTBEAT_FILE',
    );
  });

  it('reads SWEEP_INTERVAL_SECONDS and rejects one that is not a positive whole number', () => {
    expect(parseSweeperConfig({ SWEEP_INTERVAL_SECONDS: '3' }).SWEEP_INTERVAL_SECONDS).toBe(3);
    expect(() => parseSweeperConfig({ SWEEP_INTERVAL_SECONDS: '0' })).toThrow(
      /SWEEP_INTERVAL_SECONDS/,
    );
  });
});

describe('parseAuditConfig', () => {
  it('needs only the database, since the audit only reads', () => {
    expect(parseAuditConfig({ BOOKING_STRATEGY: 'optimism', LOG_LEVEL: 'warn' })).toEqual({
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
    });
  });
});

describe('parseTokensConfig', () => {
  it('needs JWT_SECRET, because it signs tokens the API must accept', () => {
    expect(() => parseTokensConfig({})).toThrow(/JWT_SECRET/);
  });

  it('applies defaults, including the token lifetime', () => {
    expect(parseTokensConfig({ JWT_SECRET })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      JWT_SECRET,
      JWT_EXPIRES_IN: 3600,
    });
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

describe('parseSeedConfig', () => {
  it('needs no JWT_SECRET or NODE_ENV, since it never deletes anything', () => {
    expect(parseSeedConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toEqual({
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://taquilla:taquilla@localhost:5432/taquilla',
      SEED_PASSWORD: 'taquilla-dev',
    });
  });

  it('rejects a SEED_PASSWORD that is too short', () => {
    expect(() => parseSeedConfig({ SEED_PASSWORD: 'short' })).toThrow(/SEED_PASSWORD/);
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

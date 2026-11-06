import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, DEFAULT_DEMO_PASSWORD, parseWebConfig } from '../src/config.js';

describe('parseWebConfig', () => {
  it('defaults to the local API and the seed password when nothing is set', () => {
    expect(parseWebConfig({})).toEqual({
      apiUrl: DEFAULT_API_URL,
      demoPassword: DEFAULT_DEMO_PASSWORD,
    });
    expect(DEFAULT_API_URL).toBe('http://localhost:3000');
    // SEED_PASSWORD's default in .env.example, which the seeded fans get.
    expect(DEFAULT_DEMO_PASSWORD).toBe('taquilla-dev');
  });

  it("keeps the address and its path, without trailing slashes, and ignores Vite's own variables", () => {
    const env = { MODE: 'production', DEV: false, VITE_API_URL: 'https://tickets.example/api//' };

    expect(parseWebConfig(env).apiUrl).toBe('https://tickets.example/api');
    expect(parseWebConfig({ VITE_API_URL: 'http://localhost:3000/' }).apiUrl).toBe(
      'http://localhost:3000',
    );
  });

  it.each([
    ['an empty value', ''],
    ['no scheme', 'localhost:3000'],
    ['a scheme other than http or https', 'ftp://tickets.example'],
    ['a query', 'https://tickets.example/?v=1'],
    ['an empty query', 'https://tickets.example/?'],
    ['a fragment', 'https://tickets.example/#top'],
  ])('refuses an address with %s, naming the variable', (_case, value) => {
    expect(() => parseWebConfig({ VITE_API_URL: value })).toThrow(/VITE_API_URL/);
  });

  it('takes the demo password from VITE_DEMO_PASSWORD', () => {
    expect(parseWebConfig({ VITE_DEMO_PASSWORD: 'another-seed' }).demoPassword).toBe(
      'another-seed',
    );
  });

  it('refuses a demo password shorter than SEED_PASSWORD allows, naming the variable', () => {
    expect(() => parseWebConfig({ VITE_DEMO_PASSWORD: 'short' })).toThrow(/VITE_DEMO_PASSWORD/);
  });
});

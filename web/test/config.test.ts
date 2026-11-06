import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, parseWebConfig } from '../src/config.js';

describe('parseWebConfig', () => {
  it('defaults to the local API when VITE_API_URL is unset', () => {
    expect(parseWebConfig({})).toEqual({ apiUrl: DEFAULT_API_URL });
    expect(DEFAULT_API_URL).toBe('http://localhost:3000');
  });

  it("keeps the address and its path, without trailing slashes, and ignores Vite's own variables", () => {
    const env = { MODE: 'production', DEV: false, VITE_API_URL: 'https://tickets.example/api//' };

    expect(parseWebConfig(env)).toEqual({ apiUrl: 'https://tickets.example/api' });
    expect(parseWebConfig({ VITE_API_URL: 'http://localhost:3000/' })).toEqual({
      apiUrl: 'http://localhost:3000',
    });
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
});

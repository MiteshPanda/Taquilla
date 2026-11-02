import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{api,payments-mock}/test/**/*.test.ts'],
    // Test files share one Postgres database, so they must not run at the same time.
    fileParallelism: false,
    // Removed in WP 0.4, when the first real tests arrive.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['{api,payments-mock}/src/**/*.ts'],
      thresholds: {
        'api/src/holds/**': { lines: 80 },
        'api/src/checkout/**': { lines: 80 },
        'api/src/idempotency/**': { lines: 80 },
      },
    },
  },
});
